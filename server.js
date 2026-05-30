require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const { readLatestApiResultsPayload } = require('./utils/latest-api-results.js');
const { sendZohoMail } = require('./utils/zoho-mail');
const { sendSlackNotification } = require('./utils/slack-notify');

// ── MongoDB data layer ──
const { connectDB, pingDB, readKey, writeKey, deleteKey, readAllData } = require('./src/db');

// ── In-memory cache — loaded from MongoDB on startup ──
// All synchronous readQaData() calls read from this cache.
// All writes update the cache and persist to MongoDB.
let _qaCache = {};

// Write lock: prevents concurrent writes from clobbering each other in the cache.
let _writeQueue = Promise.resolve();
function _withWriteLock(fn) {
    _writeQueue = _writeQueue.then(fn).catch(e => {
        console.error('[writeLock] error:', e.message);
    });
    return _writeQueue;
}

function readQaData() { return _qaCache; }

function writeQaData(data) {
    _qaCache = data;
    // Persist changed keys to MongoDB asynchronously (fire and forget)
    // Full-data writes are only used by dedup on startup — safe to be async.
    Promise.resolve().then(async () => {
        for (const key of Object.keys(data)) {
            try { await writeKey(key, data[key]); } catch (e) {
                console.error('[mongo] writeQaData key failed:', key, e.message);
            }
        }
    });
}

// ── MongoDB is now the single source of truth — GitHub file sync removed ──
// _ghRequest and GH_API_REPO are kept ONLY for workflow-doc file uploads to GitHub Releases.
const GH_API_REPO = 'AHY18099/AdHash_Project_Dashboard';
function _ghRequest(method, ghPath, body, token) {
    return new Promise((resolve, reject) => {
        const https = require('https');
        const payload = body ? JSON.stringify(body) : null;
        const req = https.request({
            hostname: 'api.github.com', path: ghPath, method,
            headers: {
                'Authorization': `token ${token}`, 'User-Agent': 'AdHash-Dashboard',
                'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json',
                ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
            }
        }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch (_) { resolve({ status: res.statusCode, body: data }); } });
        });
        req.on('error', reject);
        req.setTimeout(12000, () => { req.destroy(); reject(new Error('GitHub API timeout')); });
        if (payload) req.write(payload);
        req.end();
    });
}


const app = express();
const PORT = Number(process.env.PORT) || 7777;
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;

// ── Real-time SSE broadcast ──
const _sseClients = new Set();
function broadcastSseEvent(eventName, data) {
    if (!_sseClients.size) return;
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of _sseClients) {
        try { client.write(payload); } catch (_) { _sseClients.delete(client); }
    }
}
const SUPER_ADMIN_EMAIL = process.env.QA_ADMIN_EMAIL || 'thenilavan@adhashtech.com';
const SUPER_ADMIN_PASSWORD = process.env.QA_ADMIN_PASSWORD || 'Qateam@123';

// Apply defaults so all features work on Railway without manual env var setup
// GITHUB_TOKEN must be set as a Railway environment variable — no hardcoded fallback
if (!process.env.ZOHO_MAIL_ENABLED)    process.env.ZOHO_MAIL_ENABLED    = 'true';
if (!process.env.ZOHO_MAIL_FROM)       process.env.ZOHO_MAIL_FROM       = 'thenilavan@adhashtech.com';
if (!process.env.ZOHO_MAIL_TO)         process.env.ZOHO_MAIL_TO         = 'qateam@adhashtech.com';
if (!process.env.ZOHO_MAIL_CC)         process.env.ZOHO_MAIL_CC         = 'qateam@adhashtech.com';
// Zoho REST API OAuth2 credentials (replaces SMTP — Railway blocks all SMTP ports)
if (!process.env.ZOHO_CLIENT_ID)       process.env.ZOHO_CLIENT_ID       = '1000.DVQEG5BEQDFQ0ULRWVPY77ZMFWC77S';
if (!process.env.ZOHO_CLIENT_SECRET)   process.env.ZOHO_CLIENT_SECRET   = 'b297abaa2202667173c98f59fd3ac8185fcdd71969';
if (!process.env.ZOHO_REFRESH_TOKEN)   process.env.ZOHO_REFRESH_TOKEN   = '1000.df711cadb21bd11351c2127e4e6ded37.6367f4b9c445fb1f42e5625479cb5a29';
if (!process.env.ZOHO_ACCOUNT_ID)      process.env.ZOHO_ACCOUNT_ID      = '8370649000000008002';
if (!process.env.SLACK_BOT_TOKEN)    process.env.SLACK_BOT_TOKEN    = 'xoxb-419650362022-11217403721126-XiJEnpEJPpklhzcauEXfsmSi';
if (!process.env.SLACK_CHANNEL)      process.env.SLACK_CHANNEL      = '#testing-team';
if (!process.env.SLACK_ENABLED)      process.env.SLACK_ENABLED      = 'true';
const SUPER_ADMIN_ROLE = 'super-admin';
const AUTH_COOKIE_NAME = 'adhash_auth';
const AUTH_COOKIE_VALUE = Buffer.from(`${SUPER_ADMIN_EMAIL}:${SUPER_ADMIN_PASSWORD}`).toString('base64url');

// Parse JSON bodies
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// Security headers on every response
app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('X-XSS-Protection', '1; mode=block');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (IS_PROD) {
        res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
});

function parseCookies(req) {
    const header = req.headers.cookie || '';
    return header.split(';').reduce((cookies, part) => {
        const [rawKey, ...rest] = part.trim().split('=');
        if (!rawKey) return cookies;
        cookies[rawKey] = decodeURIComponent(rest.join('='));
        return cookies;
    }, {});
}

function setAuthCookie(res) {
    const secure = IS_PROD ? '; Secure' : '';
    res.setHeader(
        'Set-Cookie',
        `${AUTH_COOKIE_NAME}=${encodeURIComponent(AUTH_COOKIE_VALUE)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secure}`
    );
}

function clearAuthCookie(res) {
    const secure = IS_PROD ? '; Secure' : '';
    res.setHeader(
        'Set-Cookie',
        `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
    );
}

app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

// Routes that don't require authentication
const PUBLIC_API_ROUTES = new Set(['/api/auth/login', '/api/auth/session', '/api/auth/logout', '/api/health']);

// Guard all non-public API routes
app.use('/api', (req, res, next) => {
    const route = req.path === '/' ? '/api' : '/api' + req.path;
    // Allow auth routes through
    if (PUBLIC_API_ROUTES.has('/api' + req.path)) return next();
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    next();
});

// Cookie value encodes email:password for super admin, or email:role:member for members
const MEMBER_COOKIE_PREFIX = 'member:';

function isMemberAuthenticated(req) {
    const cookies = parseCookies(req);
    const val = cookies[AUTH_COOKIE_NAME] || '';
    try {
        const decoded = Buffer.from(val, 'base64url').toString('utf8');
        return decoded.startsWith(MEMBER_COOKIE_PREFIX);
    } catch (_) { return false; }
}

function getSessionFromCookie(req) {
    const cookies = parseCookies(req);
    const val = cookies[AUTH_COOKIE_NAME] || '';
    if (val === AUTH_COOKIE_VALUE) return { role: SUPER_ADMIN_ROLE, email: SUPER_ADMIN_EMAIL };
    try {
        const decoded = Buffer.from(val, 'base64url').toString('utf8');
        if (decoded.startsWith(MEMBER_COOKIE_PREFIX)) {
            const parts = decoded.slice(MEMBER_COOKIE_PREFIX.length).split(':');
            return { role: 'member', email: parts[0], name: parts.slice(1).join(':') };
        }
    } catch (_) {}
    return null;
}

function isAuthenticated(req) {
    const cookies = parseCookies(req);
    const val = cookies[AUTH_COOKIE_NAME] || '';
    if (val === AUTH_COOKIE_VALUE) return true;
    try {
        const decoded = Buffer.from(val, 'base64url').toString('utf8');
        return decoded.startsWith(MEMBER_COOKIE_PREFIX);
    } catch (_) { return false; }
}

function setMemberCookie(res, email, name) {
    const secure = IS_PROD ? '; Secure' : '';
    const cookieVal = Buffer.from(`${MEMBER_COOKIE_PREFIX}${email}:${name}`).toString('base64url');
    res.setHeader('Set-Cookie',
        `${AUTH_COOKIE_NAME}=${encodeURIComponent(cookieVal)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secure}`
    );
}

app.post('/api/auth/login', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    // Super admin check
    if (email === SUPER_ADMIN_EMAIL.toLowerCase() && password === SUPER_ADMIN_PASSWORD) {
        setAuthCookie(res);
        return res.json({ success: true, role: SUPER_ADMIN_ROLE, redirectTo: '/landing' });
    }

    // Member check — look up in shared data file
    try {
        const data = readQaData();
        const users = Array.isArray(data['qa_users']) ? data['qa_users'] : [];
        const user = users.find(u =>
            u.email && u.email.toLowerCase() === email &&
            u.password === password &&
            u.role === 'member'
        );
        if (user) {
            setMemberCookie(res, user.email, user.name);
            return res.json({ success: true, role: 'member', name: user.name, redirectTo: '/landing' });
        }
    } catch (_) {}

    return res.status(401).json({ success: false, message: 'Invalid email or password.' });
});

app.get('/api/auth/session', (req, res) => {
    const session = getSessionFromCookie(req);
    const authenticated = !!session;
    res.json({
        authenticated,
        role: session ? session.role : null,
        email: session ? session.email : null,
        name: session ? session.name : null
    });
});

app.post('/api/auth/logout', (req, res) => {
    clearAuthCookie(res);
    res.json({ success: true });
});

// Store test execution status
let testRunning = false;
let testResults = null;
let testLogs = [];
let currentSuite = null;
let testProcessPid = null;
let testProcessRef = null;
let lastMailDispatchKey = null;

// Store server logs
const serverLogs = [];
const MAX_LOGS = 100;
const DASHBOARD_STATE_PATH = path.join(__dirname, 'test-results', 'dashboard-state.json');
const DOMAIN_REPORT_OUTPUT_PATH = path.join(__dirname, 'godaddy', 'report.html');
const CERTIFICATE_REPORT_OUTPUT_PATH = path.join(__dirname, 'suite-reports', 'AdHash_Projects_Certificate_Expiry_Test.html');
const DOMAIN_MODULE_REPORT_PATH = path.join(__dirname, 'final-dashboard-bundle', 'module-reports', 'domain.html');
const SSL_MODULE_REPORT_PATH = path.join(__dirname, 'final-dashboard-bundle', 'module-reports', 'ssl.html');
const EXPIRY_WARNING_DAYS = 30;
const WORKSPACE_SUITES = {
    app: {
        id: 'app',
        name: 'App Status Verification',
        repository: 'Adhash_App_Status',
        specPath: 'tests/app-status/playstore.spec.ts',
        countKey: 'appStatus',
        countPattern: /test\(/g
    },
    server: {
        id: 'server',
        name: 'Server Health Monitoring',
        repository: 'Adhash_AllProjects_Server',
        specPath: 'tests/server-health/server-check.spec.ts',
        countKey: 'serverHealth',
        countPattern: /\{\s*name:/g
    },
    cert: {
        id: 'cert',
        name: 'SSL Certificate Monitoring',
        repository: 'AdHash-Projects-Certificate-Expiry-Test',
        specPath: 'tests/certificate/cert-expiry.spec.ts',
        countKey: 'sslCertificate',
        countPattern: /\{\s*name:/g
    },
    api: {
        id: 'api',
        name: 'API Endpoint Testing',
        repository: 'AdHash-API-Test',
        specPath: 'tests/api/api-tests.spec.ts',
        countKey: 'apiEndpoint',
        countPattern: /\{\s*name:/g
    },
    domain: {
  id: 'domain',
  name: 'Domain Expiry Monitoring',
  repository: 'AdHash_Domain_Report',
  specPath: '__external__',
  countKey: 'domainExpiry',
  countPattern: /Checking\s+([^(]+)\s+\(([^)]+)\)\.\.\./g
}
};

function isSuiteConfigured(config) {
  if (!config) return false;

  if (config.id === 'domain') {
    return fs.existsSync(path.join(__dirname, 'godaddy', 'package.json'));
  }

  return !!(config.specPath && fs.existsSync(path.join(__dirname, config.specPath)));
}

function countSuiteTests(config) {
    if (!config || !config.specPath || !config.countPattern) {
        return 0;
    }

    const suiteFilePath = path.join(__dirname, config.specPath);
    if (!fs.existsSync(suiteFilePath)) {
        return 0;
    }

    const content = fs.readFileSync(suiteFilePath, 'utf8');
    const matches = content.match(config.countPattern);
    return matches ? matches.length : 0;
}

function createDefaultDetailedResults() {
    return {
        app: { status: 'not-run', passed: 0, failed: 0, warning: 0, total: 0, details: [] },
        server: { status: 'not-run', passed: 0, failed: 0, warning: 0, total: 0, details: [] },
        cert: { status: 'not-run', passed: 0, failed: 0, warning: 0, total: 0, details: [] },
        api: { status: 'not-run', passed: 0, failed: 0, warning: 0, total: 0, details: [] },
        domain: {
            status: 'unavailable',
            passed: 0,
            failed: 0,
            warning: 0,
            total: 0,
            details: [],
            message: WORKSPACE_SUITES.domain.unavailableMessage
        }
    };
}

function readDashboardState() {
    if (!fs.existsSync(DASHBOARD_STATE_PATH)) {
        return null;
    }

    try {
        return JSON.parse(fs.readFileSync(DASHBOARD_STATE_PATH, 'utf8'));
    } catch (error) {
        console.error('Error reading dashboard state:', error);
        return null;
    }
}

// Helper function to log messages to array
function logToArray(level, message) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        level: level,
        message: message
    };
    serverLogs.push(logEntry);

    // Keep only last MAX_LOGS entries
    if (serverLogs.length > MAX_LOGS) {
        serverLogs.shift();
    }

    // Also log to console
    console.log(`[${level.toUpperCase()}] ${message}`);
}

// API endpoint to get test suite counts WITHOUT running tests
app.get('/api/test-counts', (req, res) => {
    const counts = {
        appStatus: 0,
        serverHealth: 0,
        sslCertificate: 0,
        apiEndpoint: 0,
        domainExpiry: 0,
        total: 0
    };

    try {
        Object.values(WORKSPACE_SUITES).forEach((config) => {
            counts[config.countKey] = isSuiteConfigured(config) ? countSuiteTests(config) : 0;
        });

        counts.total = counts.appStatus + counts.serverHealth + counts.sslCertificate + counts.apiEndpoint + counts.domainExpiry;

        res.json({
            status: 'success',
            counts: counts
        });
    } catch (error) {
        console.error('Error counting tests:', error);
        res.json({
            status: 'error',
            message: error.message,
            counts: counts
        });
    }
});

// Helper function to check if a process is actually running
function isProcessRunning(pid) {
    if (!pid) return false;
    try {
        // Sending signal 0 checks if process exists without killing it
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
}

function buildMailDispatchKey(state) {
    if (!state || !state.summary) {
        return null;
    }

    const summary = state.summary;
    return [
        state.generatedAt || '',
        summary.passedSuites || 0,
        summary.failedSuites || 0,
        summary.skippedSuites || 0,
        summary.totalSuites || 0
    ].join('|');
}

function escapeHtml(value) {
        return String(value || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
}

function normalizeSuiteStatus(value) {
    const status = String(value || '').toLowerCase();
    if (status === 'passed' || status === 'failed' || status === 'warning') {
        return status;
    }
    if (status === 'unavailable' || status === 'not-run') {
        return 'skipped';
    }
    return 'skipped';
}

function getSuiteDisplayLabel(key) {
    const suiteLabels = {
        app: 'App Status Verification',
        server: 'Server Health Monitoring',
        cert: 'SSL Certificate Monitoring',
        api: 'API Endpoint Testing',
        domain: 'Domain Expiry Monitoring'
    };

    return suiteLabels[key] || key;
}

// Builds a single chip badge for the email template dark-card style
function buildTemplateChip(count, label, color) {
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="display:inline-table;margin-right:8px;margin-bottom:6px;border-collapse:separate;"><tr><td style="background-color:#f0f0f0;border:2px solid ${color};border-radius:18px;padding:5px 12px;font-size:12px;line-height:14px;font-weight:700;color:${color};font-family:Arial,'Segoe UI',sans-serif;white-space:nowrap;">${escapeHtml(label)} ${count}</td></tr></table>`;
}

// Builds failed item rows matching the email template dark-card style
function buildTemplateFailedItemsHtml(failedItems) {
    const rows = failedItems.map((item) => {
        const name = item.name || item.domain || item.url || 'Unknown';
        const projectLine = item.projectName ? `<div style="margin-top:6px;font-size:13px;color:#d1d5db;"><strong style="color:#ffffff;">Project:</strong> ${escapeHtml(item.projectName)}</div>` : '';
        const urlLine = item.url ? `<div style="margin-top:6px;font-size:13px;color:#d1d5db;"><strong style="color:#ffffff;">URL:</strong> ${escapeHtml(item.url)}</div>` : '';
        const durationLine = item.duration ? `<div style="margin-top:6px;font-size:13px;color:#d1d5db;"><strong style="color:#ffffff;">Duration:</strong> ${escapeHtml(String(item.duration))}</div>` : '';
        const reason = item.reason || item.message || (item.responseCode ? `Response code: ${item.responseCode}` : '') || 'Failed during execution';
        const reasonLine = `<div style="margin-top:6px;font-size:13px;color:#fca5a5;"><strong style="color:#ffffff;">Error Reason:</strong> ${escapeHtml(reason)}</div>`;
        return `<tr><td style="padding:0 0 12px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#2a1114" style="background-color:#2a1114;border:1px solid #ef4444;border-collapse:separate;border-radius:14px;"><tr><td style="padding:14px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:14px;line-height:18px;font-weight:700;color:#ffffff;font-family:Arial,'Segoe UI',sans-serif;padding-right:12px;vertical-align:top;">&#x2717; ${escapeHtml(name)}</td><td width="92" align="right" style="vertical-align:top;"><table role="presentation" cellpadding="0" cellspacing="0" align="right"><tr><td bgcolor="#ef4444" style="background-color:#ef4444;border-radius:999px;padding:4px 10px;font-size:11px;line-height:13px;font-weight:800;letter-spacing:0.7px;color:#ffffff;font-family:Arial,'Segoe UI',sans-serif;white-space:nowrap;">FAILED</td></tr></table></td></tr><tr><td colspan="2" style="padding-top:4px;">${projectLine}${urlLine}${durationLine}${reasonLine}</td></tr></table></td></tr></table></td></tr>`;
    });
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.join('')}</table>`;
}

// Builds all failed-module section cards for injection into the locked email template
function buildFailedModulesHtmlForTemplate(state) {
    const suites = (state && state.suites) || {};
    const moduleConfig = [
        { key: 'app',    label: 'App Status' },
        { key: 'server', label: 'Server Health' },
        { key: 'cert',   label: 'SSL Certificate Status' },
        { key: 'api',    label: 'API Status' },
        { key: 'domain', label: 'Domain Status' }
    ];

    let mapping;
    try { mapping = getProjectMapping(); } catch (e) { mapping = { projects: [] }; }
    const projects = mapping.projects || [];

    return moduleConfig.map(({ key, label }) => {
        let total = 0, failed = 0, skipped = 0;
        let failedItems = [];

        if (key === 'api' || key === 'server' || key === 'app') {
            // Use per-project results — suite-level details array may be empty for these types
            const getResults = key === 'api' ? getAPITestResults
                             : key === 'server' ? getServerTestResults
                             : getAppTestResults;
            projects.forEach((project) => {
                const result = getResults(project.id);
                total += result.total;
                failed += result.failed;
                skipped += result.skipped;
                (result.tests || []).forEach((test) => {
                    if ((test.status || '').toLowerCase() === 'failed') {
                        failedItems.push({ ...test, projectName: project.name });
                    }
                });
            });
        } else {
            const suite = suites[key] || {};
            total = Number(suite.total || 0);
            failed = Number(suite.failed || 0);
            skipped = Number(suite.skipped || 0);
            const details = Array.isArray(suite.details) ? suite.details : [];
            failedItems = details.filter((d) => {
                const s = String((d && d.status) || '').toLowerCase();
                return s === 'failed' || s === 'error';
            });
        }

        const headerBg = failed > 0 ? '#7f1d1d' : '#065f46';
        let chips = buildTemplateChip(total, 'TOTAL', '#3b82f6');
        if (skipped > 0) chips += buildTemplateChip(skipped, 'SKIP', '#6b7280');
        if (failed > 0) chips += buildTemplateChip(failed, 'FAIL', '#ef4444');

        const bodyContent = failedItems.length === 0
            ? '<div style="padding:16px 14px;border-radius:14px;background:#0b1524;border:1px dashed rgba(148,163,184,0.3);font-size:13px;line-height:18px;color:#94a3b8;text-align:center;">No failed or warning checks in this module.</div>'
            : buildTemplateFailedItemsHtml(failedItems);

        return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#050b17" style="margin-top:20px;background-color:#050b17;border:1px solid #1f2937;border-collapse:separate;border-radius:18px;overflow:hidden;"><tr><td style="padding:18px 20px;background:${headerBg};font-family:Arial,'Segoe UI',sans-serif;"><div style="font-size:18px;line-height:22px;font-weight:800;color:#ffffff;">${escapeHtml(label)} <span style="color:#cbd5e1;">(${total})</span></div><div style="padding-top:10px;">${chips}</div></td></tr><tr><td style="padding:18px 20px;font-family:Arial,'Segoe UI',sans-serif;">${bodyContent}</td></tr></table>`;
    }).join('');
}

function buildSuiteRowsHtml(state) {
        const suites = (state && state.suites) || {};
        const orderedSuiteKeys = ['app', 'server', 'cert', 'api', 'domain'];

        return orderedSuiteKeys
                .map((key) => {
                        const suite = suites[key] || {};
                        const normalizedStatus = normalizeSuiteStatus(suite.status);
                        const badgeBg = normalizedStatus === 'passed'
                                ? '#e8f7ee'
                                : normalizedStatus === 'failed'
                                        ? '#fdecea'
                                        : '#fff8e6';
                        const badgeColor = normalizedStatus === 'passed'
                                ? '#146c43'
                                : normalizedStatus === 'failed'
                                        ? '#b42318'
                                        : '#8a6d3b';

                        return `<tr>
                            <td style="padding:10px;border:1px solid #e5e7eb;font-size:13px;color:#111827;">${escapeHtml(getSuiteDisplayLabel(key))}</td>
                                <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;">
                                        <span style="display:inline-block;padding:3px 8px;border-radius:999px;background:${badgeBg};color:${badgeColor};font-size:12px;font-weight:600;text-transform:uppercase;">${escapeHtml(normalizedStatus)}</span>
                                </td>
                                <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;font-size:13px;">${Number(suite.total || 0)}</td>
                                <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;font-size:13px;color:#146c43;">${Number(suite.passed || 0)}</td>
                                <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;font-size:13px;color:#b42318;">${Number(suite.failed || 0)}</td>
                                <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;font-size:13px;color:#8a6d3b;">${Number(suite.warning || 0)}</td>
                                <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;font-size:13px;color:#6b7280;">${Number(suite.skipped || 0)}</td>
                        </tr>`;
                })
                .join('');
}

        function buildFailedDetailsRowsHtml(state) {
            const suites = (state && state.suites) || {};
            const orderedSuiteKeys = ['app', 'server', 'cert', 'api', 'domain'];
            const rows = [];

            orderedSuiteKeys.forEach((suiteKey) => {
                const suite = suites[suiteKey] || {};
                const failedCount = Number(suite.failed || 0);
                if (failedCount <= 0) {
                    return;
                }

                const details = Array.isArray(suite.details) ? suite.details : [];
                const failedDetails = details.filter((detail) => {
                    const status = String((detail && detail.status) || '').toLowerCase();
                    return status === 'failed' || status === 'error';
                });

                if (failedDetails.length === 0) {
                    rows.push(`<tr>
                        <td style="padding:10px;border:1px solid #e5e7eb;font-size:13px;">${escapeHtml(getSuiteDisplayLabel(suiteKey))}</td>
                        <td style="padding:10px;border:1px solid #e5e7eb;font-size:13px;">${escapeHtml('Failed checks summary')}</td>
                        <td style="padding:10px;border:1px solid #e5e7eb;font-size:13px;color:#b42318;">${escapeHtml(`Total failed checks: ${failedCount}`)}</td>
                    </tr>`);
                    return;
                }

                failedDetails.forEach((detail) => {
                    const itemName = detail.name || detail.domain || detail.url || 'Unknown check';
                    const reason = detail.reason
                        || detail.message
                        || (detail.responseCode ? `Response code: ${detail.responseCode}` : '')
                        || (detail.expiryDate ? `Expiry: ${detail.expiryDate}` : '')
                        || 'Failed during execution';

                    rows.push(`<tr>
                        <td style="padding:10px;border:1px solid #e5e7eb;font-size:13px;">${escapeHtml(getSuiteDisplayLabel(suiteKey))}</td>
                        <td style="padding:10px;border:1px solid #e5e7eb;font-size:13px;">${escapeHtml(itemName)}</td>
                        <td style="padding:10px;border:1px solid #e5e7eb;font-size:13px;color:#b42318;">${escapeHtml(reason)}</td>
                    </tr>`);
                });
            });

            if (rows.length === 0) {
                return `<tr>
                    <td colspan="3" style="padding:12px;border:1px solid #e5e7eb;font-size:13px;color:#146c43;text-align:center;">No failed checks in this run.</td>
                </tr>`;
            }

            return rows.join('');
        }

        function buildProjectViewRowsHtml() {
            let mapping;
            try {
                mapping = getProjectMapping();
            } catch (error) {
                return `<tr><td colspan="7" style="padding:12px;border:1px solid #e5e7eb;color:#b42318;">Unable to load project mapping for project view.</td></tr>`;
            }

            const projects = Array.isArray(mapping && mapping.projects) ? mapping.projects : [];
            if (projects.length === 0) {
                return `<tr><td colspan="7" style="padding:12px;border:1px solid #e5e7eb;color:#6b7280;">No projects configured.</td></tr>`;
            }

            const rows = projects.map((project) => {
                const app = getAppTestResults(project.id);
                const server = getServerTestResults(project.id);
                const ssl = getSSLTestResults(project.id);
                const domain = getDomainTestResults(project.id);
                const api = getAPITestResults(project.id);

                const total = Number(app.total || 0) + Number(server.total || 0) + Number(ssl.total || 0) + Number(domain.total || 0) + Number(api.total || 0);
                const passed = Number(app.passed || 0) + Number(server.passed || 0) + Number(ssl.passed || 0) + Number(domain.passed || 0) + Number(api.passed || 0);
                const failed = Number(app.failed || 0) + Number(server.failed || 0) + Number(ssl.failed || 0) + Number(domain.failed || 0) + Number(api.failed || 0);
                const warning = Number(app.warning || 0) + Number(server.warning || 0) + Number(ssl.warning || 0) + Number(domain.warning || 0) + Number(api.warning || 0);
                const skipped = Number(app.skipped || 0) + Number(server.skipped || 0) + Number(ssl.skipped || 0) + Number(domain.skipped || 0) + Number(api.skipped || 0);

                const status = failed > 0 ? 'failed' : (warning > 0 ? 'warning' : (skipped > 0 ? 'skipped' : 'passed'));
                const badgeBg = status === 'passed' ? '#e8f7ee' : status === 'failed' ? '#fdecea' : '#fff8e6';
                const badgeColor = status === 'passed' ? '#146c43' : status === 'failed' ? '#b42318' : '#8a6d3b';

                return {
                    sortWeight: failed * 100000 + warning * 1000 + skipped * 100 + total,
                    html: `<tr>
                        <td style="padding:10px;border:1px solid #e5e7eb;font-size:13px;">${escapeHtml(project.name || project.id)}</td>
                        <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;"><span style="display:inline-block;padding:3px 8px;border-radius:999px;background:${badgeBg};color:${badgeColor};font-size:12px;font-weight:600;text-transform:uppercase;">${escapeHtml(status)}</span></td>
                        <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;font-size:13px;">${total}</td>
                        <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;font-size:13px;color:#146c43;">${passed}</td>
                        <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;font-size:13px;color:#b42318;">${failed}</td>
                        <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;font-size:13px;color:#8a6d3b;">${warning}</td>
                        <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;font-size:13px;color:#6b7280;">${skipped}</td>
                    </tr>`
                };
            });

            return rows
                .sort((a, b) => b.sortWeight - a.sortWeight)
                .map((entry) => entry.html)
                .join('');
        }

function buildSummaryEmailHtml(summary, state) {
        const generatedAt = escapeHtml(state && state.generatedAt ? state.generatedAt : new Date().toISOString());
        const passed = Number(summary.passedSuites || 0);
        const failed = Number(summary.failedSuites || 0);
        const warning = Number(summary.warningSuites || 0);
        const skipped = Number(summary.skippedSuites || 0);
        const total = Number(summary.totalSuites || 0);

        return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <div style="max-width:900px;margin:0 auto;padding:24px;">
        <div style="background:#111827;color:#ffffff;border-radius:12px;padding:20px;">
            <h2 style="margin:0 0 8px 0;font-size:22px;">AdHash QA Summary Report</h2>
            <div style="font-size:13px;opacity:0.9;">Generated: ${generatedAt}</div>
        </div>

        <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;margin-top:14px;padding:16px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                <tr>
                    <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;"><div style="font-size:12px;color:#6b7280;">Total Suites</div><div style="font-size:24px;font-weight:700;">${total}</div></td>
                    <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;"><div style="font-size:12px;color:#6b7280;">Passed</div><div style="font-size:24px;font-weight:700;color:#146c43;">${passed}</div></td>
                    <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;"><div style="font-size:12px;color:#6b7280;">Failed</div><div style="font-size:24px;font-weight:700;color:#b42318;">${failed}</div></td>
                    <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;"><div style="font-size:12px;color:#6b7280;">Warning</div><div style="font-size:24px;font-weight:700;color:#8a6d3b;">${warning}</div></td>
                    <td style="padding:10px;border:1px solid #e5e7eb;text-align:center;"><div style="font-size:12px;color:#6b7280;">Skipped</div><div style="font-size:24px;font-weight:700;color:#6b7280;">${skipped}</div></td>
                </tr>
            </table>
        </div>

        <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;margin-top:14px;padding:16px;">
            <h3 style="margin:0 0 12px 0;font-size:18px;">Suite Breakdown</h3>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                <thead>
                    <tr>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:left;font-size:12px;color:#374151;">Suite</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;font-size:12px;color:#374151;">Status</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;font-size:12px;color:#374151;">Total</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;font-size:12px;color:#374151;">Passed</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;font-size:12px;color:#374151;">Failed</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;font-size:12px;color:#374151;">Warning</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;font-size:12px;color:#374151;">Skipped</th>
                    </tr>
                </thead>
                <tbody>
                    ${buildSuiteRowsHtml(state)}
                </tbody>
            </table>
        </div>

        <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;margin-top:14px;padding:16px;">
            <h3 style="margin:0 0 12px 0;font-size:18px;color:#b42318;">Failed Details</h3>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                <thead>
                    <tr>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#fef2f2;text-align:left;font-size:12px;color:#7f1d1d;">Suite</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#fef2f2;text-align:left;font-size:12px;color:#7f1d1d;">Item</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#fef2f2;text-align:left;font-size:12px;color:#7f1d1d;">Reason</th>
                    </tr>
                </thead>
                <tbody>
                    ${buildFailedDetailsRowsHtml(state)}
                </tbody>
            </table>
        </div>

        <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;margin-top:14px;padding:16px;">
            <h3 style="margin:0 0 12px 0;font-size:18px;">Project View</h3>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                <thead>
                    <tr>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:left;font-size:12px;color:#374151;">Project</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;font-size:12px;color:#374151;">Status</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;font-size:12px;color:#374151;">Total</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;font-size:12px;color:#374151;">Passed</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;font-size:12px;color:#374151;">Failed</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;font-size:12px;color:#374151;">Warning</th>
                        <th style="padding:10px;border:1px solid #e5e7eb;background:#f9fafb;text-align:center;font-size:12px;color:#374151;">Skipped</th>
                    </tr>
                </thead>
                <tbody>
                    ${buildProjectViewRowsHtml()}
                </tbody>
            </table>
        </div>

        <div style="padding:10px 4px 0 4px;font-size:12px;color:#6b7280;">
            This email is optimized for mailbox rendering (no script-dependent report layout).
        </div>
    </div>
</body>
</html>`;
}

async function dispatchZohoSummaryMail(state) {
    if (!state) {
        addLog('ℹ️ Zoho mail skipped: no state available.', 'info');
        return;
    }
    if (process.env.ZOHO_MAIL_ENABLED !== 'true') {
        addLog('ℹ️ Zoho mail skipped: ZOHO_MAIL_ENABLED is not true.', 'info');
        return;
    }

    // Reconstruct summary if missing
    let summary = state.summary;
    if (!summary && state.suites) {
        // Aggregate from suite results
        const suiteKeys = Object.keys(state.suites);
        let passed = 0, failed = 0, warning = 0, skipped = 0, total = 0;
        suiteKeys.forEach(k => {
            const s = state.suites[k];
            if (!s) return;
            passed += s.passed || 0;
            failed += s.failed || 0;
            warning += s.warning || 0;
            skipped += s.skipped || 0;
            total += s.total || 0;
        });
        summary = {
            passedSuites: passed,
            failedSuites: failed,
            warningSuites: warning,
            skippedSuites: skipped,
            totalSuites: total
        };
        addLog('⚠️ Summary missing in dashboard state, reconstructed for mail send.', 'warning');
    }
    if (!summary) {
        addLog('❌ Zoho mail not sent: summary missing and could not reconstruct.', 'error');
        return;
    }

    // Use timestamp + counts as dedup key; always include a wall-clock component so
    // repeated runs with the same counts still send (generatedAt changes each run).
    const runTs = state.generatedAt || new Date().toISOString();
    const mailDispatchKey = [runTs, summary.passedSuites || 0, summary.failedSuites || 0, summary.skippedSuites || 0, summary.totalSuites || 0].join('|');
    if (mailDispatchKey === lastMailDispatchKey) {
        addLog('ℹ️ Zoho mail not sent: already sent for this exact run.', 'info');
        return;
    }

    addLog(`📧 Preparing email report (passed:${summary.passedSuites} failed:${summary.failedSuites} total:${summary.totalSuites})...`, 'info');

    // Permanently locked to Email Preview style. Inject live failed-module data at placeholder.
    const emailPreviewCandidates = [
        path.join(__dirname, 'email-preview', 'AdHash-Projects-Dashboard.html'),
        path.join(__dirname, 'email-preview', 'index.html')
    ];
    const emailPreviewPath = emailPreviewCandidates.find((candidate) => fs.existsSync(candidate));

    let html;
    if (emailPreviewPath) {
        addLog(`📄 Using email template: ${emailPreviewPath}`, 'info');
        html = fs.readFileSync(emailPreviewPath, 'utf8');
        if (html.includes('<!--LIVE_FAILED_MODULES-->')) {
            html = html.replace('<!--LIVE_FAILED_MODULES-->', buildFailedModulesHtmlForTemplate(state));
        }
    } else {
        addLog('ℹ️ Email template not found — generating inline summary email.', 'info');
        const dateStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        const suites = (state && state.suites) || {};
        const suiteRows = ['app','server','cert','api','domain'].map(k => {
            const s = suites[k] || {};
            const st = String(s.status||'').toLowerCase();
            const color = st.includes('pass') ? '#059669' : st.includes('fail') ? '#dc2626' : '#d97706';
            return `<tr><td style="padding:8px 12px;border:1px solid #e5e7eb;font-size:13px">${k.toUpperCase()}</td><td style="padding:8px 12px;border:1px solid #e5e7eb;text-align:center;font-weight:700;color:${color}">${s.status||'—'}</td><td style="padding:8px 12px;border:1px solid #e5e7eb;text-align:center">${s.total||0}</td><td style="padding:8px 12px;border:1px solid #e5e7eb;text-align:center;color:#059669">${s.passed||s.pass||0}</td><td style="padding:8px 12px;border:1px solid #e5e7eb;text-align:center;color:#dc2626">${s.failed||s.fail||0}</td></tr>`;
        }).join('');
        html = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:Arial,sans-serif;background:#f1f5f9;margin:0;padding:32px">
<div style="max-width:680px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.1)">
  <div style="background:linear-gradient(135deg,#1e3a5f 0%,#0f172a 100%);padding:28px 32px;color:#fff">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;opacity:.6;margin-bottom:8px">AdHash QA Dashboard</div>
    <div style="font-size:24px;font-weight:800;margin-bottom:6px">Test Run Complete</div>
    <div style="font-size:13px;opacity:.7">${dateStr}</div>
  </div>
  <div style="padding:28px 32px">
    <div style="display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap">
      <div style="flex:1;min-width:120px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px;text-align:center"><div style="font-size:28px;font-weight:800;color:#059669">${summary.passedSuites||0}</div><div style="font-size:11px;color:#059669;font-weight:700;text-transform:uppercase">Passed</div></div>
      <div style="flex:1;min-width:120px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:16px;text-align:center"><div style="font-size:28px;font-weight:800;color:#dc2626">${summary.failedSuites||0}</div><div style="font-size:11px;color:#dc2626;font-weight:700;text-transform:uppercase">Failed</div></div>
      <div style="flex:1;min-width:120px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;text-align:center"><div style="font-size:28px;font-weight:800;color:#475569">${summary.totalSuites||0}</div><div style="font-size:11px;color:#475569;font-weight:700;text-transform:uppercase">Total</div></div>
    </div>
    <table width="100%" style="border-collapse:collapse;font-size:13px;margin-top:8px">
      <thead><tr style="background:#f8fafc"><th style="padding:10px 12px;border:1px solid #e5e7eb;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b">Suite</th><th style="padding:10px 12px;border:1px solid #e5e7eb;text-align:center;font-size:11px;text-transform:uppercase;color:#64748b">Status</th><th style="padding:10px 12px;border:1px solid #e5e7eb;text-align:center;font-size:11px;text-transform:uppercase;color:#64748b">Total</th><th style="padding:10px 12px;border:1px solid #e5e7eb;text-align:center;font-size:11px;text-transform:uppercase;color:#059669">Pass</th><th style="padding:10px 12px;border:1px solid #e5e7eb;text-align:center;font-size:11px;text-transform:uppercase;color:#dc2626">Fail</th></tr></thead>
      <tbody>${suiteRows}</tbody>
    </table>
    ${buildFailedModulesHtmlForTemplate(state)}
  </div>
  <div style="padding:14px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;text-align:center">Generated by AdHash QA Dashboard &nbsp;·&nbsp; ${dateStr}</div>
</div></body></html>`;
    }

    addLog(`📤 Sending via Zoho SMTP to ${process.env.ZOHO_MAIL_TO} from ${process.env.ZOHO_MAIL_FROM}...`, 'info');
    try {
        await sendZohoMail({
            subject: `AdHash QA Report — ${summary.passedSuites} Passed, ${summary.failedSuites} Failed | ${new Date().toLocaleDateString('en-IN')}`,
            html
        });
        lastMailDispatchKey = mailDispatchKey;
        addLog(`✅ Test report email sent to ${process.env.ZOHO_MAIL_TO}`, 'success');
    } catch (err) {
        addLog('❌ Failed to send Zoho Mail: ' + (err && err.message), 'error');
        console.error('Failed to send Zoho Mail:', err);
    }
}

async function recoverCompletedRunFromState() {
    const state = readDashboardState();
    if (!state || !state.summary) {
        return false;
    }

    testResults = {
        status: 'completed',
        totalTests: state.summary.totalSuites,
        passed: state.summary.passedSuites,
        failed: state.summary.failedSuites,
        timestamp: state.generatedAt || new Date().toISOString()
    };

    try {
        await dispatchZohoSummaryMail(state);
    } catch (mailErr) {
        addLog('❌ Failed to send Zoho Mail: ' + (mailErr && mailErr.message), 'error');
        console.error('Failed to send Zoho Mail:', mailErr);
    }

    return true;
}

// API endpoint to check if tests are running
app.get('/api/test-status', async (req, res) => {
    const trackedProcessAlive = Boolean(testProcessRef && testProcessRef.exitCode === null && !testProcessRef.killed);

    // Auto-recover from stuck state: if testRunning is true but process is dead, reset state
    if (testRunning && !trackedProcessAlive && !isProcessRunning(testProcessPid)) {
        console.log('⚠️ Test process is dead but flag is stuck. Auto-resetting state...');
        testRunning = false;
        testProcessPid = null;
        testProcessRef = null;
        currentSuite = null;
        await recoverCompletedRunFromState();
    }

    const persistedState = readDashboardState();
    const hasPersistedResults = !!(persistedState && persistedState.summary);
    const persistedResults = hasPersistedResults ? {
        status: 'completed',
        totalTests: persistedState.summary.totalSuites,
        passed: persistedState.summary.passedSuites,
        failed: persistedState.summary.failedSuites,
        timestamp: persistedState.generatedAt || new Date().toISOString()
    } : null;

    res.json({
        status: testRunning ? 'running' : ((testResults || hasPersistedResults) ? 'completed' : 'idle'),
        running: testRunning,
        hasResults: testResults !== null || hasPersistedResults,
        currentSuite: currentSuite,
        results: testResults || persistedResults
    });
});

// API endpoint to get test results
app.get('/api/test-results', (req, res) => {
    try {
        const state = readDashboardState();
        if (!state || !state.summary) {
            return res.json({ status: 'no-results', message: 'No test results available yet' });
        }
        res.json({
            status: 'completed',
            passedSuites: state.summary.passedSuites,
            failedSuites: state.summary.failedSuites,
            warningSuites: state.summary.warningSuites,
            skippedSuites: state.summary.skippedSuites,
            totalSuites: state.summary.totalSuites
        });
    } catch (error) {
        console.error('Error getting test results:', error);
        res.json({ status: 'error', message: error.message });
    }
});

// API endpoint to get detailed test results per suite
app.get('/api/detailed-results', (req, res) => {
    const detailedResults = createDefaultDetailedResults();

    try {
        const state = readDashboardState();
        if (state && state.suites) {
            Object.assign(detailedResults, state.suites);
        }

        res.json({
            status: 'success',
            results: detailedResults
        });
    } catch (error) {
        console.error('Error parsing detailed results:', error);
        res.json({
            status: 'error',
            message: error.message,
            results: detailedResults
        });
    }
});

// API endpoint to get embedded HTML report for a specific suite
app.get('/api/embedded-report/:suite', (req, res) => {
    const suite = req.params.suite;

    // Map suite names to repository IDs (as they appear in unified dashboard)
    const suiteMapping = {
        'app': 'Adhash_App_Status',
        'server': 'Adhash_AllProjects_Server',
        'cert': 'AdHash_Projects_Certificate_Expiry_Test',
        'api': 'AdHash_API_Test',
        'domain': 'AdHash_Domain_Report'
    };

    const repoName = suiteMapping[suite];
    if (!repoName) {
        return res.status(400).json({ status: 'error', message: 'Invalid suite name' });
    }

    try {
        const unifiedDashboard = path.join(__dirname, 'unified-dashboard', 'index.html');
        if (!fs.existsSync(unifiedDashboard)) {
            return res.status(404).json({ status: 'error', message: 'Unified dashboard not found' });
        }

        const html = fs.readFileSync(unifiedDashboard, 'utf8');

        // Extract the iframe content for this suite
        const iframeRegex = new RegExp(`<div class="detailed-report-container" id="report-${repoName}">[\\s\\S]*?<iframe src="data:text/html;base64,([^"]+)"[\\s\\S]*?<\\/iframe>`, 'i');
        const match = html.match(iframeRegex);

        if (match && match[1]) {
            // Decode the base64 content
            const decodedHtml = Buffer.from(match[1], 'base64').toString('utf8');
            res.send(decodedHtml);
        } else {
            res.status(404).json({ status: 'error', message: 'Report not found for this suite' });
        }
    } catch (error) {
        console.error('Error getting embedded report:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Helper function to add log
function addLog(message, type = 'info') {
    const logEntry = {
        message,
        type,
        timestamp: new Date().toISOString()
    };

    // Add to testLogs for backward compatibility
    testLogs.push(logEntry);

    // Also add to serverLogs so it appears in the UI
    serverLogs.push({
        timestamp: logEntry.timestamp,
        level: type,
        message: message
    });

    // Keep only last MAX_LOGS entries in serverLogs
    if (serverLogs.length > MAX_LOGS) {
        serverLogs.shift();
    }

    console.log(`[${type.toUpperCase()}] ${message}`);
}

// API endpoint to get test logs
app.get('/api/test-logs', (req, res) => {
    const fromIndex = parseInt(req.query.from) || 0;
    const newLogs = testLogs.slice(fromIndex);

    res.json({
        status: 'success',
        logs: newLogs,
        nextIndex: testLogs.length,
        currentSuite: currentSuite
    });
});

// API endpoint to reset test state (for debugging)
app.post('/api/reset-state', (req, res) => {
    console.log('🔄 Resetting test state...');
    testRunning = false;
    testResults = null;
    testLogs = [];
    currentSuite = null;
    testProcessPid = null;
    testProcessRef = null;
    res.json({ status: 'reset', message: 'Test state has been reset' });
});

// API endpoint to run a single test suite
app.post('/api/run-single-suite/:suite', (req, res) => {
    const { exec } = require('child_process');
    const suite = req.params.suite;

    const suiteConfig = WORKSPACE_SUITES[suite];
    if (!suiteConfig) {
        return res.status(400).json({ status: 'error', message: 'Invalid suite name' });
    }

    if (!isSuiteConfigured(suiteConfig)) {
        const message = suiteConfig.unavailableMessage || 'Not configured in current workspace';
        addLog(`⚠️ ${suiteConfig.name}: ${message}`, 'warning');
        return res.status(400).json({ status: 'error', message });
    }

    console.log(`\n🚀 Running ${suiteConfig.name}...`);
    addLog(`🚀 Running ${suiteConfig.name}...`, 'info');

    res.json({ status: 'success', message: `Running ${suiteConfig.name}...` });

    // Regenerate spec files before running this suite
    try { regenerateSpecFiles(); } catch (e) { addLog('⚠️ Spec regeneration warning: ' + e.message, 'warn'); }

    // Run the suite through the workspace-root runner
    const testProcess = exec(`"${process.execPath}" -r ts-node/register run-all-tests.ts --suite ${suite}`, { cwd: __dirname });

    testProcess.stdout.on('data', (data) => {
        console.log(data.toString());
    });

    testProcess.stderr.on('data', (data) => {
        console.error(data.toString());
    });

    testProcess.on('exit', (code) => {
        console.log(`✅ ${suiteConfig.name} completed with code ${code}`);
        addLog(`✅ ${suiteConfig.name} completed`, code === 0 ? 'success' : 'error');
    });
});

// Per-project run state
const projectRunState = {};
// In-memory override: after a per-project run, store live results here so card
// counters update immediately without waiting for a full pipeline run.
// Shape: { [projectId]: { apps, servers, ssl, domains, apis } } — each is a suiteResult
const projectResultOverride = {};
// When true, all get*TestResults functions return empty — set by /api/clear-results
let resultsCleared = false;

// Start tests for a single project
app.post('/api/run-project/:projectId', (req, res) => {
    const { spawn } = require('child_process');
    const { projectId } = req.params;

    const mappingPath = path.join(__dirname, 'config', 'project-mapping.json');
    if (!fs.existsSync(mappingPath)) return res.status(404).json({ error: 'project-mapping.json not found' });
    const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
    const project = (mapping.projects || []).find(p => p.id === projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (projectRunState[projectId] && projectRunState[projectId].running) {
        return res.json({ status: 'already-running', message: 'Tests already running for this project' });
    }

    // Determine which suites have config for this project
    const hasApps    = project.apps    && project.apps.length    > 0;
    const hasServers = project.servers && project.servers.length > 0;
    const hasSsl     = (project.ssl    && project.ssl.length    > 0) || (project.sslCerts && project.sslCerts.length > 0);
    const hasDomains = project.domains && project.domains.length > 0;
    const hasApis    = project.apis    && project.apis.length    > 0;

    const suitesToRun = [
        hasApis    && { label: 'API',    spec: 'tests/api/api-tests.spec.ts',               category: 'apis'    },
        hasServers && { label: 'Server', spec: 'tests/server-health/server-check.spec.ts',  category: 'servers' },
        hasSsl     && { label: 'SSL',    spec: 'tests/certificate/cert-expiry.spec.ts',     category: 'ssl'     },
        hasApps    && { label: 'App',    spec: 'tests/app-status/playstore.spec.ts',        category: 'apps'    },
    ].filter(Boolean);

    // Domain is checked via server-check or a separate check — skip for now if no spec
    const totalSuites = suitesToRun.length || 1;
    resultsCleared = false;
    projectRunState[projectId] = { running: true, message: `Starting tests for ${project.name}…`, passed: 0, failed: 0, warning: 0, skipped: 0, suitesDone: 0, totalSuites };
    res.json({ status: 'started' });

    addLog(`🚀 [${project.name}] Running ${totalSuites} suite(s): ${suitesToRun.map(s=>s.label).join(', ') || 'none'}`, 'info');

    const grepPattern = project.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const suiteResults = {}; // category -> { total, passed, failed, warning, skipped, tests:[] }

    function makeEmptySuiteResult() { return { total: 0, passed: 0, failed: 0, warning: 0, skipped: 0, tests: [] }; }

    // Collect API details for dashboard-state update
    let currentApi = null;
    const collectedApiDetails = [];
    const collectedAppResults = []; // parsed from __APP_RESULT__ markers

    function parseApiLine(line) {
        const apiNameMatch = line.match(/^=== (.+) ===$/);
        const urlMatch     = line.match(/^URL: (.+)$/);
        const methodMatch  = line.match(/^Method: (.+)$/);
        const codeMatch    = line.match(/__API_RESPONSE_CODE__(\d+)/);
        const reqMatch     = line.match(/__API_REQUEST_BODY__(.+)/);
        const respMatch    = line.match(/__API_RESPONSE_BODY__(.+)/);
        if (apiNameMatch) {
            if (currentApi) collectedApiDetails.push(currentApi);
            currentApi = { name: apiNameMatch[1].trim(), url: '', method: 'GET', responseCode: null, requestBody: '', responseBody: '' };
        }
        if (currentApi) {
            if (urlMatch)    currentApi.url    = urlMatch[1].trim();
            if (methodMatch) currentApi.method = methodMatch[1].trim().toUpperCase();
            if (codeMatch)   currentApi.responseCode = parseInt(codeMatch[1]);
            if (reqMatch)  { try { currentApi.requestBody  = Buffer.from(reqMatch[1].trim(),  'base64').toString('utf8'); } catch(_) {} }
            if (respMatch) { try { currentApi.responseBody = Buffer.from(respMatch[1].trim(), 'base64').toString('utf8'); } catch(_) {} }
        }
    }

    function runSuite(suiteIndex) {
        if (suiteIndex >= suitesToRun.length) {
            // All done — finalise
            onAllSuitesDone();
            return;
        }

        const suite = suitesToRun[suiteIndex];
        addLog(`[${project.name}] ▶ Running ${suite.label} suite (${suiteIndex + 1}/${suitesToRun.length})…`, 'info');
        projectRunState[projectId].message = `Running ${suite.label} suite (${suiteIndex + 1}/${suitesToRun.length})…`;

        const suiteResult = makeEmptySuiteResult();
        suiteResults[suite.category] = suiteResult;

        const proc = spawn('npx', [
            'playwright', 'test', suite.spec,
            '--reporter', 'list'
        ], { cwd: __dirname, shell: true, env: { ...process.env, PROJECT_FILTER: projectId } });

        function parseLine(line) {
            const passMatch = line.match(/(\d+)\s+passed/);
            const failMatch = line.match(/(\d+)\s+failed/);
            const skipMatch = line.match(/(\d+)\s+skipped/);
            if (passMatch) suiteResult.passed = parseInt(passMatch[1]);
            if (failMatch) suiteResult.failed = parseInt(failMatch[1]);
            if (skipMatch) suiteResult.skipped = parseInt(skipMatch[1]);
            suiteResult.total = suiteResult.passed + suiteResult.failed + suiteResult.skipped;
            if (suite.category === 'apis') parseApiLine(line);
            if (suite.category === 'apps') {
                const appResultMatch = line.match(/__APP_RESULT__(.+)/);
                if (appResultMatch) {
                    try { collectedAppResults.push(JSON.parse(appResultMatch[1])); } catch(_) {}
                }
            }

            // Parse individual test results from Playwright list reporter lines
            // Format after trim: "✓  1 [chromium] › Describe › Test title  123ms"
            const testLineMatch = line.match(/^(✓|✘|×|✗|-|–)\s+\d+\s+(.*?)(?:\s+\d+(?:\.\d+)?(?:ms|s))?$/);
            if (testLineMatch) {
                const icon = testLineMatch[1];
                // Strip browser tag and describe prefix: "[chromium] › Describe › title" → "title"
                let testTitle = testLineMatch[2].replace(/^\[.*?\]\s*›\s*/, '').trim();
                const lastArrow = testTitle.lastIndexOf(' › ');
                if (lastArrow >= 0) testTitle = testTitle.slice(lastArrow + 3).trim();
                const testStatus = (icon === '✓') ? 'passed' : (icon === '-' || icon === '–') ? 'skipped' : 'failed';
                suiteResult.tests.push({ _title: testTitle, _status: testStatus });
            }
        }

        proc.stdout.on('data', (data) => {
            data.toString().split('\n').filter(l => l.trim()).forEach(line => {
                addLog(`[${project.name}][${suite.label}] ${line}`, 'info');
                if (!line.startsWith('  ') && !line.startsWith('·')) projectRunState[projectId].message = `${suite.label}: ${line.trim().slice(0, 60)}`;
                parseLine(line.trim());
            });
        });
        proc.stderr.on('data', (data) => {
            data.toString().split('\n').filter(l => l.trim()).forEach(line => {
                addLog(`[${project.name}][${suite.label}] ${line}`, 'info');
                parseLine(line.trim());
            });
        });
        proc.on('exit', () => {
            addLog(`[${project.name}] ${suite.label} done — ✅${suiteResult.passed} ❌${suiteResult.failed} ⏭${suiteResult.skipped}`, suiteResult.failed > 0 ? 'error' : 'success');
            projectRunState[projectId].suitesDone = suiteIndex + 1;
            // Update totals incrementally
            projectRunState[projectId].passed  += suiteResult.passed;
            projectRunState[projectId].failed  += suiteResult.failed;
            projectRunState[projectId].skipped += suiteResult.skipped;
            runSuite(suiteIndex + 1);
        });
    }

    function onAllSuitesDone() {
        if (currentApi) collectedApiDetails.push(currentApi);

        // Classify API details
        collectedApiDetails.forEach(d => {
            const code = d.responseCode;
            if (code === null) { d.status = 'failed'; return; }
            d.status = code >= 200 && code < 300 ? 'passed' : code >= 300 && code < 400 ? 'warning' : 'failed';
        });

        // Update dashboard-state.json with fresh API details
        if (collectedApiDetails.length > 0) {
            try {
                const state = fs.existsSync(DASHBOARD_STATE_PATH) ? JSON.parse(fs.readFileSync(DASHBOARD_STATE_PATH, 'utf8')) : { suites: {} };
                if (!state.suites) state.suites = {};
                if (!state.suites.api) state.suites.api = { details: [] };
                if (!Array.isArray(state.suites.api.details)) state.suites.api.details = [];
                const projectApiNames = new Set((project.apis || []).map(a => String(a.name || '').toLowerCase().trim()));
                state.suites.api.details = state.suites.api.details.filter(d => !projectApiNames.has(String(d.name || '').toLowerCase().trim()));
                state.suites.api.details.push(...collectedApiDetails);
                // Do NOT update generatedAt — that would bust the shared SSL/domain cache for all projects
                fs.mkdirSync(path.dirname(DASHBOARD_STATE_PATH), { recursive: true });
                fs.writeFileSync(DASHBOARD_STATE_PATH, JSON.stringify(state, null, 2));
            } catch (e) {
                addLog(`⚠️ [${project.name}] Could not update dashboard state: ${e.message}`, 'warn');
            }
        }

        // Enrich parsed tests[] with structured data from project config
        function enrichSuiteTests() {
            // Servers
            if (suiteResults['servers']) {
                const rawTests = suiteResults['servers'].tests || [];
                suiteResults['servers'].tests = (project.servers || []).map((srv) => {
                    const name = srv.name || '';
                    const matched = rawTests.find(t => t._title && t._title.toLowerCase().includes(name.toLowerCase()));
                    const status = matched ? matched._status : (suiteResults['servers'].failed > 0 ? 'failed' : 'passed');
                    return { name, url: srv.url || '', status, type: srv.type || 'service' };
                });
            }
            // SSL — cert data populated separately in fetchSslCertData()
            if (suiteResults['ssl'] && !suiteResults['ssl']._certEnriched) {
                const rawTests = suiteResults['ssl'].tests || [];
                const sslList = (project.ssl && project.ssl.length > 0) ? project.ssl : (project.sslCerts || []);
                suiteResults['ssl'].tests = sslList.map((entry) => {
                    const hostname = String(entry).replace(/^https?:\/\//i,'').split('/')[0].toLowerCase();
                    const matched = rawTests.find(t => t._title && t._title.toLowerCase().includes(hostname));
                    const status = matched ? matched._status : (suiteResults['ssl'].failed > 0 ? 'failed' : 'passed');
                    return { name: hostname, url: `https://${hostname}`, status, daysRemaining: null, expiryDate: null, expiryDateIST: null };
                });
            }
            // Apps — build full store URLs, use per-test status from Playwright output
            if (suiteResults['apps']) {
                suiteResults['apps'].tests = (project.apps || []).flatMap((app) => {
                    const items = [];
                    if (app.playStore) {
                        const raw = String(app.playStore).trim();
                        const url = /^https?:\/\//i.test(raw) ? raw : `https://play.google.com/store/apps/details?id=${raw}`;
                        const result = collectedAppResults.find(r =>
                            r.appName === app.name && r.platform === 'Play Store');
                        items.push({ name: app.name, url, status: result ? result.status : 'skipped', platform: 'Play Store' });
                    }
                    if (app.appStore) {
                        const raw = String(app.appStore).trim();
                        const url = /^https?:\/\//i.test(raw) ? raw : `https://apps.apple.com/app/${raw.startsWith('id') ? raw : 'id' + raw}`;
                        const result = collectedAppResults.find(r =>
                            r.appName === app.name && r.platform === 'App Store');
                        items.push({ name: app.name, url, status: result ? result.status : 'skipped', platform: 'App Store' });
                    }
                    return items;
                });
            }
            // APIs — populate from collectedApiDetails (parsed from spec stdout)
            if (suiteResults['apis']) {
                if (collectedApiDetails.length > 0) {
                    suiteResults['apis'].tests = collectedApiDetails.map(d => ({
                        name: d.name,
                        url: d.url,
                        method: d.method || 'GET',
                        status: d.status || 'failed',
                        responseCode: d.responseCode,
                        requestBody: d.requestBody || '',
                        responseBody: d.responseBody || ''
                    }));
                } else {
                    // No stdout markers parsed — synthesize from project config with overall pass/fail
                    suiteResults['apis'].tests = (project.apis || []).map(api => ({
                        name: api.name || '',
                        url: api.url || '',
                        method: (api.method || 'GET').toUpperCase(),
                        status: suiteResults['apis'].failed > 0 ? 'failed' : 'passed',
                        responseCode: null,
                        requestBody: '',
                        responseBody: ''
                    }));
                }
            }
        }

        // Fetch SSL certificate expiry data inline using raw tls.connect
        function fetchSslCertData(callback) {
            if (!suiteResults['ssl']) { callback(); return; }
            const tlsMod = require('tls');
            const sslList = (project.ssl && project.ssl.length > 0) ? project.ssl : (project.sslCerts || []);

            function parseCertFields(cert) {
                if (!cert || !cert.valid_to) return { daysRemaining: null, expiryDate: null, expiryDateIST: null, certStatus: 'failed' };
                const validTo = new Date(cert.valid_to);
                const daysRemaining = Math.ceil((validTo.getTime() - Date.now()) / 86400000);
                const expiryDate = validTo.toUTCString();
                const istOffset = 5.5 * 60 * 60000;
                const expiryDateIST = new Date(validTo.getTime() + istOffset).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' IST');
                const certStatus = daysRemaining > 7 ? 'passed' : daysRemaining > 0 ? 'warning' : 'failed';
                return { daysRemaining, expiryDate, expiryDateIST, certStatus };
            }

            // Pre-build tests array
            suiteResults['ssl'].tests = sslList.map(e => {
                const h = String(e).replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
                return { name: h, url: `https://${h}`, status: 'passed', daysRemaining: null, expiryDate: null, expiryDateIST: null };
            });

            function checkCert(index) {
                if (index >= sslList.length) {
                    suiteResults['ssl']._certEnriched = true;
                    callback();
                    return;
                }
                const hostname = String(sslList[index]).replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
                let done = false;

                const tlsSocket = tlsMod.connect(
                    { host: hostname, port: 443, rejectUnauthorized: false, servername: hostname },
                    () => {
                        if (done) return;
                        done = true;
                        const cert = tlsSocket.getPeerCertificate();
                        tlsSocket.destroy();
                        const { daysRemaining, expiryDate, expiryDateIST, certStatus } = parseCertFields(cert);
                        const idx = suiteResults['ssl'].tests.findIndex(t => t.name === hostname);
                        const entry = { name: hostname, url: `https://${hostname}`, status: certStatus, daysRemaining, expiryDate, expiryDateIST };
                        if (idx >= 0) suiteResults['ssl'].tests[idx] = entry; else suiteResults['ssl'].tests.push(entry);
                        checkCert(index + 1);
                    }
                );
                tlsSocket.setTimeout(8000, () => {
                    if (done) return;
                    done = true;
                    tlsSocket.destroy();
                    const idx = suiteResults['ssl'].tests.findIndex(t => t.name === hostname);
                    const entry = { name: hostname, url: `https://${hostname}`, status: 'warning', daysRemaining: null, expiryDate: null, expiryDateIST: null, reason: 'Unreachable from this machine (TCP timeout)' };
                    if (idx >= 0) suiteResults['ssl'].tests[idx] = entry; else suiteResults['ssl'].tests.push(entry);
                    checkCert(index + 1);
                });
                tlsSocket.on('error', (err) => {
                    if (done) return;
                    done = true;
                    tlsSocket.destroy();
                    const idx = suiteResults['ssl'].tests.findIndex(t => t.name === hostname);
                    const entry = { name: hostname, url: `https://${hostname}`, status: 'warning', daysRemaining: null, expiryDate: null, expiryDateIST: null, reason: `Unreachable: ${err.message}` };
                    if (idx >= 0) suiteResults['ssl'].tests[idx] = entry; else suiteResults['ssl'].tests.push(entry);
                    checkCert(index + 1);
                });
            }
            checkCert(0);
        }

        // Inline domain availability check (no Playwright spec exists for domains)
        function finalizeSuites() {
            enrichSuiteTests();
            // Build override results for each category so card counters update immediately
            const override = {};
            for (const [category, result] of Object.entries(suiteResults)) {
                override[category] = result;
            }
            projectResultOverride[projectId] = { ...projectResultOverride[projectId], ...override };

            const { passed, failed, skipped } = projectRunState[projectId];
            projectRunState[projectId] = { running: false, passed, failed, warning: 0, skipped };
            addLog(`✅ [${project.name}] All suites complete — Passed: ${passed}, Failed: ${failed}, Skipped: ${skipped}`, failed > 0 ? 'error' : 'success');
        }

        // Fetch SSL cert expiry data, then proceed to domain check / finalize
        fetchSslCertData(() => {
            if (!hasDomains) {
                finalizeSuites();
                return;
            }

        const tlsNode = require('tls');
        const domainList = project.domains || [];
        addLog(`[${project.name}] ▶ Running Domain check for ${domainList.length} domain(s)…`, 'info');
        projectRunState[projectId].message = `Running Domain check…`;

        const domainResult = { total: domainList.length, passed: 0, failed: 0, warning: 0, skipped: 0, tests: [] };

        function parseCertExpiry(cert) {
            if (!cert || !cert.valid_to) return { daysRemaining: null, expiryDate: null, expiryDateIST: null };
            const validTo = new Date(cert.valid_to);
            const daysRemaining = Math.ceil((validTo.getTime() - Date.now()) / 86400000);
            const expiryDate = validTo.toUTCString();
            const istOffset = 5.5 * 60 * 60000;
            const expiryDateIST = new Date(validTo.getTime() + istOffset).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' IST');
            return { daysRemaining, expiryDate, expiryDateIST };
        }

        // HTTP fallback: check if domain is reachable on port 80 when HTTPS/TLS unavailable
        function httpReachabilityCheck(hostname, url, onResult) {
            const httpMod = require('http');
            let done = false;
            const req = httpMod.request({ host: hostname, port: 80, method: 'HEAD', path: '/', timeout: 8000 }, (res) => {
                if (done) return; done = true; req.destroy();
                const reachable = res.statusCode >= 200 && res.statusCode < 600;
                onResult(reachable);
            });
            req.on('timeout', () => { if (done) return; done = true; req.destroy(); onResult(false); });
            req.on('error', () => { if (done) return; done = true; onResult(false); });
            req.end();
        }

        function checkDomain(index) {
            if (index >= domainList.length) {
                suiteResults['domains'] = domainResult;
                projectRunState[projectId].passed += domainResult.passed;
                projectRunState[projectId].failed += domainResult.failed;
                addLog(`[${project.name}] Domain done — ✅${domainResult.passed} ❌${domainResult.failed}`, domainResult.failed > 0 ? 'error' : 'success');
                finalizeSuites();
                return;
            }

            const rawDomain = domainList[index];
            const hostname = rawDomain.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
            const url = `https://${hostname}`;
            let done = false;

            function onTlsFail(reason) {
                // Try www.{hostname} as fallback — many bare domains have cert on www
                const wwwHost = hostname.startsWith('www.') ? null : `www.${hostname}`;
                if (wwwHost) {
                    let wwwDone = false;
                    const wwwSocket = tlsNode.connect(
                        { host: wwwHost, port: 443, rejectUnauthorized: false, servername: wwwHost },
                        () => {
                            if (wwwDone) return; wwwDone = true;
                            const cert = wwwSocket.getPeerCertificate();
                            wwwSocket.destroy();
                            const { daysRemaining, expiryDate, expiryDateIST } = parseCertExpiry(cert);
                            const certStatus = daysRemaining === null ? 'passed' : daysRemaining > 7 ? 'passed' : daysRemaining > 0 ? 'warning' : 'failed';
                            if (certStatus === 'passed') domainResult.passed++;
                            else if (certStatus === 'warning') { domainResult.warning++; domainResult.passed++; }
                            else domainResult.failed++;
                            domainResult.tests.push({ name: hostname, url, status: certStatus, daysRemaining, expiryDate, expiryDateIST });
                            addLog(`[${project.name}][Domain] ${hostname} (via ${wwwHost}) cert ${daysRemaining !== null ? daysRemaining + 'd' : 'unknown'} ✅`, 'info');
                            checkDomain(index + 1);
                        }
                    );
                    wwwSocket.setTimeout(6000, () => {
                        if (wwwDone) return; wwwDone = true; wwwSocket.destroy();
                        // www also failed — fall back to HTTP reachability, no cert dates
                        httpReachabilityCheck(hostname, url, (reachable) => {
                            if (reachable) {
                                domainResult.passed++;
                                domainResult.tests.push({ name: hostname, url: `http://${hostname}`, status: 'passed', daysRemaining: null, expiryDate: null, expiryDateIST: null });
                                addLog(`[${project.name}][Domain] ${hostname} → reachable via HTTP only ✅`, 'info');
                            } else {
                                domainResult.failed++;
                                domainResult.tests.push({ name: hostname, url, status: 'failed', daysRemaining: null, expiryDate: null, expiryDateIST: null, error: reason });
                                addLog(`[${project.name}][Domain] ${hostname} → unreachable ❌`, 'error');
                            }
                            checkDomain(index + 1);
                        });
                    });
                    wwwSocket.on('error', () => {
                        if (wwwDone) return; wwwDone = true; wwwSocket.destroy();
                        httpReachabilityCheck(hostname, url, (reachable) => {
                            if (reachable) {
                                domainResult.passed++;
                                domainResult.tests.push({ name: hostname, url: `http://${hostname}`, status: 'passed', daysRemaining: null, expiryDate: null, expiryDateIST: null });
                                addLog(`[${project.name}][Domain] ${hostname} → reachable via HTTP only ✅`, 'info');
                            } else {
                                domainResult.failed++;
                                domainResult.tests.push({ name: hostname, url, status: 'failed', daysRemaining: null, expiryDate: null, expiryDateIST: null, error: reason });
                                addLog(`[${project.name}][Domain] ${hostname} → unreachable ❌`, 'error');
                            }
                            checkDomain(index + 1);
                        });
                    });
                } else {
                    // Already a www domain — go straight to HTTP fallback
                    httpReachabilityCheck(hostname, url, (reachable) => {
                        if (reachable) {
                            domainResult.passed++;
                            domainResult.tests.push({ name: hostname, url: `http://${hostname}`, status: 'passed', daysRemaining: null, expiryDate: null, expiryDateIST: null });
                            addLog(`[${project.name}][Domain] ${hostname} → reachable via HTTP only ✅`, 'info');
                        } else {
                            domainResult.failed++;
                            domainResult.tests.push({ name: hostname, url, status: 'failed', daysRemaining: null, expiryDate: null, expiryDateIST: null, error: reason });
                            addLog(`[${project.name}][Domain] ${hostname} → unreachable ❌`, 'error');
                        }
                        checkDomain(index + 1);
                    });
                }
            }

            // Use raw tls.connect to reliably get the peer certificate
            const tlsSocket = tlsNode.connect(
                { host: hostname, port: 443, rejectUnauthorized: false, servername: hostname },
                () => {
                    if (done) return;
                    done = true;
                    const cert = tlsSocket.getPeerCertificate();
                    tlsSocket.destroy();
                    const { daysRemaining, expiryDate, expiryDateIST } = parseCertExpiry(cert);
                    const certStatus = daysRemaining === null ? 'passed' : daysRemaining > 7 ? 'passed' : daysRemaining > 0 ? 'warning' : 'failed';
                    if (certStatus === 'passed') domainResult.passed++;
                    else if (certStatus === 'warning') { domainResult.warning++; domainResult.passed++; }
                    else domainResult.failed++;
                    domainResult.tests.push({ name: hostname, url, status: certStatus, daysRemaining, expiryDate, expiryDateIST });
                    addLog(`[${project.name}][Domain] ${hostname} cert ${daysRemaining !== null ? daysRemaining + 'd' : 'unknown'} ${certStatus === 'failed' ? '❌' : certStatus === 'warning' ? '⚠️' : '✅'}`, certStatus === 'failed' ? 'error' : 'info');
                    checkDomain(index + 1);
                }
            );
            tlsSocket.setTimeout(8000, () => {
                if (done) return;
                done = true;
                tlsSocket.destroy();
                onTlsFail('TLS timeout');
            });
            tlsSocket.on('error', (err) => {
                if (done) return;
                done = true;
                tlsSocket.destroy();
                onTlsFail(err.message);
            });
        }

        checkDomain(0);
        }); // end fetchSslCertData callback
    }

    if (suitesToRun.length === 0) {
        projectRunState[projectId] = { running: false, passed: 0, failed: 0, warning: 0, skipped: 0 };
        addLog(`⚠️ [${project.name}] No testable suites configured`, 'warn');
        return;
    }

    runSuite(0);
});

// Protected keys that must never be exposed or overwritten via the secrets UI
const PROTECTED_ENV_KEYS = new Set(['GITHUB_TOKEN','ZOHO_MAIL_PASS','ZOHO_MAIL_USER','ZOHO_MAIL_FROM','ZOHO_MAIL_TO','ZOHO_MAIL_ENABLED','ZOHO_MAIL_CC','ZOHO_CLIENT_ID','ZOHO_CLIENT_SECRET','ZOHO_REFRESH_TOKEN','ZOHO_ACCOUNT_ID','SLACK_BOT_TOKEN','SLACK_CHANNEL','SLACK_ENABLED']);

function readEnvFile() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return {};
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    const result = {};
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        result[key] = val;
    }
    return result;
}

function writeEnvFile(vars) {
    const envPath = path.join(__dirname, '.env');
    const lines = Object.entries(vars).map(([k, v]) => {
        const needsQuotes = /[\s#"']/.test(v);
        return `${k}=${needsQuotes ? `"${v.replace(/"/g, '\\"')}"` : v}`;
    });
    fs.writeFileSync(envPath, lines.join('\n') + '\n');
}

// GET /api/env-secrets — return non-protected env vars
app.get('/api/env-secrets', (req, res) => {
    const all = readEnvFile();
    const secrets = {};
    for (const [k, v] of Object.entries(all)) {
        if (!PROTECTED_ENV_KEYS.has(k)) secrets[k] = v;
    }
    res.json({ secrets });
});

// POST /api/env-secrets — merge new values into .env (protected keys untouched)
app.post('/api/env-secrets', (req, res) => {
    const { secrets } = req.body || {};
    if (!secrets || typeof secrets !== 'object') return res.status(400).json({ error: 'Invalid payload' });
    const existing = readEnvFile();
    // Merge: keep protected keys, overwrite/add rest
    const merged = { ...existing };
    for (const [k, v] of Object.entries(secrets)) {
        if (PROTECTED_ENV_KEYS.has(k)) continue; // silently skip protected keys
        if (k) merged[k] = v;
    }
    try {
        writeEnvFile(merged);
        // Reload into current process.env so next test run picks them up immediately
        for (const [k, v] of Object.entries(merged)) {
            if (!PROTECTED_ENV_KEYS.has(k)) process.env[k] = v;
        }
        addLog('⚙️ .env secrets updated', 'info');
        res.json({ status: 'saved' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Clear all cached per-project run results
app.post('/api/clear-results', (req, res) => {
    // Wipe in-memory override cache
    for (const key of Object.keys(projectResultOverride)) delete projectResultOverride[key];
    for (const key of Object.keys(projectRunState)) delete projectRunState[key];
    // Wipe suite row cache so HTML report data is not served from memory
    suiteConfigCache.apps = null;
    suiteConfigCache.certificates = null;
    suiteConfigCache.apis = null;
    suiteConfigCache.domains = null;
    suiteConfigCache.domainsCacheKey = null;
    suiteConfigCache.ssl = null;
    suiteConfigCache.sslCacheKey = null;
    suiteConfigCache.suiteRows = {};
    suiteConfigCache.suiteRowMtimes = {};
    // Clear dashboard-state.json
    try {
        fs.mkdirSync(path.dirname(DASHBOARD_STATE_PATH), { recursive: true });
        fs.writeFileSync(DASHBOARD_STATE_PATH, JSON.stringify({ suites: {}, generatedAt: new Date().toISOString() }, null, 2));
    } catch (e) { /* ignore */ }
    // Delete suite HTML report files so readSuiteRows returns empty
    const suiteReportsDir = path.join(__dirname, 'suite-reports');
    try {
        if (fs.existsSync(suiteReportsDir)) {
            fs.readdirSync(suiteReportsDir).forEach(f => {
                try { fs.unlinkSync(path.join(suiteReportsDir, f)); } catch (_) {}
            });
        }
    } catch (e) { /* ignore */ }
    resultsCleared = true;
    addLog('🗑️ All project results cleared', 'info');
    res.json({ status: 'cleared' });
});

// Poll status for a single project run
app.get('/api/run-project/:projectId/status', (req, res) => {
    const { projectId } = req.params;
    const state = projectRunState[projectId];
    if (!state) return res.json({ running: false, passed: 0, failed: 0, warning: 0, skipped: 0 });
    res.json(state);
});

// API endpoint to trigger test run
app.post('/api/run-tests', (req, res) => {
    const { spawn } = require('child_process');

    if (testRunning) {
        return res.json({ status: 'already-running', message: 'Tests are already running' });
    }

    console.log('\n🚀 Starting test execution...');
    resultsCleared = false;
    testRunning = true;
    testResults = null;
    testLogs = [];
    currentSuite = null;
    testProcessPid = null;
    testProcessRef = null;

    res.json({ status: 'started', message: 'Tests are running in the background...' });

    // Regenerate spec files from latest project-mapping.json before running
    try { regenerateSpecFiles(); } catch (e) { addLog('⚠️ Spec regeneration warning: ' + e.message, 'warn'); }

    addLog('🚀 Starting sequential test execution...', 'info');
    addLog('📋 Running configured suites, including external domain monitoring...', 'info');
    // Run the unified test framework with streaming output (no exec buffer cap)
    const testProcess = spawn(process.execPath, ['-r', 'ts-node/register', 'run-all-tests.ts'], {
        cwd: __dirname,
        shell: false
    });

    // Store the process PID for state recovery
    testProcessPid = testProcess.pid;
    testProcessRef = testProcess;
    console.log(`📌 Test process started with PID: ${testProcessPid}`);

    // Capture stdout in real-time
    testProcess.stdout.on('data', (data) => {
        const output = data.toString();
        console.log(output);

        // Parse output to detect which suite is running
        if (output.includes('Running App Status Tests')) {
            currentSuite = 'app-status';
            addLog('🚀 Starting App Status Verification tests...', 'running');
        } else if (output.includes('Running Server Health Tests')) {
            currentSuite = 'server-health';
            addLog('🚀 Starting Server Health Monitoring tests...', 'running');
        } else if (output.includes('Running Certificate Expiry Tests')) {
            currentSuite = 'ssl-cert';
            addLog('🚀 Starting SSL Certificate Monitoring tests...', 'running');
        } else if (output.includes('Running API Tests')) {
            currentSuite = 'api-test';
            addLog('🚀 Starting API Endpoint Testing tests...', 'running');
        } else if (output.includes('Domain Expiry Monitoring is not configured in current workspace')) {
            addLog('⚠️ Domain Expiry Monitoring is not configured in current workspace', 'warning');
        }

        // Log npm install progress
        if (output.includes('npm install') || output.includes('added') || output.includes('packages')) {
            addLog(`📦 Installing dependencies (using cache)...`, 'info');
        }

        // Log test progress
        if (output.includes('PASS') || output.includes('✓') || output.includes('✅')) {
            addLog(`✅ ${output.trim()}`, 'success');
        } else if (output.includes('FAIL') || output.includes('✗') || output.includes('❌')) {
            addLog(`❌ ${output.trim()}`, 'error');
        } else if (output.trim().length > 0 && !output.includes('[') && !output.includes('npm WARN')) {
            addLog(output.trim(), 'info');
        }
    });

    // Capture stderr
    testProcess.stderr.on('data', (data) => {
        const error = data.toString();
        if (error.trim().length > 0) {
            addLog(`⚠️ ${error.trim()}`, 'warning');
        }
    });

    // Function to parse and finalize results
    const finalizeResults = async (code) => {
        if (!testRunning) return; // Already finalized

        testRunning = false;
        currentSuite = null;
        testProcessPid = null;
        testProcessRef = null;

        // Clear stale suite-row and suite-config caches so next API read uses fresh data
        suiteConfigCache.apps = null;
        suiteConfigCache.certificates = null;
        suiteConfigCache.apis = null;
        suiteConfigCache.domains = null;
        suiteConfigCache.domainsCacheKey = null;
        suiteConfigCache.ssl = null;
        suiteConfigCache.sslCacheKey = null;
        suiteConfigCache.suiteRows = {};
        suiteConfigCache.suiteRowMtimes = {};

        if (code !== 0) {
            addLog(`⚠️ Test process exited with code ${code}`, 'warning');
        } else {
            addLog('✅ All tests completed successfully!', 'success');
        }

        addLog('📊 Parsing test results...', 'info');

        let state = readDashboardState();
        if (!state || !state.summary) {
            // Allow state writer a few extra seconds after child process close.
            for (let attempt = 0; attempt < 5; attempt++) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
                state = readDashboardState();
                if (state && state.summary) {
                    break;
                }
            }
        }
        if (state && state.summary) {
            try {
                testResults = {
                    status: 'completed',
                    totalTests: state.summary.totalSuites,
                    passed: state.summary.passedSuites,
                    failed: state.summary.failedSuites,
                    timestamp: new Date().toISOString()
                };

                addLog(`📊 Results: ${state.summary.passedSuites} passed, ${state.summary.failedSuites} failed, ${state.summary.skippedSuites} skipped`, state.summary.failedSuites === 0 ? 'success' : 'warning');
                console.log('✅ Test results parsed and stored:', testResults);

                // --- Generate email-preview HTML (needed for View Report button and Zoho mail) ---
                try {
                    addLog('📄 Generating email report preview...', 'info');
                    await new Promise((resolve, reject) => {
                        const { spawn: spawnChild } = require('child_process');
                        const regen = spawnChild(process.execPath, ['-r', 'ts-node/register', 'regenerate-dashboard.ts'], {
                            cwd: __dirname,
                            shell: false,
                            env: { ...process.env, ZOHO_MAIL_ENABLED: 'false' }
                        });
                        regen.stdout.on('data', (d) => console.log('[regen]', d.toString().trim()));
                        regen.stderr.on('data', (d) => console.error('[regen-err]', d.toString().trim()));
                        regen.on('close', (code) => {
                            if (code === 0) {
                                addLog('✅ Email report preview generated.', 'success');
                                resolve();
                            } else {
                                addLog('⚠️ Email preview generation exited with code ' + code, 'warning');
                                resolve(); // don't block mail send on this
                            }
                        });
                        regen.on('error', (err) => {
                            addLog('⚠️ Could not run regenerate-dashboard: ' + err.message, 'warning');
                            resolve();
                        });
                    });
                } catch (regenErr) {
                    addLog('⚠️ Email preview generation error: ' + (regenErr && regenErr.message), 'warning');
                }
                // --- End email preview generation ---

                // --- Send Zoho Mail if enabled ---
                try {
                    // Re-read state after regeneration in case it was updated
                    const freshState = readDashboardState() || state;
                    await dispatchZohoSummaryMail(freshState);
                } catch (mailErr) {
                    addLog('❌ Failed to send Zoho Mail: ' + (mailErr && mailErr.message), 'error');
                    console.error('Failed to send Zoho Mail:', mailErr);
                }
                // --- End Zoho Mail ---

            } catch (parseError) {
                console.error('Error parsing results:', parseError);
                addLog('⚠️ Could not parse test results', 'warning');
                testResults = {
                    status: 'completed',
                    message: 'Tests completed but could not parse results',
                    timestamp: new Date().toISOString()
                };
            }
        } else {
            addLog('❌ Dashboard file not found', 'error');
            testResults = {
                status: 'error',
                message: 'Dashboard file not generated',
                timestamp: new Date().toISOString()
            };
        }
    };

    // Handle exit event (fires when process exits, before streams close)
    testProcess.on('exit', (code) => {
        console.log(`📤 Test process exited with code ${code}`);
        // Wait a bit for streams to flush, then finalize
        setTimeout(() => finalizeResults(code), 2000);
    });

    // Handle close event (fires when all streams are closed)
    testProcess.on('close', (code) => {
        console.log(`🔒 Test process closed with code ${code}`);
        finalizeResults(code);
    });

    testProcess.on('error', (err) => {
        addLog(`❌ Test process spawn error: ${err.message}`, 'error');
        finalizeResults(1);
    });
});

// API endpoint to get all projects
app.get('/api/projects', (req, res) => {
    try {
        const projectMappingPath = path.join(__dirname, 'config', 'project-mapping.json');
        if (!fs.existsSync(projectMappingPath)) {
            return res.status(404).json({ projects: [], error: 'Project mapping not found' });
        }

        const projectData = JSON.parse(fs.readFileSync(projectMappingPath, 'utf8'));
        attachProjectDomainStatuses(projectData.projects || [], readDashboardState());
        attachProjectSslDetails(projectData.projects || [], readDashboardState());
        attachProjectServerStatuses(projectData.projects || []);
        attachLatestProjectApiResults(projectData.projects || []);
        res.json({ projects: projectData.projects || [] });
    } catch (error) {
        console.error('Error loading projects:', error);
        res.status(500).json({ projects: [], error: 'Failed to load projects' });
    }
});

// API endpoint to get a specific project
app.get('/api/project/:id', (req, res) => {
    try {
        const projectMappingPath = path.join(__dirname, 'config', 'project-mapping.json');
        if (!fs.existsSync(projectMappingPath)) {
            return res.status(404).json({ error: 'Project mapping not found' });
        }

        const projectData = JSON.parse(fs.readFileSync(projectMappingPath, 'utf8'));
        attachProjectDomainStatuses(projectData.projects || [], readDashboardState());
        attachProjectSslDetails(projectData.projects || [], readDashboardState());
        attachProjectServerStatuses(projectData.projects || []);
        attachLatestProjectApiResults(projectData.projects || []);
        const project = projectData.projects.find(p => p.id === req.params.id);

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        res.json(project);
    } catch (error) {
        console.error('Error loading project:', error);
        res.status(500).json({ error: 'Failed to load project' });
    }
});

// API endpoint to get server logs
app.get('/api/logs', (req, res) => {
    try {
        // Return last 50 logs
        const recentLogs = serverLogs.slice(-50);
        res.json({
            logs: recentLogs,
            message: recentLogs.length > 0 ? 'Logs loaded successfully' : 'No logs available'
        });
    } catch (error) {
        console.error('Error fetching logs:', error);
        res.status(500).json({ logs: [], message: 'No logs available', error: 'Failed to fetch logs' });
    }
});

// API endpoint to get project details
app.get('/api/project/:id', (req, res) => {
    try {
        const projectId = req.params.id;
        const projectMapping = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'project-mapping.json'), 'utf8'));
        attachProjectDomainStatuses(projectMapping.projects || [], readDashboardState());
        attachProjectSslDetails(projectMapping.projects || [], readDashboardState());
        attachLatestProjectApiResults(projectMapping.projects || []);
        const project = projectMapping.projects.find(p => p.id === projectId);

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        res.json(project);
    } catch (error) {
        console.error('Error fetching project details:', error);
        res.status(500).json({ error: 'Failed to fetch project details' });
    }
});

// Load project mapping
function getProjectMapping() {
    try {
        const mappingPath = path.join(__dirname, 'config', 'project-mapping.json');
        const data = fs.readFileSync(mappingPath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error loading project mapping:', error);
        return { projects: [] };
    }
}

function attachLatestProjectApiResults(projects) {
    const latestApiResults = readLatestApiResultsPayload(__dirname);
    const apiResultByProjectId = new Map(((latestApiResults && latestApiResults.projects) || []).map((project) => [project.id, project.results && project.results.apis]));

    (projects || []).forEach((project) => {
        const latestApiSummary = apiResultByProjectId.get(project.id);
        if (!latestApiSummary) {
            return;
        }

        project.results = {
            ...(project.results || {}),
            apis: {
                total: latestApiSummary.total,
                passed: latestApiSummary.passed,
                failed: latestApiSummary.failed,
                warning: latestApiSummary.warning,
                skipped: latestApiSummary.skipped,
                source: latestApiSummary.source || 'latest-run'
            }
        };
    });
}

const suiteConfigCache = {
    apps: null,
    certificates: null,
    apis: null,
    domains: null,
    domainsCacheKey: null,
    ssl: null,
    sslCacheKey: null,
    suiteRows: {},
    suiteRowMtimes: {}
};

const SKIPPED_SERVER_URL_FRAGMENT = '20.62.109.239';
const SKIPPED_SERVER_NAME = 'AutoChecker - PartSouq';
const SKIPPED_SERVER_MESSAGE = 'Skipped by QA (known issue / external dependency)';

function normalizeText(value) {
    return (value || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeUrl(value) {
    return (value || '').toString().trim().replace(/\/+$/, '').toLowerCase();
}

function normalizeApiMethod(value) {
    return (value || 'GET').toString().trim().toUpperCase();
}

function normalizeApiName(value) {
    return normalizeText((value || '').toString().trim());
}

function buildApiStableKey(method, url, name) {
    return `${normalizeApiMethod(method)}::${normalizeUrl(url)}::${normalizeApiName(name)}`;
}

function isSkippedServerDefinition(server) {
    return Boolean(server && ((server.name || '') === SKIPPED_SERVER_NAME || String(server.url || '').includes(SKIPPED_SERVER_URL_FRAGMENT)));
}

function buildSkippedServerResult(server) {
    return {
        name: server.name,
        url: server.url || '#',
        type: 'server',
        status: 'skipped',
        message: SKIPPED_SERVER_MESSAGE,
        responseTime: 0,
        duration: '0s'
    };
}

function dedupeApiResults(details) {
    const deduped = new Map();

    (details || []).forEach((detail) => {
        if (!detail) {
            return;
        }

        deduped.set(buildApiStableKey(detail.method, detail.url, detail.name), detail);
    });

    return Array.from(deduped.values());
}

function classifyApiStatus(responseCode, expectedStatus) {
    const parsedResponseCode = typeof responseCode === 'number'
        ? responseCode
        : (/^\d+$/.test(String(responseCode || '').trim()) ? parseInt(String(responseCode).trim(), 10) : null);
    const parsedExpectedStatus = typeof expectedStatus === 'number'
        ? expectedStatus
        : (/^\d+$/.test(String(expectedStatus || '').trim()) ? parseInt(String(expectedStatus).trim(), 10) : undefined);

    if (typeof parsedExpectedStatus === 'number') {
        if (parsedResponseCode !== parsedExpectedStatus) {
            return 'failed';
        }

        if (parsedExpectedStatus >= 300 && parsedExpectedStatus < 400) {
            return 'warning';
        }

        return 'passed';
    }

    if (parsedResponseCode === null) {
        return 'failed';
    }

    if (parsedResponseCode >= 200 && parsedResponseCode < 300) {
        return 'passed';
    }

    if (parsedResponseCode >= 300 && parsedResponseCode < 400) {
        return 'warning';
    }

    return 'failed';
}

function normalizeSslHost(value) {
    const trimmed = (value || '').toString().trim();
    if (!trimmed) {
        return '';
    }

    if (/^https?:\/\//i.test(trimmed)) {
        try {
            return new URL(trimmed).hostname.toLowerCase();
        } catch (error) {
            return '';
        }
    }

    return trimmed.replace(/^https?:\/\//i, '').split('/')[0].replace(/:\d+$/, '').toLowerCase();
}

function normalizeDomainValue(value) {
    return String(value || '')
        .replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '')
        .replace(/\/$/, '')
        .toLowerCase();
}

function buildTrackedDetailKey(type, domain, url) {
    return `${type}::${normalizeDomainValue(domain || url || '')}`;
}

function getTrackedDetailScore(detail) {
    let score = 0;

    if (detail && detail.expiryDate) {
        score += 3;
    }

    if (detail && detail.expiryDateIST && detail.expiryDateIST !== 'N/A') {
        score += 2;
    }

    if (detail && detail.daysRemaining !== null && detail.daysRemaining !== undefined && !Number.isNaN(Number(detail.daysRemaining))) {
        score += 3;
    }

    if (detail && detail.reason) {
        score += 2;
    }

    if (detail && detail.status === 'passed') {
        score += 3;
    } else if (detail && (detail.status === 'warning' || detail.status === 'expiring')) {
        score += 2;
    } else if (detail && (detail.status === 'failed' || detail.status === 'error')) {
        score += 1;
    }

    return score;
}

function pickPreferredTrackedDetail(existing, incoming) {
    if (!existing) {
        return incoming;
    }

    const existingScore = getTrackedDetailScore(existing);
    const incomingScore = getTrackedDetailScore(incoming);

    if (incomingScore > existingScore) {
        return {
            ...existing,
            ...incoming,
            domain: incoming.domain || existing.domain,
            url: incoming.url || existing.url,
            expiryDate: incoming.expiryDate || existing.expiryDate,
            expiryDateIST: incoming.expiryDateIST && incoming.expiryDateIST !== 'N/A' ? incoming.expiryDateIST : existing.expiryDateIST,
            daysRemaining: incoming.daysRemaining ?? existing.daysRemaining,
            reason: incoming.reason || existing.reason
        };
    }

    return {
        ...incoming,
        ...existing,
        domain: existing.domain || incoming.domain,
        url: existing.url || incoming.url,
        expiryDate: existing.expiryDate || incoming.expiryDate,
        expiryDateIST: existing.expiryDateIST && existing.expiryDateIST !== 'N/A' ? existing.expiryDateIST : incoming.expiryDateIST,
        daysRemaining: existing.daysRemaining ?? incoming.daysRemaining,
        reason: existing.reason || incoming.reason
    };
}

function dedupeTrackedResults(type, details) {
    const deduped = new Map();

    (details || []).forEach((detail) => {
        if (!detail) {
            return;
        }

        const normalizedDomain = normalizeDomainValue(detail.domain || detail.url);
        if (!normalizedDomain) {
            return;
        }

        const normalizedDetail = {
            ...detail,
            domain: normalizedDomain,
            url: detail.url || `https://${normalizedDomain}`
        };
        const key = buildTrackedDetailKey(type, normalizedDetail.domain, normalizedDetail.url);
        deduped.set(key, pickPreferredTrackedDetail(deduped.get(key), normalizedDetail));
    });

    return Array.from(deduped.values());
}

function normalizeDaysRemaining(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    const trimmed = String(value || '').trim();
    if (!trimmed) {
        return null;
    }

    const match = trimmed.match(/-?\d+/);
    if (!match) {
        return null;
    }

    const days = parseInt(match[0], 10);
    return Number.isNaN(days) ? null : days;
}

function getExpiryStatus(daysRemaining, hasError = false) {
    const normalizedDays = normalizeDaysRemaining(daysRemaining);

    if (hasError || normalizedDays === null) {
        return 'failed';
    }

    if (normalizedDays < 0) {
        return 'failed';
    }

    if (normalizedDays <= EXPIRY_WARNING_DAYS) {
        return 'warning';
    }

    return 'passed';
}

function toDomainDetailStatus(status) {
    if (status === 'warning') {
        return 'expiring';
    }

    if (status === 'failed') {
        return 'error';
    }

    return 'active';
}

function normalizeDomainDetail(detail) {
    const daysRemaining = normalizeDaysRemaining(detail && detail.daysRemaining);
    const status = toDomainDetailStatus(
        getExpiryStatus(daysRemaining, detail && detail.status === 'error' && daysRemaining === null)
    );

    return {
        ...detail,
        url: (detail && detail.url) || (detail && detail.domain ? `https://${normalizeDomainValue(detail.domain)}` : undefined),
        domain: normalizeDomainValue(detail && detail.domain),
        daysRemaining,
        status,
        reason: detail && detail.reason ? String(detail.reason) : undefined
    };
}

function normalizeSslDetail(detail) {
    const daysRemaining = normalizeDaysRemaining(detail && detail.daysRemaining);
    const isTimeoutWarning = detail && detail.status === 'warning' && daysRemaining === null;
    const status = isTimeoutWarning
        ? 'warning'
        : getExpiryStatus(daysRemaining, detail && detail.status === 'failed' && daysRemaining === null);

    return {
        ...detail,
        domain: normalizeDomainValue(detail && detail.domain),
        url: (detail && detail.url) || (detail && detail.domain ? `https://${normalizeDomainValue(detail.domain)}` : undefined),
        daysRemaining,
        status,
        reason: detail && detail.reason ? String(detail.reason) : undefined
    };
}

function formatToIST(value) {
    if (!value) return 'N/A';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'N/A';
    return new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    }).format(date) + ' IST';
}

function getProjectSslEntries(project) {
    const rawEntries = (project && Array.isArray(project.ssl) && project.ssl.length > 0)
        ? project.ssl
        : ((project && Array.isArray(project.sslCerts)) ? project.sslCerts : []);
    const seen = new Set();

    return rawEntries
        .map((entry) => normalizeSslHost(entry))
        .filter((entry) => {
            if (!entry || seen.has(entry)) {
                return false;
            }

            seen.add(entry);
            return true;
        });
}

function decodeHtml(value) {
    return (value || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
}

function stripHtml(value) {
    return decodeHtml((value || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/pre>/gi, '\n')
        .replace(/<\/details>/gi, '\n')
        .replace(/<\/summary>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\n\s+/g, '\n')
        .replace(/[ \t]+/g, ' '));
}

function decodeBase64Value(value) {
    if (!value) {
        return undefined;
    }

    try {
        return Buffer.from(value, 'base64').toString('utf8');
    } catch (error) {
        return undefined;
    }
}

function normalizePlayStoreValue(playStore) {
    if (!playStore || typeof playStore !== 'string') {
        return null;
    }

    const trimmed = playStore.trim();
    if (!trimmed) {
        return null;
    }

    // Accept full Play Store URL — extract package id from ?id= param
    if (/^https?:\/\//i.test(trimmed)) {
        try {
            const url = new URL(trimmed);
            const packageName = url.searchParams.get('id') || '';
            if (!packageName) return null;
            return {
                packageName,
                expectedUrl: `https://play.google.com/store/apps/details?id=${packageName}`
            };
        } catch (error) {
            return null;
        }
    }

    return {
        packageName: trimmed,
        expectedUrl: `https://play.google.com/store/apps/details?id=${trimmed}`
    };
}

function normalizeAppStoreValue(appStore) {
    if (!appStore || typeof appStore !== 'string') {
        return null;
    }

    const trimmed = appStore.trim();
    if (!trimmed) return null;

    // Accept full App Store URL — extract the id part
    if (/^https?:\/\//i.test(trimmed)) {
        try {
            const url = new URL(trimmed);
            // URL like https://apps.apple.com/us/app/whatsapp-messenger/id310633997
            const idMatch = url.pathname.match(/\/(id\d+)/);
            const appId = idMatch ? idMatch[1] : '';
            if (!appId) return null;
            return {
                appId,
                expectedUrl: `https://apps.apple.com/app/${appId}`
            };
        } catch (error) {
            return null;
        }
    }

    // Plain id like "id310633997" or "id6747385992"
    const idVal = trimmed.startsWith('id') ? trimmed : `id${trimmed}`;
    return {
        appId: idVal,
        expectedUrl: `https://apps.apple.com/app/${idVal}`
    };
}

function getSuiteReportPath(repository) {
    return path.join(__dirname, 'suite-reports', `${repository.replace(/[^a-zA-Z0-9]/g, '_')}.html`);
}

function readSuiteRows(repository) {
    const reportPath = getSuiteReportPath(repository);
    const reportStat = fs.existsSync(reportPath) ? fs.statSync(reportPath) : null;
    const reportMtime = reportStat ? reportStat.mtimeMs : null;

    if (suiteConfigCache.suiteRows[repository] && suiteConfigCache.suiteRowMtimes[repository] === reportMtime) {
        return suiteConfigCache.suiteRows[repository];
    }

    if (!fs.existsSync(reportPath)) {
        console.warn('Suite report not found:', reportPath);
        suiteConfigCache.suiteRows[repository] = [];
        suiteConfigCache.suiteRowMtimes[repository] = null;
        return suiteConfigCache.suiteRows[repository];
    }

    const html = fs.readFileSync(reportPath, 'utf8');
    const rowPattern = /<tr class="test-row (passed|failed|skipped)">[\s\S]*?<td class="test-name">([^<]+)<\/td>[\s\S]*?<span class="status-badge [^"]+">([^<]+)<\/span>[\s\S]*?<td class="test-duration">([^<]+)<\/td>[\s\S]*?<td class="test-details"([^>]*)>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/gi;
    const rows = [];

    for (const match of html.matchAll(rowPattern)) {
        const attributes = match[5] || '';
        const requestBodyMatch = attributes.match(/data-request-body="([^"]*)"/i);
        const responseBodyMatch = attributes.match(/data-response-body="([^"]*)"/i);
        const responseCodeMatch = attributes.match(/data-response-code="([^"]*)"/i);
        const expectedStatusMatch = attributes.match(/data-expected-status="([^"]*)"/i);

        rows.push({
            status: match[1].toLowerCase(),
            title: decodeHtml(match[2]),
            badge: decodeHtml(match[3]).toLowerCase(),
            duration: decodeHtml(match[4]),
            details: stripHtml(match[6]),
            requestBody: decodeBase64Value(requestBodyMatch && requestBodyMatch[1]),
            responseBody: decodeBase64Value(responseBodyMatch && responseBodyMatch[1]),
            responseCode: decodeHtml(responseCodeMatch && responseCodeMatch[1]),
            expectedStatus: decodeHtml(expectedStatusMatch && expectedStatusMatch[1])
        });
    }

    suiteConfigCache.suiteRows[repository] = rows;
    suiteConfigCache.suiteRowMtimes[repository] = reportMtime;
    return rows;
}

function parseExpectedStatus(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    const trimmed = String(value || '').trim();
    if (!/^\d+$/.test(trimmed)) {
        return undefined;
    }

    const parsed = parseInt(trimmed, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
}

function findSuiteRow(rows, expectedTitle) {
    const normalizedExpected = normalizeText(expectedTitle);
    return rows.find((row) => normalizeText(row.title) === normalizedExpected);
}

function loadAppSuiteDefinitions() {
    if (suiteConfigCache.apps) {
        return suiteConfigCache.apps;
    }

    const mapping = getProjectMapping();
    const entries = [];
    (mapping.projects || []).forEach(project => {
        (project.apps || []).forEach(app => {
            if (!app || !app.name) return;
            const play = normalizePlayStoreValue(app.playStore);
            if (play) {
                entries.push({
                    appName: app.name,
                    platform: 'Play Store',
                    packageName: play.packageName,
                    expectedUrl: play.expectedUrl
                });
            }
            const ios = normalizeAppStoreValue(app.appStore);
            if (ios) {
                entries.push({
                    appName: app.name,
                    platform: 'App Store',
                    packageName: ios.appId,
                    expectedUrl: ios.expectedUrl
                });
            }
        });
    });
    suiteConfigCache.apps = entries;

    return suiteConfigCache.apps;
}

function loadCertificateSuiteDefinitions() {
    if (suiteConfigCache.certificates) {
        return suiteConfigCache.certificates;
    }

    const mapping = getProjectMapping();
    const seen = new Set();
    suiteConfigCache.certificates = (mapping.projects || [])
        .flatMap((project) => getProjectSslEntries(project).map((url) => ({
            name: url,
            url
        })))
        .filter((entry) => {
            const key = normalizeSslHost(entry.url);
            if (!key || seen.has(key)) {
                return false;
            }

            seen.add(key);
            return true;
        });

    return suiteConfigCache.certificates;
}

function loadApiSuiteDefinitions() {
    if (suiteConfigCache.apis) {
        return suiteConfigCache.apis;
    }

    const mapping = getProjectMapping();
    suiteConfigCache.apis = (mapping.projects || [])
        .flatMap((project) => project.apis || [])
        .filter((entry) => entry && entry.name && entry.url && entry.method)
        .map((entry) => ({
            name: entry.name,
            url: entry.url,
            method: entry.method,
            expectedStatus: entry.expectedStatus
        }));

    return suiteConfigCache.apis;
}

function loadDomainReportEntries() {
    const state = readDashboardState();
    const stateGeneratedAt = state && state.generatedAt ? state.generatedAt : '';

    if (suiteConfigCache.domains && suiteConfigCache.domainsCacheKey === stateGeneratedAt) {
        return suiteConfigCache.domains;
    }

    const domainDetails = state && state.suites && state.suites.domain && Array.isArray(state.suites.domain.details)
        ? state.suites.domain.details
        : [];

    const stateEntries = domainDetails
        .map((detail) => {
            const normalizedDetail = normalizeDomainDetail(detail);
            const normalizedDomain = normalizeSslHost(normalizedDetail && normalizedDetail.domain);
            if (!normalizedDomain) {
                return null;
            }

            let status = 'failed';
            if (normalizedDetail.status === 'active') {
                status = 'passed';
            } else if (normalizedDetail.status === 'expiring') {
                status = 'warning';
            } else if (normalizedDetail.status === 'error') {
                status = 'failed';
            }

            return {
                name: normalizedDomain,
                domain: normalizedDomain,
                status,
                expiryDate: normalizedDetail.expiryDate || null,
                expiryDateIST: normalizedDetail.expiryDateIST || formatToIST(normalizedDetail.expiryDate),
                daysRemaining: normalizedDetail.daysRemaining ?? null,
                details: ''
            };
        })
        .filter(Boolean);

    const htmlEntries = [];
    if (fs.existsSync(DOMAIN_REPORT_OUTPUT_PATH)) {
        const html = fs.readFileSync(DOMAIN_REPORT_OUTPUT_PATH, 'utf8');
        const cardPattern = /<div class="domain-card(?: expiring-soon| error)?"[^>]*>[\s\S]*?<div class="days-remaining(?: [^"]+)?"[^>]*>[\s\S]*?<\/div>[\s\S]*?<\/div>[\s\S]*?<\/div>/gi;

        for (const cardMatch of html.matchAll(cardPattern)) {
            const cardHtml = cardMatch[0];
            const nameMatch = cardHtml.match(/<div class="domain-name">([^<]+)<\/div>/i);
            const domainMatch = cardHtml.match(/<div class="domain-url">([^<]+)<\/div>/i);
            const badgeClassMatch = cardHtml.match(/<span class="status-badge ([^"]+)">/i);
            const expiryDateMatch = cardHtml.match(/<div class="expiry-date">([^<]+)<\/div>/i);
            const expiryDateISTMatch = cardHtml.match(/<div class="expiry-date-ist">([^<]+)<\/div>/i);
            const daysTextMatch = cardHtml.match(/<div class="days-remaining(?: [^"]+)?"[^>]*>\s*([^<]+)\s*<\/div>/i);

            if (!nameMatch || !domainMatch || !badgeClassMatch || !expiryDateMatch) {
                continue;
            }

            const badgeClass = badgeClassMatch[1] || '';
            const daysText = decodeHtml((daysTextMatch && daysTextMatch[1]) || '');
            const daysRemaining = normalizeDaysRemaining(daysText);
            const status = classifyExpiryStatus(daysRemaining, !badgeClass.includes('status-active'));

            htmlEntries.push({
                name: decodeHtml(nameMatch[1]),
                domain: decodeHtml(domainMatch[1]),
                status,
                expiryDate: decodeHtml(expiryDateMatch[1]),
                expiryDateIST: decodeHtml((expiryDateISTMatch && expiryDateISTMatch[1]) || '') || formatToIST(decodeHtml(expiryDateMatch[1])),
                daysRemaining,
                details: daysText
            });
        }
    }

    if (fs.existsSync(DOMAIN_MODULE_REPORT_PATH)) {
        const html = fs.readFileSync(DOMAIN_MODULE_REPORT_PATH, 'utf8');
        const cardPattern = /<article class="report-card [^"]+">[\s\S]*?<\/article>/gi;

        for (const cardMatch of html.matchAll(cardPattern)) {
            const cardHtml = cardMatch[0];
            const nameMatch = cardHtml.match(/<h2>([^<]+)<\/h2>/i);
            const badgeMatch = cardHtml.match(/<span class="badge [^"]+">([^<]+)<\/span>/i);
            if (!nameMatch) {
                continue;
            }

            const fields = {};
            for (const fieldMatch of cardHtml.matchAll(/<div class="field(?: [^"]+)?">\s*<div class="field-label">([^<]+)<\/div>\s*<div class="field-value">([\s\S]*?)<\/div>\s*<\/div>/gi)) {
                fields[decodeHtml(fieldMatch[1])] = stripHtml(fieldMatch[2]);
            }

            const domain = decodeHtml(nameMatch[1]);
            const statusText = decodeHtml((badgeMatch && badgeMatch[1]) || '').toLowerCase();
            htmlEntries.push({
                name: domain,
                domain,
                url: fields.URL || `https://${normalizeDomainValue(domain)}`,
                status: statusText === 'failed' ? 'failed' : statusText === 'warning' ? 'warning' : 'passed',
                expiryDate: fields['Expiry Date (UTC)'] || null,
                expiryDateIST: fields['Expiry Date (IST)'] || formatToIST(fields['Expiry Date (UTC)']),
                daysRemaining: normalizeDaysRemaining(fields['Days Remaining']),
                details: fields['Domain Status'] || statusText
            });
        }
    }

    const entries = dedupeTrackedResults('domain', [...stateEntries, ...htmlEntries].map(normalizeDomainDetail));

    suiteConfigCache.domains = entries;
    suiteConfigCache.domainsCacheKey = stateGeneratedAt;
    return suiteConfigCache.domains;
}

function loadSslReportEntries() {
    const state = readDashboardState();
    const stateGeneratedAt = state && state.generatedAt ? state.generatedAt : '';

    if (suiteConfigCache.ssl && suiteConfigCache.sslCacheKey === stateGeneratedAt) {
        return suiteConfigCache.ssl;
    }

    const stateDetails = state && state.suites && state.suites.cert && Array.isArray(state.suites.cert.details)
        ? state.suites.cert.details
        : [];

    const normalizedStateEntries = stateDetails
        .map((detail) => normalizeSslDetail(detail))
        .filter((detail) => normalizeSslHost(detail && (detail.domain || detail.url)))
        .map((detail) => ({
            domain: normalizeSslHost(detail.domain || detail.url),
            url: detail.url || `https://${normalizeSslHost(detail.domain || detail.url)}`,
            status: detail.status,
            expiryDate: detail.expiryDate || null,
            expiryDateIST: detail.expiryDateIST || formatToIST(detail.expiryDate),
            daysRemaining: detail.daysRemaining ?? null,
            reason: detail.reason || ''
        }));

    const htmlEntries = [];
    if (fs.existsSync(CERTIFICATE_REPORT_OUTPUT_PATH)) {
        const html = fs.readFileSync(CERTIFICATE_REPORT_OUTPUT_PATH, 'utf8');
        const cardPattern = /<div class="cert-card(?: expiring-soon| error)?"[^>]*>[\s\S]*?<div class="days-remaining(?: [^"]+)?"[^>]*>[\s\S]*?<\/div>[\s\S]*?<\/div>[\s\S]*?<\/div>/gi;

        for (const cardMatch of html.matchAll(cardPattern)) {
            const cardHtml = cardMatch[0];
            const nameMatch = cardHtml.match(/<div class="cert-name">([^<]+)<\/div>/i);
            const urlMatch = cardHtml.match(/<div class="cert-url">([^<]+)<\/div>/i);
            const badgeClassMatch = cardHtml.match(/<span class="status-badge ([^"]+)">/i);
            const expiryDateMatch = cardHtml.match(/<div class="expiry-date">([^<]+)<\/div>/i);
            const expiryDateISTMatch = cardHtml.match(/<div class="expiry-date-ist">([^<]+)<\/div>/i);
            const daysTextMatch = cardHtml.match(/<div class="days-remaining(?: [^"]+)?"[^>]*>\s*([^<]+)\s*<\/div>/i);
            const reasonMatch = cardHtml.match(/<div class="error-reason">(?:<strong>[^<]+<\/strong>\s*)?([^<]+)<\/div>/i);

            if (!nameMatch || !urlMatch || !badgeClassMatch || !expiryDateMatch) {
                continue;
            }

            const badgeClass = badgeClassMatch[1] || '';
            const url = decodeHtml(urlMatch[1]);
            const domain = normalizeSslHost(decodeHtml(nameMatch[1]) || url);
            const daysText = decodeHtml((daysTextMatch && daysTextMatch[1]) || '');
            const daysRemaining = normalizeDaysRemaining(daysText);
            const status = classifyExpiryStatus(daysRemaining, badgeClass.includes('status-error'));

            htmlEntries.push({
                domain,
                url: url || `https://${domain}`,
                status,
                expiryDate: decodeHtml(expiryDateMatch[1]),
                expiryDateIST: decodeHtml((expiryDateISTMatch && expiryDateISTMatch[1]) || '') || formatToIST(decodeHtml(expiryDateMatch[1])),
                daysRemaining,
                reason: decodeHtml((reasonMatch && reasonMatch[1]) || '') || daysText
            });
        }
    }

    if (fs.existsSync(SSL_MODULE_REPORT_PATH)) {
        const html = fs.readFileSync(SSL_MODULE_REPORT_PATH, 'utf8');
        const cardPattern = /<article class="report-card [^"]+">[\s\S]*?<\/article>/gi;

        for (const cardMatch of html.matchAll(cardPattern)) {
            const cardHtml = cardMatch[0];
            const nameMatch = cardHtml.match(/<h2>([^<]+)<\/h2>/i);
            const badgeMatch = cardHtml.match(/<span class="badge [^"]+">([^<]+)<\/span>/i);
            if (!nameMatch) {
                continue;
            }

            const fields = {};
            for (const fieldMatch of cardHtml.matchAll(/<div class="field(?: [^"]+)?">\s*<div class="field-label">([^<]+)<\/div>\s*<div class="field-value">([\s\S]*?)<\/div>\s*<\/div>/gi)) {
                fields[decodeHtml(fieldMatch[1])] = stripHtml(fieldMatch[2]);
            }

            const domain = normalizeSslHost(decodeHtml(nameMatch[1]) || fields.URL);
            const statusText = decodeHtml((badgeMatch && badgeMatch[1]) || '').toLowerCase();
            const reasonText = fields['Reason'] || fields['Certificate Status'] || statusText;
            const isTimeoutReason = /ETIMEDOUT|ECONNRESET|TCP.*timeout|timeout.*TCP|Unreachable.*machine/i.test(reasonText);
            const resolvedStatus = isTimeoutReason ? 'warning' : (statusText === 'failed' ? 'failed' : statusText === 'warning' ? 'warning' : 'passed');
            htmlEntries.push({
                domain,
                url: fields.URL || `https://${domain}`,
                status: resolvedStatus,
                expiryDate: fields['Expiry Date (UTC)'] || null,
                expiryDateIST: fields['Expiry Date (IST)'] || formatToIST(fields['Expiry Date (UTC)']),
                daysRemaining: normalizeDaysRemaining(fields['Days Remaining']),
                reason: isTimeoutReason ? 'Unreachable from this machine (TCP timeout)' : (fields['Certificate Status'] || statusText)
            });
        }
    }

    const mergedEntries = dedupeTrackedResults('ssl', [...normalizedStateEntries, ...htmlEntries].map(normalizeSslDetail));

    suiteConfigCache.ssl = mergedEntries;
    suiteConfigCache.sslCacheKey = stateGeneratedAt;
    return suiteConfigCache.ssl;
}

function createEmptySuiteResult() {
    return { total: 0, passed: 0, failed: 0, warning: 0, skipped: 0, tests: [] };
}

function getProjectDomainStatus(project, domainDetails) {
    const configuredDomains = new Set((project.domains || []).map((projectDomain) => normalizeDomainValue(projectDomain)).filter(Boolean));
    const matched = dedupeTrackedResults('domain', (domainDetails || []).map(normalizeDomainDetail)).filter((detail) =>
        configuredDomains.has(normalizeDomainValue(detail.domain || detail.url))
    );

    const total = matched.length;
    const passed = matched.filter((detail) => detail.status === 'active').length;
    const warning = matched.filter((detail) => detail.status === 'expiring').length;
    const failed = matched.filter((detail) => detail.status === 'error').length;

    return { total, passed, warning, failed, matched };
}

function getProjectSslDetails(project, sslDetails) {
    const sslEntries = getProjectSslEntries(project);
    const configuredSslEntries = new Set(sslEntries.map((entry) => normalizeDomainValue(entry)).filter(Boolean));
    const sslResults = dedupeTrackedResults('ssl', (sslDetails || []).map(normalizeSslDetail)).filter((detail) =>
        configuredSslEntries.has(normalizeDomainValue(detail.domain || detail.url))
    );
    return sslResults;
}

function attachProjectDomainStatuses(projects, dashboardState) {
    const domainDetails = loadDomainReportEntries().map(normalizeDomainDetail);

    projects.forEach((project) => {
        const status = getProjectDomainStatus(project, domainDetails);
        project.domainStatus = {
            total: status.total,
            passed: status.passed,
            warning: status.warning,
            failed: status.failed
        };
    });
}

function attachProjectSslDetails(projects, dashboardState) {
    const sslDetails = loadSslReportEntries().map(normalizeSslDetail);

    projects.forEach((project) => {
        project.sslDetails = getProjectSslDetails(project, sslDetails);
    });
}

function attachProjectServerStatuses(projects) {
    (projects || []).forEach((project) => {
        const serverResults = getServerTestResults(project.id);
        const serverByKey = new Map((serverResults.tests || []).map((test) => [`${normalizeText(test.name)}::${normalizeUrl(test.url)}`, test]));

        project.servers = (project.servers || []).map((server) => {
            const key = `${normalizeText(server.name)}::${normalizeUrl(server.url)}`;
            const matched = serverByKey.get(key);

            if (matched) {
                return {
                    ...server,
                    status: matched.status,
                    message: matched.message || matched.reason,
                    responseTime: matched.responseTime ?? 0
                };
            }

            if (isSkippedServerDefinition(server)) {
                return {
                    ...server,
                    status: 'skipped',
                    message: SKIPPED_SERVER_MESSAGE,
                    responseTime: 0
                };
            }

            return server;
        });
    });
}

function getAppTestResults(projectId) {
    if (resultsCleared && !projectResultOverride[projectId]?.apps) return createEmptySuiteResult();
    if (projectResultOverride[projectId] && projectResultOverride[projectId].apps) return projectResultOverride[projectId].apps;
    const state = readDashboardState();
    if (!state || !state.generatedAt) return createEmptySuiteResult();
    try {
        const mapping = getProjectMapping();
        const project = mapping.projects.find((entry) => entry.id === projectId);

        if (!project || !project.apps || project.apps.length === 0) {
            return createEmptySuiteResult();
        }

        const rows = readSuiteRows('Adhash_App_Status');
        const definitions = loadAppSuiteDefinitions();
        const result = createEmptySuiteResult();

        project.apps.forEach((app) => {
            const appDefinitions = definitions.filter((entry) => normalizeText(entry.appName) === normalizeText(app.name));
            if (!appDefinitions.length) {
                return;
            }

            appDefinitions.forEach((definition) => {
                const platform = definition.platform || 'Play Store';
                // Try both naming conventions used by different spec generators
                const row = findSuiteRow(rows, `Verify ${definition.appName} on ${platform}`) ||
                            findSuiteRow(rows, `App Status: ${definition.appName} (${platform})`) ||
                            findSuiteRow(rows, `App Status: ${app.name} (${platform})`);
                if (!row || row.status === 'skipped') {
                    return;
                }

                result.total++;
                if (row.status === 'passed') {
                    result.passed++;
                } else if (row.status === 'warning') {
                    result.warning++;
                } else {
                    result.failed++;
                }

                result.tests.push({
                    name: definition.appName,
                    platform,
                    url: definition.expectedUrl,
                    status: row.status,
                    type: 'app'
                });
            });
        });

        return result;
    } catch (error) {
        console.error('Error getting app test results:', error);
        return createEmptySuiteResult();
    }
}

function getServerTestResults(projectId) {
    if (resultsCleared && !projectResultOverride[projectId]?.servers) return createEmptySuiteResult();
    if (projectResultOverride[projectId] && projectResultOverride[projectId].servers) return projectResultOverride[projectId].servers;
    const state = readDashboardState();
    if (!state || !state.generatedAt) return createEmptySuiteResult();
    try {
        const mapping = getProjectMapping();
        const project = mapping.projects.find((entry) => entry.id === projectId);

        if (!project || !project.servers || project.servers.length === 0) {
            return createEmptySuiteResult();
        }

        const rows = readSuiteRows('Adhash_AllProjects_Server');
        const result = createEmptySuiteResult();

        project.servers.forEach((server) => {
            const row = findSuiteRow(rows, `Check ${server.name} health`);
            if (!row && !isSkippedServerDefinition(server)) {
                return;
            }

            if (isSkippedServerDefinition(server) || row.status === 'skipped') {
                result.total++;
                result.skipped++;
                result.tests.push(buildSkippedServerResult(server));
                return;
            }

            result.total++;
            if (row.status === 'passed') {
                result.passed++;
            } else {
                result.failed++;
            }

            result.tests.push({
                name: server.name,
                url: server.url || '#',
                type: 'server',
                status: row.status,
                message: row.details || row.badge,
                responseTime: 0
            });
        });

        return result;
    } catch (error) {
        console.error('Error getting server test results:', error);
        return createEmptySuiteResult();
    }
}

function getSSLTestResults(projectId) {
    if (resultsCleared && !projectResultOverride[projectId]?.ssl) return createEmptySuiteResult();
    if (projectResultOverride[projectId] && projectResultOverride[projectId].ssl) return projectResultOverride[projectId].ssl;
    // Only read shared report files if a full run has been completed (generatedAt set)
    const state = readDashboardState();
    if (!state || !state.generatedAt) return createEmptySuiteResult();
    try {
        const sslDetails = dedupeTrackedResults('ssl', loadSslReportEntries().map(normalizeSslDetail));
        const mapping = getProjectMapping();
        const project = mapping.projects.find((entry) => entry.id === projectId);

        const sslEntries = getProjectSslEntries(project);

        if (!project || sslEntries.length === 0) {
            return createEmptySuiteResult();
        }

        const result = createEmptySuiteResult();

        const matched = dedupeTrackedResults('ssl', getProjectSslDetails(project, sslDetails));

        result.total = matched.length;
        result.passed = matched.filter((detail) => detail.status === 'passed').length;
        result.warning = matched.filter((detail) => detail.status === 'warning').length;
        result.failed = matched.filter((detail) => detail.status === 'failed').length;
        result.details = matched;

        matched.forEach((detail) => {
            result.tests.push({
                name: detail.domain,
                url: detail.url,
                status: detail.status,
                type: 'ssl',
                expiryDate: detail.expiryDate,
                expiryDateIST: detail.expiryDateIST || formatToIST(detail.expiryDate),
                daysRemaining: detail.daysRemaining,
                reason: detail.reason
            });
        });

        return result;
    } catch (error) {
        console.error('Error getting SSL test results:', error);
        return createEmptySuiteResult();
    }
}

function getDomainTestResults(projectId) {
    if (resultsCleared && !projectResultOverride[projectId]?.domains) return createEmptySuiteResult();
    if (projectResultOverride[projectId] && projectResultOverride[projectId].domains) return projectResultOverride[projectId].domains;
    // Only read shared report files if a full run has been completed (generatedAt set)
    const state = readDashboardState();
    if (!state || !state.generatedAt) return createEmptySuiteResult();
    try {
        const domainDetails = dedupeTrackedResults('domain', loadDomainReportEntries().map(normalizeDomainDetail));
        const mapping = getProjectMapping();
        const project = mapping.projects.find((entry) => entry.id === projectId);

        if (!project || !project.domains || project.domains.length === 0) {
            return createEmptySuiteResult();
        }

        const result = createEmptySuiteResult();
        const status = getProjectDomainStatus(project, domainDetails);

        result.total = status.total;
        result.passed = status.passed;
        result.warning = status.warning;
        result.failed = status.failed;

        status.matched.forEach((detail) => {
            result.tests.push({
                name: detail.domain,
                url: detail.url || `https://${detail.domain}`,
                status: detail.status === 'active' ? 'passed' : detail.status === 'expiring' ? 'warning' : 'failed',
                type: 'domain',
                expiryDate: detail.expiryDate || null,
                expiryDateIST: detail.expiryDateIST || formatToIST(detail.expiryDate),
                daysRemaining: detail.daysRemaining ?? null
            });
        });

        return result;
    } catch (error) {
        console.error('Error getting domain test results:', error);
        return createEmptySuiteResult();
    }
}

function getAPITestResults(projectId) {
    if (resultsCleared && !projectResultOverride[projectId]?.apis) return createEmptySuiteResult();
    if (projectResultOverride[projectId] && projectResultOverride[projectId].apis) return projectResultOverride[projectId].apis;
    const state = readDashboardState();
    if (!state || !state.generatedAt) return createEmptySuiteResult();
    try {
        const dashboardState = state;
        const apiSuite = dashboardState && dashboardState.suites ? dashboardState.suites.api : null;
        const apiDetails = apiSuite && Array.isArray(apiSuite.details) ? apiSuite.details : [];
        const mapping = getProjectMapping();
        const project = mapping.projects.find((entry) => entry.id === projectId);

        if (!project || !project.apis || project.apis.length === 0) {
            return createEmptySuiteResult();
        }

        const result = createEmptySuiteResult();
        const projectApiKeys = new Set((project.apis || []).map((api) => buildApiStableKey(api.method, api.url, api.name)));

        const rows = readSuiteRows('AdHash_API_Test');
        const detailByKey = new Map(
            dedupeApiResults(
                apiDetails.filter((detail) => detail && projectApiKeys.has(buildApiStableKey(detail.method, detail.url, detail.name)))
            ).map((detail) => [buildApiStableKey(detail.method, detail.url, detail.name), detail])
        );
        const apiResults = [];

        project.apis.forEach((api) => {
            const stableKey = buildApiStableKey(api.method, api.url, api.name);
            const method = (api.method || 'GET').toUpperCase();
            const row = findSuiteRow(rows, `${method} ${api.name}`);
            const detail = detailByKey.get(stableKey);

            if (row) {
                if (row.status === 'skipped') {
                    // If the dashboard-state detail has a definitive status (passed/failed/warning),
                    // always prefer it over the stale suite-report row's 'skipped' classification.
                    const detailStatus = detail && String(detail.status || '').toLowerCase();
                    if (detail && (detailStatus === 'passed' || detailStatus === 'failed' || detailStatus === 'warning')) {
                        const expectedStatus = parseExpectedStatus(api.expectedStatus) ?? parseExpectedStatus(detail.expectedStatus) ?? parseExpectedStatus(row.expectedStatus);
                        apiResults.push({
                            name: api.name,
                            url: api.url,
                            method,
                            duration: detail.duration || row.duration,
                            requestBody: detail.requestBody || row.requestBody || (normalizeApiMethod(method) === 'GET' ? 'No request body' : 'Payload not provided'),
                            responseBody: detail.responseBody || row.responseBody || 'No response body',
                            responseCode: detail.responseCode || row.responseCode || null,
                            expectedStatus,
                            status: detailStatus,
                            type: 'api'
                        });
                        return;
                    }

                    const skippedReason = row.details || (detail && detail.reason) || 'Skipped by suite';
                    const normalizedSkippedReason = String(skippedReason || '').trim().toLowerCase();
                    // Only use the row's own responseBody here – falling back to detail.responseBody
                    // would incorrectly suppress tests whose detail says "No response body" but whose
                    // actual status is a real failure.
                    const normalizedRowResponseBody = String(row.responseBody || '').trim().toLowerCase();

                    // Ignore placeholder rows that are effectively "not run" rather than actionable skips.
                    if (normalizedSkippedReason === 'no response body' || normalizedRowResponseBody === 'no response body') {
                        return;
                    }

                    apiResults.push({
                        name: api.name,
                        url: api.url,
                        method,
                        duration: (detail && detail.duration) || row.duration,
                        requestBody: row.requestBody || (detail && detail.requestBody) || (normalizeApiMethod(method) === 'GET' ? 'No request body' : 'Payload not provided'),
                        responseBody: row.responseBody || (detail && detail.responseBody) || 'No response body',
                        responseCode: row.responseCode || (detail && detail.responseCode) || null,
                        expectedStatus: parseExpectedStatus(api.expectedStatus) ?? parseExpectedStatus(row.expectedStatus) ?? parseExpectedStatus(detail && detail.expectedStatus),
                        status: 'skipped',
                        type: 'api',
                        reason: skippedReason
                    });
                    return;
                }

                const expectedStatus = parseExpectedStatus(api.expectedStatus) ?? parseExpectedStatus(row.expectedStatus) ?? parseExpectedStatus(detail && detail.expectedStatus);
                const status = classifyApiStatus(row.responseCode, expectedStatus);

                apiResults.push({
                    name: api.name,
                    url: api.url,
                    method,
                    duration: (detail && detail.duration) || row.duration,
                    requestBody: row.requestBody || (detail && detail.requestBody) || (normalizeApiMethod(method) === 'GET' ? 'No request body' : 'Payload not provided'),
                    responseBody: row.responseBody || (detail && detail.responseBody) || 'No response body',
                    responseCode: row.responseCode || (detail && detail.responseCode),
                    expectedStatus,
                    status,
                    type: 'api'
                });
                return;
            }

            if (!detail) {
                return;
            }

            const detailStatus = String(detail.status || '').toLowerCase();
            const detailReason = String(detail.reason || '').toLowerCase();
            const detailResponseBody = String(detail.responseBody || '').toLowerCase();

            // Ignore synthetic placeholders when an API check never actually executed.
            if (detailStatus === 'skipped' && (detailReason === 'no response body' || detailResponseBody === 'no response body')) {
                return;
            }

            apiResults.push({
                ...detail,
                name: api.name,
                url: api.url,
                method,
                expectedStatus: parseExpectedStatus(api.expectedStatus) ?? parseExpectedStatus(detail.expectedStatus),
                requestBody: detail.requestBody || (normalizeApiMethod(method) === 'GET' ? 'No request body' : 'Payload not provided'),
                responseBody: detail.responseBody || 'No response body'
            });
        });

        result.tests = dedupeApiResults(apiResults);
        result.total = result.tests.length;
        result.passed = result.tests.filter((detail) => detail.status === 'passed').length;
        result.warning = result.tests.filter((detail) => detail.status === 'warning').length;
        result.failed = result.tests.filter((detail) => detail.status === 'failed').length;
        result.skipped = result.tests.filter((detail) => detail.status === 'skipped').length;

        return result;
    } catch (error) {
        console.error('Error getting API test results:', error);
        return createEmptySuiteResult();
    }
}

// API endpoint to get test results for a project
app.get('/api/project/:id/test-results', (req, res) => {
    try {
        const projectId = req.params.id;

        const results = {
            apps: getAppTestResults(projectId),
            servers: getServerTestResults(projectId),
            ssl: getSSLTestResults(projectId),
            domains: getDomainTestResults(projectId),
            apis: getAPITestResults(projectId)
        };

        res.json({
            projectId,
            results
        });
    } catch (error) {
        console.error('❌ Error fetching test results:', error);
        res.status(500).json({
            projectId: req.params.id,
            results: {
                apps: createEmptySuiteResult(),
                servers: createEmptySuiteResult(),
                ssl: createEmptySuiteResult(),
                domains: createEmptySuiteResult(),
                apis: createEmptySuiteResult()
            },
            error: 'Failed to fetch test results',
            message: error.message
        });
    }
});

// Main route — redirect authenticated users to landing, otherwise login
app.get('/', (req, res) => {
    if (isAuthenticated(req)) {
        return res.redirect('/landing');
    }
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Landing page — workspace selector
app.get('/landing', (req, res) => {
    if (!isAuthenticated(req)) {
        return res.redirect('/');
    }
    return res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// QA Dashboard
app.get('/qa-dashboard', (req, res) => {
    if (!isAuthenticated(req)) {
        return res.redirect('/');
    }
    return res.sendFile(path.join(__dirname, 'public', 'qa-dashboard.html'));
});

app.get('/project-dashboard', (req, res) => {
    if (!isAuthenticated(req)) {
        return res.redirect('/');
    }
    return res.sendFile(path.join(__dirname, 'public', 'project-dashboard.html'));
});

app.get('/project-dashboard.html', (req, res) => {
    if (!isAuthenticated(req)) {
        return res.redirect('/');
    }
    return res.sendFile(path.join(__dirname, 'public', 'project-dashboard.html'));
});

app.get('/public/project-dashboard.html', (req, res) => {
    if (!isAuthenticated(req)) {
        return res.redirect('/');
    }
    return res.sendFile(path.join(__dirname, 'public', 'project-dashboard.html'));
});

// ─── PROJECT MANAGEMENT API ───────────────────────────────────────────────────

const PROJECT_MAPPING_PATH = path.join(__dirname, 'config', 'project-mapping.json');

function readProjectMapping() {
    try {
        return JSON.parse(fs.readFileSync(PROJECT_MAPPING_PATH, 'utf8'));
    } catch (e) {
        return { projects: [] };
    }
}

function writeProjectMapping(data) {
    fs.writeFileSync(PROJECT_MAPPING_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// Fire-and-forget: push updated spec files to all 5 GitHub repos in the background.
// Called after every project create / update / delete so GitHub always stays in sync.
// Commit project-mapping.json to the main AdHash_Project_Dashboard repo so GitHub
// Actions always gets the latest project list when the workflow runs.
// Then push updated spec files to all 5 sibling test repos.
// Both steps run in the background — does not block the HTTP response.
function autoPushSpecsToGitHub() {
    const token = process.env.GITHUB_TOKEN || process.env.GH_PAT || '';
    if (!token) {
        addLog('⚠️ Auto-push skipped: GITHUB_TOKEN not set in .env', 'warning');
        return;
    }

    const { execFile, spawn: spawnChild } = require('child_process');
    const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'AdHash Dashboard',
        GIT_AUTHOR_EMAIL: 'dashboard@adhashtech.com',
        GIT_COMMITTER_NAME: 'AdHash Dashboard',
        GIT_COMMITTER_EMAIL: 'dashboard@adhashtech.com'
    };

    // Step 1 — commit + push project-mapping.json to this repo on GitHub
    function commitAndPushMapping(onDone) {
        addLog('🔄 Committing project-mapping.json to GitHub...', 'info');

        // Ensure git remote uses token for authentication (no prompt)
        const authedRemote = `https://${token}@github.com/AHY18099/AdHash_Project_Dashboard.git`;

        const gitSteps = [
            ['git', ['config', 'user.email', 'dashboard@adhashtech.com']],
            ['git', ['config', 'user.name', 'AdHash Dashboard']],
            ['git', ['remote', 'set-url', 'origin', authedRemote]],
            ['git', ['add', 'config/project-mapping.json']],
            ['git', ['commit', '-m', 'chore: sync project-mapping.json from dashboard UI', '--allow-empty']],
            ['git', ['push', 'origin', 'HEAD']]
        ];

        let idx = 0;
        function runNext() {
            if (idx >= gitSteps.length) {
                addLog('✅ project-mapping.json pushed to GitHub.', 'success');
                onDone();
                return;
            }
            const [cmd, args] = gitSteps[idx++];
            execFile(cmd, args, { cwd: __dirname, env: gitEnv }, (err, stdout, stderr) => {
                if (err) {
                    // "nothing to commit" is not a real error — continue
                    if (stderr && stderr.includes('nothing to commit')) {
                        addLog('ℹ️ project-mapping.json unchanged — no commit needed.', 'info');
                        // still push in case a previous commit wasn't pushed
                        idx = gitSteps.length - 1;
                        runNext();
                        return;
                    }
                    addLog('⚠️ git step failed: ' + (stderr || err.message), 'warning');
                    onDone(); // continue to spec push regardless
                    return;
                }
                runNext();
            });
        }
        runNext();
    }

    // Step 2 — push regenerated spec files to the 5 sibling test repos via GitHub API
    function pushSpecFiles() {
        const pushScript = path.join(__dirname, 'scripts', 'push-specs-to-github.mjs');
        if (!fs.existsSync(pushScript)) {
            addLog('⚠️ push-specs-to-github.mjs not found — spec push skipped', 'warning');
            return;
        }
        addLog('🔄 Pushing updated test specs to sibling repos...', 'info');
        const child = spawnChild('node', [pushScript], {
            cwd: __dirname, shell: false, env: process.env, stdio: ['ignore', 'pipe', 'pipe']
        });
        child.stdout.on('data', (d) => { const l = d.toString().trim(); if (l) addLog(l, 'info'); });
        child.stderr.on('data', (d) => { const l = d.toString().trim(); if (l) addLog('⚠️ ' + l, 'warning'); });
        child.on('close', (code) => {
            addLog(code === 0 ? '✅ Test specs pushed to all sibling repos.' : '⚠️ Spec push exited with code ' + code, code === 0 ? 'success' : 'warning');
        });
        child.on('error', (err) => { addLog('❌ Spec push error: ' + err.message, 'error'); });
    }

    // Run step 1, then step 2
    commitAndPushMapping(pushSpecFiles);
}

// Regenerate spec files for all 5 test repositories from current project-mapping.json
function regenerateSpecFiles() {
    const mapping = readProjectMapping();
    const projects = mapping.projects || [];

    // 1. Server health spec  →  Adhash_AllProjects_Server
    const serverSpecDir = path.join(__dirname, '..', 'Adhash_AllProjects_Server', 'tests', 'server-health');
    if (fs.existsSync(serverSpecDir)) {
        const servers = [];
        projects.forEach(p => {
            (p.servers || []).forEach(s => servers.push({ name: s.name, url: s.url }));
        });
        const serverSpec = `import { test, expect } from '@playwright/test';
const SERVERS = ${JSON.stringify(servers, null, 2)};
for (const server of SERVERS) {
  test(\`Server Health: \${server.name}\`, async ({ request }) => {
    const res = await request.get(server.url, { timeout: 30000 });
    expect(res.status()).toBeLessThan(500);
  });
}
`;
        fs.writeFileSync(path.join(serverSpecDir, 'server-check.spec.ts'), serverSpec, 'utf8');
        logToArray('info', `Regenerated server spec (${servers.length} servers)`);
    }

    // 2. SSL cert spec  →  AdHash-Projects-Certificate-Expiry-Test
    const certSpecDir = path.join(__dirname, '..', 'AdHash-Projects-Certificate-Expiry-Test', 'tests', 'certificate');
    if (fs.existsSync(certSpecDir)) {
        const certs = [];
        projects.forEach(p => {
            (p.sslCerts || []).forEach(domain => certs.push({ name: `${p.name} - ${domain}`, domain }));
        });
        const certSpec = `import { test, expect } from '@playwright/test';
import * as tls from 'tls';
const CERTS = ${JSON.stringify(certs, null, 2)};
for (const cert of CERTS) {
  test(\`SSL Certificate: \${cert.name}\`, async () => {
    await new Promise<void>((resolve, reject) => {
      const socket = tls.connect(443, cert.domain, { servername: cert.domain }, () => {
        const c = socket.getPeerCertificate();
        const expiry = new Date(c.valid_to);
        const daysLeft = Math.floor((expiry.getTime() - Date.now()) / 86400000);
        socket.destroy();
        if (daysLeft < 7) reject(new Error(\`Certificate expires in \${daysLeft} days\`));
        else resolve();
      });
      socket.on('error', reject);
    });
  });
}
`;
        fs.writeFileSync(path.join(certSpecDir, 'cert-expiry.spec.ts'), certSpec, 'utf8');
        logToArray('info', `Regenerated cert spec (${certs.length} certs)`);
    }

    // 3. API spec  →  AdHash-API-Test
    const apiSpecDir = path.join(__dirname, '..', 'AdHash-API-Test', 'tests', 'api');
    if (fs.existsSync(apiSpecDir)) {
        const apis = [];
        projects.forEach(p => {
            (p.apis || []).forEach(a => apis.push({
                name: a.name || a.url,
                url: a.url,
                method: (a.method || 'GET').toUpperCase(),
                headers: a.headers || {},
                body: a.body || null,
                expectedStatus: a.expectedStatus || 200
            }));
        });
        const apiSpec = `import { test, expect } from '@playwright/test';

// Auto-generated from config/project-mapping.json — do not edit manually
const APIS = ${JSON.stringify(apis, null, 2)};

for (const api of APIS) {
  test(\`API: \${api.name}\`, async ({ request }) => {
    const opts: Parameters<typeof request.get>[1] & any = {
      timeout: 30000,
      failOnStatusCode: false,
    };
    if (Object.keys(api.headers || {}).length) opts.headers = api.headers;
    if (api.body) opts.data = api.body;
    const res = await request[api.method.toLowerCase() as 'get'|'post'|'put'|'delete'|'patch'](api.url, opts);
    expect(
      res.status(),
      \`Expected \${api.expectedStatus}, got \${res.status()} for \${api.url}\`
    ).toBe(api.expectedStatus);
  });
}
`;
        fs.writeFileSync(path.join(apiSpecDir, 'api-tests.spec.ts'), apiSpec, 'utf8');
        logToArray('info', `Regenerated API spec (${apis.length} endpoints)`);
    }

    // 4. App status spec  →  Adhash_App_Status
    const appSpecDir = path.join(__dirname, '..', 'Adhash_App_Status', 'tests', 'app-status');
    if (fs.existsSync(appSpecDir)) {
        const appEntries = [];
        projects.forEach(p => {
            (p.apps || []).forEach(a => {
                const play = normalizePlayStoreValue(a.playStore);
                if (play) appEntries.push({ name: `${p.name} — ${a.name} (Play Store)`, url: play.expectedUrl });
                const ios = normalizeAppStoreValue(a.appStore);
                if (ios) appEntries.push({ name: `${p.name} — ${a.name} (App Store)`, url: ios.expectedUrl });
            });
        });
        const appSpec = `// Auto-generated from config/project-mapping.json — do not edit manually
import { test, expect } from '@playwright/test';
const APPS = ${JSON.stringify(appEntries, null, 2)};
for (const app of APPS) {
  test(\`App Status: \${app.name}\`, async ({ request }) => {
    const res = await request.get(app.url, { timeout: 30000, failOnStatusCode: false });
    expect(res.status(), \`\${app.url} returned \${res.status()}\`).toBeLessThan(400);
  });
}
`;
        fs.writeFileSync(path.join(appSpecDir, 'playstore.spec.ts'), appSpec, 'utf8');
        logToArray('info', `Regenerated app spec (${appEntries.length} apps)`);
    }

    // 5. Domain report  →  AdHash_Domain_Report (write a domains.json config file)
    const domainRepoDir = path.join(__dirname, '..', 'AdHash_Domain_Report');
    if (fs.existsSync(domainRepoDir)) {
        const domains = [];
        projects.forEach(p => {
            (p.domains || []).forEach(d => domains.push(d));
        });
        fs.writeFileSync(path.join(domainRepoDir, 'domains.json'), JSON.stringify({ domains }, null, 2), 'utf8');
        logToArray('info', `Regenerated domain list (${domains.length} domains)`);
    }

}

// POST create project
app.post('/api/projects', (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    const data = readProjectMapping();
    const body = req.body;
    if (!body.id || !body.name) return res.status(400).json({ error: 'id and name are required' });
    if (data.projects.find(p => p.id === body.id)) return res.status(409).json({ error: 'Project id already exists' });
    const project = {
        id: body.id,
        name: body.name,
        description: body.description || '',
        color: body.color || '#3b82f6',
        apps: body.apps || [],
        servers: body.servers || [],
        domains: body.domains || [],
        sslCerts: body.sslCerts || [],
        apis: body.apis || []
    };
    data.projects.push(project);
    writeProjectMapping(data);
    regenerateSpecFiles();
    autoPushSpecsToGitHub();
    res.json({ success: true, project });
});

// PUT update project
app.put('/api/projects/:id', (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    const data = readProjectMapping();
    const idx = data.projects.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Project not found' });
    const body = req.body;
    const existing = data.projects[idx];
    data.projects[idx] = {
        id: existing.id,
        name: body.name || existing.name,
        description: body.description !== undefined ? body.description : existing.description,
        color: body.color || existing.color,
        apps: body.apps !== undefined ? body.apps : existing.apps,
        servers: body.servers !== undefined ? body.servers : existing.servers,
        domains: body.domains !== undefined ? body.domains : existing.domains,
        sslCerts: body.sslCerts !== undefined ? body.sslCerts : existing.sslCerts,
        apis: body.apis !== undefined ? body.apis : existing.apis
    };
    writeProjectMapping(data);
    regenerateSpecFiles();
    autoPushSpecsToGitHub();
    res.json({ success: true, project: data.projects[idx] });
});

// DELETE project
app.delete('/api/projects/:id', (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    const data = readProjectMapping();
    const idx = data.projects.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Project not found' });
    data.projects.splice(idx, 1);
    writeProjectMapping(data);
    regenerateSpecFiles();
    autoPushSpecsToGitHub();
    res.json({ success: true });
});

// POST /api/projects/:id/env — update display fields (website, dashboard, color, name) from UI edit modal
// Merges into project-mapping.json and triggers auto-push so spec files stay in sync.
app.post('/api/projects/:id/env', (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    const data = readProjectMapping();
    const idx = data.projects.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Project not found' });
    const { website, dashboard, color, name } = req.body || {};
    const proj = data.projects[idx];
    if (name)      proj.name = name;
    if (color)     proj.color = color;
    if (website !== undefined) proj.website = website;
    if (dashboard !== undefined) proj.dashboard = dashboard;
    writeProjectMapping(data);
    autoPushSpecsToGitHub();
    res.json({ success: true });
});

// POST /api/push-specs — commit & push regenerated spec files to all 5 GitHub repos
// Streams NDJSON log lines so the browser can show live progress.
app.post('/api/push-specs', (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });

    const token = process.env.GITHUB_TOKEN || process.env.GH_PAT || '';
    if (!token) {
        return res.status(400).json({
            error: 'GITHUB_TOKEN not configured',
            hint: 'Add GITHUB_TOKEN=<your PAT> to your .env file and restart the server.'
        });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    function send(type, msg) {
        res.write(`data: ${JSON.stringify({ type, msg })}\n\n`);
    }

    send('log', '🔄 Regenerating spec files from project-mapping.json…');
    try { regenerateSpecFiles(); } catch (e) {
        send('error', '❌ Spec regeneration failed: ' + e.message);
        res.write('data: {"type":"done","success":false}\n\n');
        return res.end();
    }
    send('log', '✅ Spec files regenerated locally.');
    send('log', '📤 Pushing to GitHub repos…');

    const { spawn } = require('child_process');
    const pushScript = path.join(__dirname, 'scripts', 'push-specs-to-github.mjs');
    const child = spawn(process.execPath, [pushScript], {
        env: { ...process.env, GITHUB_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', d => {
        String(d).split('\n').filter(Boolean).forEach(line => send('log', line));
    });
    child.stderr.on('data', d => {
        String(d).split('\n').filter(Boolean).forEach(line => send('warn', line));
    });
    child.on('error', e => {
        send('error', '❌ Push script error: ' + e.message);
        res.write('data: {"type":"done","success":false}\n\n');
        res.end();
    });
    child.on('close', code => {
        if (code === 0) {
            send('log', '🎉 All repos updated! GitHub Actions will pick up the changes on next run.');
            res.write('data: {"type":"done","success":true}\n\n');
        } else {
            send('warn', `⚠️ Push script exited with code ${code}. Check your GITHUB_TOKEN permissions.`);
            res.write('data: {"type":"done","success":false}\n\n');
        }
        res.end();
    });
});

// Run report availability check
app.get('/api/run-report-status', (req, res) => {
    const candidates = [
        path.join(__dirname, 'email-preview', 'AdHash-Projects-Dashboard.html'),
        path.join(__dirname, 'email-preview', 'index.html')
    ];
    const found = candidates.find(f => fs.existsSync(f));
    if (!found) {
        return res.json({ available: false });
    }
    try {
        const stat = fs.statSync(found);
        const state = readDashboardState();
        return res.json({
            available: true,
            generatedAt: (state && state.generatedAt) || stat.mtime.toISOString(),
            path: path.basename(path.dirname(found)) + '/' + path.basename(found)
        });
    } catch (e) {
        return res.json({ available: false });
    }
});

// Legacy dashboard route
app.get('/dashboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Data restore tool — no auth required (needs localStorage access before login)
app.get('/restore-tool', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'restore-tool.html'));
});
app.get('/restore-tool.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'restore-tool.html'));
});

app.get('/favicon.ico', (req, res) => {
    res.status(204).end();
});

// ── QA Dashboard API Proxy (bypasses browser CORS restrictions) ──
app.post('/api/qa-proxy', async (req, res) => {
    const { url, method, headers, body } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url is required' });

    const t0 = Date.now();
    try {
        const fetchOpts = {
            method: (method || 'GET').toUpperCase(),
            headers: headers || {}
        };
        const hasBody = fetchOpts.method !== 'GET' && fetchOpts.method !== 'HEAD' && body;
        if (hasBody) {
            fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
            if (!fetchOpts.headers['Content-Type'] && !fetchOpts.headers['content-type']) {
                fetchOpts.headers['Content-Type'] = 'application/json';
            }
        }

        // Use Node.js built-in fetch (Node 18+) or fallback to https module
        let statusCode, responseBody, responseHeaders = {};
        if (typeof fetch !== 'undefined') {
            const resp = await fetch(url, fetchOpts);
            statusCode = resp.status;
            resp.headers.forEach((v, k) => { responseHeaders[k] = v; });
            responseBody = await resp.text();
        } else {
            // Fallback: use https/http module
            const { request: nodeRequest } = require(url.startsWith('https') ? 'https' : 'http');
            const parsed = new URL(url);
            await new Promise((resolve, reject) => {
                const opts = {
                    hostname: parsed.hostname,
                    port: parsed.port || (url.startsWith('https') ? 443 : 80),
                    path: parsed.pathname + parsed.search,
                    method: fetchOpts.method,
                    headers: fetchOpts.headers,
                    timeout: 15000
                };
                const req2 = nodeRequest(opts, (r) => {
                    statusCode = r.statusCode;
                    r.headers && Object.assign(responseHeaders, r.headers);
                    const chunks = [];
                    r.on('data', d => chunks.push(d));
                    r.on('end', () => { responseBody = Buffer.concat(chunks).toString('utf8'); resolve(); });
                });
                req2.on('error', reject);
                req2.on('timeout', () => { req2.destroy(); reject(new Error('Request timed out')); });
                if (hasBody) req2.write(fetchOpts.body);
                req2.end();
            });
        }

        const elapsed = Date.now() - t0;
        // Try to pretty-print JSON response
        let prettyBody = responseBody;
        const ct = (responseHeaders['content-type'] || '');
        if (ct.includes('json')) {
            try { prettyBody = JSON.stringify(JSON.parse(responseBody), null, 2); } catch (_) {}
        }

        res.json({ statusCode, body: prettyBody, elapsed, headers: responseHeaders });
    } catch (err) {
        res.json({ statusCode: null, body: `Error: ${err.message}`, elapsed: Date.now() - t0, error: true });
    }
});

// Block direct access to sensitive files and directories
app.use((req, res, next) => {
    const blocked = [
        /^\/(\.env|server\.js|package\.json|package-lock\.json)/i,
        /^\/(data|config|utils|test-results|suite-reports|godaddy)\//i,
        /^\/data\//i,
    ];
    if (blocked.some(r => r.test(req.path))) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
});

// Serve only the public/ directory as static (login page assets, etc.)
app.use(express.static(path.join(__dirname, 'public'), {
    index: false, // don't auto-serve index.html — routes above handle auth
    setHeaders: (res) => {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
    }
}));

// API proxy endpoint — forwards request to any URL and returns full response (follows redirects)
app.post('/api/proxy', async (req, res) => {
    const { url, method } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url is required' });
    const m = (method || 'GET').toUpperCase();
    const allowedMethods = ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'];
    if (!allowedMethods.includes(m)) return res.status(400).json({ error: 'Invalid method' });

    const https = require('https');
    const http  = require('http');
    const { URL } = require('url');
    const startTs = Date.now();

    function doRequest(targetUrl, redirectsLeft, callback) {
        let parsed;
        try { parsed = new URL(targetUrl); } catch(e) { return callback({ status: 0, statusText: 'Invalid URL', headers: {}, body: '', timing: Date.now() - startTs, error: e.message }); }
        const isHttps = parsed.protocol === 'https:';
        const mod = isHttps ? https : http;
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: (parsed.pathname || '/') + (parsed.search || ''),
            method: m,
            headers: { 'User-Agent': 'AdHash-Dashboard/1.0' },
            rejectUnauthorized: false,
            timeout: 10000
        };
        const proxyReq = mod.request(options, (proxyRes) => {
            const sc = proxyRes.statusCode;
            // Follow redirects (301, 302, 303, 307, 308) for GET/HEAD only, up to 5 hops
            if ([301,302,303,307,308].includes(sc) && redirectsLeft > 0 && (m === 'GET' || m === 'HEAD')) {
                const location = proxyRes.headers['location'];
                proxyRes.resume(); // drain
                if (location) {
                    const next = location.startsWith('http') ? location : new URL(location, targetUrl).href;
                    return doRequest(next, redirectsLeft - 1, callback);
                }
            }
            let body = '';
            proxyRes.setEncoding('utf8');
            proxyRes.on('data', chunk => { if (body.length < 50000) body += chunk; });
            proxyRes.on('end', () => callback({ status: sc, statusText: proxyRes.statusMessage || '', headers: proxyRes.headers, body, timing: Date.now() - startTs }));
        });
        proxyReq.on('timeout', () => { proxyReq.destroy(); callback({ status: 0, statusText: 'Timeout', headers: {}, body: '', timing: Date.now() - startTs, error: 'Request timed out' }); });
        proxyReq.on('error', (err) => callback({ status: 0, statusText: 'Error', headers: {}, body: '', timing: Date.now() - startTs, error: err.message }));
        proxyReq.end();
    }

    try {
        doRequest(url, 5, (result) => res.json(result));
    } catch (err) {
        res.json({ status: 0, statusText: 'Error', headers: {}, body: '', timing: Date.now() - startTs, error: err.message });
    }
});

// ── WORKFLOW DOCS FILE STORAGE — GitHub Releases backend ──
// Files are stored as GitHub Release assets (up to 2GB each, permanent, survives any redeploy).
// Railway disk is used only as a local cache; GitHub Release is the source of truth.

const WF_DOCS_DIR = path.join(__dirname, 'data', 'wfdocs');
fs.mkdirSync(WF_DOCS_DIR, { recursive: true });
const GH_WFDOC_RELEASE_TAG = 'wfdoc-storage';

// Ensure the wfdoc storage release exists, return its id
async function _ghEnsureWfDocRelease() {
    const token = process.env.GITHUB_TOKEN || process.env.GH_PAT || '';
    if (!token) return null;
    try {
        // Try to get existing release
        const get = await _ghRequest('GET', `/repos/${GH_API_REPO}/releases/tags/${GH_WFDOC_RELEASE_TAG}`, null, token);
        if (get.status === 200) return get.body.id;
        // Create it
        const create = await _ghRequest('POST', `/repos/${GH_API_REPO}/releases`, {
            tag_name: GH_WFDOC_RELEASE_TAG, name: 'Workflow Document Storage',
            body: 'Internal storage for workflow documents. Do not delete.',
            draft: false, prerelease: false
        }, token);
        if (create.status === 201) { console.log('[wfdoc] Created GitHub Release for storage, id:', create.body.id); return create.body.id; }
        console.error('[wfdoc] Could not create release:', create.status, create.body && create.body.message);
        return null;
    } catch (e) { console.error('[wfdoc] _ghEnsureWfDocRelease error:', e.message); return null; }
}

// Upload buffer to GitHub Release as an asset, return asset download_url
async function _ghUploadWfDocAsset(releaseId, assetName, buffer, mimeType) {
    const token = process.env.GITHUB_TOKEN || process.env.GH_PAT || '';
    if (!token) return null;
    return new Promise((resolve, reject) => {
        const https = require('https');
        const options = {
            hostname: 'uploads.github.com',
            path: `/repos/${GH_API_REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`,
            method: 'POST',
            headers: {
                'Authorization': `token ${token}`, 'User-Agent': 'AdHash-Dashboard',
                'Content-Type': mimeType || 'application/octet-stream',
                'Content-Length': buffer.length
            }
        };
        const req = https.request(options, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    const r = JSON.parse(data);
                    if (res.statusCode === 201) resolve(r.browser_download_url || r.url);
                    else { console.error('[wfdoc] upload asset failed:', res.statusCode, r.message); resolve(null); }
                } catch (e) { resolve(null); }
            });
        });
        req.on('error', reject);
        req.setTimeout(120000, () => { req.destroy(); reject(new Error('upload timeout')); });
        req.write(buffer);
        req.end();
    });
}

// Delete a GitHub Release asset by asset id
async function _ghDeleteWfDocAsset(assetId) {
    const token = process.env.GITHUB_TOKEN || process.env.GH_PAT || '';
    if (!token) return;
    try {
        await _ghRequest('DELETE', `/repos/${GH_API_REPO}/releases/assets/${assetId}`, null, token);
    } catch (e) { console.error('[wfdoc] delete asset error:', e.message); }
}

// Persist wfdoc metadata into qa-shared.json (survives redeploy)
function _persistWfDocMeta(projectId, wfdocList) {
    try {
        const shared = readQaData();
        const projKey = 'qa3_' + projectId;
        if (!shared[projKey]) shared[projKey] = {};
        shared[projKey].wfdocs = wfdocList;
        writeQaData(shared);
    } catch (e) { console.error('_persistWfDocMeta error:', e.message); }
}

// POST /api/wfdocs/:projectId — upload a file, store in GitHub Release
app.post('/api/wfdocs/:projectId', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { name, data: b64data, size } = req.body || {};
    if (!name || !b64data) return res.status(400).json({ error: 'Missing name or data' });
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const uploadedAt = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const mimeType = b64data.split(';')[0].replace('data:', '') || 'application/octet-stream';
    const base64 = b64data.replace(/^data:[^;]+;base64,/, '');
    const buffer = Buffer.from(base64, 'base64');
    const fileId = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const assetName = fileId + '_' + name.replace(/[^a-zA-Z0-9._-]/g, '_');

    try {
        // Try GitHub Release upload first
        const token = process.env.GITHUB_TOKEN || process.env.GH_PAT || '';
        let ghAssetId = null;
        let ghUrl = null;
        if (token) {
            const releaseId = await _ghEnsureWfDocRelease();
            if (releaseId) {
                ghUrl = await _ghUploadWfDocAsset(releaseId, assetName, buffer, mimeType);
                // Get asset id for future deletion
                if (ghUrl) {
                    const rel = await _ghRequest('GET', `/repos/${GH_API_REPO}/releases/tags/${GH_WFDOC_RELEASE_TAG}`, null, token);
                    if (rel.status === 200) {
                        const asset = (rel.body.assets || []).find(a => a.name === assetName);
                        if (asset) ghAssetId = asset.id;
                    }
                }
            }
        }

        // Also write to local disk as cache
        const projectDir = path.join(WF_DOCS_DIR, req.params.projectId);
        fs.mkdirSync(projectDir, { recursive: true });
        fs.writeFileSync(path.join(projectDir, fileId + '.bin'), buffer);
        const meta = { name, size: size || buffer.length, fileId, uploadedAt, mimeType, ghAssetId, ghUrl, assetName };
        fs.writeFileSync(path.join(projectDir, fileId + '.meta.json'), JSON.stringify(meta));

        // Read current wfdocs list from qa-shared.json and append (dedup by serverId)
        const shared = readQaData();
        const projKey = 'qa3_' + req.params.projectId;
        const current = ((shared[projKey] && shared[projKey].wfdocs) || []).filter(f => f.serverId !== fileId);
        const newEntry = { name, size: size || buffer.length, uploadedAt, serverId: fileId, ghAssetId, ghUrl, assetName };
        _persistWfDocMeta(req.params.projectId, [...current, newEntry]);

        if (ghUrl) console.log(`[wfdoc] Uploaded "${name}" to GitHub Release: ${ghUrl}`);
        else console.log(`[wfdoc] Uploaded "${name}" to local disk only (no GitHub token or upload failed)`);

        res.json({ success: true, fileId });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/wfdocs/:projectId — list files
app.get('/api/wfdocs/:projectId', (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    const shared = readQaData();
    const projKey = 'qa3_' + req.params.projectId;
    let wfdocs = (shared[projKey] && shared[projKey].wfdocs) || [];
    // Defensive dedup by name (keep entry with serverId/ghUrl preferred)
    const seenNames = new Map();
    for (const f of wfdocs) {
        const key = f.name;
        if (!seenNames.has(key)) { seenNames.set(key, f); }
        else {
            const ex = seenNames.get(key);
            if (!ex.serverId && f.serverId) seenNames.set(key, f);
            else if (ex.serverId && !ex.ghUrl && f.ghUrl) seenNames.set(key, f);
        }
    }
    wfdocs = Array.from(seenNames.values());
    // If we deduped in-memory, persist the fix so it doesn't accumulate again
    const storedCount = (shared[projKey] && shared[projKey].wfdocs) ? shared[projKey].wfdocs.length : 0;
    if (storedCount !== wfdocs.length) {
        console.log(`[wfdoc-dedup] ${req.params.projectId}: ${storedCount} → ${wfdocs.length} (fixed in GET)`);
        _persistWfDocMeta(req.params.projectId, wfdocs);
    }
    // Mark each file as available (disk or ghUrl) or unavailable
    const projectDir = path.join(WF_DOCS_DIR, req.params.projectId);
    const result = wfdocs.map(f => {
        const onDisk = fs.existsSync(path.join(projectDir, (f.serverId || '') + '.bin'));
        return { ...f, fileId: f.serverId, available: onDisk || !!f.ghUrl };
    });
    res.json(result);
});

// GET /api/wfdocs/:projectId/:fileId — download a file
app.get('/api/wfdocs/:projectId/:fileId', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { projectId, fileId } = req.params;
    const projectDir = path.join(WF_DOCS_DIR, projectId);
    const diskPath = path.join(projectDir, fileId + '.bin');
    const metaPath = path.join(projectDir, fileId + '.meta.json');

    // Try disk first (fast)
    if (fs.existsSync(diskPath) && fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        res.setHeader('Content-Type', meta.mimeType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(meta.name)}"`);
        return res.send(fs.readFileSync(diskPath));
    }

    // Disk miss — check qa-shared.json for GitHub URL
    const shared = readQaData();
    const projKey = 'qa3_' + projectId;
    const wfdocs = (shared[projKey] && shared[projKey].wfdocs) || [];
    const entry = wfdocs.find(f => f.serverId === fileId);

    if (entry && entry.ghUrl) {
        // Stream from GitHub Release
        try {
            const token = process.env.GITHUB_TOKEN || process.env.GH_PAT || '';
            const https = require('https');
            // GitHub release asset download requires auth redirect handling
            const dlUrl = new URL(entry.ghUrl);
            const options = {
                hostname: dlUrl.hostname, path: dlUrl.pathname + dlUrl.search,
                headers: { 'Authorization': `token ${token}`, 'User-Agent': 'AdHash-Dashboard', 'Accept': 'application/octet-stream' }
            };
            const ghReq = https.get(options, ghRes => {
                if (ghRes.statusCode === 302 || ghRes.statusCode === 301) {
                    // Follow redirect
                    https.get(ghRes.headers.location, ghRes2 => {
                        res.setHeader('Content-Type', entry.mimeType || 'application/octet-stream');
                        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(entry.name)}"`);
                        ghRes2.pipe(res);
                        // Cache to disk for next time
                        const chunks = [];
                        ghRes2.on('data', c => chunks.push(c));
                        ghRes2.on('end', () => {
                            try {
                                fs.mkdirSync(projectDir, { recursive: true });
                                fs.writeFileSync(diskPath, Buffer.concat(chunks));
                            } catch (_) {}
                        });
                    }).on('error', () => res.status(502).json({ error: 'Failed to fetch from GitHub' }));
                    return;
                }
                res.setHeader('Content-Type', entry.mimeType || 'application/octet-stream');
                res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(entry.name)}"`);
                ghRes.pipe(res);
            });
            ghReq.on('error', () => res.status(502).json({ error: 'Failed to fetch from GitHub' }));
        } catch (e) { res.status(500).json({ error: e.message }); }
    } else {
        res.status(404).json({ error: 'File not found. Please re-upload.' });
    }
});

// DELETE /api/wfdocs/:projectId/:fileId — delete a file from disk + GitHub Release
app.delete('/api/wfdocs/:projectId/:fileId', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    const { projectId, fileId } = req.params;
    const projectDir = path.join(WF_DOCS_DIR, projectId);
    try {
        const diskPath = path.join(projectDir, fileId + '.bin');
        const metaPath = path.join(projectDir, fileId + '.meta.json');
        if (fs.existsSync(diskPath)) fs.unlinkSync(diskPath);
        if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);

        // Remove from qa-shared.json and delete GitHub asset
        const shared = readQaData();
        const projKey = 'qa3_' + projectId;
        const before = (shared[projKey] && shared[projKey].wfdocs) || [];
        const entry = before.find(f => f.serverId === fileId);
        const after = before.filter(f => f.serverId !== fileId);
        _persistWfDocMeta(projectId, after);

        // Delete from GitHub Release if we have the asset id
        if (entry && entry.ghAssetId) await _ghDeleteWfDocAsset(entry.ghAssetId);

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── SHARED DATA API endpoints ──

// GET /api/qa-data — return all shared keys (deduped before sending)
// _DEPLOY_VERSION is checked by client to detect stale deploys
const _DEPLOY_VERSION = 'v20260529-dedup-final';
app.get('/api/qa-data', (req, res) => {
    const raw = readQaData();
    // Apply dedup to all per-project objects before sending to client
    const out = { _deployVersion: _DEPLOY_VERSION };
    for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith('qa3_') && v && typeof v === 'object' && !Array.isArray(v)) {
            out[k] = deduplicateProjectData(v);
        } else {
            out[k] = v;
        }
    }
    res.json(out);
});

// GET /api/health — public status check; pings MongoDB and reports cache state
app.get('/api/health', async (req, res) => {
    try {
        await pingDB();
        const keys = Object.keys(_qaCache);
        const projectCount = keys.filter(k => k.startsWith('qa3_') &&
            !['qa3_daily_tasks','qa3_team_tasks','qa3_releases'].includes(k) &&
            !k.includes('test') && !k.includes('heartbeat')).length;
        res.json({
            status:       'ok',
            database:     'connected',
            dataLoaded:   keys.length > 0,
            projectCount,
            totalKeys:    keys.length,
            activeUsers:  _sseClients.size,
            deployVersion: _DEPLOY_VERSION,
            uptime:       Math.floor(process.uptime())
        });
    } catch (e) {
        res.status(500).json({ status: 'error', database: 'disconnected', error: e.message });
    }
});

// GET /api/events — SSE stream; pushes qa-data-update/delete events to all connected clients
app.get('/api/events', (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).end();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx proxy buffering
    res.flushHeaders();
    res.write('event: connected\ndata: {"ok":true}\n\n');
    _sseClients.add(res);
    // Keepalive ping every 25s to prevent proxy/load-balancer timeouts
    const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch (_) { clearInterval(ping); _sseClients.delete(res); }
    }, 25000);
    req.on('close', () => { clearInterval(ping); _sseClients.delete(res); });
});

// GET /api/backup — download full qa-shared.json as a file (for manual backup)
app.get('/api/backup', (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const data = readQaData();
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="adhash-qa-backup-${ts}.json"`);
        res.send(JSON.stringify(data, null, 2));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/qa-data/:key — return one key (deduped before sending)
app.get('/api/qa-data/:key', (req, res) => {
    const data = readQaData();
    const key = req.params.key;
    if (!(key in data)) return res.status(404).json({ error: 'Key not found' });
    let value = data[key];
    // Apply dedup on per-project objects before returning to client
    if (key.startsWith('qa3_') && value && typeof value === 'object' && !Array.isArray(value)) {
        value = deduplicateProjectData(value);
    } else if (key === 'qa3_team_tasks' && Array.isArray(value)) {
        value = mergeTeamTasks([], value);
    } else if (key === 'qa3_daily_tasks' && Array.isArray(value)) {
        value = mergeDailyTasks([], value);
    }
    res.json({ key, value });
});

// DELETE /api/qa-data/:key — remove a key
app.delete('/api/qa-data/:key', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    const key = req.params.key;
    try {
        delete _qaCache[key];
        await deleteKey(key);
        res.json({ status: 'deleted', key });
        broadcastSseEvent('qa-data-delete', { key });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/qa-data-bulk — restore many keys at once (used by restore tool)
app.post('/api/qa-data-bulk', async (req, res) => {
    const { records } = req.body || {};
    if (!records || typeof records !== 'object') return res.status(400).json({ error: 'Missing records' });
    let count = 0;
    try {
        await _withWriteLock(async () => {
            const data = _qaCache;
            for (const [k, v] of Object.entries(records)) {
                if (!k || v === undefined || v === null) continue;
                if (k === 'qa3_daily_tasks') data[k] = mergeDailyTasks(data[k], v);
                else if (k === 'qa3_team_tasks') data[k] = mergeTeamTasks(data[k], v);
                else if (k === 'qa3_releases') data[k] = mergeReleases(data[k], v);
                else if (k.startsWith('qa3_') && v && typeof v === 'object' && !Array.isArray(v)) data[k] = mergeProjectData(data[k], v);
                else data[k] = v;
                count++;
            }
        });
        // Persist all changed keys to MongoDB
        for (const k of Object.keys(records)) {
            try { await writeKey(k, _qaCache[k]); } catch (e) { console.error('[mongo] bulk write failed for', k, e.message); }
        }
        res.json({ status: 'saved', count, dbSaved: true });
        for (const k of Object.keys(records)) {
            if (_qaCache[k] !== undefined) broadcastSseEvent('qa-data-update', { key: k, value: _qaCache[k] });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Smart merge helpers — prevent multi-user overwrite on shared arrays
// Each user's browser only has their slice of data; a full replace would clobber other users' rows.

// Merge daily tasks: keyed by (date, projectId) — each row is unique per project per day
function mergeDailyTasks(existing, incoming) {
    if (!Array.isArray(incoming)) return existing;
    const byId = new Map();
    const byNk = new Map();
    const nk = r => (r.date||'') + '|' + (r.projectId||'');
    (existing || []).forEach(r => { if (r.id) byId.set(r.id, r); else byNk.set(nk(r), r); });
    incoming.forEach(r => { if (r.id) byId.set(r.id, r); else byNk.set(nk(r), r); });
    // Build set of date|projectId keys already covered by id-keyed entries
    // so no-id legacy entries don't create duplicates alongside them
    const coveredById = new Set(Array.from(byId.values()).map(nk));
    const nkOnly = Array.from(byNk.entries())
        .filter(([k]) => !coveredById.has(k))
        .map(([, v]) => v);
    return [...Array.from(byId.values()), ...nkOnly];
}

// Merge team tasks: keyed by id when present, otherwise by (date, projectId) for legacy items
function mergeTeamTasks(existing, incoming) {
    if (!Array.isArray(incoming)) return existing;
    const byId = new Map();
    const byNk = new Map(); // natural key fallback for legacy items without id
    const nk = r => (r.date||'') + '|' + (r.projectId||'');
    (existing || []).forEach(r => {
        if (r.id) byId.set(r.id, r); else byNk.set(nk(r), r);
    });
    incoming.forEach(r => {
        if (r.id) byId.set(r.id, r); else byNk.set(nk(r), r);
    });
    // Drop no-id entries whose date|projectId is already covered by an id-keyed entry
    const coveredById = new Set(Array.from(byId.values()).map(nk));
    const nkOnly = Array.from(byNk.entries())
        .filter(([k]) => !coveredById.has(k))
        .map(([, v]) => v);
    return [...Array.from(byId.values()), ...nkOnly];
}

// Merge releases: keyed by id
function mergeReleases(existing, incoming) {
    if (!Array.isArray(incoming)) return existing;
    const map = new Map();
    (existing || []).forEach(r => { if (r.id) map.set(r.id, r); });
    incoming.forEach(r => { if (r.id) map.set(r.id, r); });
    return Array.from(map.values());
}

// Generic array merge by id field — for any sub-array that uses an 'id' key.
// For legacy items without an id, use a natural key (name+url or name alone) to deduplicate
// so repeated heartbeat saves never produce duplicates even for old records.
function mergeById(existing, incoming) {
    if (!Array.isArray(incoming)) return existing || [];
    if (!Array.isArray(existing) || existing.length === 0) return incoming;
    const byId = new Map();
    existing.forEach(r => { if (r && r.id) byId.set(r.id, r); });
    incoming.forEach(r => { if (r && r.id) byId.set(r.id, r); });
    // For items without id, deduplicate by natural key: name+url (or just name if no url)
    const noIdMap = new Map();
    const natKey = r => ((r && r.name) || '') + '|' + ((r && r.url) || '') + '|' + ((r && r.environment) || '');
    existing.filter(r => r && !r.id).forEach(r => noIdMap.set(natKey(r), r));
    // Incoming wins for matching natural key
    incoming.filter(r => r && !r.id).forEach(r => noIdMap.set(natKey(r), r));
    return [...Array.from(byId.values()), ...Array.from(noIdMap.values())];
}

// Merge smoke/prod rows: stable 'id' like SMK-01, PRD-01 — merge by that id
// Status, owner, comment are the mutable fields; structure fields are trusted from incoming
function mergeTestRows(existing, incoming) {
    if (!Array.isArray(incoming)) return existing || [];
    if (!Array.isArray(existing) || existing.length === 0) return incoming;
    const byId = new Map();
    const byNk = new Map();
    // Natural key for legacy rows without id: module+step (or module+item for prod)
    const nk = r => ((r && r.module) || '') + '|' + ((r && r.step) || '') + '|' + ((r && r.item) || '');
    existing.forEach(r => { if (r && r.id) byId.set(r.id, r); else if (r) byNk.set(nk(r), r); });
    // Incoming wins — preserves status/comment updates
    incoming.forEach(r => { if (r && r.id) byId.set(r.id, r); else if (r) byNk.set(nk(r), r); });
    return [...Array.from(byId.values()), ...Array.from(byNk.values())];
}

// Deep merge a qa3_<projectId> project object.
// Sub-arrays that multiple users can edit concurrently are merged by row id.
// Scalar fields (env, gates) are replaced by incoming (only admin edits those).
const PROJECT_ARRAY_KEYS = ['smoke', 'prod', 'feedback', 'thirdparty', 'taskchecklist',
                            'pendingtasks', 'credentials', 'apitests', 'testdata',
                            'releaseNotes', 'reports', 'pending'];

function mergeProjectData(existing, incoming) {
    if (!existing || typeof existing !== 'object') return incoming;
    if (!incoming || typeof incoming !== 'object') return existing;
    // Start from existing so keys NOT present in incoming are preserved (not wiped)
    const merged = { ...existing };
    for (const key of Object.keys(incoming)) {
        const inVal = incoming[key];
        // Never clobber existing data with null/undefined
        if (inVal === null || inVal === undefined) continue;
        if (PROJECT_ARRAY_KEYS.includes(key)) {
            if (key === 'smoke' || key === 'prod') {
                merged[key] = mergeTestRows(existing[key], inVal);
            } else {
                merged[key] = mergeById(existing[key], inVal);
            }
        } else if (key === 'envDetails' && inVal && typeof inVal === 'object') {
            merged[key] = {
                production: mergeById((existing[key]||{}).production, inVal.production),
                staging:    mergeById((existing[key]||{}).staging,    inVal.staging),
            };
        } else {
            // Scalar/object fields — incoming wins only if it has a real value
            merged[key] = inVal;
        }
    }
    return merged;
}

// POST /api/qa-data/:key — save one key's value, serialised through write lock to prevent race.
// The write lock ensures concurrent requests read-modify-write sequentially, not in parallel.
app.post('/api/qa-data/:key', async (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    const key = req.params.key;
    const { value } = req.body;
    if (value === undefined) return res.status(400).json({ error: 'Missing value' });

    try {
        await _withWriteLock(async () => {
            // Merge into in-memory cache (prevents concurrent writes clobbering each other)
            if (key === 'qa3_daily_tasks') {
                _qaCache[key] = mergeDailyTasks(_qaCache[key], value);
            } else if (key === 'qa3_team_tasks') {
                _qaCache[key] = mergeTeamTasks(_qaCache[key], value);
            } else if (key === 'qa3_releases') {
                _qaCache[key] = mergeReleases(_qaCache[key], value);
            } else if (key.startsWith('qa3_') && value && typeof value === 'object' && !Array.isArray(value)) {
                _qaCache[key] = mergeProjectData(_qaCache[key], value);
            } else {
                _qaCache[key] = value;
            }
        });
        // Persist merged value to MongoDB
        await writeKey(key, _qaCache[key]);
        res.json({ status: 'saved', key, dbSaved: true });
        // Broadcast merged value to all connected clients
        try { broadcastSseEvent('qa-data-update', { key, value: _qaCache[key] }); } catch (_) {}
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── ASSIGNMENT NOTIFICATION EMAIL + SLACK ──
// POST /api/notify-assignment — respond IMMEDIATELY (202), send email+Slack in background
app.post('/api/notify-assignment', (req, res) => {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });

    const { type, assignedBy, assignedTo, projectName, subject: subjectOverride, details, dashboardUrl } = req.body || {};
    if (!type) return res.status(400).json({ error: 'Missing required field: type' });

    // Respond immediately so the browser never hangs
    res.json({ queued: true, type, projectName });
    console.log(`[notify] queued → type:${type} project:${projectName} assignedBy:${assignedBy||'(none)'}`);

    // Fire all notifications asynchronously in the background
    _sendNotificationsAsync({ type, assignedBy: assignedBy || 'Dashboard', assignedTo, projectName, subject: subjectOverride, details, dashboardUrl });
});

async function _sendNotificationsAsync({ type, assignedBy, assignedTo, projectName, subject: subjectOverride, details, dashboardUrl }) {
    console.log(`[notify] _sendNotificationsAsync start → ZOHO_MAIL_ENABLED=${process.env.ZOHO_MAIL_ENABLED} SLACK_ENABLED=${process.env.SLACK_ENABLED} ZOHO_MAIL_USER=${process.env.ZOHO_MAIL_USER} type=${type}`);
    if (process.env.ZOHO_MAIL_ENABLED !== 'true' && process.env.SLACK_ENABLED !== 'true') {
        console.log('[notify] both mail and slack disabled — skipping');
        return;
    }

    // Resolve assignedBy → email using qa_users from shared data
    const sharedData = readQaData();
    const users = sharedData['qa_users'] || [];
    const DEFAULT_EMAILS = {
        'Deepa': 'deepa@adhashtech.com',
        'Prakash Raj': 'prakashraj@adhashtech.com',
        'Raghuram': 'raghuram@adhashtech.com',
        'Thenilavan': 'thenilavan@adhashtech.com',
        'Yogesh': 'yogesh@adhashtech.com',
    };
    const findEmail = (name) => {
        if (!name) return null;
        const u = users.find(u => u.name && u.name.toLowerCase() === name.toLowerCase());
        if (u && u.email) return u.email;
        for (const [k, v] of Object.entries(DEFAULT_EMAILS)) {
            if (k.toLowerCase() === name.toLowerCase()) return v;
        }
        return null;
    };

    const assignedByEmail = findEmail(assignedBy);
    const assignedToEmail = assignedTo ? findEmail(assignedTo) : null;

    // Build recipients: always notify thenilavan, and include assignedTo if resolved
    const toList = new Set(['thenilavan@adhashtech.com']);
    if (assignedByEmail && assignedByEmail !== 'thenilavan@adhashtech.com') toList.add(assignedByEmail);
    if (assignedToEmail) toList.add(assignedToEmail);
    const toAddresses = [...toList].join(', ');

    // Type labels
    const typeLabels = {
        'teamtask': '📋 Team Task Assigned',
        'release_today': '🚀 Today\'s Release',
        'release_next': '📆 Next Release',
        'feedback_req': '📋 New Client Requirement',
        'feedback_bug': '🐛 New Bug Reported',
    };
    const typeLabel = typeLabels[type] || '📌 Dashboard Notification';
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    const dashUrl = dashboardUrl || 'https://adhashprojectdashboard-production.up.railway.app/';

    // Build detail rows HTML
    const detailRowsHtml = (details || []).map(d =>
        `<tr><td style="padding:10px 16px;font-size:13px;color:#64748b;font-weight:600;white-space:nowrap;vertical-align:top;border-bottom:1px solid #f1f5f9;width:36%">${d.label}</td><td style="padding:10px 16px;font-size:13px;color:#1e293b;vertical-align:top;border-bottom:1px solid #f1f5f9">${d.value||'—'}</td></tr>`
    ).join('');

    const subjectLine = subjectOverride || `${typeLabel} — ${projectName || 'AdHash Dashboard'} | ${dateStr}`;

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f8;padding:32px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
  <!-- Header gradient -->
  <tr><td style="background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 50%,#ec4899 100%);padding:32px 36px">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td>
          <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:rgba(255,255,255,0.7);margin-bottom:6px">AdHash QA Dashboard</div>
          <div style="font-size:22px;font-weight:800;color:#ffffff;line-height:1.2">${typeLabel}</div>
          ${projectName?`<div style="margin-top:8px;display:inline-block;background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.3);border-radius:50px;padding:4px 14px;font-size:12px;font-weight:700;color:#fff">📁 ${projectName}</div>`:''}
        </td>
        <td align="right" style="vertical-align:top">
          <div style="background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);border-radius:10px;padding:10px 14px;text-align:right">
            <div style="font-size:11px;color:rgba(255,255,255,0.75);font-weight:600">Assigned by</div>
            <div style="font-size:15px;font-weight:800;color:#fff;margin-top:2px">${assignedBy||'—'}</div>
          </div>
        </td>
      </tr>
    </table>
  </td></tr>
  <!-- Date/time bar -->
  <tr><td style="background:#f8fafc;padding:10px 36px;border-bottom:1px solid #e2e8f0">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:12px;color:#64748b;font-weight:600">📅 ${dateStr}</td>
      <td align="right" style="font-size:12px;color:#64748b;font-weight:600">🕐 ${timeStr}</td>
    </tr></table>
  </td></tr>
  <!-- Details table -->
  <tr><td style="padding:24px 36px">
    <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;margin-bottom:14px">Assignment Details</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
      ${detailRowsHtml}
    </table>
  </td></tr>
  <!-- CTA -->
  <tr><td align="center" style="padding:8px 36px 28px">
    <a href="${dashUrl}" style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;padding:14px 32px;border-radius:50px;font-size:14px;font-weight:800;letter-spacing:.3px;box-shadow:0 4px 16px rgba(99,102,241,.35)">🚀 Open Dashboard →</a>
  </td></tr>
  <!-- Footer -->
  <tr><td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 36px;text-align:center">
    <div style="font-size:11px;color:#94a3b8">This is an automated notification from AdHash QA Dashboard. Do not reply to this email.</div>
    <div style="font-size:11px;color:#94a3b8;margin-top:4px">© ${now.getFullYear()} AdHash Technologies · <a href="${dashUrl}" style="color:#6366f1;text-decoration:none">adhashprojectdashboard-production.up.railway.app</a></div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

    // ── Send Email + Slack in parallel (both non-blocking, errors logged only) ──
    const emailPromise = (process.env.ZOHO_MAIL_ENABLED === 'true')
        ? sendZohoMail({
            subject: subjectLine,
            html,
            to: toAddresses,
            cc: process.env.ZOHO_MAIL_CC || 'qateam@adhashtech.com'
          })
            .then(() => console.log(`[notify] ✅ Email → to:${toAddresses} cc:${process.env.ZOHO_MAIL_CC} | ${type} | ${projectName}`))
            .catch(e => console.error(`[notify] ❌ Email failed (${type}):`, e.message))
        : Promise.resolve();

    const slackPromise = (process.env.SLACK_ENABLED === 'true')
        ? sendSlackNotification({ type, projectName, assignedBy, assignedTo, details, dashboardUrl: dashUrl })
            .then(() => console.log(`[notify] ✅ Slack → ${process.env.SLACK_CHANNEL} | ${type} | ${projectName}`))
            .catch(e => console.error(`[notify] ❌ Slack failed (${type}):`, e.message))
        : Promise.resolve();

    // Wait for both (for logging), but this runs after response already sent
    Promise.all([emailPromise, slackPromise])
        .catch(e => console.error('[notify] unexpected error:', e.message));
}

// Deduplicate a single array: keyed by id if present, otherwise by natural key (name+url+environment).
function deduplicateArray(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return arr;
    const byId = new Map();
    const byNatKey = new Map();
    const natKey = r => ((r && r.name) || '') + '|' + ((r && r.url) || '') + '|' + ((r && r.environment) || '');
    arr.forEach(r => {
        if (r && r.id) byId.set(r.id, r);
        else byNatKey.set(natKey(r), r);
    });
    return [...Array.from(byId.values()), ...Array.from(byNatKey.values())];
}

// Dedup a single project object in memory — used by GET /api/qa-data/:key before sending to client
const PROJECT_ARRAY_KEYS_ALL = ['smoke', 'prod', 'feedback', 'thirdparty', 'taskchecklist',
    'pendingtasks', 'credentials', 'apitests', 'testdata', 'releaseNotes', 'reports', 'pending', 'wfdocs'];
function deduplicateProjectData(proj) {
    if (!proj || typeof proj !== 'object') return proj;
    const out = { ...proj };
    PROJECT_ARRAY_KEYS_ALL.forEach(k => {
        if (Array.isArray(out[k]) && out[k].length > 0) out[k] = deduplicateArray(out[k]);
    });
    if (out.envDetails) {
        if (Array.isArray(out.envDetails.production)) out.envDetails = { ...out.envDetails, production: deduplicateArray(out.envDetails.production) };
        if (Array.isArray(out.envDetails.staging))    out.envDetails = { ...out.envDetails, staging:    deduplicateArray(out.envDetails.staging)    };
    }
    if (Array.isArray(out.thirdparty)) {
        out.thirdparty = out.thirdparty.map(acct => ({
            ...acct,
            apis: Array.isArray(acct.apis) ? deduplicateArray(acct.apis) : acct.apis
        }));
    }
    return out;
}

// Deduplicate all project sub-arrays on startup.
// Uses deduplicateArray so even legacy records without an 'id' are cleaned.
async function deduplicateAllProjectData() {
    const data = readQaData();
    let changed = false;

    // Dedup top-level team tasks and daily tasks arrays
    if (Array.isArray(data['qa3_team_tasks']) && data['qa3_team_tasks'].length > 0) {
        const before = data['qa3_team_tasks'].length;
        data['qa3_team_tasks'] = mergeTeamTasks([], data['qa3_team_tasks']);
        if (data['qa3_team_tasks'].length !== before) {
            console.log(`[dedup] qa3_team_tasks: ${before} → ${data['qa3_team_tasks'].length}`);
            changed = true;
        }
    }
    if (Array.isArray(data['qa3_daily_tasks']) && data['qa3_daily_tasks'].length > 0) {
        const before = data['qa3_daily_tasks'].length;
        data['qa3_daily_tasks'] = mergeDailyTasks([], data['qa3_daily_tasks']);
        if (data['qa3_daily_tasks'].length !== before) {
            console.log(`[dedup] qa3_daily_tasks: ${before} → ${data['qa3_daily_tasks'].length}`);
            changed = true;
        }
    }

    for (const key of Object.keys(data)) {
        if (!key.startsWith('qa3_')) continue;
        const proj = data[key];
        if (!proj || typeof proj !== 'object' || Array.isArray(proj)) continue;
        for (const arrKey of PROJECT_ARRAY_KEYS) {
            if (!Array.isArray(proj[arrKey]) || proj[arrKey].length === 0) continue;
            const before = proj[arrKey].length;
            proj[arrKey] = deduplicateArray(proj[arrKey]);
            if (proj[arrKey].length !== before) {
                console.log(`[dedup] ${key}.${arrKey}: ${before} → ${proj[arrKey].length}`);
                changed = true;
            }
        }
        // Dedup thirdparty.apis nested arrays
        if (Array.isArray(proj.thirdparty)) {
            proj.thirdparty.forEach(acct => {
                if (!Array.isArray(acct.apis) || acct.apis.length === 0) return;
                const before = acct.apis.length;
                acct.apis = deduplicateArray(acct.apis);
                if (acct.apis.length !== before) {
                    console.log(`[dedup] ${key}.thirdparty[${acct.name}].apis: ${before} → ${acct.apis.length}`);
                    changed = true;
                }
            });
        }
        // Dedup envDetails
        if (proj.envDetails && typeof proj.envDetails === 'object') {
            for (const side of ['production', 'staging']) {
                if (!Array.isArray(proj.envDetails[side]) || proj.envDetails[side].length === 0) continue;
                const before = proj.envDetails[side].length;
                proj.envDetails[side] = deduplicateArray(proj.envDetails[side]);
                if (proj.envDetails[side].length !== before) {
                    console.log(`[dedup] ${key}.envDetails.${side}: ${before} → ${proj.envDetails[side].length}`);
                    changed = true;
                }
            }
        }
        // Dedup wfdocs by name — keep entry with serverId preferred over legacy entry
        if (Array.isArray(proj.wfdocs) && proj.wfdocs.length > 0) {
            const before = proj.wfdocs.length;
            const seenNames = new Map();
            proj.wfdocs.forEach(f => {
                const k = (f.name || '').trim();
                if (!seenNames.has(k)) { seenNames.set(k, f); }
                else {
                    const ex = seenNames.get(k);
                    if (!ex.serverId && f.serverId) seenNames.set(k, f);
                    else if (!ex.ghUrl && f.ghUrl) seenNames.set(k, f);
                }
            });
            proj.wfdocs = Array.from(seenNames.values());
            if (proj.wfdocs.length !== before) {
                console.log(`[dedup] ${key}.wfdocs: ${before} → ${proj.wfdocs.length}`);
                changed = true;
            }
        }
    }
    if (changed) {
        _qaCache = data;
        console.log('[dedup] cleaned duplicates — persisting to MongoDB');
        for (const [k, v] of Object.entries(data)) {
            try { await writeKey(k, v); } catch (e) { console.error('[dedup] MongoDB write failed:', k, e.message); }
        }
    } else {
        console.log('[dedup] no duplicates found');
    }
}

// On startup: migrate any local wfdoc .bin files that have no ghUrl yet to GitHub Releases.
// Also performs a full dedup pass on ALL project wfdoc lists to fix any previously accumulated duplicates.
async function migrateWfDocsToGitHub() {
    const token = process.env.GITHUB_TOKEN || process.env.GH_PAT || '';
    if (!token) return;
    const shared = readQaData();
    let anyChanged = false;

    for (const projKey of Object.keys(shared)) {
        if (!projKey.startsWith('qa3_')) continue;
        const projectId = projKey.replace('qa3_', '');
        const wfdocs = (shared[projKey] && shared[projKey].wfdocs) || [];
        if (!wfdocs.length) continue;

        // ── Always dedup by name first (defensive: fixes accumulated duplicates) ──
        const seenNames = new Map();
        for (const f of wfdocs) {
            const key = f.name;
            if (!seenNames.has(key)) { seenNames.set(key, f); }
            else {
                const ex = seenNames.get(key);
                if (!ex.serverId && f.serverId) seenNames.set(key, f);
                else if (ex.serverId && !ex.ghUrl && f.ghUrl) seenNames.set(key, f);
            }
        }
        const deduped = Array.from(seenNames.values());
        if (deduped.length !== wfdocs.length) {
            console.log(`[migrate] dedup ${projKey}: ${wfdocs.length} → ${deduped.length}`);
            shared[projKey].wfdocs = deduped;
            anyChanged = true;
        }

        // ── Migrate files that have a local .bin but no ghUrl yet ──
        const needMigration = deduped.filter(f => !f.ghUrl && f.serverId);
        if (!needMigration.length) continue;
        const projectDir = path.join(WF_DOCS_DIR, projectId);
        for (const entry of needMigration) {
            const binPath = path.join(projectDir, entry.serverId + '.bin');
            const metaPath = path.join(projectDir, entry.serverId + '.meta.json');
            if (!fs.existsSync(binPath)) { console.log(`[migrate] No bin for ${entry.name} — skipping`); continue; }
            try {
                const buffer = fs.readFileSync(binPath);
                const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
                const mimeType = meta.mimeType || entry.mimeType || 'application/octet-stream';
                const assetName = (entry.serverId) + '_' + (entry.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
                const releaseId = await _ghEnsureWfDocRelease();
                if (!releaseId) continue;
                const ghUrl = await _ghUploadWfDocAsset(releaseId, assetName, buffer, mimeType);
                if (ghUrl) {
                    // Get asset id
                    const rel = await _ghRequest('GET', `/repos/${GH_API_REPO}/releases/tags/${GH_WFDOC_RELEASE_TAG}`, null, token);
                    const asset = rel.status === 200 ? (rel.body.assets || []).find(a => a.name === assetName) : null;
                    entry.ghUrl = ghUrl;
                    entry.ghAssetId = asset ? asset.id : null;
                    entry.assetName = assetName;
                    anyChanged = true;
                    console.log(`[migrate] Uploaded "${entry.name}" to GitHub Release`);
                }
            } catch (e) { console.error(`[migrate] Failed for ${entry.name}:`, e.message); }
        }
    }
    if (anyChanged) { writeQaData(shared); console.log('[migrate] wfdoc dedup/migration complete, qa-shared.json updated'); }
}

// Start server — connect to MongoDB, load cache, THEN start listening
(async () => {
    try {
        await connectDB();
        _qaCache = await readAllData();
        const keyCount = Object.keys(_qaCache).length;
        console.log(`[startup] ✅ Loaded ${keyCount} keys from MongoDB into cache`);
    } catch (e) {
        console.error('[startup] ⚠️  MongoDB connection failed:', e.message);
        console.error('[startup] Starting with empty cache — data will be unavailable until MongoDB connects');
        // Do NOT exit — let the server start so Railway health checks pass.
        // Reconnection will be attempted on first data request.
    }
    app.listen(PORT, () => {
    testRunning = false;
    testResults = null;
    testLogs = [];
    currentSuite = null;

    console.log('\n╔════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                   AdHash Unified Test Dashboard                           ║');
    console.log('║                        Running on Localhost                                ║');
    console.log('╚════════════════════════════════════════════════════════════════════════════╝\n');
    console.log(`🚀 Server is running at: http://localhost:${PORT}`);
    console.log(`📊 Unified Dashboard: http://localhost:${PORT}/`);
    console.log(`📈 Playwright Report: http://localhost:${PORT}/playwright-report`);
    console.log(`🔧 API Summary: http://localhost:${PORT}/api/test-summary`);
    console.log('\n✨ Press Ctrl+C to stop the server\n');

    // Log server startup
    logToArray('info', `Server started successfully on port ${PORT}`);
    logToArray('info', 'Project dashboard available at http://localhost:' + PORT);

    // On startup, recover persisted test results.
    (async () => {
        try {
            const recovered = await recoverCompletedRunFromState();
            if (recovered) {
                addLog('📦 Recovered persisted test results on startup.', 'info');
            } else {
                addLog('ℹ️ No persisted summary found on startup; skipped recovery mail dispatch.', 'info');
            }
        } catch (error) {
            addLog('❌ Startup recovery/mail dispatch failed: ' + (error && error.message), 'error');
            console.error('Startup recovery/mail dispatch failed:', error);
        }
    })();
});
})(); // end startup async IIFE

// Graceful shutdown — wait for in-flight writes then close MongoDB connection.
process.on('SIGTERM', async () => {
    console.log('[shutdown] SIGTERM received — waiting for write queue then closing MongoDB');
    const killTimer = setTimeout(() => { process.exit(0); }, 10000);
    killTimer.unref();
    try {
        await _writeQueue; // wait for any in-flight cache writes
        const { closeDB } = require('./src/db');
        await closeDB();
        console.log('[shutdown] MongoDB connection closed cleanly');
    } catch (e) {
        console.error('[shutdown] Error during shutdown:', e.message);
    }
    process.exit(0);
});


'use strict';
/**
 * routes/security-tests.js
 * Practical security scanner — runs server-side using axios + Node built-ins.
 * Checks: security headers, SSL/TLS, CORS, open redirects, sensitive paths,
 *         HTTP methods, information disclosure, rate limiting.
 */

const router  = require('express').Router();
const axios   = require('axios');
const https   = require('https');
const tls     = require('tls');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const url     = require('url');

const REPORTS_DIR = path.join(__dirname, '..', 'reports', 'security-tests');
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

// ── In-memory run registry ──
const _runs = new Map();

// ── Auth ──
function isAuth(req) {
    if (req.user || req.session?.authenticated) return true;
    const jwt = req.headers.authorization?.split(' ')[1] || req.query.token;
    if (!jwt) return false;
    try {
        const secret = process.env.JWT_SECRET || 'adhash-qa-jwt-secret-change-in-production-2026';
        require('jsonwebtoken').verify(jwt, secret);
        return true;
    } catch { return false; }
}
function auth(req, res, next) {
    if (!isAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

// ── Axios instance (ignores self-signed certs for scanning) ──
const ax = axios.create({
    timeout: 8000,
    maxRedirects: 0,
    validateStatus: () => true,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    headers: { 'User-Agent': 'AdHash-SecurityScanner/1.0' },
});

// ── Severity levels ──
const SEV = { CRITICAL: 'CRITICAL', HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW', INFO: 'INFO', PASS: 'PASS' };

// ── Finding builder ──
function finding(id, category, title, severity, status, detail, recommendation = '') {
    return { id, category, title, severity, status, detail, recommendation };
}

// ══════════════════════════════════════════════════════════════════════════
// SECURITY CHECKS
// ══════════════════════════════════════════════════════════════════════════

async function checkSecurityHeaders(targetUrl, findings, log) {
    log('Checking security headers...');
    let res;
    try { res = await ax.get(targetUrl); } catch (e) { findings.push(finding('hdr-err','Security Headers','Headers check failed',SEV.INFO,'error',e.message)); return; }

    const h = res.headers;
    const checks = [
        {
            key: 'strict-transport-security', id: 'hsts',
            title: 'HTTP Strict Transport Security (HSTS)',
            pass: !!h['strict-transport-security'],
            detail: h['strict-transport-security'] || 'Header missing',
            sev: SEV.HIGH,
            rec: 'Add: Strict-Transport-Security: max-age=31536000; includeSubDomains; preload',
        },
        {
            key: 'content-security-policy', id: 'csp',
            title: 'Content Security Policy (CSP)',
            pass: !!h['content-security-policy'],
            detail: h['content-security-policy'] || 'Header missing',
            sev: SEV.HIGH,
            rec: 'Add a CSP header to prevent XSS. Start with: Content-Security-Policy: default-src \'self\'',
        },
        {
            key: 'x-frame-options', id: 'xfo',
            title: 'X-Frame-Options (Clickjacking)',
            pass: !!h['x-frame-options'],
            detail: h['x-frame-options'] || 'Header missing',
            sev: SEV.MEDIUM,
            rec: 'Add: X-Frame-Options: DENY or SAMEORIGIN',
        },
        {
            key: 'x-content-type-options', id: 'xcto',
            title: 'X-Content-Type-Options',
            pass: h['x-content-type-options'] === 'nosniff',
            detail: h['x-content-type-options'] || 'Header missing',
            sev: SEV.MEDIUM,
            rec: 'Add: X-Content-Type-Options: nosniff',
        },
        {
            key: 'referrer-policy', id: 'rp',
            title: 'Referrer-Policy',
            pass: !!h['referrer-policy'],
            detail: h['referrer-policy'] || 'Header missing',
            sev: SEV.LOW,
            rec: 'Add: Referrer-Policy: strict-origin-when-cross-origin',
        },
        {
            key: 'permissions-policy', id: 'pp',
            title: 'Permissions-Policy',
            pass: !!h['permissions-policy'] || !!h['feature-policy'],
            detail: h['permissions-policy'] || h['feature-policy'] || 'Header missing',
            sev: SEV.LOW,
            rec: 'Add: Permissions-Policy: geolocation=(), microphone=(), camera=()',
        },
        {
            key: 'x-xss-protection', id: 'xxss',
            title: 'X-XSS-Protection (legacy)',
            pass: !!h['x-xss-protection'],
            detail: h['x-xss-protection'] || 'Header missing (legacy but still recommended)',
            sev: SEV.LOW,
            rec: 'Add: X-XSS-Protection: 1; mode=block',
        },
    ];

    for (const c of checks) {
        findings.push(finding(
            c.id, 'Security Headers', c.title,
            c.pass ? SEV.PASS : c.sev,
            c.pass ? 'pass' : 'fail',
            c.detail,
            c.pass ? '' : c.rec,
        ));
    }
}

async function checkSSL(targetUrl, findings, log) {
    log('Checking SSL/TLS certificate...');
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== 'https:') {
        findings.push(finding('ssl-proto','SSL/TLS','Protocol is HTTP not HTTPS',SEV.CRITICAL,'fail','Application is served over plain HTTP — all traffic is unencrypted','Migrate to HTTPS immediately'));
        return;
    }
    try {
        await new Promise((resolve, reject) => {
            const socket = tls.connect({ host: parsed.hostname, port: parseInt(parsed.port) || 443, servername: parsed.hostname }, () => {
                const cert = socket.getPeerCertificate();
                const now  = Date.now();
                const exp  = new Date(cert.valid_to).getTime();
                const daysLeft = Math.round((exp - now) / 86400000);

                if (daysLeft < 0) {
                    findings.push(finding('ssl-exp','SSL/TLS','SSL Certificate EXPIRED',SEV.CRITICAL,'fail',`Expired on ${cert.valid_to}`,'Renew SSL certificate immediately'));
                } else if (daysLeft < 14) {
                    findings.push(finding('ssl-exp','SSL/TLS','SSL Certificate expiring very soon',SEV.HIGH,'fail',`Expires in ${daysLeft} days (${cert.valid_to})`,'Renew SSL certificate immediately'));
                } else if (daysLeft < 30) {
                    findings.push(finding('ssl-exp','SSL/TLS','SSL Certificate expiring soon',SEV.MEDIUM,'warn',`Expires in ${daysLeft} days (${cert.valid_to})`,'Plan certificate renewal'));
                } else {
                    findings.push(finding('ssl-exp','SSL/TLS','SSL Certificate valid',SEV.PASS,'pass',`Valid for ${daysLeft} more days. Expires ${cert.valid_to}`,''));
                }

                findings.push(finding('ssl-cn','SSL/TLS','Certificate Subject',SEV.INFO,'info',`CN=${cert.subject?.CN || '—'}, Issuer=${cert.issuer?.O || '—'}`,''));

                const proto = socket.getProtocol();
                const weak = ['TLSv1', 'TLSv1.1', 'SSLv3', 'SSLv2'];
                const isWeak = weak.some(p => proto?.includes(p));
                findings.push(finding('ssl-ver','SSL/TLS','TLS Version',isWeak ? SEV.HIGH : SEV.PASS, isWeak ? 'fail' : 'pass', `Protocol: ${proto || 'unknown'}`, isWeak ? 'Disable TLS 1.0 and 1.1. Use TLS 1.2+ only.' : ''));

                socket.end();
                resolve();
            });
            socket.on('error', reject);
            socket.setTimeout(6000, () => reject(new Error('TLS timeout')));
        });
    } catch (e) {
        findings.push(finding('ssl-err','SSL/TLS','SSL check failed',SEV.INFO,'error',e.message,''));
    }
}

async function checkCORS(targetUrl, findings, log) {
    log('Checking CORS configuration...');
    try {
        const res = await ax.get(targetUrl, { headers: { Origin: 'https://evil-attacker.com' } });
        const acao = res.headers['access-control-allow-origin'];
        const acac = res.headers['access-control-allow-credentials'];

        if (acao === '*') {
            findings.push(finding('cors-wild','CORS','Wildcard CORS origin (*)',SEV.MEDIUM,'fail','Access-Control-Allow-Origin: * — any domain can read responses','Restrict CORS to known origins instead of using wildcard'));
        } else if (acao === 'https://evil-attacker.com') {
            findings.push(finding('cors-reflect','CORS','CORS origin reflection vulnerability',SEV.HIGH,'fail','Server reflects any Origin header back — allows arbitrary cross-origin access','Maintain an explicit allowlist of trusted origins'));
        } else if (acao) {
            findings.push(finding('cors-ok','CORS','CORS origin restricted',SEV.PASS,'pass',`Access-Control-Allow-Origin: ${acao}`,''));
        } else {
            findings.push(finding('cors-none','CORS','No CORS headers present',SEV.PASS,'pass','No cross-origin access granted (good for non-API pages)',''));
        }

        if (acac === 'true' && (acao === '*' || acao === 'https://evil-attacker.com')) {
            findings.push(finding('cors-cred','CORS','CORS credentials exposed with permissive origin',SEV.CRITICAL,'fail','Access-Control-Allow-Credentials: true with a permissive origin — cookies/auth tokens leakable','Never combine credentials:true with wildcard or reflected origins'));
        }
    } catch (e) {
        findings.push(finding('cors-err','CORS','CORS check failed',SEV.INFO,'error',e.message,''));
    }
}

async function checkOpenRedirect(targetUrl, findings, log) {
    log('Checking for open redirects...');
    const parsed = new URL(targetUrl);
    const base   = `${parsed.protocol}//${parsed.host}`;
    const payloads = [
        `${base}/?redirect=https://evil-attacker.com`,
        `${base}/?url=https://evil-attacker.com`,
        `${base}/?next=https://evil-attacker.com`,
        `${base}/?return=https://evil-attacker.com`,
        `${base}/?goto=https://evil-attacker.com`,
    ];
    let found = false;
    for (const p of payloads) {
        try {
            const res = await ax.get(p);
            const loc = res.headers['location'] || '';
            if ((res.status >= 301 && res.status <= 308) && loc.startsWith('https://evil-attacker.com')) {
                findings.push(finding('redir','Open Redirect','Open Redirect vulnerability found',SEV.HIGH,'fail',`${p} redirects to ${loc}`,'Validate redirect URLs against an allowlist of trusted domains'));
                found = true;
                break;
            }
        } catch {}
    }
    if (!found) findings.push(finding('redir','Open Redirect','No open redirect found',SEV.PASS,'pass','Common redirect parameters do not redirect to external domains',''));
}

async function checkSensitivePaths(targetUrl, findings, log) {
    log('Checking sensitive/exposed paths...');
    const parsed = new URL(targetUrl);
    const base   = `${parsed.protocol}//${parsed.host}`;
    const paths  = [
        { path: '/.env',             sev: SEV.CRITICAL, title: '.env file exposed' },
        { path: '/.env.local',       sev: SEV.CRITICAL, title: '.env.local file exposed' },
        { path: '/.git/config',      sev: SEV.CRITICAL, title: 'Git repository exposed' },
        { path: '/config.json',      sev: SEV.CRITICAL, title: 'config.json exposed' },
        { path: '/credentials.json', sev: SEV.CRITICAL, title: 'credentials.json exposed' },
        { path: '/backup.sql',       sev: SEV.CRITICAL, title: 'Database backup exposed' },
        { path: '/wp-config.php',    sev: SEV.HIGH,     title: 'WordPress config exposed' },
        { path: '/admin',            sev: SEV.MEDIUM,   title: 'Admin panel accessible' },
        { path: '/phpinfo.php',      sev: SEV.HIGH,     title: 'phpinfo() exposed' },
        { path: '/server-status',    sev: SEV.MEDIUM,   title: 'Apache server-status exposed' },
        { path: '/actuator',         sev: SEV.HIGH,     title: 'Spring Boot Actuator exposed' },
        { path: '/actuator/env',     sev: SEV.CRITICAL, title: 'Spring Boot /actuator/env exposed' },
        { path: '/swagger-ui.html',  sev: SEV.LOW,      title: 'Swagger UI publicly accessible' },
        { path: '/api-docs',         sev: SEV.LOW,      title: 'API docs publicly accessible' },
        { path: '/graphql',          sev: SEV.LOW,      title: 'GraphQL endpoint accessible' },
        { path: '/.DS_Store',        sev: SEV.MEDIUM,   title: '.DS_Store file exposed' },
        { path: '/robots.txt',       sev: SEV.INFO,     title: 'robots.txt present (info)' },
        { path: '/sitemap.xml',      sev: SEV.INFO,     title: 'sitemap.xml present (info)' },
    ];

    const exposed = [];
    await Promise.all(paths.map(async p => {
        try {
            const res = await ax.get(base + p.path);
            if (res.status === 200) exposed.push({ ...p, status: res.status });
        } catch {}
    }));

    if (exposed.length === 0) {
        findings.push(finding('paths','Sensitive Paths','No sensitive paths exposed',SEV.PASS,'pass','Common sensitive files and paths are not publicly accessible',''));
    } else {
        for (const e of exposed) {
            findings.push(finding('path-' + e.path.replace(/\W/g,''), 'Sensitive Paths', e.title, e.sev, 'fail', `GET ${base + e.path} returned HTTP 200`, 'Restrict access to this path or remove the file from public directory'));
        }
    }
}

async function checkHTTPMethods(targetUrl, findings, log) {
    log('Checking dangerous HTTP methods...');
    const dangerous = ['TRACE', 'TRACK', 'PUT', 'DELETE', 'OPTIONS'];
    const allowed = [];
    for (const method of dangerous) {
        try {
            const res = await ax({ method, url: targetUrl });
            if (res.status < 405 && res.status !== 404) allowed.push(`${method} (${res.status})`);
            // OPTIONS — check what it advertises
            if (method === 'OPTIONS') {
                const allow = res.headers['allow'] || res.headers['access-control-allow-methods'] || '';
                if (allow) findings.push(finding('opt-allow','HTTP Methods','OPTIONS Allow header',SEV.INFO,'info',`Allow: ${allow}`,''));
            }
        } catch {}
    }
    if (allowed.filter(m => !m.startsWith('OPTIONS')).length > 0) {
        findings.push(finding('methods','HTTP Methods','Dangerous HTTP methods enabled',SEV.MEDIUM,'fail',`Methods responding: ${allowed.join(', ')}`, 'Disable TRACE, TRACK, and unneeded methods at the server/WAF level'));
    } else {
        findings.push(finding('methods','HTTP Methods','Dangerous HTTP methods blocked',SEV.PASS,'pass','TRACE/TRACK/PUT/DELETE return 405 or 404',''));
    }
}

async function checkInfoDisclosure(targetUrl, findings, log) {
    log('Checking information disclosure...');
    try {
        const res = await ax.get(targetUrl);
        const server  = res.headers['server']  || '';
        const powered = res.headers['x-powered-by'] || '';

        if (server && /\d/.test(server)) {
            findings.push(finding('srv-ver','Info Disclosure','Server version disclosed',SEV.LOW,'fail',`Server: ${server}`,'Remove version from Server header — expose only "nginx" not "nginx/1.18.0"'));
        } else if (server) {
            findings.push(finding('srv-name','Info Disclosure','Server technology disclosed',SEV.INFO,'info',`Server: ${server}`,'Consider removing the Server header entirely'));
        } else {
            findings.push(finding('srv-ok','Info Disclosure','Server header hidden',SEV.PASS,'pass','No Server header present',''));
        }

        if (powered) {
            findings.push(finding('powered','Info Disclosure','X-Powered-By header exposes technology',SEV.LOW,'fail',`X-Powered-By: ${powered}`,'Remove this header: res.removeHeader("X-Powered-By") in Express'));
        } else {
            findings.push(finding('powered-ok','Info Disclosure','X-Powered-By header not present',SEV.PASS,'pass','Technology stack not advertised in headers',''));
        }

        // Check for debug info in body
        const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || '');
        const debugPatterns = [
            { pattern: /stack trace/i,          title: 'Stack trace in response body' },
            { pattern: /exception in thread/i,  title: 'Java exception in response body' },
            { pattern: /SyntaxError|TypeError/i,title: 'JavaScript error in response body' },
            { pattern: /DEBUG\s*=/i,             title: 'Debug mode enabled in response' },
            { pattern: /password.*=.*[^\s]{6,}/i,title: 'Possible password in response body' },
        ];
        let debugFound = false;
        for (const d of debugPatterns) {
            if (d.pattern.test(body)) {
                findings.push(finding('debug','Info Disclosure', d.title, SEV.HIGH,'fail','Sensitive debug information found in response body','Disable debug mode and ensure error details are not sent to clients'));
                debugFound = true; break;
            }
        }
        if (!debugFound) findings.push(finding('debug-ok','Info Disclosure','No debug info in response body',SEV.PASS,'pass','Response body does not contain stack traces or debug output',''));

    } catch (e) {
        findings.push(finding('info-err','Info Disclosure','Info disclosure check failed',SEV.INFO,'error',e.message,''));
    }
}

async function checkRateLimit(targetUrl, findings, log) {
    log('Checking rate limiting...');
    try {
        const BURST = 20;
        const requests = Array.from({ length: BURST }, () => ax.get(targetUrl).catch(e => ({ status: 0, error: e.message })));
        const results  = await Promise.all(requests);
        const codes    = results.map(r => r.status);
        const limited  = codes.filter(c => c === 429).length;
        const errors   = codes.filter(c => c === 0).length;

        if (limited > 0) {
            findings.push(finding('rl','Rate Limiting','Rate limiting is active',SEV.PASS,'pass',`${limited}/${BURST} requests returned 429 Too Many Requests`,''));
        } else if (errors > BURST * 0.5) {
            findings.push(finding('rl','Rate Limiting','Rate limit check inconclusive',SEV.INFO,'warn',`${errors}/${BURST} requests errored — server may be down or blocking scanner`,''));
        } else {
            findings.push(finding('rl','Rate Limiting','No rate limiting detected',SEV.MEDIUM,'fail',`${BURST} rapid requests all succeeded without 429 response`,'Implement rate limiting — e.g. express-rate-limit for Node.js APIs'));
        }
    } catch (e) {
        findings.push(finding('rl-err','Rate Limiting','Rate limit check failed',SEV.INFO,'error',e.message,''));
    }
}

async function checkCookieSecurity(targetUrl, findings, log) {
    log('Checking cookie security...');
    try {
        const res = await ax.get(targetUrl);
        const cookies = res.headers['set-cookie'] || [];
        if (!cookies.length) {
            findings.push(finding('ck-none','Cookie Security','No cookies set on this endpoint',SEV.INFO,'info','No Set-Cookie headers found on the root response',''));
            return;
        }
        for (const ck of cookies) {
            const name = ck.split('=')[0];
            const hasSecure   = /;\s*Secure/i.test(ck);
            const hasHttpOnly = /;\s*HttpOnly/i.test(ck);
            const hasSameSite = /;\s*SameSite/i.test(ck);

            if (!hasSecure) findings.push(finding(`ck-sec-${name}`,'Cookie Security',`Cookie "${name}" missing Secure flag`,SEV.MEDIUM,'fail',ck,'Add the Secure attribute so cookie is only sent over HTTPS'));
            if (!hasHttpOnly) findings.push(finding(`ck-http-${name}`,'Cookie Security',`Cookie "${name}" missing HttpOnly flag`,SEV.MEDIUM,'fail',ck,'Add HttpOnly to prevent JavaScript access to the cookie'));
            if (!hasSameSite) findings.push(finding(`ck-ss-${name}`,'Cookie Security',`Cookie "${name}" missing SameSite attribute`,SEV.LOW,'fail',ck,'Add SameSite=Strict or SameSite=Lax to prevent CSRF'));
            if (hasSecure && hasHttpOnly && hasSameSite) findings.push(finding(`ck-ok-${name}`,'Cookie Security',`Cookie "${name}" properly secured`,SEV.PASS,'pass','Secure + HttpOnly + SameSite all present',''));
        }
    } catch (e) {
        findings.push(finding('ck-err','Cookie Security','Cookie check failed',SEV.INFO,'error',e.message,''));
    }
}

// ── Verdict calculation ──
function calcVerdict(findings) {
    const hasCritical = findings.some(f => f.severity === SEV.CRITICAL && f.status !== 'pass');
    const highCount   = findings.filter(f => f.severity === SEV.HIGH    && f.status !== 'pass').length;
    const medCount    = findings.filter(f => f.severity === SEV.MEDIUM  && f.status !== 'pass').length;
    if (hasCritical || highCount >= 3) return 'FAIL';
    if (highCount >= 1 || medCount >= 3) return 'RISK';
    return 'PASS';
}

function calcScore(findings) {
    let deductions = 0;
    for (const f of findings) {
        if (f.status === 'pass' || f.status === 'info' || f.status === 'error') continue;
        if (f.severity === SEV.CRITICAL) deductions += 25;
        else if (f.severity === SEV.HIGH)    deductions += 15;
        else if (f.severity === SEV.MEDIUM)  deductions += 8;
        else if (f.severity === SEV.LOW)     deductions += 3;
    }
    return Math.max(0, 100 - deductions);
}

// ══════════════════════════════════════════════════════════════════════════
// POST /api/security-test/start
// ══════════════════════════════════════════════════════════════════════════
router.post('/start', auth, async (req, res) => {
    const { projectName, environment, url: targetUrl, checks = [], executedBy = 'Dashboard' } = req.body || {};
    if (!targetUrl) return res.status(400).json({ error: 'url is required' });
    if (!/^https?:\/\//i.test(targetUrl)) return res.status(400).json({ error: 'url must start with http:// or https://' });

    // Prevent concurrent scan on same URL
    for (const [, run] of _runs) {
        if (run.status === 'running' && run.config.url === targetUrl) {
            return res.status(409).json({ error: `A scan is already running for ${targetUrl}` });
        }
    }

    const runId    = 'st_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    const startTime = new Date().toISOString();
    const enabledChecks = checks.length ? checks : ['headers','ssl','cors','redirect','paths','methods','info','ratelimit','cookies'];

    const state = {
        runId, status: 'running',
        config: { projectName, environment, url: targetUrl, checks: enabledChecks, executedBy, startTime },
        findings: [], logs: [], progress: 0, totalChecks: enabledChecks.length,
        startTime, endTime: null, verdict: null, score: null,
        reportPath: null,
    };
    _runs.set(runId, state);
    res.json({ runId, status: 'running' });

    setImmediate(() => _executeScan(runId, state));
});

const CHECK_MAP = {
    headers:   checkSecurityHeaders,
    ssl:       checkSSL,
    cors:      checkCORS,
    redirect:  checkOpenRedirect,
    paths:     checkSensitivePaths,
    methods:   checkHTTPMethods,
    info:      checkInfoDisclosure,
    ratelimit: checkRateLimit,
    cookies:   checkCookieSecurity,
};

async function _executeScan(runId, state) {
    const log = (msg) => {
        state.logs.push({ time: new Date().toISOString(), msg });
        if (state.logs.length > 200) state.logs.shift();
    };
    try {
        const checks = state.config.checks;
        let done = 0;
        for (const key of checks) {
            if (CHECK_MAP[key]) {
                await CHECK_MAP[key](state.config.url, state.findings, log);
            }
            done++;
            state.progress = Math.round((done / checks.length) * 100);
        }
        state.verdict = calcVerdict(state.findings);
        state.score   = calcScore(state.findings);
        state.status  = 'completed';
        state.endTime = new Date().toISOString();
        log(`Scan completed — ${state.findings.length} findings · Score ${state.score}/100 · Verdict ${state.verdict}`);
        _saveReport(runId, state);
    } catch (e) {
        state.status  = 'failed';
        state.endTime = new Date().toISOString();
        state.logs.push({ time: new Date().toISOString(), msg: 'Fatal: ' + e.message });
    }
}

// ── Save JSON + HTML ──
function _saveReport(runId, state) {
    try {
        const tmpl    = _loadTemplate();
        const jsonPath = path.join(REPORTS_DIR, `${runId}.json`);
        const htmlPath = path.join(REPORTS_DIR, `${runId}.html`);
        fs.writeFileSync(jsonPath, JSON.stringify(state, null, 2));
        fs.writeFileSync(htmlPath, _generateHtml(state, tmpl));
        state.reportPath = htmlPath;
    } catch (e) { console.error('[sec-test] save failed:', e.message); }
}

const TMPL_FILE = path.join(REPORTS_DIR, '_template.json');
function _loadTemplate() { try { return JSON.parse(fs.readFileSync(TMPL_FILE, 'utf8')); } catch { return {}; } }

// ══════════════════════════════════════════════════════════════════════════
// GET /api/security-test/status/:runId
// ══════════════════════════════════════════════════════════════════════════
router.get('/status/:runId', auth, (req, res) => {
    const state = _runs.get(req.params.runId);
    if (!state) return res.status(404).json({ error: 'Run not found' });
    res.json({
        runId: req.params.runId, status: state.status,
        verdict: state.verdict, score: state.score,
        progress: state.progress, totalChecks: state.totalChecks,
        findings: state.findings, logs: state.logs.slice(-30),
        config: state.config, startTime: state.startTime, endTime: state.endTime,
    });
});

// ══════════════════════════════════════════════════════════════════════════
// GET /api/security-test/report/:runId
// ══════════════════════════════════════════════════════════════════════════
router.get('/report/:runId', auth, (req, res) => {
    const htmlPath = path.join(REPORTS_DIR, `${req.params.runId}.html`);
    if (!fs.existsSync(htmlPath)) return res.status(404).send('<h2>Report not found</h2>');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(fs.readFileSync(htmlPath, 'utf8'));
});

router.get('/report/:runId/download', auth, (req, res) => {
    const htmlPath = path.join(REPORTS_DIR, `${req.params.runId}.html`);
    if (!fs.existsSync(htmlPath)) return res.status(404).json({ error: 'Not found' });
    const state = _runs.get(req.params.runId);
    const proj  = state?.config?.projectName || 'SecurityTest';
    const ts    = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="SecurityTest-${proj}-${ts}.html"`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(fs.readFileSync(htmlPath, 'utf8'));
});

// ══════════════════════════════════════════════════════════════════════════
// GET /api/security-test/history
// ══════════════════════════════════════════════════════════════════════════
router.get('/history', auth, (req, res) => {
    const rows = [];
    if (fs.existsSync(REPORTS_DIR)) {
        for (const f of fs.readdirSync(REPORTS_DIR)) {
            if (!f.endsWith('.json') || f.startsWith('_')) continue;
            try {
                const d = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8'));
                const critical = d.findings?.filter(f => f.severity === 'CRITICAL' && f.status !== 'pass').length || 0;
                const high     = d.findings?.filter(f => f.severity === 'HIGH'     && f.status !== 'pass').length || 0;
                const medium   = d.findings?.filter(f => f.severity === 'MEDIUM'   && f.status !== 'pass').length || 0;
                rows.push({
                    runId: d.runId, projectName: d.config?.projectName || '—',
                    environment: d.config?.environment || '—', url: d.config?.url || '—',
                    startTime: d.startTime, status: d.status, verdict: d.verdict,
                    score: d.score, critical, high, medium, executedBy: d.config?.executedBy || '—',
                    hasReport: fs.existsSync(path.join(REPORTS_DIR, f.replace('.json','.html'))),
                });
            } catch {}
        }
    }
    rows.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    res.json({ runs: rows });
});

router.delete('/history/:runId', auth, (req, res) => {
    const id = req.params.runId;
    ['.json','.html'].forEach(ext => { const p = path.join(REPORTS_DIR, id + ext); if (fs.existsSync(p)) fs.unlinkSync(p); });
    _runs.delete(id);
    res.json({ ok: true });
});

router.post('/save-template', auth, (req, res) => {
    try { fs.writeFileSync(TMPL_FILE, JSON.stringify(req.body || {}, null, 2)); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/report-template', auth, (req, res) => res.json(_loadTemplate()));

// ══════════════════════════════════════════════════════════════════════════
// HTML REPORT GENERATOR
// ══════════════════════════════════════════════════════════════════════════
function _generateHtml(state, tmpl = {}) {
    const cfg = state.config || {};
    const companyName = tmpl.companyName || 'Ad-Hash Technolabs Pvt Ltd';
    const reportTitle = tmpl.reportTitle || 'Security Test Report';
    const headerColor = tmpl.headerColor || '#0f172a';
    const preparedBy  = tmpl.preparedBy  || cfg.executedBy || 'QA Team';
    const footerText  = tmpl.footerText  || 'AdHash Project Control Center · Authorized Personnel Only';

    const vd      = state.verdict || 'FAIL';
    const score   = state.score   ?? 0;
    const vdColor = vd === 'PASS' ? '#10b981' : vd === 'RISK' ? '#f59e0b' : '#ef4444';
    const vdBg    = vd === 'PASS' ? '#d1fae5' : vd === 'RISK' ? '#fef3c7' : '#fee2e2';
    const vdTxt   = vd === 'PASS' ? '#065f46' : vd === 'RISK' ? '#78350f' : '#7f1d1d';

    const scoreColor = score >= 80 ? '#10b981' : score >= 60 ? '#f59e0b' : '#ef4444';

    const findings = state.findings || [];
    const critical = findings.filter(f => f.severity === 'CRITICAL' && f.status !== 'pass');
    const high     = findings.filter(f => f.severity === 'HIGH'     && f.status !== 'pass');
    const medium   = findings.filter(f => f.severity === 'MEDIUM'   && f.status !== 'pass');
    const low      = findings.filter(f => f.severity === 'LOW'      && f.status !== 'pass');
    const passed   = findings.filter(f => f.status === 'pass');

    const sevColor = { CRITICAL: '#ef4444', HIGH: '#f97316', MEDIUM: '#f59e0b', LOW: '#3b82f6', INFO: '#94a3b8', PASS: '#10b981' };
    const sevBg    = { CRITICAL: '#fee2e2', HIGH: '#ffedd5', MEDIUM: '#fef3c7', LOW: '#dbeafe', INFO: '#f1f5f9', PASS: '#d1fae5' };

    const genTime = new Date().toLocaleString('en-IN', { weekday:'short', year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', timeZone:'Asia/Kolkata' }) + ' IST';

    const allFail = [...critical, ...high, ...medium, ...low];

    const findingRows = allFail.map(f => `
      <tr>
        <td><span style="background:${sevBg[f.severity]};color:${sevColor[f.severity]};padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700">${f.severity}</span></td>
        <td style="font-size:11px;color:#64748b">${f.category}</td>
        <td style="font-weight:600">${f.title}</td>
        <td style="font-size:12px;color:#475569;word-break:break-word;max-width:300px">${f.detail}</td>
        <td style="font-size:12px;color:#0c4a6e">${f.recommendation || '—'}</td>
      </tr>`).join('');

    const passRows = passed.map(f => `
      <tr>
        <td><span style="background:#d1fae5;color:#065f46;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700">PASS</span></td>
        <td style="font-size:11px;color:#64748b">${f.category}</td>
        <td style="font-weight:600">${f.title}</td>
        <td style="font-size:12px;color:#475569">${f.detail}</td>
      </tr>`).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${reportTitle} — ${cfg.projectName || 'Project'}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Arial,sans-serif;background:#f1f5f9;color:#1e293b;line-height:1.5}
.page{max-width:1100px;margin:0 auto;padding:24px}
.rpt-header{background:${headerColor};color:#fff;border-radius:16px;padding:36px 40px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:16px}
.rpt-brand{font-size:28px;font-weight:800}.rpt-brand span{color:#60a5fa}
.rpt-meta{text-align:right}.rpt-meta .title{font-size:18px;font-weight:700;margin-bottom:4px}.rpt-meta .sub{font-size:12px;opacity:.75}
.section{background:#fff;border-radius:12px;padding:24px;margin-bottom:20px;box-shadow:0 1px 4px rgba(0,0,0,.06)}
.section h2{font-size:15px;font-weight:700;margin-bottom:16px;padding-bottom:10px;border-bottom:2px solid #e2e8f0}
.kpi-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:16px}
.kpi{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;text-align:center}
.kpi-val{font-size:28px;font-weight:800;line-height:1}.kpi-lbl{font-size:11px;color:#64748b;margin-top:4px;text-transform:uppercase;letter-spacing:.5px}
table{width:100%;border-collapse:collapse}
th{padding:10px 14px;background:#f8fafc;font-size:11px;font-weight:700;text-transform:uppercase;color:#64748b;text-align:left;border-bottom:2px solid #e2e8f0}
td{padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:13px;vertical-align:top}
tr:hover td{background:#f8fafc}
.verdict-badge{display:inline-block;padding:8px 24px;border-radius:12px;font-size:20px;font-weight:900;background:${vdBg};color:${vdTxt};border:2px solid ${vdColor}}
.score-circle{width:80px;height:80px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:900;border:4px solid ${scoreColor};color:${scoreColor}}
footer{text-align:center;padding:24px;color:#94a3b8;font-size:11px;border-top:1px solid #e2e8f0;margin-top:8px}
</style>
</head>
<body><div class="page">

<div class="rpt-header">
  <div>
    <div class="rpt-brand"><span>${companyName.split(' ')[0]}</span> ${companyName.split(' ').slice(1).join(' ')}</div>
    <div style="margin-top:8px;font-size:13px;opacity:.8">${cfg.projectName} · ${cfg.environment}</div>
    <div style="margin-top:4px;font-size:12px;opacity:.6;word-break:break-all">${cfg.url}</div>
  </div>
  <div class="rpt-meta">
    <div class="title">${reportTitle}</div>
    <div class="sub">Generated: ${genTime}</div>
    <div class="sub">Executed by: ${preparedBy}</div>
    <div style="margin-top:12px"><span class="verdict-badge">⬤ ${vd}</span></div>
  </div>
</div>

<div class="section">
  <h2>🏆 Security Score</h2>
  <div style="display:flex;align-items:center;gap:32px;flex-wrap:wrap">
    <div class="score-circle">${score}</div>
    <div class="kpi-row" style="flex:1">
      <div class="kpi"><div class="kpi-val" style="color:#ef4444">${critical.length}</div><div class="kpi-lbl">Critical</div></div>
      <div class="kpi"><div class="kpi-val" style="color:#f97316">${high.length}</div><div class="kpi-lbl">High</div></div>
      <div class="kpi"><div class="kpi-val" style="color:#f59e0b">${medium.length}</div><div class="kpi-lbl">Medium</div></div>
      <div class="kpi"><div class="kpi-val" style="color:#3b82f6">${low.length}</div><div class="kpi-lbl">Low</div></div>
      <div class="kpi"><div class="kpi-val" style="color:#10b981">${passed.length}</div><div class="kpi-lbl">Passed</div></div>
    </div>
  </div>
</div>

${allFail.length ? `
<div class="section">
  <h2>🚨 Findings (${allFail.length} issues)</h2>
  <div style="overflow-x:auto"><table>
    <thead><tr><th>Severity</th><th>Category</th><th>Finding</th><th>Detail</th><th>Recommendation</th></tr></thead>
    <tbody>${findingRows}</tbody>
  </table></div>
</div>` : ''}

${passed.length ? `
<div class="section">
  <h2>✅ Passed Checks (${passed.length})</h2>
  <div style="overflow-x:auto"><table>
    <thead><tr><th>Status</th><th>Category</th><th>Check</th><th>Detail</th></tr></thead>
    <tbody>${passRows}</tbody>
  </table></div>
</div>` : ''}

<footer>
  <div>${footerText}</div>
  <div style="margin-top:4px">Report ID: ${state.runId} · Generated: ${genTime}</div>
</footer>
</div></body></html>`;
}

module.exports = router;

const express = require('express');
const path = require('path');
const fs = require('fs');
const { readLatestApiResultsPayload } = require('./utils/latest-api-results.js');
const { sendZohoMail } = require('./utils/zoho-mail');

const app = express();
const PORT = Number(process.env.PORT) || 7777;

// Parse JSON bodies
app.use(express.json());

app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
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
    return fs.existsSync('D:\\Automation\\AdHash_Domain_Report_Standalone\\godaddy\\package.json');
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

    return moduleConfig.map(({ key, label }) => {
        let total = 0, failed = 0, skipped = 0;
        let failedItems = [];

        if (key === 'api') {
            // Use per-project API results so ZapAI-style failures (row=skipped, detail=failed) are captured
            let mapping;
            try { mapping = getProjectMapping(); } catch (e) { mapping = { projects: [] }; }
            (mapping.projects || []).forEach((project) => {
                const apiResult = getAPITestResults(project.id);
                total += apiResult.total;
                failed += apiResult.failed;
                skipped += apiResult.skipped;
                (apiResult.tests || []).forEach((test) => {
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
    if (process.env.ZOHO_MAIL_ENABLED !== 'true' || !state) {
        addLog('❌ Zoho mail not sent: mail disabled or state missing', 'error');
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

    const mailDispatchKey = [state.generatedAt || '', summary.passedSuites || 0, summary.failedSuites || 0, summary.skippedSuites || 0, summary.totalSuites || 0].join('|');
    if (!mailDispatchKey || mailDispatchKey === lastMailDispatchKey) {
        addLog('ℹ️ Zoho mail not sent: already sent for this summary.', 'info');
        return;
    }

    // Permanently locked to Email Preview style. Inject live failed-module data at placeholder.
    const emailPreviewCandidates = [
        path.join(__dirname, 'email-preview', 'AdHash-Projects-Dashboard.html'),
        path.join(__dirname, 'email-preview', 'index.html')
    ];
    const emailPreviewPath = emailPreviewCandidates.find((candidate) => fs.existsSync(candidate));

    if (!emailPreviewPath) {
        addLog('❌ Email report not sent: locked template missing in email-preview.', 'error');
        return;
    }

    let html = fs.readFileSync(emailPreviewPath, 'utf8');
    // Inject live failed-module cards so the Failed Details section always reflects current run
    if (html.includes('<!--LIVE_FAILED_MODULES-->')) {
        html = html.replace('<!--LIVE_FAILED_MODULES-->', buildFailedModulesHtmlForTemplate(state));
    }

    try {
        await sendZohoMail({
            subject: `AdHash Test Report: ${summary.passedSuites} Passed, ${summary.failedSuites} Failed`,
            html
        });
        lastMailDispatchKey = mailDispatchKey;
        addLog('📧 Test report sent via Zoho Mail', 'info');
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

    // Run the suite through the workspace-root runner
    const testProcess = exec(`npx ts-node run-all-tests.ts --suite ${suite}`, { cwd: __dirname });

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

// API endpoint to trigger test run
app.post('/api/run-tests', (req, res) => {
    const { spawn } = require('child_process');

    if (testRunning) {
        return res.json({ status: 'already-running', message: 'Tests are already running' });
    }

    console.log('\n🚀 Starting test execution...');
    testRunning = true;
    testResults = null;
    testLogs = [];
    currentSuite = null;
    testProcessPid = null;
    testProcessRef = null;

    res.json({ status: 'started', message: 'Tests are running in the background...' });

    addLog('🚀 Starting sequential test execution...', 'info');
 addLog('📋 Running configured suites, including external domain monitoring...', 'info');
    // Run the unified test framework with streaming output (no exec buffer cap)
    const testProcess = spawn('npx', ['ts-node', 'run-all-tests.ts'], {
        cwd: __dirname,
        shell: true
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

                // --- Send Zoho Mail if enabled ---
                try {
                    await dispatchZohoSummaryMail(state);
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
    const status = getExpiryStatus(daysRemaining, detail && detail.status === 'failed' && daysRemaining === null);

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

    if (/^https?:\/\//i.test(trimmed)) {
        try {
            const url = new URL(trimmed);
            const packageName = url.searchParams.get('id') || '';

            if (!packageName) {
                return null;
            }

            return {
                packageName,
                expectedUrl: trimmed
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
    suiteConfigCache.apps = (mapping.projects || [])
        .flatMap((project) => project.apps || [])
        .map((app) => {
            const normalized = normalizePlayStoreValue(app && app.playStore);
            if (!app || !app.name || !normalized) {
                return null;
            }

            return {
                appName: app.name,
                packageName: normalized.packageName,
                expectedUrl: normalized.expectedUrl
            };
        })
        .filter(Boolean);

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
            htmlEntries.push({
                domain,
                url: fields.URL || `https://${domain}`,
                status: statusText === 'failed' ? 'failed' : statusText === 'warning' ? 'warning' : 'passed',
                expiryDate: fields['Expiry Date (UTC)'] || null,
                expiryDateIST: fields['Expiry Date (IST)'] || formatToIST(fields['Expiry Date (UTC)']),
                daysRemaining: normalizeDaysRemaining(fields['Days Remaining']),
                reason: fields['Certificate Status'] || statusText
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
            const definition = definitions.find((entry) => normalizeText(entry.appName) === normalizeText(app.name));
            if (!definition) {
                return;
            }

            const row = findSuiteRow(rows, `Verify ${definition.appName} on Play Store`);
            if (!row || row.status === 'skipped') {
                return;
            }

            result.total++;
            if (row.status === 'passed') {
                result.passed++;
            } else {
                result.failed++;
            }

            result.tests.push({
                name: definition.appName,
                platform: 'Play Store',
                url: definition.expectedUrl,
                status: row.status,
                type: 'app'
            });
        });

        return result;
    } catch (error) {
        console.error('Error getting app test results:', error);
        return createEmptySuiteResult();
    }
}

function getServerTestResults(projectId) {
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
    try {
        const dashboardState = readDashboardState();
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
                    // If the dashboard detail recorded a definitive failure for this API,
                    // prefer that status over the suite row's 'skipped' classification.
                    if (detail && String(detail.status || '').toLowerCase() === 'failed') {
                        const expectedStatus = parseExpectedStatus(api.expectedStatus) ?? parseExpectedStatus(row.expectedStatus) ?? parseExpectedStatus(detail.expectedStatus);
                        apiResults.push({
                            name: api.name,
                            url: api.url,
                            method,
                            duration: (detail && detail.duration) || row.duration,
                            requestBody: detail.requestBody || row.requestBody || (normalizeApiMethod(method) === 'GET' ? 'No request body' : 'Payload not provided'),
                            responseBody: detail.responseBody || row.responseBody || 'No response body',
                            responseCode: detail.responseCode || row.responseCode || null,
                            expectedStatus,
                            status: 'failed',
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

// Main route - serve project dashboard
app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, 'public', 'project-dashboard.html'));
});

// Legacy dashboard route
app.get('/dashboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/favicon.ico', (req, res) => {
    res.status(204).end();
});

// Serve static files with no-cache headers (MUST be last to not override API routes)
app.use(express.static(__dirname, {
    setHeaders: (res, path) => {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
    }
}));

// Start server
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

    // On startup, recover persisted results and attempt Zoho summary dispatch.
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


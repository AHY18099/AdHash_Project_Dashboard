/**
 * post-report-to-dashboard.mjs
 *
 * Reads the generated HTML report and POSTs it to the dashboard API.
 * Called by the GitHub Action after the QA pipeline completes.
 *
 * Usage:
 *   node scripts/post-report-to-dashboard.mjs [reportPath] [runType]
 *
 * Environment variables required:
 *   DASHBOARD_URL          — e.g. https://adhashprojectdashboard-production.up.railway.app
 *   STATUS_REPORT_API_KEY  — must match the key set in Railway
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');

// ── Config ────────────────────────────────────────────────────────────────────
const DASHBOARD_URL = (process.env.DASHBOARD_URL || '').replace(/\/$/, '');
const API_KEY       = process.env.STATUS_REPORT_API_KEY || '';

if (!DASHBOARD_URL) {
    console.warn('[post-report] ⚠  DASHBOARD_URL not set — skipping dashboard save');
    process.exit(0);
}
if (!API_KEY) {
    console.warn('[post-report] ⚠  STATUS_REPORT_API_KEY not set — skipping dashboard save');
    process.exit(0);
}

// ── Find the HTML report ──────────────────────────────────────────────────────
const reportPathArg = process.argv[2];
const _rtArg        = (process.argv[3] || '').toLowerCase();
const runTypeArg    = (!_rtArg || _rtArg === 'auto') ? detectRunType() : _rtArg;

// Candidate paths — first existing one wins
const candidates = [
    reportPathArg,
    path.join(ROOT, 'email-preview', 'index.html'),
    path.join(ROOT, 'email-preview', 'dashboard-email.html'),
    path.join(ROOT, 'email-preview', 'AdHash-Projects-Dashboard.html'),
    path.join(ROOT, 'unified-dashboard', 'index.html'),
].filter(Boolean);

let htmlPath = null;
for (const p of candidates) {
    if (fs.existsSync(p)) { htmlPath = p; break; }
}

if (!htmlPath) {
    console.warn('[post-report] ⚠  No HTML report file found — skipping dashboard save');
    console.warn('[post-report]    Searched:', candidates.join('\n               '));
    process.exit(0);
}

console.log(`[post-report] Using report: ${htmlPath}`);

// ── Parse metadata from the HTML ──────────────────────────────────────────────
const htmlContent = fs.readFileSync(htmlPath, 'utf8');

function extractText(html, regex) {
    const m = html.match(regex);
    return m ? m[1].trim() : null;
}

// Title from <title> tag or h1
const htmlTitle = extractText(htmlContent, /<title[^>]*>([^<]+)<\/title>/i)
    || extractText(htmlContent, /<h1[^>]*>([^<]+)<\/h1>/i)
    || 'AdHash Projects Status Dashboard';

// Pull stats from the summary cards in the HTML (matches the email template)
function extractCardNumber(html, label) {
    // Matches patterns like: <div class="card-value">3</div> ... Success
    const patterns = [
        new RegExp(`<[^>]*card-value[^>]*>(\\d+)<\\/[^>]+>[\\s\\S]{0,200}?${label}`, 'i'),
        new RegExp(`${label}[\\s\\S]{0,200}?<[^>]*card-value[^>]*>(\\d+)<\\/`, 'i'),
        new RegExp(`<[^>]*>(\\d+)<\\/[^>]+>[\\s\\S]{0,100}?${label}`, 'i'),
    ];
    for (const p of patterns) {
        const m = html.match(p);
        if (m) return parseInt(m[1], 10);
    }
    return 0;
}

const totalProjects  = extractCardNumber(htmlContent, 'Total') || extractCardNumber(htmlContent, 'Suites');
const passedCount    = extractCardNumber(htmlContent, 'Success') || extractCardNumber(htmlContent, 'Passed');
const failedCount    = extractCardNumber(htmlContent, 'Failed');
const warningCount   = extractCardNumber(htmlContent, 'Warning');

// Duration from footer or summary
const durationMatch  = htmlContent.match(/(\d+m\s*\d+s|\d+:\d+:\d+|\d+\.\d+s)/i);
const duration       = durationMatch ? durationMatch[1] : '';

// Overall status from title prefix or a STATUS element
let overallStatus = 'unknown';
if (/^(PASSED|SUCCESS)/i.test(htmlTitle))  overallStatus = 'passed';
else if (/^FAILED/i.test(htmlTitle))        overallStatus = 'failed';
else if (/^WARNING/i.test(htmlTitle))       overallStatus = 'warning';
else if (failedCount > 0)                   overallStatus = 'failed';
else if (warningCount > 0)                  overallStatus = 'warning';
else if (passedCount > 0)                   overallStatus = 'passed';

const reportDateTime = new Date().toISOString();

console.log('[post-report] Parsed metadata:', {
    title: htmlTitle, runType: runTypeArg, overallStatus,
    totalProjects, passedCount, failedCount, warningCount, duration,
});

// ── POST to dashboard ─────────────────────────────────────────────────────────
const payload = {
    title:           htmlTitle,
    runType:         runTypeArg || 'manual',
    overallStatus,
    reportDateTime,
    totalProjects,
    passedCount,
    failedCount,
    warningCount,
    duration,
    htmlContent,
    source:          'github-action',
};

async function postReport() {
    const url = `${DASHBOARD_URL}/api/status-reports`;
    console.log(`[post-report] POSTing to ${url} …`);

    const response = await fetch(url, {
        method:  'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key':    API_KEY,
        },
        body: JSON.stringify(payload),
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!response.ok || !data.success) {
        throw new Error(`HTTP ${response.status}: ${data.error || text.slice(0, 200)}`);
    }

    console.log(`[post-report] ✅ Report saved to dashboard: ${data.report?.id}`);

    // Send Slack alert if status is warning or failed
    if (overallStatus === 'warning' || overallStatus === 'failed') {
        await sendSlackAlert(data.report?.id).catch(e =>
            console.warn(`[post-report] ⚠  Slack notify failed (non-fatal): ${e.message}`)
        );
    }

    return data;
}

async function sendSlackAlert(reportId) {
    const token   = process.env.SLACK_BOT_TOKEN;
    const rawCh   = process.env.SLACK_CHANNEL || 'testing-team';
    const channel = rawCh.startsWith('#') ? rawCh.slice(1) : rawCh;

    if (!token) {
        console.warn('[post-report] SLACK_BOT_TOKEN not set — skipping Slack alert');
        return;
    }

    const isFailed  = overallStatus === 'failed';
    const emoji     = isFailed ? ':x:' : ':warning:';
    const color     = isFailed ? '#ef4444' : '#f59e0b';
    const label     = isFailed ? 'QA Run Failed' : 'QA Run Warning';
    const RUN_LABELS = { morning: '🌅 Morning', evening: '🌆 Evening' };
    const runLabel  = RUN_LABELS[runTypeArg] || '🔧 Manual';
    const reportUrl = reportId ? `${DASHBOARD_URL}/qa-dashboard?report=${encodeURIComponent(reportId)}` : DASHBOARD_URL;

    const now = new Date();
    const dateStr = now.toLocaleString('en-IN', {
        weekday:'short', year:'numeric', month:'short', day:'numeric',
        hour:'2-digit', minute:'2-digit', timeZone:'Asia/Kolkata'
    });

    const blocks = [
        {
            type: 'header',
            text: { type: 'plain_text', text: `${emoji} ${label}`, emoji: true }
        },
        {
            type: 'context',
            elements: [
                { type: 'mrkdwn', text: `🕐 ${dateStr} IST` },
                { type: 'mrkdwn', text: `🏃 Run type: *${runLabel}*` },
            ]
        },
        { type: 'divider' },
        {
            type: 'section',
            fields: [
                { type: 'mrkdwn', text: `*Total Projects*\n${totalProjects}` },
                { type: 'mrkdwn', text: `*✓ Passed*\n${passedCount}` },
                { type: 'mrkdwn', text: `*✗ Failed*\n${failedCount}` },
                { type: 'mrkdwn', text: `*⚠ Warnings*\n${warningCount}` },
                { type: 'mrkdwn', text: `*Duration*\n${duration || '—'}` },
                { type: 'mrkdwn', text: `*Report*\n${htmlTitle}` },
            ]
        },
        { type: 'divider' },
        {
            type: 'actions',
            elements: [{
                type: 'button',
                text: { type: 'plain_text', text: '📊 View Report', emoji: true },
                url:  reportUrl,
                style: isFailed ? 'danger' : 'primary'
            }]
        }
    ];

    const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type':  'application/json',
        },
        body: JSON.stringify({
            channel,
            text: `${emoji} *${label}* — ${totalProjects} projects | ✓ ${passedCount} passed · ✗ ${failedCount} failed · ⚠ ${warningCount} warnings`,
            attachments: [{ color, blocks }],
        }),
    });

    const slackData = await slackRes.json();
    if (!slackData.ok) throw new Error(`Slack API error: ${slackData.error}`);
    console.log(`[post-report] ✅ Slack alert sent to #${channel}`);
}

// Never let this script fail the CI pipeline — just warn
postReport().catch(err => {
    console.warn(`[post-report] ⚠  Dashboard save failed (non-fatal): ${err.message}`);
    process.exit(0);
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function detectRunType() {
    const hour = new Date().getUTCHours();
    // 02:00 UTC = morning India, 10:00 UTC = evening India
    if (hour >= 1 && hour <= 4)  return 'morning';
    if (hour >= 9 && hour <= 12) return 'evening';
    return 'manual';
}

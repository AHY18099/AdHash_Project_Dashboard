const fs = require('fs');
const path = require('path');
const tls = require('tls');

const reportPath = path.join(__dirname, 'report.html');
const mappingPath = path.join(__dirname, '..', 'config', 'project-mapping.json');

function normalizeDomainHost(value) {
    if (!value) return '';
    return String(value).trim().toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
        .replace(/:\d+$/, '');
}

function formatToIST(utcStr) {
    if (!utcStr) return 'N/A';
    try {
        const d = new Date(utcStr);
        const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
        const day = String(ist.getUTCDate()).padStart(2, '0');
        const mon = String(ist.getUTCMonth() + 1).padStart(2, '0');
        const yr = ist.getUTCFullYear();
        const hh = String(ist.getUTCHours()).padStart(2, '0');
        const mm = String(ist.getUTCMinutes()).padStart(2, '0');
        const ss = String(ist.getUTCSeconds()).padStart(2, '0');
        const ampm = ist.getUTCHours() >= 12 ? 'pm' : 'am';
        const hr12 = ist.getUTCHours() % 12 || 12;
        return `${day}/${mon}/${yr}, ${String(hr12).padStart(2, '0')}:${mm}:${ss} ${ampm} IST`;
    } catch { return 'N/A'; }
}

function checkCert(host) {
    return new Promise((resolve) => {
        const sock = tls.connect(
            { host, port: 443, rejectUnauthorized: false, servername: host, timeout: 10000 },
            () => {
                const cert = sock.getPeerCertificate();
                sock.destroy();
                if (!cert || !cert.valid_to) {
                    resolve({ host, expiryDate: null, expiryDateIST: null, daysRemaining: null, status: 'error' });
                    return;
                }
                const expiry = new Date(cert.valid_to);
                const days = Math.ceil((expiry.getTime() - Date.now()) / 86400000);
                const expiryUTC = expiry.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
                resolve({
                    host,
                    expiryDate: expiryUTC,
                    expiryDateIST: formatToIST(expiry.toISOString()),
                    daysRemaining: days,
                    status: days <= 0 ? 'error' : days <= 30 ? 'expiring' : 'active'
                });
            }
        );
        sock.on('error', () => {
            sock.destroy();
            resolve({ host, expiryDate: null, expiryDateIST: null, daysRemaining: null, status: 'error' });
        });
        sock.on('timeout', () => {
            sock.destroy();
            resolve({ host, expiryDate: null, expiryDateIST: null, daysRemaining: null, status: 'error' });
        });
    });
}

function buildReportHtml(results) {
    const warnings = results.filter(r => r.status === 'expiring').length;
    const failed   = results.filter(r => r.status === 'error').length;
    const passed   = results.filter(r => r.status === 'active').length;
    const total    = results.length;
    const now      = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

    const cards = results.map(r => {
        const statusLabel = r.status === 'active' ? 'PASSED' : r.status === 'expiring' ? 'WARNING' : 'FAILED';
        const cardClass   = r.status === 'active' ? 'passed' : r.status === 'expiring' ? 'warning' : 'failed';
        const reasonBlock = r.status === 'expiring'
            ? `\n        <div class="field wide">\n            <div class="field-label">Reason</div>\n            <div class="field-value">Expiry within warning window (${r.daysRemaining} days remaining)</div>\n        </div>`
            : r.status === 'error'
            ? `\n        <div class="field wide">\n            <div class="field-label">Reason</div>\n            <div class="field-value">SSL certificate unreachable or missing</div>\n        </div>`
            : '';
        return `        <article class="report-card ${cardClass}">
            <div class="report-card-header">
                <div><h2>${r.host}</h2></div>
                <span class="badge ${cardClass}">${statusLabel}</span>
            </div>
            <div class="field-grid">
        <div class="field wide">
            <div class="field-label">URL</div>
            <div class="field-value">https://${r.host}</div>
        </div>
        <div class="field">
            <div class="field-label">Domain Status</div>
            <div class="field-value">${statusLabel}</div>
        </div>
        <div class="field">
            <div class="field-label">Expiry Date (UTC)</div>
            <div class="field-value">${r.expiryDate || 'N/A'}</div>
        </div>
        <div class="field">
            <div class="field-label">Expiry Date (IST)</div>
            <div class="field-value">${r.expiryDateIST || 'N/A'}</div>
        </div>
        <div class="field">
            <div class="field-label">Days Remaining</div>
            <div class="field-value">${r.daysRemaining !== null ? r.daysRemaining : 'N/A'}</div>
        </div>${reasonBlock}
            </div>
        </article>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Domain Expiry Monitoring</title>
<style>
:root{color-scheme:dark;--bg:#04111f;--border:#1e293b;--text:#e2e8f0;--muted:#94a3b8;--pass:#10b981;--warn:#f59e0b;--fail:#ef4444}
*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:#04111f;color:var(--text)}
.page{max-width:1320px;margin:0 auto;padding:28px 20px 40px}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:14px;margin-bottom:24px}
.summary-card{background:rgba(2,6,23,.48);border:1px solid var(--border);border-radius:18px;padding:14px 16px}
.summary-card .label{color:var(--muted);font-size:12px;font-weight:700;text-transform:uppercase}
.summary-card .value{margin-top:8px;font-size:26px;font-weight:800}
.cards{display:grid;gap:18px}
.report-card{background:linear-gradient(180deg,rgba(15,23,42,.95),rgba(8,16,31,.98));border:1px solid var(--border);border-left:6px solid #60a5fa;border-radius:20px;padding:18px}
.report-card.failed{border-left-color:var(--fail)}.report-card.warning{border-left-color:var(--warn)}.report-card.passed{border-left-color:var(--pass)}
.report-card-header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:14px}
.report-card-header h2{margin:0;font-size:18px}
.badge{display:inline-flex;align-items:center;min-width:80px;padding:6px 12px;border-radius:999px;font-size:11px;font-weight:800;text-transform:uppercase}
.badge.passed{background:rgba(16,185,129,.18);color:#6ee7b7}.badge.warning{background:rgba(245,158,11,.2);color:#fcd34d}.badge.failed{background:rgba(239,68,68,.18);color:#fca5a5}
.field-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.field{background:rgba(15,23,42,.65);border:1px solid rgba(30,41,59,.9);border-radius:14px;padding:12px 13px}
.field.wide{grid-column:1/-1}.field-label{color:var(--muted);font-size:11px;font-weight:700;text-transform:uppercase;margin-bottom:6px}
.field-value{font-size:14px;line-height:1.5}
</style></head>
<body><main class="page">
<section class="summary">
<div class="summary-card"><div class="label">Passed</div><div class="value" style="color:#6ee7b7">${passed}</div></div>
<div class="summary-card"><div class="label">Failed</div><div class="value" style="color:#fca5a5">${failed}</div></div>
<div class="summary-card"><div class="label">Warnings</div><div class="value" style="color:#fcd34d">${warnings}</div></div>
<div class="summary-card"><div class="label">Total</div><div class="value">${total}</div></div>
<div class="summary-card"><div class="label">Generated</div><div class="value" style="font-size:11px;margin-top:12px">${now}</div></div>
</section>
<section class="cards">
${cards}
</section>
</main></body></html>`;
}

async function main() {
    let domains = [];
    try {
        const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
        const seen = new Set();
        for (const project of (mapping.projects || [])) {
            for (const d of (project.domains || [])) {
                const h = normalizeDomainHost(d);
                if (h && !seen.has(h)) { seen.add(h); domains.push(h); }
            }
        }
    } catch (e) {
        console.error('[godaddy] Failed to load project-mapping.json:', e.message);
        process.exit(1);
    }

    if (!domains.length) {
        console.log('[godaddy] No domains configured in project-mapping.json');
        fs.writeFileSync(reportPath, buildReportHtml([]));
        process.exit(0);
    }

    console.log(`[godaddy] Live TLS checking ${domains.length} domains...`);
    const results = await Promise.all(domains.map(checkCert));
    results.forEach(r => console.log(`  ${r.status.padEnd(8)} | ${String(r.daysRemaining ?? 'N/A').padStart(4)}d | ${r.host}`));

    fs.writeFileSync(reportPath, buildReportHtml(results));
    console.log(`[godaddy] report.html written (${results.length} domains, ${results.filter(r=>r.status==='expiring').length} warnings)`);
}

main().catch(e => { console.error('[godaddy] Fatal:', e); process.exit(1); });

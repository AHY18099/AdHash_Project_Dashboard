const fs = require('fs');
const path = require('path');
const net = require('net');
const https = require('https');

const reportPath = path.join(__dirname, 'report.html');
const mappingPath = path.join(__dirname, '..', 'config', 'project-mapping.json');

// Extract root domain (e.g. spark.synctag.com -> synctag.com)
function rootDomain(host) {
    const parts = host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').split('.');
    if (parts.length <= 2) return parts.join('.');
    // Handle two-part TLDs like .co.uk, .com.au
    const twoPartTLDs = ['co.uk','com.au','com.br','co.in','net.au','org.uk','me.uk'];
    const last2 = parts.slice(-2).join('.');
    if (twoPartTLDs.includes(last2)) return parts.slice(-3).join('.');
    return parts.slice(-2).join('.');
}

function normalizeDomainHost(value) {
    if (!value) return '';
    return String(value).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
}

function formatToIST(date) {
    if (!date) return 'N/A';
    try {
        const d = typeof date === 'string' ? new Date(date) : date;
        if (isNaN(d.getTime())) return 'N/A';
        const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
        const pad = n => String(n).padStart(2, '0');
        const day = pad(ist.getUTCDate()), mon = pad(ist.getUTCMonth() + 1), yr = ist.getUTCFullYear();
        const hh = ist.getUTCHours(), mm = pad(ist.getUTCMinutes()), ss = pad(ist.getUTCSeconds());
        const ampm = hh >= 12 ? 'pm' : 'am';
        const hr12 = pad(hh % 12 || 12);
        return `${day}/${mon}/${yr}, ${hr12}:${mm}:${ss} ${ampm} IST`;
    } catch { return 'N/A'; }
}

// WHOIS server map for common TLDs
const WHOIS_SERVERS = {
    'com':   'whois.verisign-grs.com',
    'net':   'whois.verisign-grs.com',
    'org':   'whois.pir.org',
    'io':    'whois.nic.io',
    'ai':    'whois.nic.ai',
    'app':   'whois.nic.google',
    'us':    'whois.nic.us',
    'co':    'whois.nic.co',
    'in':    'whois.registry.in',
    'info':  'whois.afilias.net',
    'biz':   'whois.biz',
};

function getWhoisServer(domain) {
    const tld = domain.split('.').pop();
    return WHOIS_SERVERS[tld] || `whois.nic.${tld}`;
}

// Parse expiry date from WHOIS response text
function parseWhoisExpiry(text) {
    // Try common field names in order of preference
    const patterns = [
        /Registry Expiry Date:\s*([^\r\n]+)/i,
        /Expiry Date:\s*([^\r\n]+)/i,
        /Expiration Date:\s*([^\r\n]+)/i,
        /Registrar Registration Expiration Date:\s*([^\r\n]+)/i,
        /paid-till:\s*([^\r\n]+)/i,
        /expire:\s*([^\r\n]+)/i,
        /expires:\s*([^\r\n]+)/i,
    ];
    for (const pat of patterns) {
        const m = text.match(pat);
        if (m) {
            let raw = m[1].trim();
            // Some registries return date-only (YYYY-MM-DD) without time — append midnight UTC
            if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) raw += 'T00:00:00Z';
            const d = new Date(raw);
            if (!isNaN(d.getTime())) return d;
        }
    }
    return null;
}

// RDAP fallback servers — only servers confirmed reachable (no ENOTFOUND).
// Confirmed-working RDAP servers per TLD (tested 2026-07).
// GoDaddy RDAP is the fallback for .co/.io and any unknown TLD.
const RDAP_SERVERS = {
    'com': 'https://rdap.verisign.com/com/v1/domain/',
    'net': 'https://rdap.verisign.com/net/v1/domain/',
    'org': 'https://rdap.publicinterestregistry.org/rdap/domain/',
    'ai':  'https://rdap.identitydigital.services/rdap/domain/',
    'app': 'https://pubapi.registry.google/rdap/domain/',
};

function rdapFetch(url, timeout = 10000, _redirects = 0, _retries = 1) {
    return new Promise((resolve) => {
        const req = https.get(url, { timeout }, (res) => {
            // Follow redirects (rdap.org uses 301/302)
            if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && _redirects < 3) {
                res.resume();
                rdapFetch(res.headers.location, timeout, _redirects + 1, _retries).then(resolve);
                return;
            }
            // Retry once on 429 rate-limit after 6s
            if (res.statusCode === 429 && _retries > 0) {
                res.resume();
                setTimeout(() => rdapFetch(url, timeout, _redirects, _retries - 1).then(resolve), 6000);
                return;
            }
            let d = '';
            res.on('data', c => { d += c; });
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try { resolve(JSON.parse(d)); } catch { resolve(null); }
                } else {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

async function rdapLookup(domain) {
    const tld = domain.split('.').pop();
    // Try TLD-specific RDAP first
    if (RDAP_SERVERS[tld]) {
        const obj = await rdapFetch(RDAP_SERVERS[tld] + domain);
        if (obj && parseRdapExpiry(obj)) return obj;
    }
    // rdap.org — public aggregator, works for all TLDs
    const rdapOrg = await rdapFetch('https://rdap.org/domain/' + domain);
    if (rdapOrg && parseRdapExpiry(rdapOrg)) return rdapOrg;
    // GoDaddy RDAP (covers GoDaddy-registered domains on any TLD)
    const gdap = await rdapFetch('https://rdap.godaddy.com/v1/domain/' + domain);
    if (gdap && parseRdapExpiry(gdap)) return gdap;
    // IANA bootstrap RDAP as last resort
    return rdapFetch('https://rdap.iana.org/domain/' + domain);
}

function parseRdapExpiry(obj) {
    if (!obj || !Array.isArray(obj.events)) return null;
    // Standard RDAP uses "expiration"; GoDaddy uses "registrar expiration"
    const ev = obj.events.find(e => e.eventAction === 'expiration' || e.eventAction === 'registrar expiration');
    if (!ev || !ev.eventDate) return null;
    const d = new Date(ev.eventDate);
    return isNaN(d.getTime()) ? null : d;
}

function whoisLookup(domain, server, timeout = 10000, retries = 1) {
    return new Promise((resolve) => {
        let data = '';
        const sock = net.createConnection(43, server);
        sock.setTimeout(timeout);
        sock.on('connect', () => sock.write(domain + '\r\n'));
        sock.on('data', chunk => { data += chunk.toString(); });
        sock.on('end', () => resolve(data));
        sock.on('error', (err) => {
            // Retry once on transient DNS/connection errors
            if (retries > 0 && (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT')) {
                setTimeout(() => whoisLookup(domain, server, timeout, retries - 1).then(resolve), 2000);
            } else {
                resolve('');
            }
        });
        sock.on('timeout', () => { sock.destroy(); resolve(''); });
    });
}

async function checkDomainRegistrar(host) {
    const root = rootDomain(host);
    const server = getWhoisServer(root);
    console.log(`  [WHOIS] ${root} via ${server}`);

    let text = await whoisLookup(root, server);

    // Try to parse the registry response directly first (many registries include the expiry date)
    let expiry = text ? parseWhoisExpiry(text) : null;

    // If not found in registry response, follow the registrar WHOIS referral
    if (!expiry && text) {
        const referral = (text.match(/Registrar WHOIS Server:\s*([^\r\n]+)/i) || [])[1]?.trim();
        if (referral && referral !== server && referral.includes('.')) {
            const referralText = await whoisLookup(root, referral);
            expiry = referralText ? parseWhoisExpiry(referralText) : null;
        }
    }

    // RDAP fallback: if WHOIS returned empty or unparseable (rate-limited / retired / port 43 blocked)
    if (!expiry) {
        console.log(`  [RDAP]  ${root} (WHOIS failed, trying RDAP chain)...`);
        const rdap = await rdapLookup(root);
        expiry = rdap ? parseRdapExpiry(rdap) : null;
    }

    if (!expiry) {
        console.log(`  [WHOIS] ${root}: could not parse expiry date`);
        return { host, root, expiryDate: null, expiryDateIST: null, daysRemaining: null, status: 'error' };
    }

    const days = Math.ceil((expiry.getTime() - Date.now()) / 86400000);
    const expiryUTC = expiry.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
    const status = days <= 0 ? 'error' : days <= 30 ? 'expiring' : 'active';
    console.log(`  [WHOIS] ${root}: expires ${expiryUTC} (${days}d) -> ${status}`);
    return { host, root, expiryDate: expiryUTC, expiryDateIST: formatToIST(expiry), daysRemaining: days, status };
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
            ? `\n        <div class="field wide"><div class="field-label">Reason</div><div class="field-value">Domain registration expiry within warning window (${r.daysRemaining} days remaining)</div></div>`
            : r.status === 'error'
            ? `\n        <div class="field wide"><div class="field-label">Reason</div><div class="field-value">Domain registrar expiry could not be determined</div></div>`
            : '';
        return `        <article class="report-card ${cardClass}">
            <div class="report-card-header">
                <div><h2>${r.root || r.host}</h2></div>
                <span class="badge ${cardClass}">${statusLabel}</span>
            </div>
            <div class="field-grid">
        <div class="field wide"><div class="field-label">URL</div><div class="field-value">https://${r.root || r.host}</div></div>
        <div class="field"><div class="field-label">Domain Status</div><div class="field-value">${statusLabel}</div></div>
        <div class="field"><div class="field-label">Expiry Date (UTC)</div><div class="field-value">${r.expiryDate || 'N/A'}</div></div>
        <div class="field"><div class="field-label">Expiry Date (IST)</div><div class="field-value">${r.expiryDateIST || 'N/A'}</div></div>
        <div class="field"><div class="field-label">Days Remaining</div><div class="field-value">${r.daysRemaining !== null ? r.daysRemaining : 'N/A'}</div></div>${reasonBlock}
            </div>
        </article>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Domain Expiry Monitoring</title>
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
    let allDomains = [];
    try {
        const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
        const seen = new Set();
        for (const project of (mapping.projects || [])) {
            for (const d of (project.domains || [])) {
                const h = normalizeDomainHost(d);
                if (h && !seen.has(h)) { seen.add(h); allDomains.push(h); }
            }
        }
    } catch (e) {
        console.error('[godaddy] Failed to load project-mapping.json:', e.message);
        process.exit(1);
    }

    if (!allDomains.length) {
        console.log('[godaddy] No domains configured');
        fs.writeFileSync(reportPath, buildReportHtml([]));
        process.exit(0);
    }

    // Deduplicate to root domains — one WHOIS lookup per root domain covers all subdomains
    const rootMap = new Map(); // root -> first host that mapped to it
    for (const h of allDomains) {
        const r = rootDomain(h);
        if (!rootMap.has(r)) rootMap.set(r, h);
    }

    console.log(`[godaddy] WHOIS checking ${rootMap.size} root domains (from ${allDomains.length} configured)...`);
    // Run sequentially with a delay — GoDaddy RDAP rate-limits when domains hit concurrently.
    const whoisResults = [];
    const entries = Array.from(rootMap.entries());
    for (let i = 0; i < entries.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 2000));
        whoisResults.push(await checkDomainRegistrar(entries[i][1]));
    }

    // Expand results back to all configured hosts: each subdomain inherits its root domain's expiry
    const rootResultMap = new Map(whoisResults.map(r => [r.root, r]));
    const results = allDomains.map(host => {
        const r = rootDomain(host);
        const base = rootResultMap.get(r);
        if (!base) return { host, root: r, expiryDate: null, expiryDateIST: null, daysRemaining: null, status: 'error' };
        return { ...base, host }; // keep host as-is but use root domain's expiry
    });

    // Deduplicate: only one entry per root domain in the report
    const seenRoots = new Set();
    const dedupedResults = results.filter(r => {
        if (seenRoots.has(r.root)) return false;
        seenRoots.add(r.root);
        return true;
    });

    fs.writeFileSync(reportPath, buildReportHtml(dedupedResults));
    console.log(`[godaddy] report.html written (${dedupedResults.length} root domains, ${dedupedResults.filter(r=>r.status==='expiring').length} warnings)`);
}

main().catch(e => { console.error('[godaddy] Fatal:', e); process.exit(1); });

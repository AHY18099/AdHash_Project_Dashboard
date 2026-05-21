#!/usr/bin/env node
/**
 * regenerate-specs.mjs
 * Reads config/project-mapping.json and writes Playwright spec files
 * into the 5 sibling test repositories.
 *
 * Runs both locally (called by server.js on project save / run) and
 * in GitHub Actions as a pre-test step.
 *
 * Usage:  node scripts/regenerate-specs.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MAPPING_PATH = path.join(ROOT, 'config', 'project-mapping.json');

function log(msg) { console.log(`[regenerate-specs] ${msg}`); }

function readMapping() {
  try {
    return JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf8'));
  } catch (e) {
    console.error('[regenerate-specs] ERROR: Cannot read project-mapping.json:', e.message);
    process.exit(1);
  }
}

function writeIfDirExists(filePath, content, label) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    log(`SKIP ${label} — directory not found: ${dir}`);
    return false;
  }
  fs.writeFileSync(filePath, content, 'utf8');
  log(`OK   ${label} → ${path.relative(ROOT, filePath)}`);
  return true;
}

const { projects = [] } = readMapping();

// ── 1. Server health  ──────────────────────────────────────────────────────────
const servers = [];
projects.forEach(p => (p.servers || []).forEach(s => servers.push({ name: `${p.name} — ${s.name}`, url: s.url })));

writeIfDirExists(
  path.join(ROOT, '..', 'Adhash_AllProjects_Server', 'tests', 'server-health', 'server-check.spec.ts'),
  `// Auto-generated from config/project-mapping.json — do not edit manually
import { test, expect } from '@playwright/test';

const SERVERS = ${JSON.stringify(servers, null, 2)};

for (const server of SERVERS) {
  test(\`Server Health: \${server.name}\`, async ({ request }) => {
    const res = await request.get(server.url, { timeout: 30000, failOnStatusCode: false });
    expect(res.status(), \`\${server.url} returned \${res.status()}\`).toBeLessThan(500);
  });
}
`,
  `Server spec (${servers.length} servers)`
);

// ── 2. SSL certificates  ──────────────────────────────────────────────────────
const certs = [];
projects.forEach(p => (p.sslCerts || []).forEach(domain => certs.push({ name: `${p.name} — ${domain}`, domain })));

writeIfDirExists(
  path.join(ROOT, '..', 'AdHash-Projects-Certificate-Expiry-Test', 'tests', 'certificate', 'cert-expiry.spec.ts'),
  `// Auto-generated from config/project-mapping.json — do not edit manually
import { test, expect } from '@playwright/test';
import * as tls from 'tls';

const CERTS = ${JSON.stringify(certs, null, 2)};

for (const cert of CERTS) {
  test(\`SSL Certificate: \${cert.name}\`, async () => {
    await new Promise<void>((resolve, reject) => {
      const socket = tls.connect(443, cert.domain, { servername: cert.domain }, () => {
        const c = socket.getPeerCertificate();
        const daysLeft = Math.floor((new Date(c.valid_to).getTime() - Date.now()) / 86400000);
        socket.destroy();
        if (daysLeft < 7) reject(new Error(\`Certificate for \${cert.domain} expires in \${daysLeft} days\`));
        else resolve();
      });
      socket.on('error', reject);
    });
  });
}
`,
  `SSL cert spec (${certs.length} certs)`
);

// ── 3. API endpoints  ─────────────────────────────────────────────────────────
const apis = [];
projects.forEach(p =>
  (p.apis || []).forEach(a => apis.push({
    name: `${p.name} — ${a.name || a.url}`,
    url: a.url,
    method: (a.method || 'GET').toUpperCase(),
    headers: a.headers || {},
    body: a.body || null,
    expectedStatus: a.expectedStatus || 200
  }))
);

writeIfDirExists(
  path.join(ROOT, '..', 'AdHash-API-Test', 'tests', 'api', 'api-tests.spec.ts'),
  `// Auto-generated from config/project-mapping.json — do not edit manually
import { test, expect } from '@playwright/test';

const APIS = ${JSON.stringify(apis, null, 2)};

for (const api of APIS) {
  test(\`API: \${api.name}\`, async ({ request }) => {
    const opts: Parameters<typeof request.get>[1] & any = {
      timeout: 30000,
      failOnStatusCode: false,
    };
    if (Object.keys(api.headers || {}).length) opts.headers = api.headers;
    if (api.body !== null) opts.data = api.body;
    const method = api.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch';
    const res = await request[method](api.url, opts);
    expect(
      res.status(),
      \`Expected HTTP \${api.expectedStatus}, got \${res.status()} for \${api.url}\`
    ).toBe(api.expectedStatus);
  });
}
`,
  `API spec (${apis.length} endpoints)`
);

// ── 4. App store status  ──────────────────────────────────────────────────────
function normalizePlayId(val) {
  if (!val || typeof val !== 'string') return null;
  const t = val.trim();
  if (/^https?:\/\//i.test(t)) {
    try { const u = new URL(t); return u.searchParams.get('id') || null; } catch { return null; }
  }
  return t || null;
}
function normalizeAppId(val) {
  if (!val || typeof val !== 'string') return null;
  const t = val.trim();
  if (/^https?:\/\//i.test(t)) {
    try { const u = new URL(t); const m = /\/(id\d+)/.exec(u.pathname); return m ? m[1] : null; } catch { return null; }
  }
  return t.startsWith('id') ? t : `id${t}`;
}

const appEntries = [];
projects.forEach(p =>
  (p.apps || []).forEach(a => {
    const pid = normalizePlayId(a.playStore);
    if (pid) appEntries.push({ name: `${p.name} — ${a.name} (Play Store)`, url: `https://play.google.com/store/apps/details?id=${pid}` });
    const aid = normalizeAppId(a.appStore);
    if (aid) appEntries.push({ name: `${p.name} — ${a.name} (App Store)`, url: `https://apps.apple.com/app/${aid}` });
  })
);

writeIfDirExists(
  path.join(ROOT, '..', 'Adhash_App_Status', 'tests', 'app-status', 'playstore.spec.ts'),
  `// Auto-generated from config/project-mapping.json — do not edit manually
import { test, expect } from '@playwright/test';

const APPS = ${JSON.stringify(appEntries, null, 2)};

for (const app of APPS) {
  test(\`App Status: \${app.name}\`, async ({ request }) => {
    const res = await request.get(app.url, { timeout: 30000, failOnStatusCode: false });
    expect(res.status(), \`\${app.url} returned \${res.status()}\`).toBeLessThan(400);
  });
}
`,
  `App spec (${appEntries.length} apps)`
);

// ── 5. Domain expiry  ─────────────────────────────────────────────────────────
const domains = [];
projects.forEach(p => (p.domains || []).forEach(d => domains.push(d)));

writeIfDirExists(
  path.join(ROOT, '..', 'AdHash_Domain_Report', 'domains.json'),
  JSON.stringify({ domains }, null, 2),
  `Domain list (${domains.length} domains)`
);

log(`Done. Regenerated specs for ${projects.length} projects.`);

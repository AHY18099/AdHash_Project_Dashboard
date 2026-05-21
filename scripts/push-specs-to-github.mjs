#!/usr/bin/env node
/**
 * push-specs-to-github.mjs
 *
 * After regenerating spec files from project-mapping.json, this script
 * commits & pushes the updated file contents directly to each of the 5
 * test repositories on GitHub using the REST API.
 *
 * Requires:  GITHUB_TOKEN env var (PAT with repo write access to all 5 repos,
 *            OR the built-in GITHUB_TOKEN in a workflow that has been granted
 *            write permission to those repos via a PAT stored as GH_PAT).
 *
 * Usage:     node scripts/push-specs-to-github.mjs
 *
 * Each file is pushed with a GET-then-PUT flow:
 *   1. GET /repos/{owner}/{repo}/contents/{path}  → retrieve current SHA
 *   2. PUT /repos/{owner}/{repo}/contents/{path}  → create or update the file
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MAPPING_PATH = path.join(ROOT, 'config', 'project-mapping.json');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_PAT || '';
const OWNER = 'AHY18099';

function log(msg) { console.log(`[push-specs] ${msg}`); }
function warn(msg) { console.warn(`[push-specs] WARN: ${msg}`); }
function err(msg)  { console.error(`[push-specs] ERROR: ${msg}`); }

if (!GITHUB_TOKEN) {
  warn('GITHUB_TOKEN / GH_PAT not set — skipping auto-push to GitHub repos.');
  warn('Set GITHUB_TOKEN in your environment or .env file to enable auto-push.');
  process.exit(0);  // exit 0 so callers don't fail hard
}

function readMapping() {
  try {
    return JSON.parse(fs.readFileSync(MAPPING_PATH, 'utf8'));
  } catch (e) {
    err('Cannot read project-mapping.json: ' + e.message);
    process.exit(1);
  }
}

async function githubGetSHA(repo, filePath) {
  const url = `https://api.github.com/repos/${OWNER}/${repo}/contents/${filePath}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${url} → ${res.status}: ${body}`);
  }
  const data = await res.json();
  return data.sha || null;
}

async function githubPutFile(repo, filePath, content, message, sha) {
  const url = `https://api.github.com/repos/${OWNER}/${repo}/contents/${filePath}`;
  const body = {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    ...(sha ? { sha } : {})
  };
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`PUT ${url} → ${res.status}: ${errBody}`);
  }
  const data = await res.json();
  return data;
}

async function pushFile(repo, filePath, content, label) {
  try {
    log(`Pushing ${label} → ${OWNER}/${repo}/${filePath}`);
    const sha = await githubGetSHA(repo, filePath);
    const action = sha ? 'Update' : 'Create';
    const message = `${action} ${filePath} — auto-generated from project-mapping.json`;
    await githubPutFile(repo, filePath, content, message, sha);
    log(`✅ ${action}d ${label}`);
    return true;
  } catch (e) {
    warn(`Failed to push ${label}: ${e.message}`);
    return false;
  }
}

// ─── Build all spec file contents ─────────────────────────────────────────────

const { projects = [] } = readMapping();

// 1. Server health
const servers = [];
projects.forEach(p => (p.servers || []).forEach(s => servers.push({ name: `${p.name} — ${s.name}`, url: s.url })));
const serverSpec = `// Auto-generated from config/project-mapping.json — do not edit manually
import { test, expect } from '@playwright/test';

const SERVERS = ${JSON.stringify(servers, null, 2)};

for (const server of SERVERS) {
  test(\`Server Health: \${server.name}\`, async ({ request }) => {
    const res = await request.get(server.url, { timeout: 30000, failOnStatusCode: false });
    expect(res.status(), \`\${server.url} returned \${res.status()}\`).toBeLessThan(500);
  });
}
`;

// 2. SSL certificates
const certs = [];
projects.forEach(p => (p.sslCerts || []).forEach(domain => certs.push({ name: `${p.name} — ${domain}`, domain })));
const certSpec = `// Auto-generated from config/project-mapping.json — do not edit manually
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
`;

// 3. API endpoints
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
const apiSpec = `// Auto-generated from config/project-mapping.json — do not edit manually
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
`;

// 4. App store
const appEntries = [];
projects.forEach(p =>
  (p.apps || []).forEach(a => {
    if (a.playStore) appEntries.push({ name: `${p.name} — ${a.name} (Play Store)`, store: 'play', id: a.playStore });
    if (a.appStore)  appEntries.push({ name: `${p.name} — ${a.name} (App Store)`,  store: 'app',  id: a.appStore });
  })
);
const appSpec = `// Auto-generated from config/project-mapping.json — do not edit manually
import { test, expect } from '@playwright/test';

const APPS = ${JSON.stringify(appEntries, null, 2)};

for (const app of APPS) {
  test(\`App Status: \${app.name}\`, async ({ request }) => {
    const url = app.store === 'play'
      ? \`https://play.google.com/store/apps/details?id=\${app.id}\`
      : \`https://apps.apple.com/app/\${app.id}\`;
    const res = await request.get(url, { timeout: 30000, failOnStatusCode: false });
    expect(res.status(), \`\${url} returned \${res.status()}\`).toBeLessThan(400);
  });
}
`;

// 5. Domain list
const domains = [];
projects.forEach(p => (p.domains || []).forEach(d => domains.push(d)));
const domainsJson = JSON.stringify({ domains }, null, 2);

// ─── Push all files ────────────────────────────────────────────────────────────

const results = await Promise.allSettled([
  pushFile('Adhash_AllProjects_Server',              'tests/server-health/server-check.spec.ts', serverSpec,   `Server spec (${servers.length} servers)`),
  pushFile('AdHash-Projects-Certificate-Expiry-Test','tests/certificate/cert-expiry.spec.ts',    certSpec,     `SSL cert spec (${certs.length} certs)`),
  pushFile('AdHash-API-Test',                        'tests/api/api-tests.spec.ts',              apiSpec,      `API spec (${apis.length} endpoints)`),
  pushFile('Adhash_App_Status',                      'tests/app-status/playstore.spec.ts',       appSpec,      `App spec (${appEntries.length} apps)`),
  pushFile('AdHash_Domain_Report',                   'domains.json',                             domainsJson,  `Domain list (${domains.length} domains)`),
]);

const failed = results.filter(r => r.status === 'rejected' || r.value === false).length;
log(`Done. ${results.length - failed}/${results.length} repos updated.`);
if (failed > 0) {
  warn(`${failed} push(es) failed — check GITHUB_TOKEN permissions.`);
}

const fs = require('fs');
const path = require('path');

const LATEST_API_RESULTS_FILE = 'latest-api-results.json';

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

function normalizeApiMethod(value) {
  return String(value || 'GET').trim().toUpperCase();
}

function buildApiStableKey(method, url, name) {
  return `${normalizeApiMethod(method)}::${normalizeUrl(url)}::${normalizeText(name)}`;
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

function classifyApiStatus(responseCode, expectedStatus) {
  const parsedResponseCode = typeof responseCode === 'number'
    ? responseCode
    : (/^\d+$/.test(String(responseCode || '').trim()) ? parseInt(String(responseCode).trim(), 10) : null);
  const parsedExpectedStatus = parseExpectedStatus(expectedStatus);

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

function getApiDetailStatus(detail, expectedStatus) {
  if (detail && detail.status === 'skipped') {
    return 'skipped';
  }

  return classifyApiStatus(detail && detail.responseCode, expectedStatus);
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

function getLatestApiResultsPath(rootDir = process.cwd()) {
  return path.join(rootDir, 'test-results', LATEST_API_RESULTS_FILE);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function buildProjectApiSummary(project, apiDetails) {
  const projectApiKeys = new Set((project.apis || []).map((api) => buildApiStableKey(api.method, api.url, api.name)));
  const detailByKey = new Map(
    dedupeApiResults((apiDetails || []).filter((detail) => detail && projectApiKeys.has(buildApiStableKey(detail.method, detail.url, detail.name))))
      .map((detail) => [buildApiStableKey(detail.method, detail.url, detail.name), detail])
  );

  const summary = {
    total: 0,
    passed: 0,
    failed: 0,
    warning: 0,
    skipped: 0,
    source: 'latest-run'
  };

  for (const api of project.apis || []) {
    const stableKey = buildApiStableKey(api.method, api.url, api.name);
    const detail = detailByKey.get(stableKey);
    const status = detail
      ? getApiDetailStatus(detail, api.expectedStatus ?? detail.expectedStatus)
      : 'failed';

    summary.total += 1;
    summary[status] += 1;
  }

  return summary;
}

function buildLatestApiResultsPayload(rootDir = process.cwd()) {
  const mappingPath = path.join(rootDir, 'config', 'project-mapping.json');
  const statePath = path.join(rootDir, 'test-results', 'dashboard-state.json');

  const mapping = fs.existsSync(mappingPath) ? readJsonFile(mappingPath) : { projects: [] };
  const state = fs.existsSync(statePath) ? readJsonFile(statePath) : {};
  const apiDetails = state && state.suites && state.suites.api && Array.isArray(state.suites.api.details)
    ? state.suites.api.details
    : [];

  return {
    generatedAt: state.generatedAt || new Date().toISOString(),
    source: 'latest-run',
    projects: (mapping.projects || []).map((project) => ({
      id: project.id,
      name: project.name,
      results: {
        apis: buildProjectApiSummary(project, apiDetails)
      }
    }))
  };
}

function writeLatestApiResultsPayload(rootDir = process.cwd(), payload) {
  const filePath = getLatestApiResultsPath(rootDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

function readLatestApiResultsPayload(rootDir = process.cwd()) {
  const filePath = getLatestApiResultsPath(rootDir);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return readJsonFile(filePath);
}

module.exports = {
  buildLatestApiResultsPayload,
  getLatestApiResultsPath,
  readLatestApiResultsPayload,
  writeLatestApiResultsPayload
};
import fs from 'fs';
import path from 'path';

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readTextFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function ensureFileExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`[validate:report] Missing ${label}: ${filePath}`);
  }
}

function getExpectedStatusLabel(summary) {
  if ((summary.failed || 0) > 0) {
    return 'FAILED';
  }

  if ((summary.warning || 0) > 0 || (summary.skipped || 0) > 0) {
    return 'WARNING';
  }

  return 'PASSED';
}

function extractDdpCard(html, label) {
  const markerMatch = /<div[^>]*>DDP<\/div>/i.exec(html);
  if (!markerMatch || markerMatch.index === undefined) {
    throw new Error(`[validate:report] Unable to locate DDP card in ${label}`);
  }

  const cardSlice = html.slice(markerMatch.index, markerMatch.index + 8000);
  const failedMatch = cardSlice.match(/project-failed-count">❗\s*(\d+)/i);
  const statusMatch = cardSlice.match(/<td[^>]*>(PASSED|FAILED|WARNING)<\/td>/i);
  const totalMatch = cardSlice.match(/project-chip-badge chip-api [^"]*">API\s*(\d+)/i);

  if (!statusMatch || !totalMatch) {
    throw new Error(`[validate:report] Unable to parse DDP API summary from ${label}`);
  }

  return {
    failed: failedMatch ? parseInt(failedMatch[1], 10) : 0,
    total: parseInt(totalMatch[1], 10),
    statusLabel: statusMatch[1],
    cardSlice
  };
}

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(`[validate:report] ${message}`);
  }
}

const rootDir = process.cwd();
const latestApiResultsPath = path.join(rootDir, 'test-results', 'latest-api-results.json');
const emailPreviewPath = path.join(rootDir, 'email-preview', 'index.html');
const finalBundlePath = path.join(rootDir, 'final-dashboard-bundle', 'AdHash-Projects-Dashboard.html');

ensureFileExists(latestApiResultsPath, 'latest API results');
ensureFileExists(emailPreviewPath, 'email preview HTML');
ensureFileExists(finalBundlePath, 'final dashboard bundle HTML');

const latestApiResults = readJsonFile(latestApiResultsPath);
const ddpProject = (latestApiResults.projects || []).find((project) => project.id === 'ddp');
const latestApi = ddpProject?.results?.apis;

assertCondition(Boolean(latestApi), 'DDP API summary missing from latest-api-results.json');
assertCondition(latestApi.total === 16, `Expected DDP API total 16, got ${latestApi.total}`);

const emailCard = extractDdpCard(readTextFile(emailPreviewPath), 'email preview');
const dashboardCard = extractDdpCard(readTextFile(finalBundlePath), 'final dashboard bundle');
const expectedStatus = getExpectedStatusLabel(latestApi);

assertCondition(emailCard.total === latestApi.total, `DDP API total mismatch in email: expected ${latestApi.total}, got ${emailCard.total}`);
assertCondition(dashboardCard.total === latestApi.total, `DDP API total mismatch in final dashboard: expected ${latestApi.total}, got ${dashboardCard.total}`);
assertCondition(emailCard.failed === latestApi.failed, `DDP failed count mismatch in email: expected ${latestApi.failed}, got ${emailCard.failed}`);
assertCondition(dashboardCard.failed === latestApi.failed, `DDP failed count mismatch in final dashboard: expected ${latestApi.failed}, got ${dashboardCard.failed}`);
assertCondition(emailCard.statusLabel === expectedStatus, `DDP status mismatch in email: expected ${expectedStatus}, got ${emailCard.statusLabel}`);
assertCondition(dashboardCard.statusLabel === expectedStatus, `DDP status mismatch in final dashboard: expected ${expectedStatus}, got ${dashboardCard.statusLabel}`);
assertCondition(!emailCard.cardSlice.includes('❗ 10'), 'Stale DDP failed badge ❗ 10 found in email preview');
assertCondition(!dashboardCard.cardSlice.includes('❗ 10'), 'Stale DDP failed badge ❗ 10 found in final dashboard bundle');
assertCondition(emailCard.total === dashboardCard.total, `DDP API total mismatch between email and dashboard: ${emailCard.total} vs ${dashboardCard.total}`);
assertCondition(emailCard.failed === dashboardCard.failed, `DDP failed count mismatch between email and dashboard: ${emailCard.failed} vs ${dashboardCard.failed}`);
assertCondition(emailCard.statusLabel === dashboardCard.statusLabel, `DDP status mismatch between email and dashboard: ${emailCard.statusLabel} vs ${dashboardCard.statusLabel}`);

console.log(`[validate:report] Source: ${latestApiResults.source || 'latest-run'}`);
console.log(`[validate:report] DDP API = ${latestApi.passed}/${latestApi.total} passed, failed ${latestApi.failed}`);
console.log(`[validate:report] Email DDP = API ${emailCard.total}, failed ${emailCard.failed}, status ${emailCard.statusLabel}`);
console.log(`[validate:report] Dashboard DDP = API ${dashboardCard.total}, failed ${dashboardCard.failed}, status ${dashboardCard.statusLabel}`);
console.log('[validate:report] Report consistency validated');
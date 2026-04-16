import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { generateDashboard } from './utils/dashboard-generator';
import { sendTestReport } from './utils/email-sender';

dotenv.config();

const execAsync = promisify(exec);
const DASHBOARD_STATE_PATH = path.join(process.cwd(), 'test-results', 'dashboard-state.json');
const DOMAIN_REPORT_WORKING_DIRECTORY = path.join(process.cwd(), 'godaddy');
const DOMAIN_REPORT_ENTRY_PATH = path.join(DOMAIN_REPORT_WORKING_DIRECTORY, 'index.js');
const DOMAIN_REPORT_PACKAGE_PATH = path.join(DOMAIN_REPORT_WORKING_DIRECTORY, 'package.json');
const DOMAIN_REPORT_OUTPUT_PATH = path.join(DOMAIN_REPORT_WORKING_DIRECTORY, 'report.html');
const EXPIRY_WARNING_DAYS = 30;

type SuiteId = 'app' | 'server' | 'cert' | 'api' | 'domain';

type DomainDetailStatus = 'active' | 'expiring' | 'error';

type SslDetailStatus = 'passed' | 'warning' | 'failed';

interface DomainDetail {
  domain: string;
  url: string;
  status: DomainDetailStatus;
  expiryDate: string | null;
  expiryDateIST: string;
  daysRemaining: number | null;
}

interface SslDetail {
  domain: string;
  url: string;
  status: SslDetailStatus;
  expiryDate: string | null;
  expiryDateIST: string;
  daysRemaining: number | null;
  reason?: string;
}

interface ApiDetail {
  name: string;
  url: string;
  method: string;
  requestBody: string;
  responseBody: string;
  responseCode: number | null;
  expectedStatus?: number;
  status: 'passed' | 'warning' | 'failed';
  type: 'api';
}

type SuiteDetail = DomainDetail | SslDetail | ApiDetail;

interface DomainSuiteReport {
  passed: number;
  failed: number;
  warnings: number;
  total: number;
  details: SuiteDetail[];
}

interface ApiSuiteConfig {
  name: string;
  url: string;
  method: string;
  expectedStatus?: number;
}

interface TestResult {
  repository: string;
  status: 'success' | 'failed' | 'error' | 'unavailable';
  duration: number;
  reportPath: string;
  error?: string;
  message?: string;
  passed?: number;
  failed?: number;
  warnings?: number;
  total?: number;
  details?: SuiteDetail[];
}

interface SuiteDefinition {
  id: SuiteId;
  repository: string;
  displayName: string;
  icon: string;
  stepLabel: string;
  specPath?: string;
  countPattern?: RegExp;
  unavailableMessage?: string;
}

interface SuiteExecutionConfig {
  command: string;
  cwd: string;
  fallbackTotal: number;
  reportPath?: string;
}

interface DashboardStateSuite {
  status: 'passed' | 'failed' | 'warning' | 'not-run' | 'unavailable';
  passed: number;
  failed: number;
  warning: number;
  total: number;
  details: SuiteDetail[];
  duration: number;
  reportPath: string;
  message?: string;
}

interface DashboardState {
  generatedAt: string;
  summary: {
    passedSuites: number;
    failedSuites: number;
    warningSuites: number;
    skippedSuites: number;
    totalSuites: number;
    configuredSuites: number;
  };
  suites: Record<SuiteId, DashboardStateSuite>;
}

const suiteDefinitions: SuiteDefinition[] = [
  {
    id: 'app',
    repository: 'Adhash_App_Status',
    displayName: 'App Status Verification',
    icon: '📱',
    stepLabel: '📱 Step 1/5: Running App Status Tests...',
    specPath: 'tests/app-status/playstore.spec.ts',
    countPattern: /test\(/g
  },
  {
    id: 'server',
    repository: 'Adhash_AllProjects_Server',
    displayName: 'Server Health Monitoring',
    icon: '🖥️',
    stepLabel: '🖥️  Step 2/5: Running Server Health Tests...',
    specPath: 'tests/server-health/server-check.spec.ts',
    countPattern: /\{\s*name:/g
  },
  {
    id: 'cert',
    repository: 'AdHash-Projects-Certificate-Expiry-Test',
    displayName: 'SSL Certificate Monitoring',
    icon: '🔒',
    stepLabel: '🔒 Step 3/5: Running Certificate Expiry Tests...',
    specPath: 'tests/certificate/cert-expiry.spec.ts',
    countPattern: /\{\s*name:/g
  },
  {
    id: 'api',
    repository: 'AdHash-API-Test',
    displayName: 'API Endpoint Testing',
    icon: '🌐',
    stepLabel: '🌐 Step 4/5: Running API Tests...',
    specPath: 'tests/api/api-tests.spec.ts',
    countPattern: /\{\s*name:/g
  },
  {
  id: 'domain',
  repository: 'AdHash_Domain_Report',
  displayName: 'Domain Expiry Monitoring',
  icon: '🌐',
  stepLabel: '🌐 Step 5/5: Running Domain Expiry Monitoring...'
}
];

function isSuiteConfigured(definition: SuiteDefinition): boolean {
  return !!getSuiteExecutionConfig(definition);
}

function countSuiteTests(definition: SuiteDefinition): number {
  if (!definition.specPath || !definition.countPattern) {
    return 0;
  }

  const filePath = path.join(process.cwd(), definition.specPath);
  if (!fs.existsSync(filePath)) {
    return 0;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const matches = content.match(definition.countPattern);
  return matches ? matches.length : 0;
}

function getSuiteExecutionConfig(definition: SuiteDefinition): SuiteExecutionConfig | null {
  if (definition.id === 'domain') {
    if (!fs.existsSync(DOMAIN_REPORT_ENTRY_PATH) || !fs.existsSync(DOMAIN_REPORT_PACKAGE_PATH)) {
      return null;
    }

    return {
      command: 'npm start',
      cwd: DOMAIN_REPORT_WORKING_DIRECTORY,
      fallbackTotal: 0,
      reportPath: DOMAIN_REPORT_OUTPUT_PATH
    };
  }

  if (!definition.specPath || !fs.existsSync(path.join(process.cwd(), definition.specPath))) {
    return null;
  }

  return {
    command: `npx playwright test ${definition.specPath}`,
    cwd: process.cwd(),
    fallbackTotal: countSuiteTests(definition)
  };
}

function getSelectedSuites(): SuiteDefinition[] {
  const suiteArgIndex = process.argv.indexOf('--suite');
  if (suiteArgIndex === -1) {
    return suiteDefinitions;
  }

  const requestedSuite = process.argv[suiteArgIndex + 1] as SuiteId | undefined;
  if (!requestedSuite) {
    return suiteDefinitions;
  }

  return suiteDefinitions.filter((definition) => definition.id === requestedSuite);
}

function archiveSuiteReport(repository: string): string {
  const sourceReportPath = path.join(process.cwd(), 'unified-report', 'index.html');
  if (!fs.existsSync(sourceReportPath)) {
    return '';
  }

  const reportDir = path.join(process.cwd(), 'suite-reports');
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const targetFile = path.join(reportDir, `${repository.replace(/[^a-zA-Z0-9]/g, '_')}.html`);
  fs.copyFileSync(sourceReportPath, targetFile);
  return path.relative(process.cwd(), targetFile).replace(/\\/g, '/');
}

function parseUnifiedSuiteReport(reportPath: string, fallbackTotal: number): { passed: number; failed: number; total: number } {
  if (!reportPath) {
    return { passed: 0, failed: 0, total: fallbackTotal };
  }

  const fullReportPath = path.join(process.cwd(), reportPath);
  if (!fs.existsSync(fullReportPath)) {
    return { passed: 0, failed: 0, total: fallbackTotal };
  }

  const html = fs.readFileSync(fullReportPath, 'utf-8');
  const totalMatch = html.match(/<div class="card-value">(\d+)<\/div>\s*<div class="card-label">Total Tests<\/div>/i);
  const passedMatch = html.match(/<div class="card-value">(\d+)<\/div>\s*<div class="card-label">Passed<\/div>/i);
  const failedMatch = html.match(/<div class="card-value">(\d+)<\/div>\s*<div class="card-label">Failed<\/div>/i);

  return {
    total: totalMatch ? parseInt(totalMatch[1], 10) : fallbackTotal,
    passed: passedMatch ? parseInt(passedMatch[1], 10) : 0,
    failed: failedMatch ? parseInt(failedMatch[1], 10) : 0
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2f;/gi, '/');
}

function normalizeHtmlText(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeBase64Value(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch (error) {
    return undefined;
  }
}

function formatToIST(value?: string | null): string {
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

function parseDateValue(value?: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || /^n\/?a$/i.test(trimmed)) {
    return null;
  }

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function parseDaysRemaining(value?: string | null): number | null {
  if (!value) {
    return null;
  }

  const match = value.match(/-?\d+/);
  if (!match) {
    return null;
  }

  const days = parseInt(match[0], 10);
  return Number.isNaN(days) ? null : days;
}

function getExpiryStatus(daysRemaining?: number | null, hasError = false): SslDetailStatus {
  const normalizedDays = daysRemaining === null || daysRemaining === undefined
    ? null
    : Number(daysRemaining);

  if (hasError || normalizedDays === null || Number.isNaN(normalizedDays)) {
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

function classifyDomainStatus(daysRemaining: number | null | undefined, hasError = false): DomainDetailStatus {
  const status = getExpiryStatus(daysRemaining, hasError);

  if (status === 'warning') {
    return 'expiring';
  }

  if (status === 'failed') {
    return 'error';
  }

  return 'active';
}

function normalizeDomainHost(value?: string | null): string {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

function buildTrackedDetailKey(type: 'ssl' | 'domain', domain?: string | null, url?: string | null): string {
  return `${type}::${normalizeDomainHost(domain || url || '')}`;
}

function getTrackedDetailScore(detail: { status?: string; expiryDate?: string | null; expiryDateIST?: string; daysRemaining?: number | null; reason?: string }): number {
  let score = 0;

  if (detail.expiryDate) {
    score += 3;
  }

  if (detail.expiryDateIST && detail.expiryDateIST !== 'N/A') {
    score += 2;
  }

  if (detail.daysRemaining !== null && detail.daysRemaining !== undefined && !Number.isNaN(Number(detail.daysRemaining))) {
    score += 3;
  }

  if (detail.reason) {
    score += 2;
  }

  if (detail.status === 'passed') {
    score += 3;
  } else if (detail.status === 'warning' || detail.status === 'expiring') {
    score += 2;
  } else if (detail.status === 'failed' || detail.status === 'error') {
    score += 1;
  }

  return score;
}

function pickPreferredTrackedDetail<T extends { domain?: string; url?: string; status?: string; expiryDate?: string | null; expiryDateIST?: string; daysRemaining?: number | null; reason?: string }>(
  existing: T | undefined,
  incoming: T
): T {
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

function normalizeSslFailureReason(errorMessage?: string | null): string | undefined {
  const normalizedMessage = String(errorMessage || '').trim();
  if (!normalizedMessage) {
    return undefined;
  }

  if (/ENOTFOUND|getaddrinfo/i.test(normalizedMessage)) {
    return `DNS RESOLUTION FAILED: ${normalizedMessage}`;
  }

  if (/ETIMEDOUT|timeout/i.test(normalizedMessage)) {
    return `TCP CONNECT TIMEOUT: ${normalizedMessage}`;
  }

  if (/handshake|tls|ssl/i.test(normalizedMessage)) {
    return `TLS HANDSHAKE FAILED: ${normalizedMessage}`;
  }

  if (/No certificate found/i.test(normalizedMessage)) {
    return `CERTIFICATE FETCH FAILED: ${normalizedMessage}`;
  }

  return `CERTIFICATE FETCH FAILED: ${normalizedMessage}`;
}

function dedupeDomainDetails(details: DomainDetail[]): DomainDetail[] {
  const deduped = new Map<string, DomainDetail>();

  details.forEach((detail) => {
    if (!detail) {
      return;
    }

    const normalizedDomain = normalizeDomainHost(detail.domain || detail.url);
    if (!normalizedDomain) {
      return;
    }

    const normalizedDetail: DomainDetail = {
      ...detail,
      domain: normalizedDomain,
      url: detail.url || `https://${normalizedDomain}`
    };

    deduped.set(
      buildTrackedDetailKey('domain', normalizedDetail.domain, normalizedDetail.url),
      pickPreferredTrackedDetail(deduped.get(buildTrackedDetailKey('domain', normalizedDetail.domain, normalizedDetail.url)), normalizedDetail)
    );
  });

  return Array.from(deduped.values());
}

function dedupeSslDetails(details: SslDetail[]): SslDetail[] {
  const deduped = new Map<string, SslDetail>();

  details.forEach((detail) => {
    if (!detail) {
      return;
    }

    const normalizedDomain = normalizeDomainHost(detail.domain || detail.url);
    if (!normalizedDomain) {
      return;
    }

    const normalizedDetail: SslDetail = {
      ...detail,
      domain: normalizedDomain,
      url: detail.url || `https://${normalizedDomain}`
    };

    deduped.set(
      buildTrackedDetailKey('ssl', normalizedDetail.domain, normalizedDetail.url),
      pickPreferredTrackedDetail(deduped.get(buildTrackedDetailKey('ssl', normalizedDetail.domain, normalizedDetail.url)), normalizedDetail)
    );
  });

  return Array.from(deduped.values());
}

function toDomainStatusFromSsl(status: SslDetailStatus): DomainDetailStatus {
  if (status === 'warning') {
    return 'expiring';
  }

  if (status === 'failed') {
    return 'error';
  }

  return 'active';
}

function loadConfiguredDomains(): Set<string> {
  const mappingPath = path.join(process.cwd(), 'config', 'project-mapping.json');
  if (!fs.existsSync(mappingPath)) {
    return new Set();
  }

  try {
    const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8')) as { projects?: Array<{ domains?: string[] }> };
    return new Set(
      (mapping.projects || [])
        .flatMap((project) => project.domains || [])
        .map((domain) => normalizeDomainHost(domain))
        .filter(Boolean)
    );
  } catch (error) {
    console.error('[Domain Parser] Failed to load configured domains:', error);
    return new Set();
  }
}

function enrichDomainDetailsWithSsl(domainDetails: DomainDetail[], sslDetails: SslDetail[]): DomainDetail[] {
  const detailsByDomain = new Map<string, DomainDetail>();
  const configuredDomains = loadConfiguredDomains();

  dedupeDomainDetails(domainDetails).forEach((detail) => {
    detailsByDomain.set(normalizeDomainHost(detail.domain), {
      ...detail,
      url: detail.url || `https://${normalizeDomainHost(detail.domain)}`,
      status: classifyDomainStatus(detail.daysRemaining, detail.status === 'error' && (detail.daysRemaining === null || detail.daysRemaining === undefined))
    });
  });

  dedupeSslDetails(sslDetails).forEach((detail) => {
    const normalizedDomain = normalizeDomainHost(detail.domain);
    if (!normalizedDomain || !configuredDomains.has(normalizedDomain)) {
      return;
    }

    const existingDetail = detailsByDomain.get(normalizedDomain);
    if (existingDetail) {
      const daysRemaining = existingDetail.daysRemaining ?? detail.daysRemaining;
      detailsByDomain.set(normalizedDomain, {
        ...existingDetail,
        url: existingDetail.url || detail.url || `https://${normalizedDomain}`,
        status: classifyDomainStatus(daysRemaining, existingDetail.status === 'error' && (daysRemaining === null || daysRemaining === undefined)),
        expiryDate: existingDetail.expiryDate || detail.expiryDate,
        expiryDateIST: existingDetail.expiryDateIST !== 'N/A' ? existingDetail.expiryDateIST : detail.expiryDateIST,
        daysRemaining
      });
      return;
    }

    detailsByDomain.set(normalizedDomain, {
      domain: normalizedDomain,
      url: detail.url || `https://${normalizedDomain}`,
      status: classifyDomainStatus(detail.daysRemaining, detail.status === 'failed'),
      expiryDate: detail.expiryDate,
      expiryDateIST: detail.expiryDateIST,
      daysRemaining: detail.daysRemaining
    });
  });

  return dedupeDomainDetails(Array.from(detailsByDomain.values()))
    .filter((detail) => configuredDomains.has(normalizeDomainHost(detail.domain)));
}

function normalizeApiMethod(method?: string): string {
  return String(method || 'GET').trim().toUpperCase();
}

function normalizeApiUrl(value?: string): string {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

function normalizeApiName(value?: string): string {
  return normalizeHtmlText(String(value || '')).toLowerCase();
}

function buildApiStableKey(method?: string, url?: string, name?: string): string {
  return `${normalizeApiMethod(method)}::${normalizeApiUrl(url)}::${normalizeApiName(name)}`;
}

function getApiRequestFallback(method: string): string {
  return method === 'GET' || method === 'DELETE' ? 'No request body' : 'Payload not provided';
}

function getApiResponseFallback(): string {
  return 'No response body';
}

function classifyApiStatus(responseCode: number | null, expectedStatus?: number): 'passed' | 'warning' | 'failed' {
  if (typeof expectedStatus === 'number') {
    if (responseCode !== expectedStatus) {
      return 'failed';
    }

    if (expectedStatus >= 300 && expectedStatus < 400) {
      return 'warning';
    }

    return 'passed';
  }

  if (responseCode === null) {
    return 'failed';
  }

  if (responseCode >= 200 && responseCode < 300) {
    return 'passed';
  }

  if (responseCode >= 300 && responseCode < 400) {
    return 'warning';
  }

  return 'failed';
}

function loadApiSuiteConfigs(): ApiSuiteConfig[] {
  const mappingPath = path.join(process.cwd(), 'config', 'project-mapping.json');
  if (!fs.existsSync(mappingPath)) {
    return [];
  }

  try {
    const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8')) as { projects?: Array<{ apis?: ApiSuiteConfig[] }> };
    return (mapping.projects || [])
      .flatMap((project) => project.apis || [])
      .filter((api): api is ApiSuiteConfig => Boolean(api?.name && api?.url && api?.method));
  } catch (error) {
    console.error('[API Parser] Failed to load project mapping for API expectations:', error);
    return [];
  }
}

function parseApiSuiteReport(reportPath: string, fallbackTotal: number): DomainSuiteReport {
  if (!reportPath) {
    return { passed: 0, failed: 0, warnings: 0, total: fallbackTotal, details: [] };
  }

  const fullReportPath = path.join(process.cwd(), reportPath);
  if (!fs.existsSync(fullReportPath)) {
    return { passed: 0, failed: 0, warnings: 0, total: fallbackTotal, details: [] };
  }

  const html = fs.readFileSync(fullReportPath, 'utf8');
  const rowPattern = /<tr class="test-row (passed|failed|skipped)">[\s\S]*?<td class="test-name">([^<]+)<\/td>[\s\S]*?<span class="status-badge [^"]+">([^<]+)<\/span>[\s\S]*?<td class="test-duration">([^<]+)<\/td>[\s\S]*?<td class="test-details"([^>]*)>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/gi;
  const configs = loadApiSuiteConfigs();
  const configByMethodAndName = new Map(
    configs.map((entry) => [
      `${normalizeApiMethod(entry.method)}::${normalizeApiName(entry.name)}`,
      entry
    ])
  );
  const detailsByKey = new Map<string, ApiDetail>();
  let parsedCount = 0;

  for (const match of html.matchAll(rowPattern)) {
    const attributes = match[5] || '';
    const title = decodeHtmlEntities(match[2]).trim();
    const titleMatch = title.match(/^(GET|POST|PUT|DELETE|PATCH)\s+(.+)$/i);

    if (!titleMatch) {
      continue;
    }

    const method = normalizeApiMethod(titleMatch[1]);
    const name = titleMatch[2].trim();
    const requestBody = decodeBase64Value(attributes.match(/data-request-body="([^"]*)"/i)?.[1]) || getApiRequestFallback(method);
    const responseBody = decodeBase64Value(attributes.match(/data-response-body="([^"]*)"/i)?.[1]) || getApiResponseFallback();
    const responseCodeValue = decodeHtmlEntities(attributes.match(/data-response-code="([^"]*)"/i)?.[1] || '').trim();
    const responseCode = /^\d+$/.test(responseCodeValue) ? parseInt(responseCodeValue, 10) : null;

    const config = configByMethodAndName.get(`${method}::${normalizeApiName(name)}`);

    const apiResult: ApiDetail = {
      name,
      url: config?.url || '',
      method,
      requestBody,
      responseBody,
      responseCode,
      expectedStatus: config?.expectedStatus,
      status: classifyApiStatus(responseCode, config?.expectedStatus),
      type: 'api'
    };

    console.log('API RESULT PARSED:', apiResult);
    detailsByKey.set(buildApiStableKey(apiResult.method, apiResult.url, apiResult.name), apiResult);
    parsedCount++;
  }

  const details = Array.from(detailsByKey.values());

  console.log('DEDUPED API RESULTS:', {
    parsed: parsedCount,
    unique: details.length,
    removed: parsedCount - details.length
  });

  return {
    passed: details.filter((detail) => detail.status === 'passed').length,
    failed: details.filter((detail) => detail.status === 'failed').length,
    warnings: details.filter((detail) => detail.status === 'warning').length,
    total: details.length || fallbackTotal,
    details
  };
}

function parseDomainSuiteReport(reportPath: string, fallbackTotal: number): DomainSuiteReport {
  if (!reportPath) {
    console.log('[Domain Parser] Report path missing: N/A');
    return { passed: 0, failed: 0, warnings: 0, total: fallbackTotal, details: [] };
  }

  try {
    if (!fs.existsSync(reportPath)) {
      console.log(`[Domain Parser] Report file not found at ${reportPath}`);
      return { passed: 0, failed: 0, warnings: 0, total: fallbackTotal, details: [] };
    }

    const html = fs.readFileSync(reportPath, 'utf-8');

    if (!html || !html.trim()) {
      console.log(`[Domain Parser] Empty HTML in ${reportPath}`);
      return { passed: 0, failed: 0, warnings: 0, total: fallbackTotal, details: [] };
    }

    const details: DomainDetail[] = [];
    const cardPattern = /<div class="domain-card(?: expiring-soon| error)?"[^>]*>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi;

    for (const match of html.matchAll(cardPattern)) {
      const cardHtml = match[0];
      const domain = normalizeDomainHost(cardHtml.match(/<div class="domain-url">([^<]+)<\/div>/i)?.[1]);
      if (!domain) {
        continue;
      }

      const badgeClass = cardHtml.match(/<span class="status-badge ([^"]+)">/i)?.[1] || '';
      const daysText = cardHtml.match(/<div class="days-remaining(?: [^"]+)?"[^>]*>\s*([^<]+)\s*<\/div>/i)?.[1] || '';
      const daysRemaining = parseDaysRemaining(daysText);
      const expiryDate = parseDateValue(cardHtml.match(/<div class="expiry-date">([^<]+)<\/div>/i)?.[1]);
      const expiryDateIST = cardHtml.match(/<div class="expiry-date-ist">([^<]+)<\/div>/i)?.[1]?.trim() || formatToIST(expiryDate);
      const status = classifyDomainStatus(daysRemaining, !badgeClass.includes('status-active'));

      details.push({
        domain,
        url: `https://${domain}`,
        status,
        expiryDate,
        expiryDateIST,
        daysRemaining
      });
    }

    const rowPattern = /<div class="domain-row">([\s\S]*?)<\/div>/gi;
    for (const match of html.matchAll(rowPattern)) {
      const rowHtml = match[1] || '';
      const domain = normalizeDomainHost(rowHtml.match(/domain-name">([^<]+)</i)?.[1]);
      if (!domain || details.some((detail) => normalizeDomainHost(detail.domain) === domain)) {
        continue;
      }

      const expiryDate = parseDateValue(rowHtml.match(/expiry-date">([^<]+)</i)?.[1]);
      const daysRemaining = parseDaysRemaining(rowHtml.match(/days-remaining">([^<]+)</i)?.[1]);
      const rawStatus = (rowHtml.match(/status\s+(active|expiring|error)/i)?.[1] || 'error').toLowerCase();
      const status = classifyDomainStatus(daysRemaining, rawStatus === 'error');

      details.push({
        domain,
        url: `https://${domain}`,
        status,
        expiryDate,
        expiryDateIST: formatToIST(expiryDate),
        daysRemaining
      });
    }

    const dedupedDetails = dedupeDomainDetails(details);
    const passed = dedupedDetails.filter((detail) => detail.status === 'active').length;
    const failed = dedupedDetails.filter((detail) => detail.status === 'error').length;
    const warnings = dedupedDetails.filter((detail) => detail.status === 'expiring').length;
    const total = dedupedDetails.length;
    const sampleDomains = dedupedDetails.slice(0, 3).map((detail) => `${detail.domain} (${detail.status})`).join(', ');

    console.log(`[Domain Parser] Parsed ${details.length} domain rows from ${reportPath}`);
    console.log(`[Domain Parser] Deduped to ${dedupedDetails.length} domain rows`);
    console.log(`[Domain Parser] Sample parsed domains: ${sampleDomains || 'none'}`);
    console.log('DOMAIN DETAILS PARSED:', dedupedDetails);

    return {
      passed,
      failed,
      warnings,
      total,
      details: dedupedDetails
    };
  } catch (error) {
    console.error(`[Domain Parser] Failed to parse ${reportPath}:`, error);
    return { passed: 0, failed: 0, warnings: 0, total: fallbackTotal, details: [] };
  }
}

function parseSslSuiteReport(reportPath: string, rawOutput: string, fallbackTotal: number): DomainSuiteReport {
  if (!reportPath) {
    return { passed: 0, failed: 0, warnings: 0, total: fallbackTotal, details: [] };
  }

  const fullReportPath = path.join(process.cwd(), reportPath);
  if (!fs.existsSync(fullReportPath)) {
    return { passed: 0, failed: 0, warnings: 0, total: fallbackTotal, details: [] };
  }

  const html = fs.readFileSync(fullReportPath, 'utf-8');
  const summary = parseUnifiedSuiteReport(reportPath, fallbackTotal);
  const rowPattern = /<tr class="test-row (passed|failed|skipped)">[\s\S]*?<td class="test-name">Check SSL certificate for ([^<]+)<\/td>[\s\S]*?<\/tr>/gi;
  const details: SslDetail[] = [];

  for (const match of html.matchAll(rowPattern)) {
    const rowStatus = match[1].toLowerCase();
    const domain = decodeHtmlEntities(match[2]).trim();

    if (!domain || rowStatus === 'skipped') {
      continue;
    }

    const outputBlockMatch = rawOutput.match(new RegExp(`=== ${escapeRegExp(domain)} Certificate Info ===([\\s\\S]*?)=====================================`, 'i'));
    const outputBlock = (outputBlockMatch?.[1] || '').replace(/Valid To:/i, 'Expiry Date:');
    const expiryMatch = outputBlock.match(/Expiry Date:\s*([^\n<]+)/i);
    const daysMatch = outputBlock.match(/Days Remaining:\s*(-?\d+)/i);
    const failureMatch = rawOutput.match(new RegExp(`✗ Error checking certificate for ${escapeRegExp(domain)}:\s*([^\r\n]+)`, 'i'));

    const expiryDate = parseDateValue(expiryMatch?.[1]?.trim() || null);
    const daysRemaining = parseDaysRemaining(daysMatch?.[1]?.trim() || null);
    const status = getExpiryStatus(daysRemaining, rowStatus !== 'passed');
    const reason = status === 'failed'
      ? normalizeSslFailureReason(failureMatch?.[1]?.trim() || null)
      : undefined;

    details.push({
      domain: normalizeDomainHost(domain),
      url: `https://${normalizeDomainHost(domain)}`,
      status,
      expiryDate,
      expiryDateIST: formatToIST(expiryDate),
      daysRemaining,
      reason
    });
  }

  const dedupedDetails = dedupeSslDetails(details);
  const passed = dedupedDetails.filter((detail) => detail.status === 'passed').length;
  const failed = dedupedDetails.filter((detail) => detail.status === 'failed').length;
  const warnings = dedupedDetails.filter((detail) => detail.status === 'warning').length;
  const total = dedupedDetails.length;
  const sampleDetails = dedupedDetails.slice(0, 3).map((detail) => `${detail.domain} => ${detail.expiryDate} (${detail.daysRemaining} days)`).join(', ');

  console.log(`[SSL Parser] Parsed ${details.length} SSL details from ${reportPath}`);
  console.log(`[SSL Parser] Deduped to ${dedupedDetails.length} SSL details`);
  console.log(`[SSL Parser] Sample SSL details: ${sampleDetails || 'none'}`);
  console.log('SSL DETAILS PARSED:', dedupedDetails);

  return {
    passed,
    failed,
    warnings,
    total,
    details: dedupedDetails
  };
}

function createUnavailableResult(definition: SuiteDefinition): TestResult {
  return {
    repository: definition.repository,
    status: 'unavailable',
    duration: 0,
    reportPath: '',
    passed: 0,
    failed: 0,
    warnings: 0,
    total: 0,
    details: [],
    message: definition.unavailableMessage || 'Not configured in current workspace'
  };
}

function createDefaultResult(definition: SuiteDefinition): TestResult {
  const execution = getSuiteExecutionConfig(definition);

  if (!execution) {
    return createUnavailableResult(definition);
  }

  return {
    repository: definition.repository,
    status: 'error',
    duration: 0,
    reportPath: '',
    passed: 0,
    failed: 0,
    warnings: 0,
    total: execution.fallbackTotal,
    details: []
  };
}

function readDashboardState(): DashboardState | null {
  if (!fs.existsSync(DASHBOARD_STATE_PATH)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(DASHBOARD_STATE_PATH, 'utf-8')) as DashboardState;
  } catch (error) {
    console.error('Failed to read dashboard state:', error);
    return null;
  }
}

function buildStoredResultsMap(): Map<string, TestResult> {
  const storedState = readDashboardState();
  const storedResults = new Map<string, TestResult>();

  suiteDefinitions.forEach((definition) => {
    const suiteState = storedState?.suites?.[definition.id];
    if (!suiteState) {
      storedResults.set(definition.repository, createDefaultResult(definition));
      return;
    }

    storedResults.set(definition.repository, {
      repository: definition.repository,
      status: suiteState.status === 'passed' ? 'success' : suiteState.status === 'unavailable' ? 'unavailable' : suiteState.status === 'not-run' ? 'error' : 'failed',
      duration: suiteState.duration || 0,
      reportPath: suiteState.reportPath || '',
      message: suiteState.message,
      passed: suiteState.passed || 0,
      failed: suiteState.failed || 0,
      warnings: suiteState.warning || 0,
      total: suiteState.total || 0,
      details: suiteState.details || []
    });
  });

  return storedResults;
}

function writeDashboardState(finalResults: TestResult[]): void {
  const domainResult = finalResults.find((entry) => entry.repository === 'AdHash_Domain_Report');
  const sslResult = finalResults.find((entry) => entry.repository === 'AdHash-Projects-Certificate-Expiry-Test');

  if (sslResult) {
    sslResult.details = dedupeSslDetails((sslResult.details || []) as SslDetail[]);
    sslResult.total = sslResult.details.length;
    sslResult.passed = sslResult.details.filter((detail) => (detail as SslDetail).status === 'passed').length;
    sslResult.warnings = sslResult.details.filter((detail) => (detail as SslDetail).status === 'warning').length;
    sslResult.failed = sslResult.details.filter((detail) => (detail as SslDetail).status === 'failed').length;
    sslResult.status = sslResult.failed > 0 ? 'failed' : sslResult.warnings > 0 ? 'failed' : 'success';
  }

  if (domainResult && sslResult) {
    domainResult.details = enrichDomainDetailsWithSsl(
      dedupeDomainDetails((domainResult.details || []) as DomainDetail[]),
      dedupeSslDetails((sslResult.details || []) as SslDetail[])
    );
    domainResult.total = domainResult.details.length;
    domainResult.passed = domainResult.details.filter((detail) => (detail as DomainDetail).status === 'active').length;
    domainResult.warnings = domainResult.details.filter((detail) => (detail as DomainDetail).status === 'expiring').length;
    domainResult.failed = domainResult.details.filter((detail) => (detail as DomainDetail).status === 'error').length;
    domainResult.status = domainResult.failed > 0 ? 'failed' : 'success';
  }

  try {
    const mappingPath = path.join(process.cwd(), 'config', 'project-mapping.json');
    const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8')) as { projects?: Array<{ id: string; domains?: string[]; sslCerts?: string[]; ssl?: string[] }> };
    const syncTrade = (mapping.projects || []).find((project) => project.id === 'synctrade');
    const syncTradeDomains = new Set((syncTrade?.domains || []).map((entry) => normalizeDomainHost(entry)).filter(Boolean));
    const syncTradeSsl = new Set((syncTrade?.ssl || syncTrade?.sslCerts || []).map((entry) => normalizeDomainHost(entry)).filter(Boolean));

    console.log('SYNCTRADE SSL DETAILS:', ((sslResult?.details || []) as SslDetail[]).filter((detail) => syncTradeSsl.has(normalizeDomainHost(detail.domain || detail.url))));
    console.log('SYNCTRADE DOMAIN DETAILS:', ((domainResult?.details || []) as DomainDetail[]).filter((detail) => syncTradeDomains.has(normalizeDomainHost(detail.domain || detail.url))));
  } catch (error) {
    console.error('Failed to log SyncTrade detail snapshots:', error);
  }

  const suites = {} as Record<SuiteId, DashboardStateSuite>;

  suiteDefinitions.forEach((definition) => {
    const result = finalResults.find((entry) => entry.repository === definition.repository) || createDefaultResult(definition);
    let status: DashboardStateSuite['status'] = 'not-run';

    if (result.status === 'success') {
      status = 'passed';
    } else if (result.status === 'failed' || result.status === 'error') {
      status = 'failed';
    } else if (result.status === 'unavailable') {
      status = 'unavailable';
    }

    suites[definition.id] = {
      status,
      passed: result.passed || 0,
      failed: result.failed || 0,
      warning: result.warnings || 0,
      total: result.total || 0,
      details: result.details || [],
      duration: result.duration || 0,
      reportPath: result.reportPath || '',
      message: result.message
    };
  });

  const state: DashboardState = {
    generatedAt: new Date().toISOString(),
    summary: {
      passedSuites: Object.values(suites).filter((suite) => suite.status === 'passed').length,
      failedSuites: Object.values(suites).filter((suite) => suite.status === 'failed').length,
      warningSuites: Object.values(suites).filter((suite) => suite.status === 'warning').length,
      skippedSuites: Object.values(suites).filter((suite) => suite.status === 'unavailable' || suite.status === 'not-run').length,
      totalSuites: suiteDefinitions.length,
      configuredSuites: suiteDefinitions.filter((definition) => isSuiteConfigured(definition)).length
    },
    suites
  };

  const stateDir = path.dirname(DASHBOARD_STATE_PATH);
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  fs.writeFileSync(DASHBOARD_STATE_PATH, JSON.stringify(state, null, 2));
}

function regenerateDashboardFromState(): void {
  const resultsMap = buildStoredResultsMap();
  const storedResults = suiteDefinitions.map((definition) => resultsMap.get(definition.repository) || createDefaultResult(definition));
  const dashboardPath = path.join(process.cwd(), 'unified-dashboard', 'index.html');
  generateDashboard(storedResults, dashboardPath);
}

async function runCommand(definition: SuiteDefinition): Promise<TestResult> {
  const startTime = Date.now();
  const execution = getSuiteExecutionConfig(definition);

  if (!execution) {
    return createUnavailableResult(definition);
  }

  const { command, cwd, fallbackTotal } = execution;

  console.log(`\n${'='.repeat(80)}`);
  console.log(`🚀 Running tests for: ${definition.repository}`);
  console.log(`📂 Directory: ${cwd}`);
  console.log(`⚙️  Command: ${command}`);
  console.log(`${'='.repeat(80)}\n`);

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      maxBuffer: 10 * 1024 * 1024
    });

    if (stdout) {
      console.log(stdout);
    }
    if (stderr) {
      console.error(stderr);
    }

    const duration = Date.now() - startTime;
    const reportPath = definition.id === 'domain'
      ? (execution.reportPath && fs.existsSync(execution.reportPath) ? execution.reportPath : '')
      : archiveSuiteReport(definition.repository);
    const parsed = definition.id === 'domain'
      ? parseDomainSuiteReport(reportPath, fallbackTotal)
      : definition.id === 'cert'
        ? parseSslSuiteReport(reportPath, stdout || '', fallbackTotal)
        : definition.id === 'api'
          ? parseApiSuiteReport(reportPath, fallbackTotal)
          : { ...parseUnifiedSuiteReport(reportPath, fallbackTotal), warnings: 0, details: [] as SuiteDetail[] };
    const status = parsed.failed > 0 ? 'failed' : 'success';

    return {
      repository: definition.repository,
      status,
      duration,
      reportPath,
      passed: parsed.passed || (definition.id === 'domain' ? 0 : parsed.total),
      failed: parsed.failed,
      warnings: parsed.warnings || 0,
      total: parsed.total,
      details: (definition.id === 'domain' || definition.id === 'cert' || definition.id === 'api') ? parsed.details : []
    };
  } catch (error: any) {
    if (error.stdout) {
      console.log(error.stdout);
    }
    if (error.stderr) {
      console.error(error.stderr);
    }

    const duration = Date.now() - startTime;
    const reportPath = definition.id === 'domain'
      ? (execution.reportPath && fs.existsSync(execution.reportPath) ? execution.reportPath : '')
      : archiveSuiteReport(definition.repository);
    const parsed = definition.id === 'domain'
      ? parseDomainSuiteReport(reportPath, fallbackTotal)
      : definition.id === 'cert'
        ? parseSslSuiteReport(reportPath, `${error.stdout || ''}\n${error.stderr || ''}`, fallbackTotal)
        : definition.id === 'api'
          ? parseApiSuiteReport(reportPath, fallbackTotal)
          : { ...parseUnifiedSuiteReport(reportPath, fallbackTotal), warnings: 0, details: [] as SuiteDetail[] };

    return {
      repository: definition.repository,
      status: 'failed',
      duration,
      reportPath,
      error: error.message,
      passed: parsed.passed,
      failed: parsed.failed || Math.max(parsed.total - parsed.passed, 1),
      warnings: parsed.warnings || 0,
      total: parsed.total || fallbackTotal,
      details: (definition.id === 'domain' || definition.id === 'cert' || definition.id === 'api') ? parsed.details : []
    };
  }
}

async function maybeSendEmail(finalResults: TestResult[], totalDuration: number, dashboardPath: string): Promise<void> {
  const emailEnabled = process.env.ZOHO_MAIL_ENABLED === 'true';
  if (!emailEnabled) {
    console.log('\n📧 Email notifications disabled. Set ZOHO_MAIL_ENABLED=true to enable.');
    return;
  }

  try {
    const emailConfig = {
      host: process.env.ZOHO_MAIL_HOST || 'smtp.zoho.com',
      port: parseInt(process.env.ZOHO_MAIL_PORT || '465', 10),
      secure: process.env.ZOHO_MAIL_SECURE === 'true' || true,
      user: process.env.ZOHO_MAIL_USER || '',
      pass: process.env.ZOHO_MAIL_PASS || '',
      from: process.env.ZOHO_MAIL_FROM || process.env.ZOHO_MAIL_USER || '',
      to: (process.env.ZOHO_MAIL_TO || '').split(',').map((email) => email.trim()).filter(Boolean),
    };

    if (!emailConfig.user || !emailConfig.pass || emailConfig.to.length === 0) {
      console.log('⚠️  Email configuration incomplete. Skipping email send.');
      return;
    }

    const suiteDetails = finalResults.map((result) => {
      const definition = suiteDefinitions.find((entry) => entry.repository === result.repository);
      return {
        repository: result.repository,
        displayName: definition?.displayName || result.repository,
        icon: definition?.icon || '📦',
        status: result.status === 'unavailable' ? 'error' : result.status,
        passed: result.passed || 0,
        failed: result.failed || 0,
        warnings: result.warnings || 0,
        total: result.total || 0,
        error: result.error || result.message
      };
    });

    await sendTestReport(
      dashboardPath,
      {
        totalSuites: finalResults.length,
        successfulSuites: finalResults.filter((result) => result.status === 'success').length,
        failedSuites: finalResults.filter((result) => result.status === 'failed' || result.status === 'error').length,
        totalDuration: `${(totalDuration / 1000).toFixed(1)}s`,
        timestamp: new Date().toLocaleString(),
        suiteDetails
      },
      emailConfig
    );

    console.log('✅ Email report sent successfully.');
  } catch (error) {
    console.error('❌ Failed to send email report:', error);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--regenerate-only')) {
    regenerateDashboardFromState();
    console.log('✅ Dashboard regenerated from stored state.');
    return;
  }

  console.log('\n');
  console.log('╔════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                   AdHash Unified Test Execution                           ║');
  console.log('║                   Running Workspace Test Suites                           ║');
  console.log('╚════════════════════════════════════════════════════════════════════════════╝');
  console.log('\n');

  console.log('🔄 Using workspace-root Playwright specs for suite execution...\n');

  const selectedSuites = getSelectedSuites();
  const storedResults = buildStoredResultsMap();
  const startTime = Date.now();

  for (const definition of selectedSuites) {
    console.log(definition.stepLabel);

    if (!isSuiteConfigured(definition)) {
      storedResults.set(definition.repository, createUnavailableResult(definition));
      console.log(`⚠️  ${definition.displayName} is not configured in current workspace.\n`);
      continue;
    }

    const result = await runCommand(definition);
    storedResults.set(definition.repository, result);
    console.log(`✅ ${definition.displayName} step completed.\n`);
  }

  const finalResults = suiteDefinitions.map((definition) => storedResults.get(definition.repository) || createDefaultResult(definition));
  const totalDuration = Date.now() - startTime;

  console.log('\n');
  console.log('╔════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                          Execution Summary                                 ║');
  console.log('╚════════════════════════════════════════════════════════════════════════════╝');
  console.log('\n');

  finalResults.forEach((result) => {
    const statusIcon = result.status === 'success' ? '✅' : result.status === 'unavailable' ? '⚪' : '❌';
    const duration = (result.duration / 1000).toFixed(2);
    const errorMessage = result.error || result.message;
    const messageSuffix = errorMessage ? ` (${errorMessage})` : '';
    console.log(`${statusIcon} ${result.repository.padEnd(50)} ${duration}s${messageSuffix}`);
  });

  console.log('\n');
  console.log(`⏱️  Total execution time: ${(totalDuration / 1000).toFixed(2)}s`);
  console.log('\n');

  writeDashboardState(finalResults);

  console.log('📋 Report paths found:');
  finalResults.forEach((result) => {
    const reportStatus = result.reportPath ? '✅' : '❌';
    console.log(`${reportStatus} ${result.repository}: ${result.reportPath || 'No report found'}`);
  });
  console.log('\n');

  console.log('📊 Generating unified dashboard...');
  const dashboardPath = path.join(process.cwd(), 'unified-dashboard', 'index.html');
  generateDashboard(finalResults, dashboardPath);

  const openCommand = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  exec(`${openCommand} "${dashboardPath}"`);

  await maybeSendEmail(finalResults, totalDuration, dashboardPath);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

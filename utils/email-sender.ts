import nodemailer from 'nodemailer';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

dotenv.config();

const EXPIRY_WARNING_DAYS = 30;

type ItemStatus = 'passed' | 'warning' | 'failed' | 'skipped';
type SectionKey = 'apps' | 'servers' | 'ssl' | 'domains' | 'apis';

interface CategoryIssueCounts {
    apps: number;
    servers: number;
    ssl: number;
    domains: number;
    apis: number;
}

interface EmailConfig {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    from: string;
    to: string[];
}

interface ProjectMapping {
    projects: ProjectDefinition[];
}

interface ProjectDefinition {
    id: string;
    name: string;
    description?: string;
    color?: string;
    apps?: Array<{ name: string; playStore?: string | null; appStore?: string | null }>;
    servers?: Array<{ name: string; url?: string; type?: string }>;
    domains?: string[];
    ssl?: string[];
    sslCerts?: string[];
    apis?: Array<{ name: string; url: string; method?: string; expectedStatus?: number }>;
}

interface DashboardState {
    generatedAt?: string;
    summary?: {
        passedSuites?: number;
        failedSuites?: number;
        warningSuites?: number;
        skippedSuites?: number;
        totalSuites?: number;
        configuredSuites?: number;
    };
    suites?: {
        app?: DashboardSuiteState;
        server?: DashboardSuiteState;
        cert?: DashboardSuiteState;
        api?: DashboardSuiteState;
        domain?: DashboardSuiteState;
    };
}

interface DashboardSuiteState {
    status?: 'passed' | 'failed' | 'warning' | 'not-run' | 'unavailable' | string;
    passed?: number;
    failed?: number;
    warning?: number;
    skipped?: number;
    total?: number;
    duration?: number;
    reportPath?: string;
    message?: string;
    details?: Array<SslDetail | DomainDetail | ApiTestItem>;
}

interface DomainDetail {
    domain: string;
    url?: string;
    status: 'active' | 'expiring' | 'error' | string;
    expiryDate: string | null;
    expiryDateIST?: string;
    daysRemaining: number | null;
}

interface SslDetail {
    domain: string;
    url?: string;
    status: 'passed' | 'warning' | 'failed' | string;
    expiryDate: string | null;
    expiryDateIST?: string;
    daysRemaining: number | null;
    reason?: string;
}

interface ApiTestItem {
    name: string;
    url: string;
    method: string;
    requestBody?: string;
    responseBody?: string;
    responseCode?: number | string | null;
    expectedStatus?: number;
    status: ItemStatus;
}

export interface EmailItem {
    name: string;
    projectName: string;
    url?: string;
    status: ItemStatus;
    type: SectionKey | 'app';
    method?: string;
    platform?: string;
    expiryDate?: string | null;
    expiryDateIST?: string;
    daysRemaining?: number | null;
    reason?: string;
    responseCode?: number | string | null;
    expectedStatus?: number;
    durationLabel?: string;
    requestBody?: string;
    responseBody?: string;
}

export interface SectionSummary {
    total: number;
    passed: number;
    warning: number;
    failed: number;
    skipped: number;
    tests: EmailItem[];
}

export interface ProjectSectionResults {
    apps: SectionSummary;
    servers: SectionSummary;
    ssl: SectionSummary;
    domains: SectionSummary;
    apis: SectionSummary;
}

export interface ProjectEmailCard {
    id: string;
    name: string;
    description: string;
    color: string;
    overallStatus: ItemStatus;
    failedCount: number;
    warningCount: number;
    categoryFailures: CategoryIssueCounts;
    categoryWarnings: CategoryIssueCounts;
    primaryModuleId: SuiteId;
    primaryModuleHref: string;
    results: ProjectSectionResults;
}

export interface DashboardEmailModel {
    generatedAt: string;
    headerTitle: string;
    headerSubtitle: string;
    summary: {
        successfulSuites: number;
        failedSuites: number;
        warningSuites: number;
        skippedSuites: number;
        totalSuites: number;
        totalFailedTests: number;
        totalWarningTests: number;
        totalSkippedTests: number;
        finalEmailStatus: 'FAILED' | 'WARNING' | 'PASSED';
        durationLabel: string;
    };
    moduleSections: ModuleSection[];
    projects: ProjectEmailCard[];
    failedItems: Array<{ projectName: string; sectionLabel: string; item: EmailItem }>;
    warningItems: Array<{ projectName: string; sectionLabel: string; item: EmailItem }>;
}

interface LatestApiSourceProject {
    id: string;
    name: string;
    results?: {
        apis?: SectionSummary & { source?: string };
    };
}

interface LatestApiSourceResult {
    source: string;
    projects: LatestApiSourceProject[];
}

interface LatestApiResultsPayload {
    generatedAt?: string;
    source?: string;
    projects?: LatestApiSourceProject[];
}

function getApiStatusLabel(summary: { failed?: number; warning?: number }): 'FAILED' | 'WARNING' | 'PASSED' {
    if ((summary.failed || 0) > 0) {
        return 'FAILED';
    }

    if ((summary.warning || 0) > 0 || (summary as { skipped?: number }).skipped || 0) {
        return 'WARNING';
    }

    return 'PASSED';
}

function getFinalEmailStatus(summary: {
    totalFailedTests?: number;
    totalWarningTests?: number;
    totalSkippedTests?: number;
}): 'FAILED' | 'WARNING' | 'PASSED' {
    if ((summary.totalFailedTests || 0) > 0) {
        return 'FAILED';
    }

    if ((summary.totalWarningTests || 0) > 0 || (summary.totalSkippedTests || 0) > 0) {
        return 'WARNING';
    }

    return 'PASSED';
}

export interface ModuleSection {
    id: SuiteId;
    title: string;
    icon: string;
    status: ItemStatus;
    reportHref?: string;
    reportExists?: boolean;
    passed: number;
    failed: number;
    warning: number;
    skipped: number;
    total: number;
    durationLabel: string;
    items: EmailItem[];
}

type SuiteId = 'app' | 'server' | 'cert' | 'api' | 'domain';

const SUITE_META: Record<SuiteId, { title: string; icon: string }> = {
    app: { title: 'App Status Verification', icon: '📱' },
    server: { title: 'Server Health Monitoring', icon: '🖥️' },
    cert: { title: 'SSL Certificate Monitoring', icon: '🔒' },
    api: { title: 'API Endpoint Testing', icon: '⚡' },
    domain: { title: 'Domain Expiry Monitoring', icon: '🌐' }
};

const MODULE_SECTION_KEY: Record<SuiteId, SectionKey> = {
    app: 'apps',
    server: 'servers',
    cert: 'ssl',
    api: 'apis',
    domain: 'domains'
};

const MODULE_REPORT_FILE: Record<SuiteId, string> = {
    app: 'app-status.html',
    server: 'server-health.html',
    cert: 'ssl.html',
    api: 'api.html',
    domain: 'domain.html'
};

function getModuleReportHref(suiteId: SuiteId): string {
    return `module-reports/${MODULE_REPORT_FILE[suiteId]}`;
}

function getPrimaryProjectModuleId(results: ProjectSectionResults): SuiteId {
    const orderedSections: Array<{ suiteId: SuiteId; summary: SectionSummary }> = [
        { suiteId: 'app', summary: results.apps },
        { suiteId: 'server', summary: results.servers },
        { suiteId: 'cert', summary: results.ssl },
        { suiteId: 'domain', summary: results.domains },
        { suiteId: 'api', summary: results.apis }
    ];

    const failedSection = orderedSections.find((entry) => entry.summary.failed > 0);
    if (failedSection) {
        return failedSection.suiteId;
    }

    const warningSection = orderedSections.find((entry) => entry.summary.warning > 0);
    if (warningSection) {
        return warningSection.suiteId;
    }

    const populatedSection = orderedSections.find((entry) => entry.summary.total > 0);
    return populatedSection ? populatedSection.suiteId : 'app';
}

function createFinalDashboardBundle(rootDir: string, sourceHtmlPath: string, moduleReportsDir: string): { bundleDir: string; bundleHtmlPath: string } {
    const bundleDir = path.join(rootDir, 'final-dashboard-bundle');
    const bundleReportsDir = path.join(bundleDir, 'module-reports');
    const bundleHtmlPath = path.join(bundleDir, 'AdHash-Projects-Dashboard.html');
    const bundleIndexPath = path.join(bundleDir, 'index.html');

    fs.rmSync(bundleDir, { recursive: true, force: true });
    fs.mkdirSync(bundleReportsDir, { recursive: true });
    fs.copyFileSync(sourceHtmlPath, bundleHtmlPath);
    fs.copyFileSync(sourceHtmlPath, bundleIndexPath);

    for (const reportFile of Object.values(MODULE_REPORT_FILE)) {
        const sourceReportPath = path.join(moduleReportsDir, reportFile);
        const targetReportPath = path.join(bundleReportsDir, reportFile);
        if (fs.existsSync(sourceReportPath)) {
            fs.copyFileSync(sourceReportPath, targetReportPath);
        }
    }

    console.log(`[BUNDLE] root path: ${bundleDir}`);
    console.log(`[BUNDLE] main html path: ${bundleHtmlPath}`);
    console.log(`[BUNDLE] module reports path: ${bundleReportsDir}`);

    return { bundleDir, bundleHtmlPath };
}

export interface DashboardEmailSendResult {
    enabled: boolean;
    sent: boolean;
    previewPath?: string;
    attachmentPath?: string;
    subject?: string;
    messageId?: string;
    recipients: string[];
    missingKeys: string[];
    error?: string;
}

interface SuiteRow {
    status: string;
    title: string;
    durationLabel?: string;
    detailText?: string;
    requestBody?: string;
    responseBody?: string;
    responseCode?: string;
    expectedStatus?: string;
}

interface NormalizedAppTarget {
    appName: string;
    platform: 'Play Store' | 'App Store';
    expectedUrl: string;
    title: string;
}

function createEmptySectionSummary(): SectionSummary {
    return { total: 0, passed: 0, warning: 0, failed: 0, skipped: 0, tests: [] };
}

function formatDurationLabel(durationMs: unknown): string {
    const duration = typeof durationMs === 'number' && Number.isFinite(durationMs) ? durationMs : 0;
    if (duration <= 0) {
        return '0s';
    }

    const totalSeconds = Math.round(duration / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    }

    return `${totalSeconds}s`;
}

function sumSuiteDurations(suites: DashboardState['suites']): number {
    return Object.values(suites || {}).reduce((total, suite) => {
        const duration = typeof suite?.duration === 'number' && Number.isFinite(suite.duration) ? suite.duration : 0;
        return total + duration;
    }, 0);
}

function mapSuiteStatus(value: unknown): ItemStatus {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'failed' || normalized === 'error' || normalized === 'unavailable') {
        return 'failed';
    }
    if (normalized === 'warning') {
        return 'warning';
    }
    return 'passed';
}

function buildModuleSections(state: DashboardState): ModuleSection[] {
    const orderedSuiteIds: SuiteId[] = ['app', 'server', 'cert', 'domain', 'api'];

    return orderedSuiteIds.map((suiteId) => {
        const suite = state.suites?.[suiteId] || {};
        const meta = SUITE_META[suiteId];

        return {
            id: suiteId,
            title: meta.title,
            icon: meta.icon,
            status: mapSuiteStatus(suite.status),
            passed: typeof suite.passed === 'number' ? suite.passed : 0,
            failed: typeof suite.failed === 'number' ? suite.failed : 0,
            warning: typeof suite.warning === 'number' ? suite.warning : 0,
            skipped: typeof suite.skipped === 'number' ? suite.skipped : 0,
            total: typeof suite.total === 'number' ? suite.total : 0,
            durationLabel: formatDurationLabel(suite.duration),
            items: []
        };
    });
}

function normalizeText(value: unknown): string {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeUrl(value: unknown): string {
    return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

function normalizeApiMethod(value: unknown): string {
    return String(value || 'GET').trim().toUpperCase();
}

function normalizeApiName(value: unknown): string {
    return normalizeText(String(value || '').trim());
}

function buildApiStableKey(method: unknown, url: unknown, name: unknown): string {
    return `${normalizeApiMethod(method)}::${normalizeUrl(url)}::${normalizeApiName(name)}`;
}

function getRequestBodyFallback(method: string): string {
    return method === 'GET' || method === 'DELETE' ? 'No request body' : 'Payload not provided';
}

function getResponseBodyFallback(): string {
    return 'No response body';
}

function parseExpectedStatus(value: unknown): number | undefined {
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

function dedupeApiResults(details: ApiTestItem[]): ApiTestItem[] {
    const deduped = new Map<string, ApiTestItem>();
    for (const detail of details || []) {
        if (!detail) {
            continue;
        }
        deduped.set(buildApiStableKey(detail.method, detail.url, detail.name), detail);
    }
    return Array.from(deduped.values());
}

function normalizeSslHost(value: unknown): string {
    const trimmed = String(value || '').trim();
    if (!trimmed) {
        return '';
    }

    if (/^https?:\/\//i.test(trimmed)) {
        try {
            return new URL(trimmed).hostname.toLowerCase();
        } catch {
            return '';
        }
    }

    return trimmed.replace(/^https?:\/\//i, '').split('/')[0].replace(/:\d+$/, '').toLowerCase();
}

function normalizeDomainValue(value: unknown): string {
    return String(value || '')
        .replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '')
        .replace(/\/$/, '')
        .toLowerCase();
}

function normalizeDaysRemaining(value: unknown): number | null {
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

    const parsed = parseInt(match[0], 10);
    return Number.isNaN(parsed) ? null : parsed;
}

function deriveDaysRemainingFromExpiryDate(expiryDate: unknown): number | null {
    if (!expiryDate) {
        return null;
    }

    const parsedExpiryDate = new Date(String(expiryDate));
    if (Number.isNaN(parsedExpiryDate.getTime())) {
        return null;
    }

    const millisecondsPerDay = 1000 * 60 * 60 * 24;
    return Math.ceil((parsedExpiryDate.getTime() - Date.now()) / millisecondsPerDay);
}

function resolveDaysRemaining(daysRemaining: unknown, expiryDate: unknown): number | null {
    const derivedDaysRemaining = deriveDaysRemainingFromExpiryDate(expiryDate);
    if (derivedDaysRemaining !== null) {
        return derivedDaysRemaining;
    }

    return normalizeDaysRemaining(daysRemaining);
}

function getExpiryStatus(daysRemaining: unknown, hasError = false): ItemStatus {
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

function toDomainDetailStatus(status: ItemStatus): 'active' | 'expiring' | 'error' {
    if (status === 'warning') {
        return 'expiring';
    }
    if (status === 'failed') {
        return 'error';
    }
    return 'active';
}

function normalizeDomainDetail(detail: DomainDetail): DomainDetail {
    const daysRemaining = resolveDaysRemaining(detail && detail.daysRemaining, detail && detail.expiryDate);
    const status = toDomainDetailStatus(
        getExpiryStatus(daysRemaining, detail && detail.status === 'error' && daysRemaining === null)
    );

    return {
        ...detail,
        domain: normalizeDomainValue(detail && detail.domain),
        url: (detail && detail.url) || (detail && detail.domain ? `https://${normalizeDomainValue(detail.domain)}` : undefined),
        daysRemaining,
        status,
        expiryDateIST: detail && detail.expiryDateIST ? String(detail.expiryDateIST) : undefined
    };
}

function normalizeSslDetail(detail: SslDetail): SslDetail {
    const daysRemaining = resolveDaysRemaining(detail && detail.daysRemaining, detail && detail.expiryDate);
    const status = getExpiryStatus(daysRemaining, detail && detail.status === 'failed' && daysRemaining === null);

    return {
        ...detail,
        domain: normalizeDomainValue(detail && detail.domain),
        url: (detail && detail.url) || (detail && detail.domain ? `https://${normalizeDomainValue(detail.domain)}` : undefined),
        daysRemaining,
        status,
        expiryDateIST: detail && detail.expiryDateIST ? String(detail.expiryDateIST) : undefined,
        reason: detail && detail.reason ? String(detail.reason) : undefined
    };
}

function buildTrackedDetailKey(type: 'ssl' | 'domain', domain: unknown, url: unknown): string {
    return `${type}::${normalizeDomainValue(domain || url || '')}`;
}

function getTrackedDetailScore(detail: Partial<SslDetail & DomainDetail>): number {
    let score = 0;

    if (detail.expiryDate) score += 3;
    if (detail.expiryDateIST && detail.expiryDateIST !== 'N/A') score += 2;
    if (detail.daysRemaining !== null && detail.daysRemaining !== undefined && !Number.isNaN(Number(detail.daysRemaining))) score += 3;
    if ((detail as SslDetail).reason) score += 2;

    if (detail.status === 'passed' || detail.status === 'active') score += 3;
    else if (detail.status === 'warning' || detail.status === 'expiring') score += 2;
    else if (detail.status === 'failed' || detail.status === 'error') score += 1;

    return score;
}

function pickPreferredTrackedDetail<T extends SslDetail | DomainDetail>(existing: T | undefined, incoming: T): T {
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
            reason: (incoming as SslDetail).reason || (existing as SslDetail).reason
        } as T;
    }

    return {
        ...incoming,
        ...existing,
        domain: existing.domain || incoming.domain,
        url: existing.url || incoming.url,
        expiryDate: existing.expiryDate || incoming.expiryDate,
        expiryDateIST: existing.expiryDateIST && existing.expiryDateIST !== 'N/A' ? existing.expiryDateIST : incoming.expiryDateIST,
        daysRemaining: existing.daysRemaining ?? incoming.daysRemaining,
        reason: (existing as SslDetail).reason || (incoming as SslDetail).reason
    } as T;
}

function dedupeTrackedResults<T extends SslDetail | DomainDetail>(type: 'ssl' | 'domain', details: T[]): T[] {
    const deduped = new Map<string, T>();

    for (const detail of details || []) {
        if (!detail) {
            continue;
        }

        const normalizedDomain = normalizeDomainValue(detail.domain || detail.url);
        if (!normalizedDomain) {
            continue;
        }

        const normalizedDetail = {
            ...detail,
            domain: normalizedDomain,
            url: detail.url || `https://${normalizedDomain}`
        } as T;
        const key = buildTrackedDetailKey(type, normalizedDetail.domain, normalizedDetail.url);
        deduped.set(key, pickPreferredTrackedDetail(deduped.get(key), normalizedDetail));
    }

    return Array.from(deduped.values());
}

function formatToIST(value: unknown): string {
    if (!value) {
        return 'N/A';
    }

    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) {
        return 'N/A';
    }

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

function formatDateTimeInZone(value: unknown, timeZone: 'UTC' | 'Asia/Kolkata', suffix?: string): string | undefined {
    if (!value) {
        return undefined;
    }

    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) {
        return undefined;
    }

    const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    const parts = formatter.formatToParts(date);
    const getPart = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || '';
    const formatted = `${getPart('year')}-${getPart('month')}-${getPart('day')} ${getPart('hour')}:${getPart('minute')}:${getPart('second')}`;

    return suffix ? `${formatted} ${suffix}` : formatted;
}

function formatUtcDateTime(value: unknown): string | undefined {
    return formatDateTimeInZone(value, 'UTC', 'UTC');
}

function formatIstDateTime(value: unknown): string | undefined {
    return formatDateTimeInZone(value, 'Asia/Kolkata', 'IST');
}

function buildDateDisplayLines(value: unknown, fallbackIST?: string): { utc?: string; ist?: string } {
    const utc = formatUtcDateTime(value);
    const normalizedIST = String(fallbackIST || '').trim();
    const ist = normalizedIST && normalizedIST !== 'N/A'
        ? normalizedIST
        : formatIstDateTime(value);

    return {
        utc,
        ist: ist || undefined
    };
}

function decodeHtml(value: unknown): string {
    return String(value || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
}

function stripHtml(value: unknown): string {
    return decodeHtml(String(value || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/pre>/gi, '\n')
        .replace(/<\/details>/gi, '\n')
        .replace(/<\/summary>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\n\s+/g, '\n')
        .replace(/[ \t]+/g, ' '));
}

function normalizeDetailText(value: unknown): string | undefined {
    const trimmed = stripHtml(value).trim();
    if (!trimmed || trimmed === '-' || trimmed.toLowerCase() === 'n/a') {
        return undefined;
    }
    return trimmed;
}

function normalizePayloadText(value: unknown): string | undefined {
    const trimmed = String(value || '').trim();
    if (!trimmed || trimmed === '-') {
        return undefined;
    }
    return trimmed;
}

function summarizeText(value: unknown, maxLength = 180): string | undefined {
    const trimmed = String(value || '').trim().replace(/\s+/g, ' ');
    if (!trimmed) {
        return undefined;
    }
    if (trimmed.length <= maxLength) {
        return trimmed;
    }
    return `${trimmed.slice(0, maxLength - 3)}...`;
}

function buildDomainReason(status: ItemStatus, daysRemaining: number | null | undefined, expiryDate: string | null | undefined): string | undefined {
    if (status === 'warning') {
        if (typeof daysRemaining === 'number') {
            return `Expiry within warning window (${daysRemaining} days remaining)`;
        }
        return 'Expiry approaching warning window';
    }

    if (status === 'failed') {
        if (!expiryDate && (daysRemaining === null || daysRemaining === undefined)) {
            return 'Structured expiry details unavailable';
        }
        if (typeof daysRemaining === 'number' && daysRemaining < 0) {
            return 'Domain already expired';
        }
    }

    return undefined;
}

function buildSslReason(detail: SslDetail): string | undefined {
    if (detail.reason) {
        return detail.reason;
    }
    if (detail.status === 'warning' && typeof detail.daysRemaining === 'number') {
        return `Certificate expires in ${detail.daysRemaining} days`;
    }
    if (detail.status === 'failed' && typeof detail.daysRemaining === 'number' && detail.daysRemaining < 0) {
        return 'Certificate already expired';
    }
    return undefined;
}

function buildApiFailureReason(
    status: ItemStatus,
    expectedStatus: number | undefined,
    responseCode: number | string | null | undefined,
    detailText?: string,
    responseBody?: string
): string | undefined {
    if (status === 'passed') {
        return undefined;
    }

    if (status === 'skipped') {
        return detailText || 'Skipped in CI: SUPABASE_API_KEY secret is not configured';
    }

    if (detailText) {
        return detailText;
    }

    const normalizedResponseCode = String(responseCode ?? '').trim();
    if (expectedStatus !== undefined && normalizedResponseCode) {
        return `Expected ${expectedStatus}, received ${normalizedResponseCode}`;
    }
    if (normalizedResponseCode) {
        return `Received response code ${normalizedResponseCode}`;
    }

    return summarizeText(normalizeDetailText(responseBody) || responseBody, 240);
}

function decodeBase64Value(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }

    try {
        return Buffer.from(value, 'base64').toString('utf8');
    } catch {
        return undefined;
    }
}

function normalizePlayStoreValue(playStore: string | null | undefined): { packageName: string; expectedUrl: string } | null {
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
            return { packageName, expectedUrl: trimmed };
        } catch {
            return null;
        }
    }

    return {
        packageName: trimmed,
        expectedUrl: `https://play.google.com/store/apps/details?id=${trimmed}`
    };
}

function normalizeAppStoreValue(appStore: string | null | undefined): { appId: string; expectedUrl: string } | null {
    if (!appStore || typeof appStore !== 'string') {
        return null;
    }

    const trimmed = appStore.trim();
    if (!trimmed) {
        return null;
    }

    if (/^https?:\/\//i.test(trimmed)) {
        try {
            const url = new URL(trimmed);
            const appIdMatch = url.pathname.match(/(id\d+)/i);
            const appId = appIdMatch?.[1] || '';
            return appId ? { appId, expectedUrl: trimmed } : null;
        } catch {
            return null;
        }
    }

    const appId = trimmed.startsWith('id') ? trimmed : `id${trimmed}`;
    return {
        appId,
        expectedUrl: `https://apps.apple.com/app/${appId}`
    };
}

function normalizeProjectAppTargets(project: ProjectDefinition): NormalizedAppTarget[] {
    const normalizedTargets: NormalizedAppTarget[] = [];
    const playStoreCount = (project.apps || []).filter((app) => normalizePlayStoreValue(app.playStore || null)).length;
    const appStoreCount = (project.apps || []).filter((app) => normalizeAppStoreValue(app.appStore || null)).length;

    for (const app of project.apps || []) {
        if (!app?.name) {
            continue;
        }

        const normalizedPlayStore = normalizePlayStoreValue(app.playStore || null);
        if (normalizedPlayStore) {
            normalizedTargets.push({
                appName: app.name,
                platform: 'Play Store',
                expectedUrl: normalizedPlayStore.expectedUrl,
                title: `Verify ${app.name} on Play Store`
            });
        }

        const normalizedAppStore = normalizeAppStoreValue(app.appStore || null);
        if (normalizedAppStore) {
            normalizedTargets.push({
                appName: app.name,
                platform: 'App Store',
                expectedUrl: normalizedAppStore.expectedUrl,
                title: `Verify ${app.name} on App Store`
            });
        }
    }

    console.log(`[APP STATUS] project name: ${project.name}, playStore count: ${playStoreCount}, appStore count: ${appStoreCount}, total normalized apps: ${normalizedTargets.length}`);

    return normalizedTargets;
}

function getProjectSslEntries(project: ProjectDefinition): string[] {
    const rawEntries = Array.isArray(project.ssl) && project.ssl.length > 0 ? project.ssl : (project.sslCerts || []);
    const seen = new Set<string>();
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

function getSuiteReportPath(rootDir: string, repository: string): string {
    return path.join(rootDir, 'suite-reports', `${repository.replace(/[^a-zA-Z0-9]/g, '_')}.html`);
}

function readSuiteRows(rootDir: string, repository: string): SuiteRow[] {
    const reportPath = getSuiteReportPath(rootDir, repository);
    if (!fs.existsSync(reportPath)) {
        return [];
    }

    const html = fs.readFileSync(reportPath, 'utf8');
    const rowPattern = /<tr class="test-row (passed|failed|skipped)">[\s\S]*?<td class="test-name">([^<]+)<\/td>[\s\S]*?<span class="status-badge [^"]+">([^<]+)<\/span>[\s\S]*?<td class="test-duration">([^<]+)<\/td>[\s\S]*?<td class="test-details"([^>]*)>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/gi;
    const rows: SuiteRow[] = [];

    for (const match of html.matchAll(rowPattern)) {
        const attributes = match[5] || '';
        const requestBodyMatch = attributes.match(/data-request-body="([^"]*)"/i);
        const responseBodyMatch = attributes.match(/data-response-body="([^"]*)"/i);
        const responseCodeMatch = attributes.match(/data-response-code="([^"]*)"/i);
        const expectedStatusMatch = attributes.match(/data-expected-status="([^"]*)"/i);

        rows.push({
            status: match[1].toLowerCase(),
            title: decodeHtml(match[2]),
            durationLabel: decodeHtml(match[4]),
            detailText: normalizeDetailText(match[6]),
            requestBody: normalizePayloadText(decodeBase64Value(requestBodyMatch?.[1])),
            responseBody: normalizePayloadText(decodeBase64Value(responseBodyMatch?.[1])),
            responseCode: decodeHtml(responseCodeMatch?.[1]),
            expectedStatus: decodeHtml(expectedStatusMatch?.[1])
        });
    }

    return rows;
}

function findSuiteRow(rows: SuiteRow[], expectedTitle: string): SuiteRow | undefined {
    const normalizedExpected = normalizeText(expectedTitle);
    return rows.find((row) => normalizeText(row.title) === normalizedExpected);
}

function classifyApiStatus(responseCode: number | string | null | undefined, expectedStatus?: number): ItemStatus {
    const parsedResponseCode = typeof responseCode === 'number'
        ? responseCode
        : (/^\d+$/.test(String(responseCode || '').trim()) ? parseInt(String(responseCode).trim(), 10) : null);

    if (typeof expectedStatus === 'number') {
        if (parsedResponseCode !== expectedStatus) {
            return 'failed';
        }
        if (expectedStatus >= 300 && expectedStatus < 400) {
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

function loadProjectMapping(rootDir: string): ProjectMapping {
    const filePath = path.join(rootDir, 'config', 'project-mapping.json');
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as ProjectMapping;
}

function loadDashboardState(rootDir: string): DashboardState {
    const filePath = path.join(rootDir, 'test-results', 'dashboard-state.json');
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as DashboardState;
}

function getProjectAppResults(project: ProjectDefinition, appRows: SuiteRow[]): SectionSummary {
    const result = createEmptySectionSummary();
    const normalizedTargets = normalizeProjectAppTargets(project);

    for (const target of normalizedTargets) {
        // Try both naming conventions: old "Verify X on Y" and new "App Status: X (Y)"
        const row = findSuiteRow(appRows, target.title) ||
                    findSuiteRow(appRows, `App Status: ${target.appName} (${target.platform})`);
        if (!row || row.status === 'skipped') {
            continue;
        }

        const status: ItemStatus = row.status === 'passed' ? 'passed' : 'failed';
        result.total += 1;
        result[status] += 1;
        result.tests.push({
            name: target.appName,
            projectName: project.name,
            url: target.expectedUrl,
            status,
            type: 'app',
            platform: target.platform,
            durationLabel: row.durationLabel,
            reason: row.detailText
        });
    }

    return result;
}

function getProjectServerResults(project: ProjectDefinition, serverRows: SuiteRow[]): SectionSummary {
    const result = createEmptySectionSummary();

    for (const server of project.servers || []) {
        const row = findSuiteRow(serverRows, `Check ${server.name} health`);
        if (!row) {
            continue;
        }

        const status: ItemStatus = row.status === 'passed' ? 'passed' : row.status === 'skipped' ? 'skipped' : 'failed';
        result.total += 1;
        result[status] += 1;
        result.tests.push({
            name: server.name,
            projectName: project.name,
            url: server.url,
            status,
            type: 'servers',
            durationLabel: row.durationLabel,
            reason: row.detailText || (status === 'skipped' ? 'Skipped by QA (known issue / external dependency)' : undefined)
        });
    }

    return result;
}

function getProjectSslResults(project: ProjectDefinition, sslDetails: SslDetail[]): SectionSummary {
    const result = createEmptySectionSummary();
    const configuredEntries = new Set(getProjectSslEntries(project).map((entry) => normalizeDomainValue(entry)).filter(Boolean));
    const matched = dedupeTrackedResults('ssl', (sslDetails || []).map(normalizeSslDetail)).filter((detail) =>
        configuredEntries.has(normalizeDomainValue(detail.domain || detail.url))
    );

    for (const detail of matched) {
        const status = detail.status as ItemStatus;
        result.total += 1;
        result[status] += 1;
        result.tests.push({
            name: detail.domain,
            projectName: project.name,
            url: detail.url,
            status,
            type: 'ssl',
            expiryDate: detail.expiryDate,
            expiryDateIST: detail.expiryDateIST || formatToIST(detail.expiryDate),
            daysRemaining: detail.daysRemaining,
            reason: buildSslReason(detail)
        });
    }

    return result;
}

function getProjectDomainResults(project: ProjectDefinition, domainDetails: DomainDetail[]): SectionSummary {
    const result = createEmptySectionSummary();
    const configuredDomains = new Set((project.domains || []).map((value) => normalizeDomainValue(value)).filter(Boolean));
    const matched = dedupeTrackedResults('domain', (domainDetails || []).map(normalizeDomainDetail)).filter((detail) =>
        configuredDomains.has(normalizeDomainValue(detail.domain || detail.url))
    );

    for (const detail of matched) {
        const status: ItemStatus = detail.status === 'active' ? 'passed' : detail.status === 'expiring' ? 'warning' : 'failed';
        result.total += 1;
        result[status] += 1;
        result.tests.push({
            name: detail.domain,
            projectName: project.name,
            url: detail.url,
            status,
            type: 'domains',
            expiryDate: detail.expiryDate,
            expiryDateIST: detail.expiryDateIST || formatToIST(detail.expiryDate),
            daysRemaining: detail.daysRemaining,
            reason: buildDomainReason(status, detail.daysRemaining, detail.expiryDate)
        });
    }

    return result;
}

function getProjectApiResults(project: ProjectDefinition, apiDetails: ApiTestItem[], apiRows: SuiteRow[]): SectionSummary {
    const result = createEmptySectionSummary();
    const projectApiKeys = new Set((project.apis || []).map((api) => buildApiStableKey(api.method, api.url, api.name)));
    const detailByKey = new Map(
        dedupeApiResults(
        (apiDetails || []).filter((detail) => detail && projectApiKeys.has(buildApiStableKey(detail.method, detail.url, detail.name)))
        ).map((detail) => [buildApiStableKey(detail.method, detail.url, detail.name), detail] as const)
    );

    for (const api of project.apis || []) {
        const stableKey = buildApiStableKey(api.method, api.url, api.name);
        const row = findSuiteRow(apiRows, `${normalizeApiMethod(api.method)} ${api.name}`);
        const detail = detailByKey.get(stableKey);

        if (row && row.status !== 'skipped') {
            const expectedStatus = parseExpectedStatus(api.expectedStatus) ?? parseExpectedStatus(row.expectedStatus) ?? parseExpectedStatus(detail?.expectedStatus);
            const status = classifyApiStatus(row.responseCode, expectedStatus);
            const requestBody = row.requestBody || normalizePayloadText(detail?.requestBody) || getRequestBodyFallback(normalizeApiMethod(api.method));
            const responseBody = row.responseBody || normalizePayloadText(detail?.responseBody) || getResponseBodyFallback();

            result.total += 1;
            result[status] += 1;
            result.tests.push({
                name: api.name,
                projectName: project.name,
                url: api.url,
                status,
                type: 'apis',
                method: normalizeApiMethod(api.method),
                responseCode: row.responseCode || detail?.responseCode || null,
                expectedStatus,
                durationLabel: row.durationLabel,
                requestBody,
                responseBody,
                reason: buildApiFailureReason(status, expectedStatus, row.responseCode || detail?.responseCode || null, row.detailText, responseBody)
            });
            continue;
        }

        if (row && row.status === 'skipped') {
            // If dashboard-state detail has a definitive status, prefer it over the stale row.
            const detailStatus = detail?.status as ItemStatus | undefined;
            if (detail && (detailStatus === 'passed' || detailStatus === 'failed' || detailStatus === 'warning')) {
                const expectedStatus = parseExpectedStatus(api.expectedStatus) ?? parseExpectedStatus(detail.expectedStatus) ?? parseExpectedStatus(row.expectedStatus);
                const status = detailStatus;
                const requestBody = normalizePayloadText(detail.requestBody) || row.requestBody || getRequestBodyFallback(normalizeApiMethod(api.method));
                const responseBody = normalizePayloadText(detail.responseBody) || row.responseBody || getResponseBodyFallback();
                result.total += 1;
                result[status] += 1;
                result.tests.push({
                    name: api.name,
                    projectName: project.name,
                    url: api.url,
                    status,
                    type: 'apis',
                    method: normalizeApiMethod(api.method),
                    responseCode: detail.responseCode || row.responseCode || null,
                    expectedStatus,
                    durationLabel: row.durationLabel,
                    requestBody,
                    responseBody,
                    reason: buildApiFailureReason(status, expectedStatus, detail.responseCode || row.responseCode || null, row.detailText, responseBody)
                });
                continue;
            }

            const expectedStatus = parseExpectedStatus(api.expectedStatus) ?? parseExpectedStatus(row.expectedStatus) ?? parseExpectedStatus(detail?.expectedStatus);
            const requestBody = row.requestBody || normalizePayloadText(detail?.requestBody) || getRequestBodyFallback(normalizeApiMethod(api.method));
            const responseBody = row.responseBody || normalizePayloadText(detail?.responseBody) || getResponseBodyFallback();

            result.total += 1;
            result.skipped += 1;
            result.tests.push({
                name: api.name,
                projectName: project.name,
                url: api.url,
                status: 'skipped',
                type: 'apis',
                method: normalizeApiMethod(api.method),
                responseCode: row.responseCode || detail?.responseCode || null,
                expectedStatus,
                durationLabel: row.durationLabel,
                requestBody,
                responseBody,
                reason: buildApiFailureReason('skipped', expectedStatus, row.responseCode || detail?.responseCode || null, row.detailText, responseBody)
            });
            continue;
        }

        if (!detail) {
            continue;
        }

        const status = detail.status as ItemStatus;
        const expectedStatus = parseExpectedStatus(api.expectedStatus) ?? parseExpectedStatus(detail.expectedStatus);
        const requestBody = normalizePayloadText(detail.requestBody) || getRequestBodyFallback(normalizeApiMethod(api.method));
        const responseBody = normalizePayloadText(detail.responseBody) || getResponseBodyFallback();

        result.total += 1;
        result[status] += 1;
        result.tests.push({
            name: api.name,
            projectName: project.name,
            url: api.url,
            status,
            type: 'apis',
            method: normalizeApiMethod(api.method),
            responseCode: detail.responseCode || null,
            expectedStatus,
            requestBody,
            responseBody,
            reason: buildApiFailureReason(status, expectedStatus, detail.responseCode || null, undefined, responseBody)
        });
    }

    return result;
}

function getOverallProjectStatus(results: ProjectSectionResults): ItemStatus {
    const sections = Object.values(results);
    if (sections.some((section) => section.failed > 0)) {
        return 'failed';
    }
    if (sections.some((section) => section.warning > 0 || section.skipped > 0)) {
        return 'warning';
    }
    return 'passed';
}

function getProjectFailedCount(results: ProjectSectionResults): number {
    return results.apps.failed + results.servers.failed + results.ssl.failed + results.domains.failed + results.apis.failed;
}

function getProjectWarningCount(results: ProjectSectionResults): number {
    return results.apps.warning + results.servers.warning + results.ssl.warning + results.domains.warning + results.apis.warning + results.apps.skipped + results.servers.skipped + results.ssl.skipped + results.domains.skipped + results.apis.skipped;
}

function getProjectCategoryFailures(results: ProjectSectionResults): CategoryIssueCounts {
    return {
        apps: results.apps.failed,
        servers: results.servers.failed,
        ssl: results.ssl.failed,
        domains: results.domains.failed,
        apis: results.apis.failed
    };
}

function getProjectCategoryWarnings(results: ProjectSectionResults): CategoryIssueCounts {
    return {
        apps: results.apps.warning + results.apps.skipped,
        servers: results.servers.warning + results.servers.skipped,
        ssl: results.ssl.warning + results.ssl.skipped,
        domains: results.domains.warning + results.domains.skipped,
        apis: results.apis.warning + results.apis.skipped
    };
}

function sortTestsForEmail(tests: EmailItem[]): EmailItem[] {
    const statusOrder: Record<ItemStatus, number> = { failed: 0, warning: 1, skipped: 2, passed: 3 };
    return [...tests].sort((left, right) => {
        const statusScore = statusOrder[left.status] - statusOrder[right.status];
        if (statusScore !== 0) {
            return statusScore;
        }
        return left.name.localeCompare(right.name);
    });
}

export function buildDashboardRenderModel(rootDir: string): DashboardEmailModel {
    const mapping = loadProjectMapping(rootDir);
    const state = loadDashboardState(rootDir);
    const appRows = readSuiteRows(rootDir, 'Adhash_App_Status');
    const serverRows = readSuiteRows(rootDir, 'Adhash_AllProjects_Server');
    const apiRows = readSuiteRows(rootDir, 'AdHash_API_Test');
    const sslDetails = ((state.suites?.cert?.details || []) as SslDetail[]).map(normalizeSslDetail);
    // Domain details come exclusively from the domain suite (godaddy/report.html via run-all-tests).
    // These are domain registrar/WHOIS expiry dates — completely separate from SSL cert expiry.
    // Do NOT merge SSL cert data here; SSL has its own section in the email.
    const domainDetails = ((state.suites?.domain?.details || []) as DomainDetail[]).map(normalizeDomainDetail);
    const apiDetails = dedupeApiResults((state.suites?.api?.details || []) as ApiTestItem[]);
    const baseModuleSections = buildModuleSections(state);

    const projects = (mapping.projects || []).map((project) => {
        const results: ProjectSectionResults = {
            apps: getProjectAppResults(project, appRows),
            servers: getProjectServerResults(project, serverRows),
            ssl: getProjectSslResults(project, sslDetails),
            domains: getProjectDomainResults(project, domainDetails),
            apis: getProjectApiResults(project, apiDetails, apiRows)
        };

        return {
            id: project.id,
            name: project.name,
            description: project.description || 'Project monitoring summary',
            color: project.color || '#3b82f6',
            overallStatus: getOverallProjectStatus(results),
            failedCount: getProjectFailedCount(results),
            warningCount: getProjectWarningCount(results),
            categoryFailures: getProjectCategoryFailures(results),
            categoryWarnings: getProjectCategoryWarnings(results),
            primaryModuleId: getPrimaryProjectModuleId(results),
            primaryModuleHref: getModuleReportHref(getPrimaryProjectModuleId(results)),
            results
        };
    }).sort((left, right) => {
        const statusOrder: Record<ItemStatus, number> = { failed: 0, warning: 1, skipped: 2, passed: 3 };
        const statusScore = statusOrder[left.overallStatus] - statusOrder[right.overallStatus];
        if (statusScore !== 0) {
            return statusScore;
        }
        return left.name.localeCompare(right.name);
    });

    let totalTests = 0;
    const failedItems: Array<{ projectName: string; sectionLabel: string; item: EmailItem }> = [];
    const warningItems: Array<{ projectName: string; sectionLabel: string; item: EmailItem }> = [];

    for (const project of projects) {
        for (const [sectionKey, sectionResult] of Object.entries(project.results) as Array<[SectionKey, SectionSummary]>) {
            totalTests += sectionResult.total;

            for (const item of sectionResult.tests) {
                if (item.status === 'failed') {
                    failedItems.push({ projectName: project.name, sectionLabel: sectionKey.toUpperCase(), item });
                } else if (item.status === 'warning' || item.status === 'skipped') {
                    warningItems.push({ projectName: project.name, sectionLabel: sectionKey.toUpperCase(), item });
                }
            }

            sectionResult.tests = sortTestsForEmail(sectionResult.tests);
        }
    }

    const moduleSections = baseModuleSections.map((section) => {
        const items = getModuleItems(projects, section.id);
        const normalizedSection = buildModuleSectionFromItems(section, items);
        return {
            ...normalizedSection,
            items,
            reportHref: getModuleReportHref(section.id),
            reportExists: true
        };
    });

    const summary: DashboardEmailModel['summary'] = {
        successfulSuites: Number(state.summary?.passedSuites || 0),
        failedSuites: Number(state.summary?.failedSuites || 0),
        warningSuites: Number(state.summary?.warningSuites || 0),
        skippedSuites: Number(state.summary?.skippedSuites || 0),
        totalSuites: Number(state.summary?.totalSuites || moduleSections.length),
        totalFailedTests: failedItems.length,
        totalWarningTests: warningItems.filter(({ item }) => item.status === 'warning').length,
        totalSkippedTests: warningItems.filter(({ item }) => item.status === 'skipped').length,
        finalEmailStatus: 'PASSED',
        durationLabel: formatDurationLabel(sumSuiteDurations(state.suites))
    };

    summary.finalEmailStatus = getFinalEmailStatus(summary);

    return {
        generatedAt: state.generatedAt || new Date().toISOString(),
        headerTitle: 'AdHash Projects Status Dashboard',
        headerSubtitle: `Unified suite and project monitoring summary generated from dashboard state (${totalTests} project checks).`,
        summary,
        moduleSections,
        projects,
        failedItems,
        warningItems
    };
}

function buildDashboardEmailModel(rootDir: string): DashboardEmailModel {
    return buildDashboardRenderModel(rootDir);
}

function readLatestApiResultsJson(rootDir: string): LatestApiResultsPayload | null {
    const latestApiResultsPath = path.join(rootDir, 'test-results', 'latest-api-results.json');

    try {
        if (!fs.existsSync(latestApiResultsPath)) {
            console.warn('[EMAIL] latest-api-results.json not found. Falling back safely to current dashboard model.');
            return null;
        }

        return JSON.parse(fs.readFileSync(latestApiResultsPath, 'utf8')) as LatestApiResultsPayload;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[EMAIL] Failed to read latest-api-results.json. Falling back safely: ${message}`);
        return null;
    }
}

function buildLatestApiSourceFromModel(model: DashboardEmailModel): LatestApiSourceResult {
    return {
        source: 'dashboard-model',
        projects: model.projects.map((project) => ({
            id: project.id,
            name: project.name,
            results: {
                apis: {
                    ...project.results.apis,
                    source: 'dashboard-model'
                }
            }
        }))
    };
}

async function loadLatestApiSource(rootDir: string, fallbackModel: DashboardEmailModel): Promise<LatestApiSourceResult> {
    try {
        const response = await axios.get('http://localhost:7777/api/projects', {
            timeout: 2500,
            headers: {
                'Cache-Control': 'no-store'
            }
        });

        if (Array.isArray(response.data?.projects)) {
            const liveProjects = response.data.projects as LatestApiSourceProject[];
            const hasCanonicalApiResults = liveProjects.some((project) => project.results?.apis && typeof project.results.apis.total === 'number');

            if (hasCanonicalApiResults) {
                return {
                    source: 'live-api',
                    projects: liveProjects
                };
            }

            console.log('[EMAIL] Live /api/projects missing canonical results.apis, falling back to latest generated JSON');
        }
    } catch (error) {
        console.log('[EMAIL] Live /api/projects unavailable, falling back to latest generated JSON');
    }

    const payload = readLatestApiResultsJson(rootDir);
    if (payload && Array.isArray(payload.projects)) {
        return {
            source: payload.source || 'latest-run',
            projects: payload.projects as LatestApiSourceProject[]
        };
    }

    return buildLatestApiSourceFromModel(fallbackModel);
}

function applyLatestApiResultsToModel(model: DashboardEmailModel, latestSource: LatestApiSourceResult): DashboardEmailModel {
    const projectApiSummaryById = new Map(
        latestSource.projects
            .filter((project) => project && project.results && project.results.apis)
            .map((project) => [project.id, project.results!.apis!] as const)
    );

    const nextProjects = model.projects.map((project) => {
        const latestApiSummary = projectApiSummaryById.get(project.id);
        if (!latestApiSummary) {
            return project;
        }

        const nextResults: ProjectSectionResults = {
            ...project.results,
            apis: {
                ...project.results.apis,
                total: latestApiSummary.total,
                passed: latestApiSummary.passed,
                failed: latestApiSummary.failed,
                warning: latestApiSummary.warning,
                skipped: latestApiSummary.skipped
            }
        };
        const primaryModuleId = getPrimaryProjectModuleId(nextResults);

        return {
            ...project,
            results: nextResults,
            overallStatus: getOverallProjectStatus(nextResults),
            failedCount: getProjectFailedCount(nextResults),
            warningCount: getProjectWarningCount(nextResults),
            categoryFailures: getProjectCategoryFailures(nextResults),
            categoryWarnings: getProjectCategoryWarnings(nextResults),
            primaryModuleId,
            primaryModuleHref: getModuleReportHref(primaryModuleId)
        };
    });

    return {
        ...model,
        projects: nextProjects
    };
}

function extractEmailProjectApiSummary(html: string, projectName: string): { failed: number; total: number; statusLabel: string } | null {
    const escapedProjectName = projectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const projectMarker = new RegExp(`<div[^>]*>${escapedProjectName}<\\/div>`, 'i');
    const markerMatch = projectMarker.exec(html);
    if (!markerMatch || markerMatch.index < 0) {
        return null;
    }

    const cardSlice = html.slice(markerMatch.index, markerMatch.index + 6000);
    // Match inline-style badge (new) or legacy class-based badge (old)
    const failedMatch = cardSlice.match(/❗\s*(\d+)/i);
    const statusMatch = cardSlice.match(/<td[^>]*>(PASSED|FAILED|WARNING)<\/td>/i);
    // Match inline-style chip (new): ">API N<" or legacy class-based chip (old)
    const totalMatch = cardSlice.match(/[>"]API\s+(\d+)[<"]/i) || cardSlice.match(/project-chip-badge chip-api [^"]*">API\s*(\d+)/i);

    if (!statusMatch || !totalMatch) {
        return null;
    }

    return {
        failed: failedMatch ? parseInt(failedMatch[1], 10) : 0,
        statusLabel: statusMatch[1],
        total: parseInt(totalMatch[1], 10)
    };
}

function assertEmailMatchesLatestApiSource(model: DashboardEmailModel, html: string, latestSource: LatestApiSourceResult, projectId = 'ddp'): void {
    const latestProject = latestSource.projects.find((entry) => entry.id === projectId);
    const emailProject = model.projects.find((entry) => entry.id === projectId);

    if (!latestProject || !latestProject.results?.apis || !emailProject) {
        throw new Error('❌ Report generation failed: stale or inconsistent data detected');
    }

    const latestStatus = getApiStatusLabel(latestProject.results.apis);
    const emailStatus = getApiStatusLabel(emailProject.results.apis);

    if (
        emailProject.results.apis.failed !== latestProject.results.apis.failed ||
        emailProject.results.apis.total !== latestProject.results.apis.total ||
        emailStatus !== latestStatus
    ) {
        throw new Error('❌ Report generation failed: stale or inconsistent data detected');
    }
}

function ensureEmailModelMatchesLatestProjectSummary(model: DashboardEmailModel, latestSource: LatestApiSourceResult, projectId = 'ddp'): void {
    assertEmailMatchesLatestApiSource(model, '', latestSource, projectId);
}

function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getStatusColor(status: ItemStatus): string {
    if (status === 'failed') return '#ef4444';
    if (status === 'warning') return '#f59e0b';
    if (status === 'skipped') return '#6b7280';
    return '#10b981';
}

function getStatusLabel(status: ItemStatus): string {
    if (status === 'failed') return 'FAILED';
    if (status === 'warning') return 'WARNING';
    if (status === 'skipped') return 'SKIPPED';
    return 'PASSED';
}

function getStatusTextColor(status: ItemStatus): string {
    return status === 'warning' ? '#111827' : '#ffffff';
}

function getStatusEmoji(status: ItemStatus): string {
    if (status === 'failed') return '✗';
    if (status === 'warning') return '⚠';
    if (status === 'skipped') return '⏭';
    return '✓';
}

function getProjectChipInlineStyle(variant: string, tone: 'failed' | 'warning' | 'normal'): string {
    const chipColors: Record<string, { bg: string; color: string; border: string }> = {
        app:    { bg: '#f0f0f0', color: '#3b82f6', border: '#3b82f6' },
        server: { bg: '#f0f0f0', color: '#06b6d4', border: '#06b6d4' },
        ssl:    { bg: '#f0f0f0', color: '#8b5cf6', border: '#8b5cf6' },
        domain: { bg: '#f0f0f0', color: '#10b981', border: '#10b981' },
        api:    { bg: '#f0f0f0', color: '#f59e0b', border: '#f59e0b' }
    };
    const base = chipColors[variant] || chipColors['api'];
    const bg    = tone === 'failed' ? '#2a0d0d' : tone === 'warning' ? '#3a2600' : base.bg;
    const color = tone === 'failed' ? '#ff6b6b' : tone === 'warning' ? '#ffb020' : base.color;
    const border = tone === 'failed' ? '#ff4d4f' : tone === 'warning' ? '#ffb020' : base.border;
    const bw    = tone === 'normal' ? '2px' : '1px';
    return `display:inline-block;margin-right:8px;margin-bottom:6px;padding:5px 12px;border-radius:18px;font-size:12px;line-height:14px;font-weight:700;font-family:Arial,'Segoe UI',sans-serif;white-space:nowrap;background-color:${bg};color:${color};border:${bw} solid ${border};`;
}

function renderProjectFailedCountBadge(failedCount: number): string {
    return `<span style="display:inline-block;margin-right:8px;padding:4px 10px;border-radius:12px;background-color:#3b0a0a;color:#ff4d4f;font-size:12px;font-weight:600;border:1px solid #ff4d4f;vertical-align:middle;font-family:Arial,'Segoe UI',sans-serif;">❗ ${escapeHtml(failedCount)}</span>`;
}

function renderProjectWarningCountBadge(warningCount: number): string {
    if (warningCount <= 0) {
        return '';
    }

    return `<span style="display:inline-block;margin-right:8px;padding:4px 10px;border-radius:12px;background-color:#3a2600;color:#ffb020;font-size:12px;font-weight:600;border:1px solid #ffb020;vertical-align:middle;font-family:Arial,'Segoe UI',sans-serif;">⚠ ${escapeHtml(warningCount)}</span>`;
}

function getProjectChipTone(failureCount: number, warningCount: number): 'failed' | 'warning' | 'normal' {
    if (failureCount > 0) {
        return 'failed';
    }
    if (warningCount > 0) {
        return 'warning';
    }
    return 'normal';
}

function renderProjectSummaryChip(label: string, value: number, variant: string, tone: 'failed' | 'warning' | 'normal'): string {
    return `<span style="${getProjectChipInlineStyle(variant, tone)}">${escapeHtml(label)} ${value}</span>`;
}

function renderCountChip(label: string, value: number, color: string): string {
    return `
        <table role="presentation" cellpadding="0" cellspacing="0" style="display:inline-table;margin-right:8px;margin-bottom:6px;border-collapse:separate;">
            <tr>
                <td style="background-color:#f0f0f0;border:2px solid ${color};border-radius:18px;padding:5px 12px;font-size:12px;line-height:14px;font-weight:700;color:${color};font-family:Arial,'Segoe UI',sans-serif;white-space:nowrap;">${escapeHtml(label)} ${value}</td>
            </tr>
        </table>`;
}

function renderSummaryCard(label: string, value: number | string, accent: string, subtitle: string): string {
    const displayValue = String(value);
    const valueFontSize = /[a-zA-Z]/.test(displayValue) ? '26px' : '34px';
    const valueLineHeight = /[a-zA-Z]/.test(displayValue) ? '30px' : '36px';

    return `
        <td width="50%" style="width:50%;padding:8px;vertical-align:top;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#07111f" style="background-color:#07111f;border:2px solid ${accent};border-collapse:separate;border-radius:14px;">
                <tr>
                    <td style="padding:20px 18px;font-family:Arial,'Segoe UI',sans-serif;">
                        <div style="font-size:12px;line-height:16px;letter-spacing:1px;text-transform:uppercase;color:#cbd5e1;font-weight:700;margin-bottom:10px;">${escapeHtml(label)}</div>
                        <div style="font-size:${valueFontSize};line-height:${valueLineHeight};color:${accent};font-weight:800;margin-bottom:8px;">${escapeHtml(displayValue)}</div>
                        <div style="font-size:13px;line-height:18px;color:#94a3b8;">${escapeHtml(subtitle)}</div>
                    </td>
                </tr>
            </table>
        </td>`;
}

function renderActionButton(label: string, href?: string, enabled = true): string {
    if (!enabled) {
        return `<span style="display:inline-block;background-color:#334155;color:#cbd5e1;border:1px solid #475569;border-radius:16px;padding:8px 14px;font-size:12px;line-height:14px;font-weight:700;font-family:Arial,'Segoe UI',sans-serif;text-decoration:none;cursor:default;">${escapeHtml(label)}</span>`;
    }

    if (!href) {
        return `<span style="display:inline-block;background-color:#2563eb;color:#ffffff;border:1px solid #2563eb;border-radius:16px;padding:8px 14px;font-size:12px;line-height:14px;font-weight:700;font-family:Arial,'Segoe UI',sans-serif;text-decoration:none;">${escapeHtml(label)}</span>`;
    }

    return `<a href="${escapeHtml(href)}" style="display:inline-block;background-color:#2563eb;color:#ffffff;border:1px solid #2563eb;border-radius:16px;padding:8px 14px;font-size:12px;line-height:14px;font-weight:700;font-family:Arial,'Segoe UI',sans-serif;text-decoration:none;">${escapeHtml(label)}</a>`;
}

function renderModuleSection(section: ModuleSection): string {
    const statusColor = getStatusColor(section.status);
    const reportUrl = section.reportHref;
    const reportLabel = section.reportExists ? 'View Report' : 'Report not available';

    return `
        <tr>
            <td style="padding:0 0 12px 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#08111d" style="background-color:#08111d;border:1px solid #1f2937;border-left:6px solid ${statusColor};border-collapse:separate;border-radius:16px;">
                    <tr>
                        <td style="padding:16px 18px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                                <tr>
                                    <td style="font-size:16px;line-height:20px;font-weight:800;color:#ffffff;font-family:Arial,'Segoe UI',sans-serif;padding-right:12px;">${section.icon} ${escapeHtml(section.title)}</td>
                                    <td align="right" style="white-space:nowrap;">
                                        <table role="presentation" cellpadding="0" cellspacing="0" align="right">
                                            <tr>
                                                <td bgcolor="${statusColor}" style="background-color:${statusColor};border-radius:999px;padding:5px 12px;font-size:11px;line-height:13px;font-weight:800;letter-spacing:0.7px;color:${getStatusTextColor(section.status)};font-family:Arial,'Segoe UI',sans-serif;">${getStatusLabel(section.status)}</td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                                <tr>
                                    <td colspan="2" style="padding-top:10px;">
                                        ${renderCountChip('PASS', section.passed, '#10b981')}${section.failed > 0 ? renderCountChip('FAIL', section.failed, '#ef4444') : ''}${section.warning > 0 ? renderCountChip('WARN', section.warning, '#f59e0b') : ''}${renderCountChip('TOTAL', section.total, '#3b82f6')}
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding-top:10px;font-size:12px;line-height:17px;color:#94a3b8;font-family:Arial,'Segoe UI',sans-serif;">Duration: ${escapeHtml(section.durationLabel)}</td>
                                    <td align="right" style="padding-top:10px;">${renderActionButton(reportLabel, reportUrl, Boolean(section.reportExists))}</td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>`;
}

function renderItemDetails(item: EmailItem): string {
    const lines: string[] = [];

    lines.push(`<div style="margin-top:6px;font-size:13px;color:#d1d5db;"><strong style="color:#ffffff;">Project:</strong> ${escapeHtml(item.projectName)}</div>`);

    if (item.method) {
        lines.push(`<div style="margin-top:6px;font-size:13px;color:#d1d5db;"><strong style="color:#ffffff;">Method:</strong> ${escapeHtml(item.method)}</div>`);
    }
    if (item.url) {
        lines.push(`<div style="margin-top:6px;font-size:13px;color:#d1d5db;"><strong style="color:#ffffff;">URL:</strong> ${escapeHtml(item.url)}</div>`);
    }
    if (item.platform) {
        lines.push(`<div style="margin-top:6px;font-size:13px;color:#d1d5db;"><strong style="color:#ffffff;">Platform:</strong> ${escapeHtml(item.platform)}</div>`);
    }
    if (item.durationLabel) {
        lines.push(`<div style="margin-top:6px;font-size:13px;color:#d1d5db;"><strong style="color:#ffffff;">Duration:</strong> ${escapeHtml(item.durationLabel)}</div>`);
    }
    if (item.expiryDate) {
        lines.push(`<div style="margin-top:6px;font-size:13px;color:#d1d5db;"><strong style="color:#ffffff;">Expiry UTC:</strong> ${escapeHtml(item.expiryDate)}</div>`);
    }
    if (item.expiryDateIST) {
        lines.push(`<div style="margin-top:6px;font-size:13px;color:#d1d5db;"><strong style="color:#ffffff;">Expiry IST:</strong> ${escapeHtml(item.expiryDateIST)}</div>`);
    }
    if (item.daysRemaining !== null && item.daysRemaining !== undefined) {
        lines.push(`<div style="margin-top:6px;font-size:13px;color:#d1d5db;"><strong style="color:#ffffff;">Days Remaining:</strong> ${escapeHtml(item.daysRemaining)}</div>`);
    }
    if (item.responseCode !== null && item.responseCode !== undefined) {
        lines.push(`<div style="margin-top:6px;font-size:13px;color:#d1d5db;"><strong style="color:#ffffff;">Response Code:</strong> ${escapeHtml(item.responseCode)}</div>`);
    }
    if (item.expectedStatus !== null && item.expectedStatus !== undefined) {
        lines.push(`<div style="margin-top:6px;font-size:13px;color:#d1d5db;"><strong style="color:#ffffff;">Expected:</strong> ${escapeHtml(item.expectedStatus)}</div>`);
    }
    if (item.reason) {
        lines.push(`<div style="margin-top:6px;font-size:13px;color:#fca5a5;"><strong style="color:#ffffff;">Error Reason:</strong> ${escapeHtml(item.reason)}</div>`);
    }

    return lines.join('');
}

function renderItem(item: EmailItem): string {
    const statusColor = getStatusColor(item.status);
    return `
        <tr>
            <td style="padding:0 0 12px 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${item.status === 'failed' ? '#2a1114' : item.status === 'warning' ? '#2b200c' : '#0d2218'}" style="background-color:${item.status === 'failed' ? '#2a1114' : item.status === 'warning' ? '#2b200c' : '#0d2218'};border:1px solid ${statusColor};border-collapse:separate;border-radius:14px;">
                    <tr>
                        <td style="padding:14px 16px;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td style="font-size:14px;line-height:18px;font-weight:700;color:#ffffff;font-family:Arial,'Segoe UI',sans-serif;padding-right:12px;vertical-align:top;">${getStatusEmoji(item.status)} ${escapeHtml(item.name)}</td>
                                    <td width="92" align="right" style="vertical-align:top;">
                                        <table role="presentation" cellpadding="0" cellspacing="0" align="right">
                                            <tr>
                                                <td bgcolor="${statusColor}" style="background-color:${statusColor};border-radius:999px;padding:4px 10px;font-size:11px;line-height:13px;font-weight:800;letter-spacing:0.7px;color:${item.status === 'warning' ? '#111827' : '#ffffff'};font-family:Arial,'Segoe UI',sans-serif;white-space:nowrap;">${getStatusLabel(item.status)}</td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                                <tr>
                                    <td colspan="2" style="padding-top:4px;">${renderItemDetails(item)}</td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>`;
}

function renderSection(sectionTitle: string, section: SectionSummary): string {
    if (section.total === 0) {
        return '';
    }

    const sectionStatus: ItemStatus = section.failed > 0 ? 'failed' : section.warning > 0 ? 'warning' : 'passed';
    const accent = getStatusColor(sectionStatus);

    return `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#0b1120" style="margin-top:18px;background-color:#0b1120;border:1px solid #1f2937;border-collapse:separate;border-radius:18px;">
            <tr>
                <td bgcolor="${sectionStatus === 'failed' ? '#7f1d1d' : sectionStatus === 'warning' ? '#7c4a03' : '#065f46'}" style="padding:16px 18px;background-color:${sectionStatus === 'failed' ? '#7f1d1d' : sectionStatus === 'warning' ? '#7c4a03' : '#065f46'};border-bottom:1px solid #111827;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                        <tr>
                            <td style="font-size:16px;line-height:20px;font-weight:800;color:#ffffff;font-family:Arial,'Segoe UI',sans-serif;vertical-align:middle;">${escapeHtml(sectionTitle)}</td>
                        </tr>
                        <tr>
                            <td style="padding-top:10px;">${renderCountChip('✓', section.passed, '#10b981')}${section.warning > 0 ? renderCountChip('⚠', section.warning, '#f59e0b') : ''}${section.failed > 0 ? renderCountChip('✗', section.failed, '#ef4444') : ''}</td>
                        </tr>
                    </table>
                </td>
            </tr>
            <tr>
                <td style="padding:16px 18px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                        ${section.tests.map(renderItem).join('')}
                    </table>
                </td>
            </tr>
        </table>`;
}

function renderAttentionSection(title: string, items: Array<{ projectName: string; sectionLabel: string; item: EmailItem }>, status: ItemStatus): string {
    const accent = getStatusColor(status);
    const background = status === 'failed' ? '#081019' : '#0a1320';
    const emptyMessage = status === 'failed' ? 'No failed checks in this run.' : 'No warning checks in this run.';
    const headerBackground = status === 'failed'
        ? 'linear-gradient(135deg, rgba(239, 68, 68, 0.24), rgba(127, 29, 29, 0.82))'
        : 'linear-gradient(135deg, rgba(245, 158, 11, 0.28), rgba(120, 53, 15, 0.82))';
    const groupedItems = items.reduce((groups, entry) => {
        const bucket = groups.get(entry.projectName) || [];
        bucket.push(entry);
        groups.set(entry.projectName, bucket);
        return groups;
    }, new Map<string, Array<{ projectName: string; sectionLabel: string; item: EmailItem }>>());

    return `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${background}" style="margin-top:24px;background-color:${background};border:1px solid ${accent};border-collapse:separate;border-radius:22px;overflow:hidden;">
            <tr>
                <td style="padding:20px 22px;background:${headerBackground};border-bottom:1px solid rgba(255,255,255,0.08);font-family:Arial,'Segoe UI',sans-serif;">
                    <div style="font-size:18px;line-height:22px;font-weight:800;color:#ffffff;">${escapeHtml(title)}</div>
                    <div style="font-size:13px;line-height:18px;color:#dbeafe;margin-top:6px;">${items.length} item${items.length === 1 ? '' : 's'} surfaced from the current normalized dashboard model.</div>
                </td>
            </tr>
            <tr>
                <td style="padding:18px 20px;font-family:Arial,'Segoe UI',sans-serif;">
                    ${items.length > 0 ? Array.from(groupedItems.entries()).map(([projectName, projectItems]) => `
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#0b1524" style="margin-bottom:16px;background-color:#0b1524;border:1px solid rgba(148,163,184,0.14);border-left:4px solid ${accent};border-collapse:separate;border-radius:18px;box-shadow:0 12px 30px rgba(2,6,23,0.22);">
                            <tr>
                                <td style="padding:16px 18px 12px 18px;border-bottom:1px solid rgba(148,163,184,0.1);">
                                    <div style="font-size:16px;line-height:20px;font-weight:800;color:#ffffff;">${escapeHtml(projectName)}</div>
                                    <div style="font-size:12px;line-height:17px;color:#94a3b8;margin-top:4px;">${projectItems.length} ${status === 'failed' ? 'failed' : 'warning'} item${projectItems.length === 1 ? '' : 's'}</div>
                                </td>
                            </tr>
                            <tr>
                                <td style="padding:14px 16px 2px 16px;">
                                    ${projectItems.map(({ sectionLabel, item }) => `
                                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#09111f" style="margin-bottom:12px;background-color:#09111f;border:1px solid rgba(148,163,184,0.12);border-radius:14px;">
                                            <tr>
                                                <td style="padding:14px 15px;">
                                                    <div style="font-size:12px;line-height:16px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:${accent};">${escapeHtml(sectionLabel)}</div>
                                                    <div style="font-size:15px;line-height:20px;font-weight:800;color:#ffffff;margin-top:6px;">${escapeHtml(item.name)}</div>
                                                    ${item.url ? `<div style="margin-top:10px;padding:10px 12px;border-radius:12px;background:rgba(15,23,42,0.72);border:1px solid rgba(59,130,246,0.18);font-size:12px;line-height:17px;color:#bfdbfe;word-break:break-all;overflow-wrap:anywhere;">${escapeHtml(item.url)}</div>` : ''}
                                                    ${item.reason ? `<div style="margin-top:10px;padding:12px 13px;border-radius:14px;background:rgba(2,6,23,0.55);border:1px solid rgba(148,163,184,0.14);font-size:13px;line-height:19px;color:${status === 'failed' ? '#fecaca' : '#fde68a'};word-break:break-word;overflow-wrap:anywhere;white-space:pre-wrap;">${escapeHtml(item.reason)}</div>` : ''}
                                                    ${(item.method || item.durationLabel || item.responseCode !== null && item.responseCode !== undefined || item.expectedStatus !== null && item.expectedStatus !== undefined || item.expiryDate || item.expiryDateIST || item.daysRemaining !== null && item.daysRemaining !== undefined) ? `<div style="margin-top:10px;font-size:12px;line-height:18px;color:#94a3b8;word-break:break-word;overflow-wrap:anywhere;">${[
                                                        item.method ? `Method: ${escapeHtml(item.method)}` : '',
                                                        item.responseCode !== null && item.responseCode !== undefined ? `Status Code: ${escapeHtml(item.responseCode)}` : '',
                                                        item.expectedStatus !== null && item.expectedStatus !== undefined ? `Expected: ${escapeHtml(item.expectedStatus)}` : '',
                                                        item.durationLabel ? `Duration: ${escapeHtml(item.durationLabel)}` : '',
                                                        item.expiryDate ? `UTC: ${escapeHtml(item.expiryDate)}` : '',
                                                        item.expiryDateIST ? `IST: ${escapeHtml(item.expiryDateIST)}` : '',
                                                        item.daysRemaining !== null && item.daysRemaining !== undefined ? `Days Remaining: ${escapeHtml(item.daysRemaining)}` : ''
                                                    ].filter(Boolean).join(' • ')}</div>` : ''}
                                                </td>
                                            </tr>
                                        </table>`).join('')}
                                </td>
                            </tr>
                        </table>`).join('') : `<div style="padding:24px 20px;border-radius:18px;background:linear-gradient(180deg, rgba(15,23,42,0.92), rgba(8,16,31,0.96));border:1px dashed rgba(148,163,184,0.32);text-align:center;"><div style="font-size:15px;line-height:20px;font-weight:800;color:#e2e8f0;">${escapeHtml(emptyMessage)}</div><div style="font-size:13px;line-height:18px;color:#94a3b8;margin-top:8px;">${status === 'failed' ? 'The latest dashboard run did not emit any failed items into this section.' : 'No warning items were emitted into the normalized report model for this run.'}</div></div>`}
                </td>
            </tr>
        </table>`;
}

function renderProjectStatusBadge(project: ProjectEmailCard): string {
    return `
        <table role="presentation" cellpadding="0" cellspacing="0" style="display:inline-table;margin-bottom:6px;">
            <tr>
                <td bgcolor="${getStatusColor(project.overallStatus)}" style="background-color:${getStatusColor(project.overallStatus)};border-radius:18px;padding:5px 12px;font-size:12px;line-height:14px;font-weight:800;color:${project.overallStatus === 'warning' ? '#111827' : '#ffffff'};font-family:Arial,'Segoe UI',sans-serif;white-space:nowrap;">${getStatusLabel(project.overallStatus)}</td>
            </tr>
        </table>`;
}

function renderProjectSummaryChips(project: ProjectEmailCard): string {
    return `
        <span style="display:inline-block;">
            ${renderProjectSummaryChip('APP', project.results.apps.total, 'app', getProjectChipTone(project.categoryFailures.apps, project.categoryWarnings.apps))}
            ${renderProjectSummaryChip('SRV', project.results.servers.total, 'server', getProjectChipTone(project.categoryFailures.servers, project.categoryWarnings.servers))}
            ${renderProjectSummaryChip('SSL', project.results.ssl.total, 'ssl', getProjectChipTone(project.categoryFailures.ssl, project.categoryWarnings.ssl))}
            ${renderProjectSummaryChip('DOM', project.results.domains.total, 'domain', getProjectChipTone(project.categoryFailures.domains, project.categoryWarnings.domains))}
            ${renderProjectSummaryChip('API', project.results.apis.total, 'api', getProjectChipTone(project.categoryFailures.apis, project.categoryWarnings.apis))}
        </span>`;
}

function renderProjectDetailSections(project: ProjectEmailCard): string {
    return `${renderSection('App Status', project.results.apps)}${renderSection('Server Health', project.results.servers)}${renderSection('SSL Certificates', project.results.ssl)}${renderSection('Domain Status', project.results.domains)}${renderSection('API Endpoints', project.results.apis)}`;
}

function renderProjectCard(project: ProjectEmailCard): string {
    return `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#050b17" style="margin-bottom:24px;background-color:#050b17;border:1px solid #1f2937;border-left:6px solid ${escapeHtml(project.color)};border-collapse:separate;border-radius:22px;overflow:hidden;box-shadow:0 12px 30px rgba(2,6,23,0.22);">
            <tr>
                <td style="padding:22px 24px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                        <tr>
                            <td style="padding-right:14px;vertical-align:top;">
                                <div style="font-size:24px;line-height:28px;font-weight:800;color:#ffffff;font-family:Arial,'Segoe UI',sans-serif;">${escapeHtml(project.name)}</div>
                                <div style="font-size:14px;line-height:20px;color:#cbd5e1;padding-top:6px;font-family:Arial,'Segoe UI',sans-serif;">${escapeHtml(project.description)}</div>
                            </td>
                            <td align="right" style="vertical-align:top;white-space:nowrap;">
                                ${renderProjectFailedCountBadge(project.failedCount)}
                                ${renderProjectWarningCountBadge(project.warningCount)}
                                ${renderProjectStatusBadge(project)}
                            </td>
                        </tr>
                        <tr>
                            <td colspan="2" style="padding-top:14px;">${renderProjectSummaryChips(project)}</td>
                        </tr>
                        <tr>
                            <td colspan="2" style="padding-top:16px;">
                                <span style="display:inline-block;padding:8px 12px;border-radius:999px;background-color:#312e81;font-size:11px;line-height:13px;font-weight:800;letter-spacing:0.06em;text-transform:uppercase;color:#e0e7ff;font-family:Arial,'Segoe UI',sans-serif;">Summary Only</span>
                            </td>
                        </tr>
                    </table>
                </td>
            </tr>
        </table>`;
}

function renderEmailModuleSection(section: ModuleSection): string {
    const attentionItems = section.items.filter((item) => item.status !== 'passed');
    const sectionStatus: ItemStatus = section.failed > 0 ? 'failed' : section.warning > 0 || section.skipped > 0 ? 'warning' : 'passed';
    const headerColor = sectionStatus === 'failed' ? '#7f1d1d' : sectionStatus === 'warning' ? '#7c4a03' : '#065f46';
    const title = section.id === 'app'
        ? 'App Status'
        : section.id === 'server'
            ? 'Server Health'
            : section.id === 'cert'
                ? 'SSL Certificates'
                : section.id === 'domain'
                    ? 'Domain Status'
                    : 'API Status';

    return `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#050b17" style="margin-top:20px;background-color:#050b17;border:1px solid #1f2937;border-collapse:separate;border-radius:18px;overflow:hidden;">
            <tr>
                <td style="padding:18px 20px;background:${headerColor};font-family:Arial,'Segoe UI',sans-serif;">
                    <div style="font-size:18px;line-height:22px;font-weight:800;color:#ffffff;">${escapeHtml(title)} <span style="color:#cbd5e1;">(${section.total})</span></div>
                    <div style="padding-top:10px;">${renderCountChip('TOTAL', section.total, '#3b82f6')}${section.warning > 0 ? renderCountChip('WARN', section.warning, '#f59e0b') : ''}${section.skipped > 0 ? renderCountChip('SKIP', section.skipped, '#6b7280') : ''}${section.failed > 0 ? renderCountChip('FAIL', section.failed, '#ef4444') : ''}</div>
                </td>
            </tr>
            <tr>
                <td style="padding:18px 20px;font-family:Arial,'Segoe UI',sans-serif;">
                    ${attentionItems.length > 0 ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${attentionItems.map(renderItem).join('')}</table>` : `<div style="padding:16px 14px;border-radius:14px;background:#0b1524;border:1px dashed rgba(148,163,184,0.3);font-size:13px;line-height:18px;color:#94a3b8;text-align:center;">No failed or warning checks in this module.</div>`}
                </td>
            </tr>
        </table>`;
}

function renderEmailModuleSections(sections: ModuleSection[]): string {
    return sections.map((section) => renderEmailModuleSection(section)).join('');
}

function buildDashboardEmailHtml(model: DashboardEmailModel): string {
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(model.headerTitle)}</title>
    <style>
        /* Responsive: stack 2-col summary cards to 1-col on small screens */
        @media screen and (max-width: 600px) {
            td[width="50%"],
            td[style*="width:50%"] {
                display: block !important;
                width: 100% !important;
                box-sizing: border-box !important;
            }
            table[style*="max-width:700px"] {
                width: 100% !important;
            }
        }
    </style>
</head>
<body style="margin:0;padding:0;background-color:#000000;color:#ffffff;font-family:Arial,'Segoe UI',sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#000000" style="background-color:#000000;margin:0;padding:0;border-collapse:collapse;">
        <tr>
            <td align="center" style="padding:24px 12px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:700px;border-collapse:collapse;">
                    <tr>
                        <td style="padding:0 0 24px 0;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0b1f38" style="background-color:#0b1f38;border:1px solid #2563eb;border-collapse:separate;border-radius:24px;">
                                <tr>
                                    <td style="padding:32px 28px;text-align:center;">
                                        <div style="font-size:36px;line-height:40px;font-weight:800;letter-spacing:-1px;color:#ffffff;">${escapeHtml(model.headerTitle)}</div>
                                        <div style="font-size:16px;line-height:22px;color:#cbd5e1;margin-top:12px;">${escapeHtml(model.headerSubtitle)}</div>
                                        <div style="font-size:13px;line-height:18px;color:#9ca3af;margin-top:12px;">Generated ${escapeHtml(model.generatedAt)}</div>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <tr>
                        <td style="padding:0 0 24px 0;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                                <tr>
                                    ${renderSummaryCard('Success', model.summary.successfulSuites, '#10b981', 'Suites completed successfully')}
                                    ${renderSummaryCard('Failed', model.summary.totalFailedTests, '#ef4444', 'Real failed or error checks only') }
                                </tr>
                                <tr>
                                    ${renderSummaryCard('Warning/Skipped', model.summary.totalWarningTests + model.summary.totalSkippedTests, '#f59e0b', 'Warning and skipped checks requiring review') }
                                    ${renderSummaryCard('Total Suites', model.summary.totalSuites, '#3b82f6', 'Configured suites in this run') }
                                </tr>
                                <tr>
                                    ${renderSummaryCard('Duration', model.summary.durationLabel, '#2563eb', 'Combined suite runtime') }
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <tr>
                        <td style="padding-top:24px;">
                            ${model.projects.map(renderProjectCard).join('')}
                        </td>
                    </tr>

                    <tr>
                        <td>
                            ${renderEmailModuleSections(model.moduleSections)}
                        </td>
                    </tr>

                    <tr>
                        <td style="padding:0 0 16px 0;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#050b17" style="background-color:#050b17;border:1px solid #1f2937;border-collapse:separate;border-radius:18px;">
                                <tr>
                                    <td style="padding:18px 20px;">
                                        <div style="font-size:16px;line-height:20px;font-weight:800;color:#ffffff;font-family:Arial,'Segoe UI',sans-serif;">Attached Full Report</div>
                                        <div style="font-size:13px;line-height:19px;color:#94a3b8;margin-top:8px;font-family:Arial,'Segoe UI',sans-serif;">This email is intentionally compact. Open the attached dashboard report to view full server, SSL, domain, API, and app-level details.</div>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <tr>
                        <td style="padding:0 0 8px 0;">
                            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#050b17" style="background-color:#050b17;border:1px solid #1f2937;border-collapse:separate;border-radius:18px;">
                                <tr>
                                    <td style="padding:18px 20px;font-size:13px;line-height:18px;color:#94a3b8;text-align:center;font-family:Arial,'Segoe UI',sans-serif;">Ad-Hash Technolabs Pvt Ltd • Automated dashboard summary email generated from current dashboard state and suite reports.</td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>`;
}

function getSortableDaysRemaining(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function getModuleItems(projects: ProjectEmailCard[], suiteId: SuiteId): EmailItem[] {
    const sectionKey = MODULE_SECTION_KEY[suiteId];
    const items = projects.flatMap((project) => project.results[sectionKey].tests);

    return items
        .map((item, index) => ({ item, index }))
        .sort((leftEntry, rightEntry) => {
            const left = leftEntry.item;
            const right = rightEntry.item;

            if (suiteId === 'cert' || suiteId === 'domain') {
                const dayScore = getSortableDaysRemaining(left.daysRemaining) - getSortableDaysRemaining(right.daysRemaining);
                if (dayScore !== 0) {
                    return dayScore;
                }
            } else {
                const statusOrder: Record<ItemStatus, number> = { failed: 0, warning: 1, skipped: 2, passed: 3 };
                const statusScore = statusOrder[left.status] - statusOrder[right.status];
                if (statusScore !== 0) {
                    return statusScore;
                }
            }

            const projectScore = left.projectName.localeCompare(right.projectName);
            if (projectScore !== 0) {
                return projectScore;
            }

            const nameScore = left.name.localeCompare(right.name);
            if (nameScore !== 0) {
                return nameScore;
            }

            return leftEntry.index - rightEntry.index;
        })
        .map((entry) => entry.item);
}

function buildModuleSectionFromItems(section: ModuleSection, items: EmailItem[]): ModuleSection {
    const passed = items.filter((item) => item.status === 'passed').length;
    const warning = items.filter((item) => item.status === 'warning').length;
    const failed = items.filter((item) => item.status === 'failed').length;
    const skipped = items.filter((item) => item.status === 'skipped').length;
    const total = items.length;
    const status = failed > 0 ? 'failed' : warning > 0 || skipped > 0 ? 'warning' : total > 0 ? 'passed' : section.status;

    return {
        ...section,
        status,
        passed,
        warning,
        failed,
        skipped,
        total,
        items
    };
}

function logModuleReportEntry(sectionId: SuiteId, item: EmailItem): void {
    if (sectionId === 'app') {
        console.log(`[APP REPORT] project: ${item.projectName}, app: ${item.name}, store: ${item.platform || 'N/A'}, store url: ${item.url || 'N/A'}, status: ${item.status}, duration: ${item.durationLabel || 'N/A'}, reason: ${item.reason || 'N/A'}`);
        return;
    }

    if (sectionId === 'cert') {
        console.log(`[SSL REPORT] project: ${item.projectName}, url: ${item.url || 'N/A'}, certificate status: ${item.status}, expiry date: ${item.expiryDate || 'N/A'}, days remaining: ${item.daysRemaining ?? 'N/A'}, reason: ${item.reason || 'N/A'}`);
        return;
    }

    if (sectionId === 'domain') {
        const validStructured = Boolean(item.name && item.url && (item.expiryDate || item.daysRemaining !== null && item.daysRemaining !== undefined || item.reason));
        console.log(`[DOMAIN REPORT] project: ${item.projectName}, domain: ${item.name}, url: ${item.url || 'N/A'}, status: ${item.status}, expiry date: ${item.expiryDate || 'N/A'}, days remaining: ${item.daysRemaining ?? 'N/A'}, reason: ${item.reason || 'N/A'}, valid structured data: ${validStructured}`);
        return;
    }

    if (sectionId === 'api') {
        console.log(`[API REPORT] project: ${item.projectName}, name: ${item.name}, url: ${item.url || 'N/A'}, method: ${item.method || 'N/A'}, status code: ${item.responseCode ?? 'N/A'}, status: ${item.status}, failure details: ${item.reason || 'N/A'}`);
        return;
    }

    console.log(`[SERVER REPORT] project: ${item.projectName}, name: ${item.name}, url: ${item.url || 'N/A'}, status: ${item.status}, response code: ${item.responseCode ?? 'N/A'}, duration: ${item.durationLabel || 'N/A'}, error: ${item.reason || 'N/A'}`);
}

function renderModuleField(label: string, value: unknown, isWide = false): string {
    const displayValue = String(value ?? '').trim();
    if (!displayValue) {
        return '';
    }

    return `
        <div class="field${isWide ? ' wide' : ''}">
            <div class="field-label">${escapeHtml(label)}</div>
            <div class="field-value">${escapeHtml(displayValue)}</div>
        </div>`;
}

function renderDateFields(utcLabel: string, istLabel: string, value: unknown, fallbackIST?: string): string {
    const display = buildDateDisplayLines(value, fallbackIST);
    return `${renderModuleField(utcLabel, display.utc)}${display.ist ? renderModuleField(istLabel, display.ist) : ''}`;
}

function renderGeneratedAtCard(value: string): string {
    const display = buildDateDisplayLines(value);

    return `
        <div class="summary-card timestamp-card">
            <div class="label">Generated At</div>
            <div class="timestamp-lines">
                ${display.utc ? `<div class="timestamp-line"><span class="timestamp-prefix">UTC</span><span class="timestamp-value">${escapeHtml(display.utc)}</span></div>` : ''}
                ${display.ist ? `<div class="timestamp-line"><span class="timestamp-prefix">IST</span><span class="timestamp-value">${escapeHtml(display.ist)}</span></div>` : ''}
                ${!display.utc && !display.ist ? `<div class="timestamp-line"><span class="timestamp-value">${escapeHtml(value)}</span></div>` : ''}
            </div>
        </div>`;
}

function renderPayloadBlock(label: string, value: string | undefined): string {
    const normalizedValue = normalizePayloadText(value);
    if (!normalizedValue) {
        return '';
    }

    return `
        <details class="payload-block">
            <summary>${escapeHtml(label)}${summarizeText(normalizedValue) ? `: ${escapeHtml(summarizeText(normalizedValue, 140) || '')}` : ''}</summary>
            <pre>${escapeHtml(normalizedValue)}</pre>
        </details>`;
}

function renderModuleCard(sectionId: SuiteId, item: EmailItem): string {
    const cardFields: string[] = [renderModuleField('URL', item.url, true)];

    if (sectionId === 'app') {
        cardFields.push(renderModuleField('Store', item.platform));
        cardFields.push(renderModuleField('Duration', item.durationLabel));
        cardFields.push(renderModuleField('Failure Details', item.reason, true));
    } else if (sectionId === 'server') {
        cardFields.push(renderModuleField('Duration', item.durationLabel));
        cardFields.push(renderModuleField('Error', item.reason, true));
    } else if (sectionId === 'cert') {
        cardFields.push(renderModuleField('Certificate Status', getStatusLabel(item.status)));
        cardFields.push(renderDateFields('Expiry Date (UTC)', 'Expiry Date (IST)', item.expiryDate, item.expiryDateIST));
        cardFields.push(renderModuleField('Days Remaining', item.daysRemaining));
        cardFields.push(renderModuleField('Reason', item.reason, true));
    } else if (sectionId === 'domain') {
        cardFields.push(renderModuleField('Domain Status', getStatusLabel(item.status)));
        cardFields.push(renderDateFields('Expiry Date (UTC)', 'Expiry Date (IST)', item.expiryDate, item.expiryDateIST));
        cardFields.push(renderModuleField('Days Remaining', item.daysRemaining));
        cardFields.push(renderModuleField('Reason', item.reason, true));
    } else if (sectionId === 'api') {
        cardFields.push(renderModuleField('Method', item.method));
        cardFields.push(renderModuleField('Status Code', item.responseCode));
        cardFields.push(renderModuleField('Expected Status', item.expectedStatus));
        cardFields.push(renderModuleField('Duration', item.durationLabel));
        cardFields.push(renderModuleField('Failure Details', item.reason, true));
    }

    return `
        <article class="report-card ${item.status}">
            <div class="report-card-header">
                <div>
                    <h2>${escapeHtml(item.name)}</h2>
                    <p>${escapeHtml(item.projectName)}</p>
                </div>
                <span class="badge ${item.status}">${escapeHtml(getStatusLabel(item.status))}</span>
            </div>
            <div class="field-grid">
                ${cardFields.filter(Boolean).join('')}
            </div>
            ${sectionId === 'api' ? `${renderPayloadBlock('Request', item.requestBody)}${renderPayloadBlock('Response', item.responseBody)}` : ''}
        </article>`;
}

function buildModuleReportPage(model: DashboardEmailModel, section: ModuleSection, items: EmailItem[]): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(section.title)}</title>
    <style>
        :root {
            color-scheme: dark;
            --bg: #04111f;
            --border: #1e293b;
            --text: #e2e8f0;
            --muted: #94a3b8;
            --pass: #10b981;
            --warn: #f59e0b;
            --fail: #ef4444;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            font-family: Arial, 'Segoe UI', sans-serif;
            background: radial-gradient(circle at top, #123154 0%, var(--bg) 45%, #020817 100%);
            color: var(--text);
        }
        .page { max-width: 1320px; margin: 0 auto; padding: 28px 20px 40px; }
        .hero {
            background: linear-gradient(135deg, rgba(37, 99, 235, 0.25), rgba(15, 23, 42, 0.95));
            border: 1px solid rgba(96, 165, 250, 0.35);
            border-radius: 24px;
            padding: 28px;
            margin-bottom: 24px;
            box-shadow: 0 24px 80px rgba(2, 6, 23, 0.35);
        }
        .hero h1 { margin: 0 0 10px; font-size: 34px; line-height: 1.1; }
        .hero p { margin: 0; color: var(--muted); font-size: 15px; line-height: 1.6; }
        .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; margin-top: 20px; }
        .summary-card { background: rgba(2, 6, 23, 0.48); border: 1px solid var(--border); border-radius: 18px; padding: 14px 16px; }
        .summary-card .label { color: var(--muted); font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
        .summary-card .value { margin-top: 8px; font-size: 26px; font-weight: 800; }
        .timestamp-card { grid-column: span 2; min-width: 0; }
        .timestamp-lines { margin-top: 10px; display: grid; gap: 8px; }
        .timestamp-line { display: flex; gap: 10px; align-items: flex-start; }
        .timestamp-prefix { flex: 0 0 36px; color: #93c5fd; font-size: 12px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; padding-top: 2px; }
        .timestamp-value { min-width: 0; color: #f8fafc; font-size: 15px; line-height: 1.45; font-weight: 700; word-break: break-word; overflow-wrap: anywhere; }
        .cards { display: grid; gap: 18px; }
        .report-card {
            background: linear-gradient(180deg, rgba(15, 23, 42, 0.95), rgba(8, 16, 31, 0.98));
            border: 1px solid var(--border);
            border-left: 6px solid #60a5fa;
            border-radius: 20px;
            padding: 18px;
        }
        .report-card.failed { border-left-color: var(--fail); }
        .report-card.warning { border-left-color: var(--warn); }
        .report-card.passed { border-left-color: var(--pass); }
        .report-card-header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 14px; }
        .report-card-header h2 { margin: 0; font-size: 22px; line-height: 1.2; }
        .report-card-header p { margin: 6px 0 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
        .badge { display: inline-flex; align-items: center; justify-content: center; min-width: 94px; padding: 8px 12px; border-radius: 999px; font-size: 11px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
        .badge.passed { background: rgba(16, 185, 129, 0.18); color: #6ee7b7; }
        .badge.warning { background: rgba(245, 158, 11, 0.2); color: #fcd34d; }
        .badge.failed { background: rgba(239, 68, 68, 0.18); color: #fca5a5; }
        .field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
        .field { background: rgba(15, 23, 42, 0.65); border: 1px solid rgba(30, 41, 59, 0.9); border-radius: 14px; padding: 12px 13px; min-width: 0; }
        .field.wide { grid-column: 1 / -1; }
        .field-label { color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 6px; }
        .field-value { font-size: 14px; line-height: 1.5; word-break: break-word; }
        .payload-block { margin-top: 14px; background: rgba(2, 6, 23, 0.55); border: 1px solid rgba(30, 41, 59, 0.9); border-radius: 14px; overflow: hidden; }
        .payload-block summary { cursor: pointer; padding: 12px 14px; font-size: 13px; font-weight: 700; color: #bfdbfe; list-style: none; }
        .payload-block summary::-webkit-details-marker { display: none; }
        .payload-block pre { margin: 0; padding: 0 14px 14px; white-space: pre-wrap; word-break: break-word; color: #dbeafe; font-size: 12px; line-height: 1.6; font-family: Consolas, 'Courier New', monospace; }
        .empty-state { background: rgba(15, 23, 42, 0.88); border: 1px dashed rgba(148, 163, 184, 0.45); border-radius: 20px; padding: 30px; color: var(--muted); text-align: center; }
        @media (max-width: 720px) {
            .hero h1 { font-size: 28px; }
            .report-card-header { flex-direction: column; }
            .badge { min-width: 0; }
            .timestamp-card { grid-column: span 1; }
            .timestamp-line { flex-direction: column; gap: 4px; }
            .timestamp-prefix { flex-basis: auto; padding-top: 0; }
            .timestamp-value { font-size: 14px; }
        }
        @media (max-width: 480px) {
            .page { padding: 14px 10px 28px; }
            .hero { padding: 18px 14px; border-radius: 16px; }
            .hero h1 { font-size: 22px; }
            .summary { grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 14px; }
            .timestamp-card { grid-column: span 2; }
            .report-card { padding: 14px; }
            .report-card-header h2 { font-size: 18px; }
            .field-grid { grid-template-columns: 1fr; }
            .field.wide { grid-column: 1; }
        }
    </style>
</head>
<body>
    <main class="page">
        <section class="hero">
            <h1>${escapeHtml(section.icon)} ${escapeHtml(section.title)}</h1>
            <p>Generated from the current dashboard state and normalized suite results. This drill-down page is the source linked by the static dashboard report for this module.</p>
            <div class="summary">
                ${renderGeneratedAtCard(model.generatedAt)}
                <div class="summary-card"><div class="label">Passed</div><div class="value" style="color:#6ee7b7;">${section.passed}</div></div>
                <div class="summary-card"><div class="label">Failed</div><div class="value" style="color:#fca5a5;">${section.failed}</div></div>
                <div class="summary-card"><div class="label">Warnings</div><div class="value" style="color:#fcd34d;">${section.warning}</div></div>
                <div class="summary-card"><div class="label">Skipped</div><div class="value" style="color:#d1d5db;">${section.skipped}</div></div>
                <div class="summary-card"><div class="label">Total</div><div class="value">${section.total}</div></div>
                <div class="summary-card"><div class="label">Duration</div><div class="value">${escapeHtml(section.durationLabel)}</div></div>
            </div>
        </section>
        <section class="cards">
            ${items.length > 0 ? items.map((item) => renderModuleCard(section.id, item)).join('') : `<div class="empty-state">No structured items were available for this module in the current output. The dashboard generated a valid report page instead of linking to a missing or generic raw file.</div>`}
        </section>
    </main>
</body>
</html>`;
}

function generateModuleReportPages(previewDir: string, model: DashboardEmailModel): DashboardEmailModel {
    const reportsDir = path.join(previewDir, 'module-reports');
    fs.mkdirSync(reportsDir, { recursive: true });

    return {
        ...model,
        moduleSections: model.moduleSections.map((section) => {
            const items = section.items || [];
            const normalizedSection = buildModuleSectionFromItems(section, items);

            if (section.id === 'server') {
                const failedItems = items.filter((item) => item.status === 'failed');
                console.log(`[SERVER HEALTH] total items: ${items.length}`);
                console.log(`[SERVER HEALTH] failed items count: ${failedItems.length}`);
                console.log(`[SERVER HEALTH] failed item names rendered: ${failedItems.length > 0 ? failedItems.map((item) => item.name).join(', ') : 'none'}`);
            }

            items.forEach((item) => logModuleReportEntry(section.id, item));

            const reportPath = path.join(reportsDir, MODULE_REPORT_FILE[section.id]);
            const html = buildModuleReportPage(model, normalizedSection, items);
            fs.writeFileSync(reportPath, html, 'utf8');

            const href = getModuleReportHref(section.id);
            console.log(`[REPORT LINK] module name: ${section.title}, target report path: ${reportPath}, exists true`);
            console.log(`[REPORT LINK] final href used: ${href}`);

            return {
                ...normalizedSection,
                items,
                reportHref: href,
                reportExists: true
            };
        })
    };
}

function parseEmailConfigFromEnv(env: NodeJS.ProcessEnv): { enabled: boolean; config: EmailConfig; missingKeys: string[] } {
    const enabled = String(env.ZOHO_MAIL_ENABLED || '').trim().toLowerCase() === 'true';
    const user = String(env.ZOHO_MAIL_USER || '').trim();
    const pass = String(env.ZOHO_MAIL_PASS || '').trim();
    const from = String(env.ZOHO_MAIL_FROM || user || '').trim();
    const to = String(env.ZOHO_MAIL_TO || '')
        .split(',')
        .map((email) => email.trim())
        .filter(Boolean);

    const missingKeys: string[] = [];
    if (!from) missingKeys.push('ZOHO_MAIL_FROM');
    if (!user) missingKeys.push('ZOHO_MAIL_USER');
    if (!pass) missingKeys.push('ZOHO_MAIL_PASS');
    if (to.length === 0) missingKeys.push('ZOHO_MAIL_TO');

    return {
        enabled,
        config: {
            host: 'smtp.zoho.com',
            port: 465,
            secure: true,
            user,
            pass,
            from,
            to
        },
        missingKeys
    };
}

function buildEmailSubject(model: DashboardEmailModel): string {
    return `${model.summary.finalEmailStatus} - AdHash Projects Status Dashboard - ${model.generatedAt}`;
}

function logEmailProjectApiSummary(model: DashboardEmailModel, projectId = 'ddp'): void {
    const project = model.projects.find((entry) => entry.id === projectId);

    if (!project) {
        console.log(`[EMAIL] Project ${projectId} not found in render model`);
        return;
    }

    console.log(JSON.stringify({
        project: project.name,
        apis: {
            total: project.results.apis.total,
            passed: project.results.apis.passed,
            failed: project.results.apis.failed
        }
    }, null, 2));
}

export async function sendDashboardSummaryEmail(dashboardPath: string, rootDir = process.cwd()): Promise<DashboardEmailSendResult> {
    const { enabled, config, missingKeys } = parseEmailConfigFromEnv(process.env);

    const previewDir = path.join(rootDir, 'email-preview');
    fs.rmSync(previewDir, { recursive: true, force: true });
    fs.mkdirSync(previewDir, { recursive: true });

    const baseModel = buildDashboardEmailModel(rootDir);
    const latestApiSource = await loadLatestApiSource(rootDir, baseModel);
    const renderModel = applyLatestApiResultsToModel(baseModel, latestApiSource);
    const model = generateModuleReportPages(previewDir, renderModel);
    logEmailProjectApiSummary(model, 'ddp');
    const subject = buildEmailSubject(model);
    const html = buildDashboardEmailHtml(model);
    const previewPath = path.join(previewDir, 'index.html');
    const legacyPreviewPath = path.join(previewDir, 'dashboard-email.html');
    const previewAttachmentPath = path.join(previewDir, 'AdHash-Projects-Dashboard.html');

    console.log('[EMAIL] render source selected: buildDashboardEmailHtml');
    console.log(`[EMAIL] data source used: ${latestApiSource.source}`);
    console.log(`[EMAIL] html length: ${html.length}`);
    console.log({
        totalSuites: model.summary.totalSuites,
        passedSuites: model.summary.successfulSuites,
        failedSuites: model.summary.failedSuites,
        warningSuites: model.summary.warningSuites + model.summary.skippedSuites,
        totalFailedTests: model.summary.totalFailedTests,
        totalWarningTests: model.summary.totalWarningTests,
        totalSkippedTests: model.summary.totalSkippedTests,
        finalEmailStatus: model.summary.finalEmailStatus
    });
    ensureEmailModelMatchesLatestProjectSummary(model, latestApiSource, 'ddp');
    assertEmailMatchesLatestApiSource(model, html, latestApiSource, 'ddp');
    fs.writeFileSync(previewPath, html, 'utf8');
    fs.writeFileSync(legacyPreviewPath, html, 'utf8');
    fs.writeFileSync(previewAttachmentPath, html, 'utf8');
    const { bundleHtmlPath } = createFinalDashboardBundle(rootDir, previewAttachmentPath, path.join(previewDir, 'module-reports'));
    const attachmentPath = bundleHtmlPath;
    console.log(`Dashboard email preview generated at: ${previewPath}`);
    console.log(`[ATTACHMENT] file output path: ${attachmentPath}`);
    console.log(`[ATTACHMENT] html length: ${html.length}`);
    console.log('[ATTACHMENT] source = same-as-email true');
    console.log('[ATTACHMENT] write complete');

    if (!enabled) {
        console.log('Email notifications disabled. Set ZOHO_MAIL_ENABLED=true to enable.');
        return {
            enabled: false,
            sent: false,
            previewPath,
            attachmentPath,
            subject,
            recipients: [],
            missingKeys: []
        };
    }

    console.log('Email notifications enabled');

    if (missingKeys.length > 0) {
        const error = `Missing required email config: ${missingKeys.join(', ')}`;
        console.error(error);
        return {
            enabled: true,
            sent: false,
            previewPath,
            attachmentPath,
            subject,
            recipients: config.to,
            missingKeys,
            error
        };
    }

    try {
        if (config.from !== config.user) {
            throw new Error('Zoho SMTP requires FROM and USER to match');
        }

        console.log('Connecting to SMTP...');
        const transporter = nodemailer.createTransport({
            host: config.host,
            port: config.port,
            secure: config.secure,
            auth: {
                user: config.user,
                pass: config.pass
            }
        });

        console.log('Authenticating...');
        await transporter.verify();

        const info = await transporter.sendMail({
            from: `"AdHash Dashboard" <${config.from}>`,
            to: config.to.join(', '),
            subject,
            html,
            attachments: [{
                filename: 'AdHash-Projects-Dashboard.html',
                path: attachmentPath,
                contentType: 'text/html'
            }]
        });

        console.log('Email sent successfully');
        console.log(`Dashboard email recipients: ${config.to.join(', ')}`);

        return {
            enabled: true,
            sent: true,
            previewPath,
            attachmentPath,
            subject,
            messageId: info.messageId,
            recipients: config.to,
            missingKeys: []
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Dashboard email send failed: ${message}`);
        return {
            enabled: true,
            sent: false,
            previewPath,
            attachmentPath,
            subject,
            recipients: config.to,
            missingKeys: [],
            error: message
        };
    }
}


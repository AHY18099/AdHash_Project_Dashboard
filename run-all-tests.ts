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
const DOMAIN_REPORT_WORKING_DIRECTORY = 'D:\\Automation\\AdHash_Domain_Report_Standalone\\godaddy';
const DOMAIN_REPORT_ENTRY_PATH = path.join(DOMAIN_REPORT_WORKING_DIRECTORY, 'index.js');
const DOMAIN_REPORT_PACKAGE_PATH = path.join(DOMAIN_REPORT_WORKING_DIRECTORY, 'package.json');
const DOMAIN_REPORT_OUTPUT_PATH = path.join(DOMAIN_REPORT_WORKING_DIRECTORY, 'report.html');

type SuiteId = 'app' | 'server' | 'cert' | 'api' | 'domain';

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
  details: unknown[];
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

function parseDomainSuiteReport(reportPath: string, fallbackTotal: number): { passed: number; failed: number; warnings: number; total: number } {
  if (!reportPath || !fs.existsSync(reportPath)) {
    return { passed: 0, failed: 0, warnings: 0, total: fallbackTotal };
  }

  const html = fs.readFileSync(reportPath, 'utf-8');
  const totalMatch = html.match(/<h3 id="totalDomains">(\d+)<\/h3>/i);
  const activeMatch = html.match(/<h3 id="activeDomains">(\d+)<\/h3>/i);
  const expiringMatch = html.match(/<h3 id="expiringDomains"[^>]*>(\d+)<\/h3>/i);
  const errorMatch = html.match(/<h3 id="errorDomains">(\d+)<\/h3>/i);

  return {
    total: totalMatch ? parseInt(totalMatch[1], 10) : fallbackTotal,
    passed: activeMatch ? parseInt(activeMatch[1], 10) : 0,
    warnings: expiringMatch ? parseInt(expiringMatch[1], 10) : 0,
    failed: errorMatch ? parseInt(errorMatch[1], 10) : 0
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
    total: execution.fallbackTotal
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
      total: suiteState.total || 0
    });
  });

  return storedResults;
}

function writeDashboardState(finalResults: TestResult[]): void {
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
      details: [],
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
      : { ...parseUnifiedSuiteReport(reportPath, fallbackTotal), warnings: 0 };
    const status = parsed.failed > 0 ? 'failed' : 'success';

    return {
      repository: definition.repository,
      status,
      duration,
      reportPath,
      passed: parsed.passed || (definition.id === 'domain' ? 0 : parsed.total),
      failed: parsed.failed,
      warnings: parsed.warnings || 0,
      total: parsed.total
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
      : { ...parseUnifiedSuiteReport(reportPath, fallbackTotal), warnings: 0 };

    return {
      repository: definition.repository,
      status: 'failed',
      duration,
      reportPath,
      error: error.message,
      passed: parsed.passed,
      failed: parsed.failed || Math.max(parsed.total - parsed.passed, 1),
      warnings: parsed.warnings || 0,
      total: parsed.total || fallbackTotal
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

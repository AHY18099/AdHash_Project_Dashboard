import * as fs from 'fs';
import * as path from 'path';

const { generateDashboard } = require('./utils/dashboard-generator.ts') as typeof import('./utils/dashboard-generator');
const { sendDashboardSummaryEmail } = require('./utils/email-sender.ts') as typeof import('./utils/email-sender');

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

const dashboardStatePath = path.join(process.cwd(), 'test-results', 'dashboard-state.json');
const suiteMap: Record<string, string> = {
  app: 'Adhash_App_Status',
  server: 'Adhash_AllProjects_Server',
  cert: 'AdHash-Projects-Certificate-Expiry-Test',
  api: 'AdHash-API-Test',
  domain: 'AdHash_Domain_Report'
};

function loadResultsFromState(): TestResult[] {
  if (!fs.existsSync(dashboardStatePath)) {
    return Object.entries(suiteMap).map(([suiteId, repository]) => ({
      repository,
      status: suiteId === 'domain' ? 'unavailable' : 'error',
      duration: 0,
      reportPath: '',
      message: suiteId === 'domain' ? 'Not configured in current workspace' : undefined
    }));
  }

  const state = JSON.parse(fs.readFileSync(dashboardStatePath, 'utf8'));
  return Object.entries(suiteMap).map(([suiteId, repository]) => {
    const suiteState = state.suites?.[suiteId] || {};
    return {
      repository,
      status: suiteState.status === 'passed' ? 'success' : suiteState.status === 'unavailable' ? 'unavailable' : suiteState.status === 'failed' ? 'failed' : 'error',
      duration: suiteState.duration || 0,
      reportPath: suiteState.reportPath || '',
      error: suiteState.message,
      message: suiteState.message,
      passed: suiteState.passed || 0,
      failed: suiteState.failed || 0,
      warnings: suiteState.warning || 0,
      total: suiteState.total || 0
    };
  });
}

async function main(): Promise<void> {
  const results = loadResultsFromState();

  console.log('🔄 Regenerating unified dashboard from workspace state...\n');
  generateDashboard(results, 'unified-dashboard/index.html');
  console.log('\n✅ Dashboard regenerated successfully!');

  const emailResult = await sendDashboardSummaryEmail(path.join(process.cwd(), 'unified-dashboard', 'index.html'));
  if (emailResult.enabled && emailResult.previewPath) {
    console.log(`📧 Dashboard email preview: ${emailResult.previewPath}`);
  }

  if (emailResult.enabled && !emailResult.sent) {
    throw new Error(emailResult.error || 'Email send failed');
  }

  if (emailResult.sent) {
    console.log('EMAIL SENT SUCCESSFULLY');
  }

  console.log('WORKFLOW REPORT GENERATION COMPLETE');
  console.log('RUN COMPLETED');
  process.exit(0);
}

main().catch((error) => {
  console.error('❌ Failed to regenerate dashboard:', error);
  process.exit(1);
});

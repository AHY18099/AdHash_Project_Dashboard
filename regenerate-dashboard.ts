import { generateDashboard } from './utils/dashboard-generator';
import * as fs from 'fs';
import * as path from 'path';

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

const results = loadResultsFromState();

console.log('🔄 Regenerating unified dashboard from workspace state...\n');
generateDashboard(results, 'unified-dashboard/index.html');
console.log('\n✅ Dashboard regenerated successfully!');
console.log('📂 Opening dashboard in browser...\n');

const { exec } = require('child_process');
const openCommand = process.platform === 'win32' ? 'start' :
                    process.platform === 'darwin' ? 'open' : 'xdg-open';
exec(`${openCommand} "unified-dashboard/index.html"`);

import { generateDashboard } from './utils/dashboard-generator';

interface TestResult {
  repository: string;
  status: 'success' | 'failed' | 'error';
  duration: number;
  reportPath: string;
  error?: string;
}

// Use existing test results with actual report paths from source repositories
const results: TestResult[] = [
  {
    repository: 'Adhash_App_Status',
    status: 'success' as const,
    duration: 45000,
    reportPath: 'Adhash_App_Status/custom-reports/Unified_App_Verification_Report.html'
  },
  {
    repository: 'Adhash_AllProjects_Server',
    status: 'success' as const,
    duration: 12000,
    reportPath: 'Adhash_AllProjects_Server/reports/server-health-report-2026-02-06.html'
  },
  {
    repository: 'AdHash-Projects-Certificate-Expiry-Test',
    status: 'success' as const,
    duration: 8000,
    reportPath: 'AdHash-Projects-Certificate-Expiry-Test/reports/certificate-report-2026-02-06.html'
  },
  {
    repository: 'AdHash-API-Test',
    status: 'success' as const,
    duration: 15000,
    reportPath: 'AdHash-API-Test/simple-reports/AdHash_API_Simple_Report_2026-02-04_07-38-17.html'
  }
];

console.log('🔄 Regenerating unified dashboard with embedded reports...\n');
generateDashboard(results, 'unified-dashboard/index.html');
console.log('\n✅ Dashboard regenerated successfully!');
console.log('📂 Opening dashboard in browser...\n');

// Open in browser
const { exec } = require('child_process');
const openCommand = process.platform === 'win32' ? 'start' :
                    process.platform === 'darwin' ? 'open' : 'xdg-open';
exec(`${openCommand} "unified-dashboard/index.html"`);


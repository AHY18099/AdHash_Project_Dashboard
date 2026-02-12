/**
 * Unified Dashboard Generator
 * Creates a beautiful HTML dashboard that links to all repository test reports
 */

import * as fs from 'fs';
import * as path from 'path';

interface TestResult {
  repository: string;
  status: 'success' | 'failed' | 'error';
  duration: number;
  reportPath: string;
  error?: string;
  passed?: number;
  failed?: number;
  warnings?: number;
  total?: number;
}

interface RepoInfo {
  name: string;
  displayName: string;
  description: string;
  icon: string;
  testCount: string;
  technology: string;
}

const repoInfo: Record<string, RepoInfo> = {
  'Adhash_App_Status': {
    name: 'Adhash_App_Status',
    displayName: 'App Status Verification',
    description: 'Play Store & App Store verification with logo comparison',
    icon: '📱',
    testCount: '5 apps × 2 platforms = 10 tests',
    technology: 'TypeScript + Playwright'
  },
  'Adhash_AllProjects_Server': {
    name: 'Adhash_AllProjects_Server',
    displayName: 'Server Health Monitoring',
    description: 'Production server health checks with email alerts',
    icon: '🖥️',
    testCount: '22 servers',
    technology: 'TypeScript + HTTP Requests'
  },
  'AdHash-Projects-Certificate-Expiry-Test': {
    name: 'AdHash-Projects-Certificate-Expiry-Test',
    displayName: 'SSL Certificate Monitoring',
    description: 'SSL certificate expiry checks with 30-day warnings',
    icon: '🔒',
    testCount: '25 certificates',
    technology: 'Java + TestNG'
  },
  'AdHash-API-Test': {
    name: 'AdHash-API-Test',
    displayName: 'API Endpoint Testing',
    description: 'Comprehensive API testing across all projects',
    icon: '🌐',
    testCount: '41 API endpoints',
    technology: 'Java + TestNG'
  }
};

/**
 * Parse test results from report files
 */
function parseTestResults(result: TestResult): { passed: number; failed: number; warnings?: number; total: number; failedTests?: string[]; warningTests?: string[] } {
  try {
    // Check if report path exists (could be relative or absolute)
    let reportPath = result.reportPath;

    // If it's a relative path (starts with 'reports/'), make it absolute
    if (reportPath.startsWith('reports/')) {
      reportPath = path.join('unified-dashboard', reportPath);
    }

    if (!fs.existsSync(reportPath)) {
      return { passed: 0, failed: 0, total: 0 };
    }

    const reportContent = fs.readFileSync(reportPath, 'utf-8');

    // Parse based on repository type
    if (result.repository === 'Adhash_App_Status') {
      // Parse Playwright custom report - HTML format
      const passedMatch = reportContent.match(/<div class="stat-number">(\d+)<\/div>\s*<div class="stat-label">Passed<\/div>/i);
      const failedMatch = reportContent.match(/<div class="stat-number">(\d+)<\/div>\s*<div class="stat-label">Failed<\/div>/i);
      const passed = passedMatch ? parseInt(passedMatch[1]) : 0;
      const failed = failedMatch ? parseInt(failedMatch[1]) : 0;
      return { passed, failed, total: passed + failed };
    }

    if (result.repository === 'Adhash_AllProjects_Server') {
      // Parse server health report - HTML format
      const healthyMatch = reportContent.match(/<div class="label">Healthy Servers<\/div>\s*<div class="count">(\d+)<\/div>/i);
      const unhealthyMatch = reportContent.match(/<div class="label">Unhealthy Servers<\/div>\s*<div class="count">(\d+)<\/div>/i);
      const downMatch = reportContent.match(/<div class="label">Down Servers<\/div>\s*<div class="count">(\d+)<\/div>/i);

      const healthy = healthyMatch ? parseInt(healthyMatch[1]) : 0;
      const unhealthy = unhealthyMatch ? parseInt(unhealthyMatch[1]) : 0;
      const down = downMatch ? parseInt(downMatch[1]) : 0;

      // Extract failed server names (down servers only)
      const failedServers: string[] = [];
      const downServerMatches = reportContent.matchAll(/<div class="server-card inactive">[\s\S]*?<div class="server-name">([^<]+)<\/div>/gi);
      for (const match of downServerMatches) {
        failedServers.push(`🚨 ${match[1].trim()} (Down - Not Responding)`);
      }

      // Extract unhealthy servers with response codes (warnings)
      const warningServers: string[] = [];
      const unhealthyServerMatches = reportContent.matchAll(/<div class="server-card (?:active|unhealthy)">[\s\S]*?<span class="server-icon">⚠️<\/span>[\s\S]*?<div class="server-name">([^<]+)<\/div>[\s\S]*?<span class="detail-label">Response:<\/span>\s*<span class="detail-value">([^<]+)<\/span>/gi);
      for (const match of unhealthyServerMatches) {
        const serverName = match[1].trim();
        const responseCode = match[2].trim();
        warningServers.push(`⚠️ ${serverName} - Response: ${responseCode}`);
      }

      return {
        passed: healthy,
        failed: down,
        warnings: unhealthy,
        total: healthy + unhealthy + down,
        failedTests: failedServers,
        warningTests: warningServers
      };
    }

    if (result.repository === 'AdHash-Projects-Certificate-Expiry-Test') {
      // Parse certificate report - HTML format
      const totalMatch = reportContent.match(/<div class='number'>(\d+)<\/div><div class='label'>Total Tests<\/div>/i);
      const passedMatch = reportContent.match(/<div class='number'>✓\s*(\d+)<\/div><div class='label'>Passed<\/div>/i);
      const failedMatch = reportContent.match(/<div class='number'>✗\s*(\d+)<\/div><div class='label'>Failed<\/div>/i);

      const total = totalMatch ? parseInt(totalMatch[1]) : 0;
      const passed = passedMatch ? parseInt(passedMatch[1]) : 0;
      const totalFailed = failedMatch ? parseInt(failedMatch[1]) : 0;

      // Extract certificates: expired (=0 days) vs expiring soon (>0 and ≤30 days)
      const warningCerts: string[] = [];
      const failedCerts: string[] = [];

      // Match all failed rows (row-failed class)
      const failedRowMatches = reportContent.matchAll(/<tr class='row-failed'>[\s\S]*?<td>(\d+)<\/td>[\s\S]*?<td>([^<]+)<\/td>[\s\S]*?<td>([^<]+)<\/td>[\s\S]*?<td>(\d+)\s*days<\/td>[\s\S]*?<td>([^<]+)<\/td>/gi);

      for (const match of failedRowMatches) {
        const projectName = match[2].trim();
        const url = match[3].trim();
        const daysRemaining = parseInt(match[4]);
        const expiryDate = match[5].trim();

        if (daysRemaining === 0) {
          // Expired certificate (=0 days) - FAILURE
          failedCerts.push(`🚨 ${projectName} - Expired (0 days) - ${expiryDate}`);
        } else if (daysRemaining > 0 && daysRemaining <= 30) {
          // Expiring soon (>0 and ≤30 days) - WARNING
          warningCerts.push(`⚠️ ${projectName} - Expires in ${daysRemaining} days - ${expiryDate}`);
        }
      }

      return {
        passed,
        failed: failedCerts.length,
        warnings: warningCerts.length,
        total,
        failedTests: failedCerts,
        warningTests: warningCerts
      };
    }

    if (result.repository === 'AdHash-API-Test') {
      // Parse API test report - HTML format
      const totalMatch = reportContent.match(/<div class="stat-number">(\d+)<\/div><div class="stat-label">Total Tests<\/div>/i);
      const passedMatch = reportContent.match(/<div class="stat-number">✓\s*(\d+)<\/div><div class="stat-label">Passed<\/div>/i);
      const failedMatch = reportContent.match(/<div class="stat-number">✗\s*(\d+)<\/div><div class="stat-label">Failed<\/div>/i);

      const total = totalMatch ? parseInt(totalMatch[1]) : 0;
      const passed = passedMatch ? parseInt(passedMatch[1]) : 0;
      const failed = failedMatch ? parseInt(failedMatch[1]) : 0;

      // Extract failed test names from table rows
      const failedTests: string[] = [];
      // Match full rows with status-fail
      const rowMatches = reportContent.matchAll(/<tr>[\s\S]*?<td class="status-fail">.*?Failed<\/td>[\s\S]*?<\/tr>/gi);
      for (const match of rowMatches) {
        // Extract project name and function from the row
        const projectMatch = match[0].match(/<td class="sno">\d+<\/td>\s*<td>([^<]+)<\/td>/);
        const functionMatch = match[0].match(/<span class="function-tag">([^<]+)<\/span>/);

        if (projectMatch && functionMatch) {
          const projectName = projectMatch[1].trim();
          const functionName = functionMatch[1].trim();
          failedTests.push(`${projectName} - ${functionName}`);
        }
      }

      return { passed, failed, total, failedTests };
    }

    return { passed: 0, failed: 0, total: 0 };
  } catch (error) {
    console.error(`Error parsing results for ${result.repository}:`, error);
    return { passed: 0, failed: 0, total: 0 };
  }
}

export function generateDashboard(results: TestResult[], outputPath: string = 'unified-dashboard/index.html'): void {
  const timestamp = new Date().toLocaleString();
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  // Create reports directory inside unified-dashboard
  const dashboardDir = path.dirname(outputPath);
  const reportsDir = path.join(dashboardDir, 'reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  // Create a README file in reports directory to ensure it's never empty
  const readmePath = path.join(reportsDir, 'README.txt');
  fs.writeFileSync(readmePath, 'This folder contains HTML report files from test executions.\nIf this folder is empty, it means no test reports were generated.\n');

  // Read report files and embed content
  console.log('\n📁 Reading report files to embed content...');
  console.log(`📂 Current working directory: ${process.cwd()}`);

  results.forEach(result => {
    console.log(`\n🔍 Processing ${result.repository}:`);
    console.log(`   Status: ${result.status}`);
    console.log(`   Report path from result: ${result.reportPath || 'NOT SET'}`);

    if (result.reportPath) {
      // Convert relative path to absolute path
      const absoluteReportPath = path.isAbsolute(result.reportPath)
        ? result.reportPath
        : path.join(process.cwd(), result.reportPath);

      console.log(`   Relative path: ${result.reportPath}`);
      console.log(`   Absolute path: ${absoluteReportPath}`);

      const exists = fs.existsSync(absoluteReportPath);
      console.log(`   File exists: ${exists}`);

      if (!exists) {
        // Try to list the directory to see what's there
        const dir = path.dirname(absoluteReportPath);
        console.log(`   Checking parent directory: ${dir}`);
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir);
          console.log(`   Files in directory: ${files.join(', ')}`);
        } else {
          console.log(`   Parent directory does not exist!`);
        }
      }

      if (exists) {
        try {
          // Read the HTML content
          const reportContent = fs.readFileSync(absoluteReportPath, 'utf-8');
          (result as any).reportContent = reportContent;
          console.log(`   ✅ Embedded report content (${reportContent.length} bytes)`);
        } catch (error) {
          console.error(`   ❌ Error reading report for ${result.repository}:`, error);
          (result as any).reportContent = '';
        }
      } else {
        console.log(`   ⚠️  Report file not found - will show "Report Not Available"`);
        (result as any).reportContent = '';
      }
    } else {
      console.log(`   ⚠️  No report path provided - will show "Report Not Available"`);
      (result as any).reportContent = '';
    }
  });
  console.log('\n✅ Report embedding complete!\n');



  // Parse test results from reports
  results.forEach(result => {
    const parsed = parseTestResults(result);
    result.passed = parsed.passed;
    result.failed = parsed.failed;
    result.total = parsed.total;

    // Update actual status based on test results
    if (result.total > 0 && result.failed > 0) {
      result.status = 'failed';
    } else if (result.total > 0 && result.failed === 0) {
      result.status = 'success';
    }
  });

  // Calculate success/failed counts AFTER updating status based on actual test results
  const successCount = results.filter(r => r.status === 'success').length;
  const failedCount = results.filter(r => r.status === 'failed').length;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AdHash Unified Test Dashboard</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px 20px 60px 20px;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
        }

        .top-section {
            margin-bottom: 30px;
        }

        .bottom-section {
            margin-top: 40px;
            padding-top: 30px;
            border-top: 2px solid rgba(255, 255, 255, 0.2);
        }

        .header {
            background: white;
            border-radius: 20px;
            padding: 40px;
            margin-bottom: 30px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.1);
        }

        .header h1 {
            font-size: 42px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 10px;
            text-align: center;
        }

        .header .subtitle {
            color: #666;
            font-size: 18px;
            margin-bottom: 20px;
        }

        .summary {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-top: 20px;
        }

        .summary-card {
            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
            padding: 20px;
            border-radius: 15px;
            text-align: center;
        }

        .summary-card .value {
            font-size: 36px;
            font-weight: bold;
            color: #333;
            margin-bottom: 5px;
        }

        .summary-card .label {
            color: #666;
            font-size: 14px;
            text-transform: uppercase;
            letter-spacing: 1px;
        }

        .summary-card.success .value { color: #10b981; }
        .summary-card.failed .value { color: #ef4444; }
        .summary-card.duration .value { color: #3b82f6; }

        .reports-grid {
            display: flex;
            flex-direction: column;
            gap: 16px;
            margin-top: 30px;
        }

        .report-card {
            background: white;
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
            transition: all 0.3s ease;
            position: relative;
            overflow: hidden;
            border-left: 4px solid #667eea;
        }

        .report-card:hover {
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
        }

        .report-card.success {
            border-left-color: #10b981;
        }

        .report-card.failed {
            border-left-color: #ef4444;
        }

        .report-card-main {
            display: grid;
            grid-template-columns: 1fr auto;
            gap: 20px;
            padding: 20px 24px;
            align-items: center;
            position: relative;
        }

        .report-icon-section {
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .report-icon {
            font-size: 42px;
            filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.1));
        }

        .report-info-section {
            display: flex;
            flex-direction: column;
            gap: 8px;
            min-width: 0;
        }

        .report-header-row {
            display: flex;
            align-items: center;
            gap: 12px;
            flex-wrap: wrap;
        }

        .report-title {
            font-size: 18px;
            font-weight: 700;
            color: #1f2937;
            margin: 0;
        }

        .report-status {
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
            white-space: nowrap;
        }

        .report-status.success {
            background: #d1fae5;
            color: #065f46;
        }

        .report-status.failed {
            background: #fee2e2;
            color: #991b1b;
        }

        .report-description {
            color: #6b7280;
            font-size: 13px;
            line-height: 1.5;
            margin: 0;
        }

        .report-meta {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-top: 4px;
        }

        .meta-badge {
            background: #f3f4f6;
            padding: 4px 10px;
            border-radius: 6px;
            font-size: 11px;
            color: #4b5563;
            font-weight: 500;
            white-space: nowrap;
        }

        .report-status {
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
            white-space: nowrap;
        }

        .report-status.success {
            background: #d1fae5;
            color: #065f46;
        }

        .report-status.failed {
            background: #fee2e2;
            color: #991b1b;
        }

        .report-stats-section {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .stats-group {
            display: flex;
            gap: 10px;
            align-items: center;
        }

        .stat-item {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 6px 12px;
            background: #f9fafb;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 600;
            white-space: nowrap;
        }

        .stat-item.total {
            color: #3b82f6;
        }

        .stat-item.passed {
            color: #10b981;
        }

        .stat-item.warning {
            color: #f59e0b;
        }

        .stat-item.failed {
            color: #ef4444;
        }

        .view-report-btn {
            display: inline-block;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 12px 30px;
            border-radius: 25px;
            text-decoration: none;
            font-weight: bold;
            transition: opacity 0.3s ease;
        }

        .view-report-btn:hover {
            opacity: 0.9;
        }

        .view-report-btn.disabled {
            background: #9ca3af;
            cursor: not-allowed;
        }

        .footer {
            text-align: center;
            color: white;
            margin-top: 40px;
            padding: 20px;
        }

        .error-message {
            background: #fee2e2;
            color: #991b1b;
            padding: 10px;
            border-radius: 10px;
            margin-top: 10px;
            font-size: 12px;
        }

        .test-counts {
            display: flex;
            gap: 15px;
            margin: 15px 0;
            flex-wrap: wrap;
        }

        .count-badge {
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 13px;
            font-weight: bold;
            display: inline-flex;
            align-items: center;
            gap: 5px;
        }

        .count-badge.total {
            background: #e0e7ff;
            color: #3730a3;
        }

        .count-badge.passed {
            background: #d1fae5;
            color: #065f46;
        }

        .count-badge.failed {
            background: #fee2e2;
            color: #991b1b;
        }

        .failed-tests {
            background: #fef2f2;
            border-left: 4px solid #ef4444;
            padding: 12px 16px;
            border-radius: 8px;
            margin: 12px 24px 0 24px;
        }

        .failed-tests-title {
            font-weight: bold;
            color: #991b1b;
            margin-bottom: 8px;
            font-size: 13px;
        }

        .failed-test-item {
            color: #7f1d1d;
            font-size: 12px;
            padding: 4px 0;
            padding-left: 16px;
            position: relative;
        }

        .failed-test-item::before {
            content: '•';
            position: absolute;
            left: 4px;
            color: #ef4444;
        }

        .warning-tests {
            background: #fffbeb;
            border-left: 4px solid #f59e0b;
            padding: 12px 16px;
            border-radius: 8px;
            margin: 12px 24px 0 24px;
        }

        .warning-tests-title {
            font-weight: bold;
            color: #92400e;
            margin-bottom: 8px;
            font-size: 13px;
        }

        .warning-test-item {
            color: #78350f;
            font-size: 12px;
            padding: 4px 0;
            padding-left: 16px;
            position: relative;
        }

        .warning-test-item::before {
            content: '•';
            position: absolute;
            left: 4px;
            color: #f59e0b;
        }

        .expand-btn {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 8px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 600;
            position: absolute;
            bottom: 20px;
            right: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            transition: all 0.3s ease;
        }

        .expand-btn:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
        }

        .expand-btn.disabled {
            background: #9ca3af;
            cursor: not-allowed;
            opacity: 0.6;
        }

        .expand-btn.disabled:hover {
            transform: none;
            box-shadow: none;
        }

        .detailed-report-container {
            display: none;
            margin: 60px 24px 16px 24px;
            border: 2px solid #e5e7eb;
            border-radius: 12px;
            overflow: hidden;
            background: white;
        }

        .detailed-report-container.expanded {
            display: block;
        }

        .detailed-report-header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 16px 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .detailed-report-header h3 {
            margin: 0;
            font-size: 16px;
            font-weight: 600;
        }

        .collapse-btn {
            background: rgba(255, 255, 255, 0.2);
            border: 1px solid rgba(255, 255, 255, 0.3);
            color: white;
            padding: 6px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            transition: all 0.2s ease;
        }

        .collapse-btn:hover {
            background: rgba(255, 255, 255, 0.3);
        }

        .detailed-report-content {
            padding: 0;
            max-height: 600px;
            overflow-y: auto;
        }

        .detailed-report-content iframe {
            width: 100%;
            min-height: 600px;
            border: none;
        }

        .arrow-icon {
            transition: transform 0.3s ease;
        }

        .expand-btn.expanded .arrow-icon {
            transform: rotate(180deg);
        }

        .report-card-content {
            padding-bottom: 60px;
            position: relative;
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- TOP SECTION -->
        <div class="top-section">
            <div class="header">
                <h1>Ad-Hash Projects Status Dashboard</h1>
                <div class="subtitle">Comprehensive test results from all repositories</div>
                <div class="subtitle">Generated: ${timestamp}</div>

                <div class="summary">
                    <div class="summary-card success">
                        <div class="value">${successCount}</div>
                        <div class="label">Successful</div>
                    </div>
                    <div class="summary-card failed">
                        <div class="value">${failedCount}</div>
                        <div class="label">Failed</div>
                    </div>
                    <div class="summary-card">
                        <div class="value">${results.length}</div>
                        <div class="label">Total Suites</div>
                    </div>
                    <div class="summary-card duration">
                        <div class="value">${(totalDuration / 1000).toFixed(1)}s</div>
                        <div class="label">Total Duration</div>
                    </div>
                </div>
            </div>
        </div>

        <!-- MAIN SECTION - TEST RESULTS -->
        <div class="reports-grid">
${results.map(result => generateReportCard(result)).join('\n')}
        </div>

        <!-- BOTTOM SECTION -->
        <div class="bottom-section">
            <div class="footer">
                <p>Ad-Hash Technolabs Pvt Ltd - Automated Test Monitoring System</p>
                <p style="margin-top: 10px; opacity: 0.8;">All tests executed from original repositories</p>
            </div>
        </div>
    </div>

    <script>
        function toggleReport(repoId) {
            const container = document.getElementById('report-' + repoId);
            const btn = document.getElementById('btn-' + repoId);

            if (container.classList.contains('expanded')) {
                container.classList.remove('expanded');
                btn.classList.remove('expanded');
                btn.innerHTML = '<span>📄 View Detailed Report</span><span class="arrow-icon">▼</span>';
            } else {
                container.classList.add('expanded');
                btn.classList.add('expanded');
                btn.innerHTML = '<span>📄 Hide Detailed Report</span><span class="arrow-icon">▲</span>';
            }
        }

        function collapseReport(repoId) {
            const container = document.getElementById('report-' + repoId);
            const btn = document.getElementById('btn-' + repoId);

            container.classList.remove('expanded');
            btn.classList.remove('expanded');
            btn.innerHTML = '<span>📄 View Detailed Report</span><span class="arrow-icon">▼</span>';
        }
    </script>
</body>
</html>`;

  // Create output directory if it doesn't exist
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write the HTML file
  fs.writeFileSync(outputPath, html, 'utf-8');
  console.log(`✅ Dashboard generated: ${outputPath}`);
}

function generateReportCard(result: TestResult): string {
  const info = repoInfo[result.repository];
  if (!info) return '';

  const duration = (result.duration / 1000).toFixed(2);

  // Parse test results from report
  const parsed = parseTestResults(result);
  const { passed, failed, warnings, total, failedTests, warningTests } = parsed;

  // Determine actual status based on test results
  // If we have test results, use them to determine status
  // Otherwise, fall back to the command execution status
  let actualStatus = result.status;
  if (total > 0 && failed > 0) {
    actualStatus = 'failed';
  } else if (total > 0 && failed === 0) {
    actualStatus = 'success';
  }

  const statusClass = actualStatus === 'success' ? 'success' : 'failed';
  const statusText = actualStatus === 'success' ? '✅ Passed' : '❌ Failed';

  // Generate test counts HTML
  let testCountsHtml = '';
  if (total > 0) {
    testCountsHtml = `
                <div class="test-counts">
                    <span class="count-badge total">📊 Total: ${total}</span>
                    <span class="count-badge passed">✅ Passed: ${passed}</span>
                    ${warnings && warnings > 0 ? `<span class="count-badge" style="background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);">⚠️ Warnings: ${warnings}</span>` : ''}
                    ${failed > 0 ? `<span class="count-badge failed">❌ Failed: ${failed}</span>` : ''}
                </div>`;
  }

  // Generate warning tests details HTML
  let warningTestsHtml = '';
  if (warningTests && warningTests.length > 0) {
    const warningTestsList = warningTests.map(test => `
                        <div class="warning-test-item">${test}</div>`).join('');

    // Determine title based on repository type
    let warningTitle = '⚠️ Warnings:';
    if (result.repository === 'Adhash_AllProjects_Server') {
      warningTitle = '⚠️ Unhealthy Servers (Warnings):';
    } else if (result.repository === 'AdHash-Projects-Certificate-Expiry-Test') {
      warningTitle = '⚠️ Certificates Expiring Soon (≤30 days):';
    }

    warningTestsHtml = `
                <div class="warning-tests">
                    <div class="warning-tests-title">${warningTitle}</div>
                    ${warningTestsList}
                </div>`;
  }

  // Generate failed tests details HTML
  let failedTestsHtml = '';
  if (failedTests && failedTests.length > 0) {
    const failedTestsList = failedTests.map(test => `
                        <div class="failed-test-item">${test}</div>`).join('');

    // Determine title based on repository type
    let failedTitle = '❌ Failed Tests:';
    if (result.repository === 'Adhash_AllProjects_Server') {
      failedTitle = '❌ Down Servers (Failed):';
    } else if (result.repository === 'AdHash-Projects-Certificate-Expiry-Test') {
      failedTitle = '❌ Expired Certificates (Failed):';
    }

    failedTestsHtml = `
                <div class="failed-tests">
                    <div class="failed-tests-title">${failedTitle}</div>
                    ${failedTestsList}
                </div>`;
  }

  // Generate unique ID for this report
  const repoId = result.repository.replace(/[^a-zA-Z0-9]/g, '_');
  const reportContent = (result as any).reportContent || '';
  const hasReport = reportContent.length > 0;

  // Create embedded report HTML
  let embeddedReportHtml = '';
  if (hasReport) {
    // Use data URI with base64 encoding for better compatibility
    const base64Content = Buffer.from(reportContent, 'utf-8').toString('base64');
    const dataUri = `data:text/html;base64,${base64Content}`;

    embeddedReportHtml = `
                <button class="expand-btn" id="btn-${repoId}" onclick="toggleReport('${repoId}')">
                    <span>📄 View Detailed Report</span>
                    <span class="arrow-icon">▼</span>
                </button>

                <div class="detailed-report-container" id="report-${repoId}">
                    <div class="detailed-report-header">
                        <h3>📊 Detailed Test Report - ${info.displayName}</h3>
                        <button class="collapse-btn" onclick="collapseReport('${repoId}')">✕ Close</button>
                    </div>
                    <div class="detailed-report-content">
                        <iframe src="${dataUri}"></iframe>
                    </div>
                </div>`;
  } else {
    embeddedReportHtml = `
                <button class="expand-btn disabled" disabled>
                    <span>📄 Report Not Available</span>
                </button>`;
  }

  // Create stats HTML for horizontal display
  const statsHtml = total > 0 ? `
                    <div class="report-stats-section">
                        <div class="stats-group">
                            <div class="stat-item total">📊 ${total}</div>
                            <div class="stat-item passed">✅ ${passed}</div>
                            ${(warnings || 0) > 0 ? `<div class="stat-item warning">⚠️ ${warnings}</div>` : ''}
                            ${failed > 0 ? `<div class="stat-item failed">❌ ${failed}</div>` : ''}
                        </div>
                    </div>` : '';

  return `            <div class="report-card ${statusClass}">
                <div class="report-card-content">
                    <div class="report-card-main">
                        <div class="report-info-section">
                            <div class="report-header-row">
                                <div class="report-title">${info.displayName}</div>
                                <div class="report-status ${statusClass}">${statusText}</div>
                            </div>
                            <div class="report-description">${info.description}</div>
                            <div class="report-meta">
                                <span class="meta-badge">📊 ${info.testCount}</span>
                                <span class="meta-badge">⚙️ ${info.technology}</span>
                                <span class="meta-badge">⏱️ ${duration}s</span>
                            </div>
                        </div>

                        ${statsHtml}
                    </div>

                    ${warningTestsHtml}

                    ${failedTestsHtml}

                    ${embeddedReportHtml}
                </div>
            </div>`;
}


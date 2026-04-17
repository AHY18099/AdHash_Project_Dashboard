/**
 * Unified Dashboard Generator
 * Creates a beautiful HTML dashboard that links to all repository test reports
 */

import * as fs from 'fs';
import * as path from 'path';
import { buildDashboardRenderModel, type EmailItem, type ModuleSection, type ProjectEmailCard } from './email-sender';

const EXPIRY_WARNING_DAYS = 30;

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
  },
  'AdHash_Domain_Report': {
    name: 'AdHash_Domain_Report',
    displayName: 'Domain Expiry Monitoring',
    description: 'WHOIS-based domain expiry tracking with 30-day warnings',
    icon: '🌐',
    testCount: '12 domains',
    technology: 'Node.js + WHOIS'
  }
};

function parseDaysRemaining(value?: string | null): number | null {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(/-?\d+/);
  if (!match) {
    return null;
  }

  const days = parseInt(match[0], 10);
  return Number.isNaN(days) ? null : days;
}

function classifyExpiryStatus(daysRemaining: number | null | undefined, hasError = false): 'passed' | 'warning' | 'failed' {
  if (hasError || daysRemaining === null || daysRemaining === undefined || Number.isNaN(daysRemaining)) {
    return 'failed';
  }

  if (daysRemaining <= 0) {
    return 'failed';
  }

  if (daysRemaining <= EXPIRY_WARNING_DAYS) {
    return 'warning';
  }

  return 'passed';
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function summarizeText(value: string | undefined, maxLength = 180): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function getStatusClass(status: string): string {
  return status === 'failed' ? 'failed' : status === 'warning' ? 'warning' : 'passed';
}

function getStatusLabel(status: string): string {
  return status === 'failed' ? 'FAILED' : status === 'warning' ? 'WARNING' : 'PASSED';
}

function renderProjectChip(label: string, value: number, className: string): string {
  return `<span class="project-chip ${className}">${escapeHtml(label)} ${value}</span>`;
}

function renderProjectSummaryCard(project: ProjectEmailCard): string {
  const statusClass = getStatusClass(project.overallStatus);

  return `<article class="project-summary-card ${statusClass}">
            <div class="project-summary-header">
                <div>
                    <h3>${escapeHtml(project.name)}</h3>
                    <p>${escapeHtml(project.description)}</p>
                </div>
                <span class="summary-status-badge ${statusClass}">${escapeHtml(getStatusLabel(project.overallStatus))}</span>
            </div>
            <div class="project-summary-chips">
                ${renderProjectChip('APP', project.results.apps.total, 'app')}
                ${renderProjectChip('SRV', project.results.servers.total, 'server')}
                ${renderProjectChip('SSL', project.results.ssl.total, 'ssl')}
                ${renderProjectChip('DOM', project.results.domains.total, 'domain')}
                ${renderProjectChip('API', project.results.apis.total, 'api')}
            </div>
        </article>`;
}

function renderDetailField(label: string, value: unknown): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return '';
  }

  return `<div class="detail-field"><span class="detail-label">${escapeHtml(label)}</span><span class="detail-value">${escapeHtml(normalized)}</span></div>`;
}

function renderWideDetailField(label: string, value: unknown): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return '';
  }

  return `<div class="detail-field wide"><span class="detail-label">${escapeHtml(label)}</span><span class="detail-value">${escapeHtml(normalized)}</span></div>`;
}

function renderModuleItemCard(sectionId: ModuleSection['id'], item: EmailItem): string {
  const statusClass = getStatusClass(item.status);
  const fields: string[] = [renderWideDetailField('Project', item.projectName)];

  if (sectionId === 'app') {
    fields.push(renderDetailField('Store', item.platform));
    fields.push(renderWideDetailField('URL', item.url));
    fields.push(renderDetailField('Status', getStatusLabel(item.status)));
    fields.push(renderWideDetailField('Failure Reason', item.reason));
  } else if (sectionId === 'cert') {
    fields.push(renderWideDetailField('URL', item.url));
    fields.push(renderDetailField('Certificate Status', getStatusLabel(item.status)));
    fields.push(renderDetailField('Expiry Date UTC', item.expiryDate));
    fields.push(renderDetailField('Expiry Date IST', item.expiryDateIST));
    fields.push(renderDetailField('Days Remaining', item.daysRemaining));
  } else if (sectionId === 'server') {
    fields.push(renderWideDetailField('URL', item.url));
    fields.push(renderDetailField('Status', getStatusLabel(item.status)));
    fields.push(renderDetailField('Duration', item.durationLabel));
    fields.push(renderWideDetailField('Error Details', item.reason));
  } else if (sectionId === 'domain') {
    fields.push(renderWideDetailField('Domain / URL', item.url || item.name));
    fields.push(renderDetailField('Status', getStatusLabel(item.status)));
    fields.push(renderDetailField('Expiry Date UTC', item.expiryDate));
    fields.push(renderDetailField('Expiry Date IST', item.expiryDateIST));
    fields.push(renderDetailField('Days Remaining', item.daysRemaining));
  } else if (sectionId === 'api') {
    fields.push(renderDetailField('Method', item.method));
    fields.push(renderWideDetailField('URL', item.url));
    fields.push(renderDetailField('Status Code', item.responseCode));
    fields.push(renderWideDetailField('Request Summary', summarizeText(item.requestBody)));
    fields.push(renderWideDetailField('Response Summary', summarizeText(item.responseBody)));
    fields.push(renderWideDetailField('Failure Details', item.reason));
  }

  return `<article class="module-detail-card ${statusClass}">
            <div class="module-detail-header">
                <div>
                    <h4>${escapeHtml(item.name)}</h4>
                    <p>${escapeHtml(item.projectName)}</p>
                </div>
                <span class="module-item-status ${statusClass}">${escapeHtml(getStatusLabel(item.status))}</span>
            </div>
            <div class="module-detail-grid">
                ${fields.filter(Boolean).join('')}
            </div>
        </article>`;
}

function renderModuleCountBadge(label: string, value: number | string, className: string): string {
  return `<span class="module-count-badge ${className}">${escapeHtml(label)} ${value}</span>`;
}

function renderModuleSection(section: ModuleSection): string {
  const statusClass = getStatusClass(section.status);
  const detailCards = section.items.length > 0
    ? section.items.map((item) => renderModuleItemCard(section.id, item)).join('')
    : '<div class="module-empty-state">No structured items were available for this module in the current dashboard state.</div>';

  return `<section class="module-section-card ${statusClass}">
            <div class="module-section-header">
                <div>
                    <div class="module-title-row">
                        <h2>${escapeHtml(section.icon)} ${escapeHtml(section.title)}</h2>
                        <span class="summary-status-badge ${statusClass}">${escapeHtml(getStatusLabel(section.status))}</span>
                    </div>
                    <div class="module-count-row">
                        ${renderModuleCountBadge('PASS', section.passed, 'passed')}
                        ${renderModuleCountBadge('WARN', section.warning, 'warning')}
                        ${renderModuleCountBadge('FAIL', section.failed, 'failed')}
                        ${renderModuleCountBadge('TOTAL', section.total, 'total')}
                        ${renderModuleCountBadge('DURATION', section.durationLabel, 'duration')}
                    </div>
                </div>
                <button class="module-toggle-btn" id="module-btn-${escapeHtml(section.id)}" type="button" aria-expanded="false" aria-controls="module-details-${escapeHtml(section.id)}" onclick="toggleModuleSection('${escapeHtml(section.id)}')">
                    <span class="toggle-text">View Details</span>
                    <span class="toggle-icon">▼</span>
                </button>
            </div>
            <div class="module-section-details" id="module-details-${escapeHtml(section.id)}">
                <div class="module-details-grid">
                    ${detailCards}
                </div>
            </div>
        </section>`;
}

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
        const daysRemaining = parseDaysRemaining(match[4]);
        const expiryDate = match[5].trim();
        const status = classifyExpiryStatus(daysRemaining);

        if (status === 'failed') {
          failedCerts.push(`🚨 ${projectName} - Expired or invalid certificate - ${expiryDate}`);
        } else if (status === 'warning') {
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

    if (result.repository === 'AdHash_Domain_Report') {
      // Parse domain report - HTML format
      const totalMatch = reportContent.match(/<h3 id="totalDomains">(\d+)<\/h3>/i);
      const activeMatch = reportContent.match(/<h3 id="activeDomains">(\d+)<\/h3>/i);

      const total = totalMatch ? parseInt(totalMatch[1]) : 0;
      const activeFallback = activeMatch ? parseInt(activeMatch[1]) : 0;

      const warningDomains: string[] = [];
      const failedDomains: string[] = [];
      const domainCardMatches = reportContent.matchAll(/<div class="domain-card([^"]*)"[\s\S]*?<div class="domain-name">([^<]+)<\/div>[\s\S]*?<div class="domain-url">([^<]+)<\/div>[\s\S]*?<div class="expiry-date">([^<]+)<\/div>(?:[\s\S]*?<div class="days-remaining[^"]*">([^<]+)<\/div>)?/gi);

      for (const match of domainCardMatches) {
        const classNames = match[1] || '';
        const domainName = match[2].trim();
        const domainUrl = match[3].trim();
        const expiryDate = match[4].trim();
        const daysRemaining = parseDaysRemaining(match[5]);
        const status = classifyExpiryStatus(daysRemaining, classNames.includes('error'));

        if (status === 'warning') {
          warningDomains.push(`⚠️ ${domainName} (${domainUrl}) - Expires in ${daysRemaining} days - ${expiryDate}`);
        } else if (status === 'failed') {
          failedDomains.push(`🚨 ${domainName} (${domainUrl}) - ${expiryDate}`);
        }
      }

      const warnings = warningDomains.length;
      const failed = failedDomains.length;
      const passed = total > 0 ? Math.max(total - warnings - failed, 0) : activeFallback;

      return {
        passed,
        failed,
        warnings,
        total: total || passed + warnings + failed,
        failedTests: failedDomains,
        warningTests: warningDomains
      };
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
  const renderModel = buildDashboardRenderModel(process.cwd());

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
    const parsed = typeof result.total === 'number'
      ? {
          passed: result.passed || 0,
          failed: result.failed || 0,
          warnings: result.warnings,
          total: result.total || 0,
          failedTests: undefined,
          warningTests: undefined
        }
      : parseTestResults(result);
    result.passed = parsed.passed;
    result.failed = parsed.failed;
    result.warnings = parsed.warnings;
    result.total = parsed.total;

    // Update actual status based on test results
    if (result.status !== 'unavailable' && result.total > 0 && result.failed > 0) {
      result.status = 'failed';
    } else if (result.status !== 'unavailable' && result.total > 0 && result.failed === 0) {
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
          background: radial-gradient(circle at top, #1e3a8a 0%, #0f172a 42%, #020617 100%);
            min-height: 100vh;
            padding: 20px 20px 60px 20px;
          color: #e2e8f0;
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
          background: linear-gradient(135deg, rgba(15, 23, 42, 0.96), rgba(30, 41, 59, 0.92));
            border-radius: 20px;
            padding: 40px;
            margin-bottom: 30px;
          box-shadow: 0 24px 80px rgba(2, 6, 23, 0.35);
          border: 1px solid rgba(96, 165, 250, 0.25);
        }

        .header h1 {
            font-size: 42px;
          background: linear-gradient(135deg, #93c5fd 0%, #c4b5fd 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 10px;
            text-align: center;
        }

        .header .subtitle {
          color: #cbd5e1;
            font-size: 18px;
            margin-bottom: 20px;
          text-align: center;
        }

        .summary {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-top: 20px;
        }

        .summary-card {
          background: linear-gradient(180deg, rgba(15, 23, 42, 0.88), rgba(30, 41, 59, 0.95));
            padding: 20px;
            border-radius: 15px;
            text-align: center;
          border: 1px solid rgba(148, 163, 184, 0.12);
        }

        .summary-card .value {
            font-size: 36px;
            font-weight: bold;
            color: #f8fafc;
            margin-bottom: 5px;
        }

        .summary-card .label {
            color: #94a3b8;
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
          gap: 24px;
            margin-top: 30px;
        }

        .project-summary-section,
        .module-dashboard-section {
          background: rgba(15, 23, 42, 0.84);
          border: 1px solid rgba(148, 163, 184, 0.12);
          border-radius: 24px;
          padding: 24px;
          box-shadow: 0 24px 60px rgba(2, 6, 23, 0.22);
        }

        .section-heading {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 16px;
          margin-bottom: 20px;
        }

        .section-heading h2 {
          margin: 0;
          font-size: 28px;
          color: #f8fafc;
        }

        .section-heading p {
          margin: 6px 0 0;
          color: #94a3b8;
          font-size: 14px;
        }

        .project-summary-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 18px;
        }

        .project-summary-card {
          background: linear-gradient(180deg, rgba(15, 23, 42, 0.95), rgba(8, 16, 31, 0.98));
          border: 1px solid rgba(148, 163, 184, 0.12);
          border-left: 5px solid #60a5fa;
          border-radius: 20px;
          padding: 20px;
        }

        .project-summary-card.failed { border-left-color: #ef4444; }
        .project-summary-card.warning { border-left-color: #f59e0b; }
        .project-summary-card.passed { border-left-color: #10b981; }

        .project-summary-header {
          display: flex;
          justify-content: space-between;
          gap: 14px;
          align-items: flex-start;
        }

        .project-summary-header h3 {
          margin: 0;
          font-size: 20px;
          color: #f8fafc;
        }

        .project-summary-header p {
          margin: 8px 0 0;
          color: #94a3b8;
          font-size: 13px;
          line-height: 1.5;
        }

        .summary-status-badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 88px;
          padding: 8px 12px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          white-space: nowrap;
        }

        .summary-status-badge.passed { background: rgba(16, 185, 129, 0.18); color: #6ee7b7; }
        .summary-status-badge.warning { background: rgba(245, 158, 11, 0.18); color: #fcd34d; }
        .summary-status-badge.failed { background: rgba(239, 68, 68, 0.18); color: #fca5a5; }

        .project-summary-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 18px;
        }

        .project-chip,
        .module-count-badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 7px 11px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          border: 1px solid transparent;
        }

        .project-chip.app { background: rgba(59, 130, 246, 0.16); color: #93c5fd; border-color: rgba(59, 130, 246, 0.3); }
        .project-chip.server { background: rgba(6, 182, 212, 0.16); color: #67e8f9; border-color: rgba(6, 182, 212, 0.3); }
        .project-chip.ssl { background: rgba(139, 92, 246, 0.16); color: #c4b5fd; border-color: rgba(139, 92, 246, 0.3); }
        .project-chip.domain { background: rgba(16, 185, 129, 0.16); color: #86efac; border-color: rgba(16, 185, 129, 0.3); }
        .project-chip.api { background: rgba(245, 158, 11, 0.16); color: #fcd34d; border-color: rgba(245, 158, 11, 0.3); }

        .module-sections-grid {
          display: grid;
          gap: 18px;
        }

        .module-section-card {
          background: linear-gradient(180deg, rgba(15, 23, 42, 0.95), rgba(8, 16, 31, 0.98));
          border: 1px solid rgba(148, 163, 184, 0.12);
          border-left: 5px solid #60a5fa;
          border-radius: 22px;
          overflow: hidden;
        }

        .module-section-card.failed { border-left-color: #ef4444; }
        .module-section-card.warning { border-left-color: #f59e0b; }
        .module-section-card.passed { border-left-color: #10b981; }

        .module-section-header {
          display: flex;
          justify-content: space-between;
          gap: 16px;
          align-items: flex-start;
          padding: 22px 24px;
        }

        .module-title-row {
          display: flex;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
        }

        .module-title-row h2 {
          margin: 0;
          font-size: 22px;
          color: #f8fafc;
        }

        .module-count-row {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 16px;
        }

        .module-count-badge.passed { background: rgba(16, 185, 129, 0.16); color: #6ee7b7; border-color: rgba(16, 185, 129, 0.3); }
        .module-count-badge.warning { background: rgba(245, 158, 11, 0.16); color: #fcd34d; border-color: rgba(245, 158, 11, 0.3); }
        .module-count-badge.failed { background: rgba(239, 68, 68, 0.16); color: #fca5a5; border-color: rgba(239, 68, 68, 0.3); }
        .module-count-badge.total { background: rgba(59, 130, 246, 0.16); color: #93c5fd; border-color: rgba(59, 130, 246, 0.3); }
        .module-count-badge.duration { background: rgba(148, 163, 184, 0.14); color: #cbd5e1; border-color: rgba(148, 163, 184, 0.25); }

        .module-toggle-btn {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          border: none;
          border-radius: 999px;
          padding: 11px 16px;
          background: linear-gradient(135deg, #1d4ed8, #4338ca);
          color: #ffffff;
          cursor: pointer;
          font-size: 12px;
          font-weight: 800;
          letter-spacing: 0.06em;
          text-transform: uppercase;
        }

        .module-toggle-btn .toggle-icon { transition: transform 0.2s ease; }
        .module-toggle-btn[aria-expanded="true"] .toggle-icon { transform: rotate(180deg); }

        .module-section-details {
          display: none;
          padding: 0 24px 24px 24px;
          border-top: 1px solid rgba(148, 163, 184, 0.12);
        }

        .module-section-details.expanded { display: block; }

        .module-details-grid {
          display: grid;
          gap: 16px;
          padding-top: 22px;
        }

        .module-detail-card {
          background: rgba(2, 6, 23, 0.52);
          border: 1px solid rgba(148, 163, 184, 0.12);
          border-left: 4px solid #60a5fa;
          border-radius: 18px;
          padding: 18px;
        }

        .module-detail-card.failed { border-left-color: #ef4444; }
        .module-detail-card.warning { border-left-color: #f59e0b; }
        .module-detail-card.passed { border-left-color: #10b981; }

        .module-detail-header {
          display: flex;
          justify-content: space-between;
          gap: 16px;
          align-items: flex-start;
          margin-bottom: 14px;
        }

        .module-detail-header h4 {
          margin: 0;
          font-size: 18px;
          color: #f8fafc;
        }

        .module-detail-header p {
          margin: 6px 0 0;
          color: #94a3b8;
          font-size: 13px;
        }

        .module-item-status {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 88px;
          padding: 8px 12px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          white-space: nowrap;
        }

        .module-item-status.passed { background: rgba(16, 185, 129, 0.18); color: #6ee7b7; }
        .module-item-status.warning { background: rgba(245, 158, 11, 0.18); color: #fcd34d; }
        .module-item-status.failed { background: rgba(239, 68, 68, 0.18); color: #fca5a5; }

        .module-detail-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 12px;
        }

        .detail-field {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 12px 13px;
          border-radius: 14px;
          background: rgba(15, 23, 42, 0.65);
          border: 1px solid rgba(30, 41, 59, 0.9);
          min-width: 0;
        }

        .detail-field.wide { grid-column: 1 / -1; }

        .detail-label {
          color: #94a3b8;
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }

        .detail-value {
          color: #f8fafc;
          font-size: 14px;
          line-height: 1.55;
          word-break: break-word;
          overflow-wrap: anywhere;
        }

        .module-empty-state {
          padding: 22px;
          border-radius: 18px;
          background: rgba(15, 23, 42, 0.88);
          border: 1px dashed rgba(148, 163, 184, 0.32);
          color: #94a3b8;
          text-align: center;
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

        .report-card.unavailable {
          border-left-color: #9ca3af;
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

        .report-status.unavailable {
          background: #f3f4f6;
          color: #4b5563;
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
          color: #cbd5e1;
            margin-top: 40px;
            padding: 20px;
        }

        @media (max-width: 900px) {
          .module-section-header,
          .project-summary-header,
          .section-heading {
            flex-direction: column;
            align-items: flex-start;
          }
        }

        @media (max-width: 720px) {
          .header h1 {
            font-size: 34px;
          }

          .summary {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }

          .project-summary-grid {
            grid-template-columns: 1fr;
          }
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
          <section class="project-summary-section">
            <div class="section-heading">
              <div>
                <h2>Project Summary Cards</h2>
                <p>Compact project status overview with APP, SRV, SSL, DOM, and API counts.</p>
              </div>
            </div>
            <div class="project-summary-grid">
              ${renderModel.projects.map((project) => renderProjectSummaryCard(project)).join('\n')}
            </div>
          </section>

          <section class="module-dashboard-section">
            <div class="section-heading">
              <div>
                <h2>Module Sections</h2>
                <p>Each module expands inline inside this page. No separate navigation is required.</p>
              </div>
            </div>
            <div class="module-sections-grid">
              ${renderModel.moduleSections.map((section) => renderModuleSection(section)).join('\n')}
            </div>
          </section>
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
      function toggleModuleSection(sectionId) {
        const details = document.getElementById('module-details-' + sectionId);
        const button = document.getElementById('module-btn-' + sectionId);
        const label = button.querySelector('.toggle-text');
        const expanded = button.getAttribute('aria-expanded') === 'true';

        button.setAttribute('aria-expanded', expanded ? 'false' : 'true');
        details.classList.toggle('expanded', !expanded);
        label.textContent = expanded ? 'View Details' : 'Hide Details';
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

  // Prefer suite totals already computed by the runner. Fall back to legacy report parsing.
  const parsed = typeof result.total === 'number'
    ? {
        passed: result.passed || 0,
        failed: result.failed || 0,
        warnings: result.warnings,
        total: result.total || 0,
        failedTests: undefined,
        warningTests: undefined
      }
    : parseTestResults(result);
  const { passed, failed, warnings, total, failedTests, warningTests } = parsed;

  // Determine actual status based on test results
  // If we have test results, use them to determine status
  // Otherwise, fall back to the command execution status
  let actualStatus = result.status;
  if (result.status === 'unavailable') {
    actualStatus = 'unavailable';
  } else if (total > 0 && failed > 0) {
    actualStatus = 'failed';
  } else if (total > 0 && failed === 0) {
    actualStatus = 'success';
  }

  const statusClass = actualStatus === 'success' ? 'success' : actualStatus === 'unavailable' ? 'unavailable' : 'failed';
  const statusText = actualStatus === 'success' ? '✅ Passed' : actualStatus === 'unavailable' ? 'Not configured in current workspace' : '❌ Failed';

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
    } else if (result.repository === 'AdHash_Domain_Report') {
      warningTitle = '⚠️ Domains Expiring Soon (≤30 days):';
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
    } else if (result.repository === 'AdHash_Domain_Report') {
      failedTitle = '❌ Domain Lookup Errors:';
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

  const messageHtml = result.message || result.error ? `
                    <div class="error-message">${result.message || result.error}</div>` : '';

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

                    ${messageHtml}

                    ${warningTestsHtml}

                    ${failedTestsHtml}

                    ${embeddedReportHtml}
                </div>
            </div>`;
}


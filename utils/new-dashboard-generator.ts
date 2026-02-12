/**
 * New Dashboard Generator
 * Creates a beautiful static HTML dashboard with embedded test data (purple gradient design)
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
  failedItems?: Array<{name: string; url?: string; status?: string; error?: string; responseMsg?: string}>;
  warningItems?: Array<{name: string; url?: string; status?: string; error?: string; responseMsg?: string}>;
}

interface ProjectData {
  name: string;
  displayName: string;
  apps?: Array<{ name: string; status: string; url?: string }>;
  servers?: Array<{ name: string; status: string; url?: string }>;
  certificates?: Array<{ domain: string; status: string; expiryDate?: string }>;
  domains?: Array<{ domain: string; status: string; expiryDate?: string }>;
  apis?: Array<{ name: string; status: string; url?: string }>;
}

/**
 * Helper function to extract detailed results from report
 */
function extractDetailedResultsForDashboard(repoName: string, reportPath: string): {
  passed: number;
  failed: number;
  warnings?: number;
  total: number;
  failedItems?: Array<{name: string; url?: string; status?: string; error?: string; responseMsg?: string}>;
  warningItems?: Array<{name: string; url?: string; status?: string; error?: string; responseMsg?: string}>;
} {
  // This function will be called from run-all-tests-new-dashboard.ts
  // For now, return empty structure - will be populated by the main runner
  return { passed: 0, failed: 0, total: 0 };
}

/**
 * Generate a beautiful static HTML dashboard with embedded test data
 */
export function generateNewDashboard(results: TestResult[], outputPath: string): void {
  console.log('📊 Generating new beautiful dashboard with embedded data...');

  // Calculate summary statistics
  const totalTests = results.reduce((sum, r) => sum + (r.total || 0), 0);
  const passedTests = results.reduce((sum, r) => sum + (r.passed || 0), 0);
  const failedTests = results.reduce((sum, r) => sum + (r.failed || 0), 0);
  const warningTests = results.reduce((sum, r) => sum + (r.warnings || 0), 0);

  // Map repository names to display info
  const repoInfo: Record<string, { displayName: string; icon: string }> = {
    'Adhash_App_Status': { displayName: 'App Status', icon: '📱' },
    'Adhash_AllProjects_Server': { displayName: 'Server Health', icon: '🖥️' },
    'AdHash-Projects-Certificate-Expiry-Test': { displayName: 'SSL Certificates', icon: '🔒' },
    'AdHash-API-Test': { displayName: 'API Endpoints', icon: '⚡' },
    'AdHash_Domain_Report': { displayName: 'Domain Status', icon: '🌐' }
  };

  // Build project cards HTML with detailed items
  const projectCardsHtml = results.map(result => {
    const info = repoInfo[result.repository] || { displayName: result.repository, icon: '📦' };
    const statusClass = result.status === 'success' ? 'success' : result.status === 'failed' ? 'failed' : 'warning';
    const statusIcon = result.status === 'success' ? '✅' : result.status === 'failed' ? '❌' : '⚠️';

    // Build detailed items HTML
    let detailedItemsHtml = '';

    // Show failed items
    if (result.failedItems && result.failedItems.length > 0) {
      detailedItemsHtml += `
        <div class="detailed-items">
          <div class="items-header failed">❌ Failed Items (${result.failedItems.length})</div>
          <div class="items-list">
            ${result.failedItems.map(item => `
              <div class="item failed">
                <div class="item-name">🔴 ${item.name}</div>
                ${item.url ? `<div class="item-url">${item.url}</div>` : ''}
                ${item.error ? `<div class="item-error">${item.error}</div>` : ''}
                ${item.responseMsg ? `<div class="item-response">${item.responseMsg}</div>` : ''}
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // Show warning items
    if (result.warningItems && result.warningItems.length > 0) {
      detailedItemsHtml += `
        <div class="detailed-items">
          <div class="items-header warning">⚠️ Warning Items (${result.warningItems.length})</div>
          <div class="items-list">
            ${result.warningItems.map(item => `
              <div class="item warning">
                <div class="item-name">🟡 ${item.name}</div>
                ${item.url ? `<div class="item-url">${item.url}</div>` : ''}
                ${item.error ? `<div class="item-error">${item.error}</div>` : ''}
                ${item.responseMsg ? `<div class="item-response">${item.responseMsg}</div>` : ''}
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    return `
    <div class="project-card">
      <div class="project-header">
        <span class="project-icon">${info.icon}</span>
        <h3>${info.displayName}</h3>
        <span class="status-badge ${statusClass}">${statusIcon} ${result.status.toUpperCase()}</span>
      </div>
      <div class="project-stats">
        <div class="stat">
          <span class="stat-label">Total</span>
          <span class="stat-value">${result.total || 0}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Passed</span>
          <span class="stat-value success">${result.passed || 0}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Failed</span>
          <span class="stat-value failed">${result.failed || 0}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Warnings</span>
          <span class="stat-value warning">${result.warnings || 0}</span>
        </div>
      </div>
      <div class="project-duration">
        <span>⏱️ Duration: ${(result.duration / 1000).toFixed(1)}s</span>
      </div>
      ${detailedItemsHtml}
    </div>
    `;
  }).join('');

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AdHash Projects Dashboard - Test Report</title>
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
            padding: 20px;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
        }

        .header {
            text-align: center;
            color: white;
            margin-bottom: 40px;
        }

        .header h1 {
            font-size: 3rem;
            font-weight: 700;
            margin-bottom: 10px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.2);
        }

        .header p {
            font-size: 1.2rem;
            opacity: 0.9;
        }

        .summary-tiles {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 40px;
        }

        .summary-tile {
            background: white;
            border-radius: 15px;
            padding: 25px;
            text-align: center;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            transition: transform 0.3s ease;
        }

        .summary-tile:hover {
            transform: translateY(-5px);
        }

        .summary-tile h3 {
            font-size: 0.9rem;
            color: #666;
            margin-bottom: 10px;
            text-transform: uppercase;
            letter-spacing: 1px;
        }

        .summary-tile .value {
            font-size: 2.5rem;
            font-weight: 700;
            color: #333;
        }

        .summary-tile.total .value { color: #667eea; }
        .summary-tile.passed .value { color: #10b981; }
        .summary-tile.failed .value { color: #ef4444; }
        .summary-tile.warning .value { color: #f59e0b; }

        .projects-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
            gap: 25px;
            margin-bottom: 40px;
        }

        .project-card {
            background: white;
            border-radius: 15px;
            padding: 25px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            transition: all 0.3s ease;
        }

        .project-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 15px 40px rgba(0,0,0,0.3);
        }

        .project-header {
            display: flex;
            align-items: center;
            gap: 15px;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 2px solid #f0f0f0;
        }

        .project-icon {
            font-size: 2rem;
        }

        .project-header h3 {
            flex: 1;
            font-size: 1.3rem;
            color: #333;
        }

        .status-badge {
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
        }

        .status-badge.success {
            background: #d1fae5;
            color: #065f46;
        }

        .status-badge.failed {
            background: #fee2e2;
            color: #991b1b;
        }

        .status-badge.warning {
            background: #fef3c7;
            color: #92400e;
        }

        .project-stats {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 15px;
            margin-bottom: 15px;
        }

        .stat {
            text-align: center;
        }

        .stat-label {
            display: block;
            font-size: 0.75rem;
            color: #666;
            margin-bottom: 5px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .stat-value {
            display: block;
            font-size: 1.5rem;
            font-weight: 700;
            color: #333;
        }

        .stat-value.success { color: #10b981; }
        .stat-value.failed { color: #ef4444; }
        .stat-value.warning { color: #f59e0b; }

        .project-duration {
            text-align: center;
            padding-top: 15px;
            border-top: 2px solid #f0f0f0;
            color: #666;
            font-size: 0.9rem;
        }

        /* Detailed Items Styles */
        .detailed-items {
            margin-top: 20px;
            border-top: 2px solid #f0f0f0;
            padding-top: 15px;
        }

        .items-header {
            font-size: 0.9rem;
            font-weight: 600;
            margin-bottom: 12px;
            padding: 8px 12px;
            border-radius: 8px;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .items-header.failed {
            background: #fee2e2;
            color: #991b1b;
        }

        .items-header.warning {
            background: #fef3c7;
            color: #92400e;
        }

        .items-list {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }

        .item {
            padding: 12px;
            border-radius: 8px;
            border-left: 4px solid;
            background: #f9fafb;
        }

        .item.failed {
            border-left-color: #ef4444;
            background: #fef2f2;
        }

        .item.warning {
            border-left-color: #f59e0b;
            background: #fffbeb;
        }

        .item-name {
            font-weight: 600;
            color: #333;
            margin-bottom: 4px;
            font-size: 0.9rem;
        }

        .item-url {
            font-size: 0.8rem;
            color: #666;
            margin-bottom: 4px;
            font-family: 'Courier New', monospace;
        }

        .item-error {
            font-size: 0.85rem;
            color: #dc2626;
            margin-bottom: 4px;
        }

        .item-response {
            font-size: 0.8rem;
            color: #666;
            font-style: italic;
        }

        .footer {
            text-align: center;
            color: white;
            padding: 20px;
            opacity: 0.9;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 AdHash Projects Dashboard</h1>
            <p>Real-time monitoring across all platforms</p>
            <p style="font-size: 0.9rem; margin-top: 10px;">Generated: ${new Date().toLocaleString()}</p>
        </div>

        <div class="summary-tiles">
            <div class="summary-tile total">
                <h3>Total Tests</h3>
                <div class="value">${totalTests}</div>
            </div>
            <div class="summary-tile passed">
                <h3>Passed</h3>
                <div class="value">${passedTests}</div>
            </div>
            <div class="summary-tile failed">
                <h3>Failed</h3>
                <div class="value">${failedTests}</div>
            </div>
            <div class="summary-tile warning">
                <h3>Warnings</h3>
                <div class="value">${warningTests}</div>
            </div>
        </div>

        <div class="projects-grid">
            ${projectCardsHtml}
        </div>

        <div class="footer">
            <p>AdHash Test Automation Framework</p>
            <p style="font-size: 0.8rem; margin-top: 5px;">Automated testing across 5 repositories</p>
        </div>
    </div>
</body>
</html>
  `;

  // Write the HTML file
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, html, 'utf-8');
  console.log(`✅ New beautiful dashboard generated: ${outputPath}`);
}


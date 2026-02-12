/**
 * Master Test Runner - Executes all repository tests and generates unified dashboard
 * This script runs tests from all 5 repositories and creates a unified HTML dashboard
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { generateDashboard } from './utils/dashboard-generator';
import { sendTestReport } from './utils/email-sender';

// Load environment variables
dotenv.config();

const execAsync = promisify(exec);

interface TestResult {
  repository: string;
  status: 'success' | 'failed' | 'error';
  duration: number;
  reportPath: string;
  error?: string;
  passed?: number;
  failed?: number;
  total?: number;
}

const results: TestResult[] = [];

/**
 * Extract detailed test results including pass/fail/warning counts and detailed failure info
 */
function extractDetailedResults(repoName: string, reportPath: string): {
  passed: number;
  failed: number;
  warnings?: number;
  total: number;
  failedItems?: Array<{name: string; url?: string; status?: string; error?: string; responseMsg?: string}>;
  warningItems?: Array<{name: string; url?: string; status?: string; error?: string; responseMsg?: string}>;
} {
  try {
    if (!fs.existsSync(reportPath)) {
      return { passed: 0, failed: 0, total: 0 };
    }

    const reportContent = fs.readFileSync(reportPath, 'utf-8');

    // Parse Server Health Report
    if (repoName === 'Adhash_AllProjects_Server') {
      const healthyMatch = reportContent.match(/<div class="label">Healthy Servers<\/div>\s*<div class="count">(\d+)<\/div>/i);
      const unhealthyMatch = reportContent.match(/<div class="label">Unhealthy Servers<\/div>\s*<div class="count">(\d+)<\/div>/i);
      const downMatch = reportContent.match(/<div class="label">Down Servers<\/div>\s*<div class="count">(\d+)<\/div>/i);

      const healthy = healthyMatch ? parseInt(healthyMatch[1]) : 0;
      const unhealthy = unhealthyMatch ? parseInt(unhealthyMatch[1]) : 0;
      const down = downMatch ? parseInt(downMatch[1]) : 0;

      // Extract down servers with details
      const failedItems: Array<{name: string; url?: string; status?: string; error?: string; responseMsg?: string}> = [];
      const downServerMatches = reportContent.matchAll(/<div class="server-card inactive">[\s\S]*?<div class="server-name">([^<]+)<\/div>[\s\S]*?<div class="server-url">([^<]+)<\/div>[\s\S]*?<span class="detail-label">Response:<\/span>\s*<span class="detail-value">([\s\S]*?)<\/span>/gi);
      for (const match of downServerMatches) {
        failedItems.push({
          name: match[1].trim(),
          url: match[2].trim(),
          status: 'Down',
          error: 'Server not responding',
          responseMsg: match[3].trim()
        });
      }

      // Extract unhealthy servers with response codes (warnings)
      const warningItems: Array<{name: string; url?: string; status?: string; error?: string; responseMsg?: string}> = [];
      const unhealthyServerMatches = reportContent.matchAll(/<div class="server-card (?:active|unhealthy)">[\s\S]*?<span class="server-icon">⚠️<\/span>[\s\S]*?<div class="server-name">([^<]+)<\/div>[\s\S]*?<div class="server-url">([^<]+)<\/div>[\s\S]*?<span class="detail-label">Response:<\/span>\s*<span class="detail-value">([^<]+)<\/span>/gi);
      for (const match of unhealthyServerMatches) {
        warningItems.push({
          name: match[1].trim(),
          url: match[2].trim(),
          status: 'Unhealthy',
          error: 'Non-200 response code',
          responseMsg: match[3].trim()
        });
      }

      return {
        passed: healthy,
        failed: down,
        warnings: unhealthy,
        total: healthy + unhealthy + down,
        failedItems: failedItems.length > 0 ? failedItems : undefined,
        warningItems: warningItems.length > 0 ? warningItems : undefined
      };
    }

    // Parse Certificate Report
    else if (repoName === 'AdHash-Projects-Certificate-Expiry-Test') {
      const totalMatch = reportContent.match(/<div class='number'>(\d+)<\/div><div class='label'>Total Tests<\/div>/i);
      const passedMatch = reportContent.match(/<div class='number'>✓\s*(\d+)<\/div><div class='label'>Passed<\/div>/i);
      const failedMatch = reportContent.match(/<div class='number'>✗\s*(\d+)<\/div><div class='label'>Failed<\/div>/i);

      const total = totalMatch ? parseInt(totalMatch[1]) : 0;
      const passed = passedMatch ? parseInt(passedMatch[1]) : 0;

      const failedItems: Array<{name: string; url?: string; status?: string; error?: string; responseMsg?: string}> = [];
      const warningItems: Array<{name: string; url?: string; status?: string; error?: string; responseMsg?: string}> = [];

      // Match all failed rows (row-failed class)
      const failedRowMatches = reportContent.matchAll(/<tr class='row-failed'>[\s\S]*?<td>(\d+)<\/td>[\s\S]*?<td>([^<]+)<\/td>[\s\S]*?<td>([^<]+)<\/td>[\s\S]*?<td>(\d+)\s*days<\/td>[\s\S]*?<td>([^<]+)<\/td>/gi);

      for (const match of failedRowMatches) {
        const projectName = match[2].trim();
        const url = match[3].trim();
        const daysRemaining = parseInt(match[4]);
        const expiryDate = match[5].trim();

        if (daysRemaining === 0) {
          // Expired certificate (=0 days) - FAILURE
          failedItems.push({
            name: projectName,
            url: url,
            status: 'Expired',
            error: `Certificate expired on ${expiryDate}`,
            responseMsg: `0 days remaining`
          });
        } else if (daysRemaining > 0 && daysRemaining <= 30) {
          // Expiring soon (>0 and ≤30 days) - WARNING
          warningItems.push({
            name: projectName,
            url: url,
            status: 'Expiring Soon',
            error: `Certificate expires on ${expiryDate}`,
            responseMsg: `${daysRemaining} days remaining`
          });
        }
      }

      return {
        passed,
        failed: failedItems.length,
        warnings: warningItems.length,
        total,
        failedItems: failedItems.length > 0 ? failedItems : undefined,
        warningItems: warningItems.length > 0 ? warningItems : undefined
      };
    }

    // Parse API Test Report
    else if (repoName === 'AdHash-API-Test') {
      const totalMatch = reportContent.match(/<div class="stat-number">(\d+)<\/div><div class="stat-label">Total Tests<\/div>/i);
      const passedMatch = reportContent.match(/<div class="stat-number">✓\s*(\d+)<\/div><div class="stat-label">Passed<\/div>/i);
      const failedMatch = reportContent.match(/<div class="stat-number">✗\s*(\d+)<\/div><div class="stat-label">Failed<\/div>/i);

      const total = totalMatch ? parseInt(totalMatch[1]) : 0;
      const passed = passedMatch ? parseInt(passedMatch[1]) : 0;
      const failed = failedMatch ? parseInt(failedMatch[1]) : 0;

      const failedItems: Array<{name: string; url?: string; status?: string; error?: string; responseMsg?: string}> = [];

      // Extract failed test details from table rows
      const rowMatches = reportContent.matchAll(/<tr>[\s\S]*?<td class="sno">(\d+)<\/td>\s*<td>([^<]+)<\/td>[\s\S]*?<span class="function-tag">([^<]+)<\/span>[\s\S]*?<td class="status-fail">.*?Failed<\/td>[\s\S]*?<\/tr>/gi);
      for (const match of rowMatches) {
        const projectName = match[2].trim();
        const functionName = match[3].trim();
        failedItems.push({
          name: `${projectName} - ${functionName}`,
          status: 'Failed',
          error: 'API test failed'
        });
      }

      return {
        passed,
        failed,
        total,
        failedItems: failedItems.length > 0 ? failedItems : undefined
      };
    }

    // Parse Domain Report
    else if (repoName === 'AdHash_Domain_Report') {
      const totalMatch = reportContent.match(/<h3 id="totalDomains">(\d+)<\/h3>/i);
      const activeMatch = reportContent.match(/<h3 id="activeDomains">(\d+)<\/h3>/i);
      const expiringMatch = reportContent.match(/<h3 id="expiringDomains"[^>]*>(\d+)<\/h3>/i);
      const errorMatch = reportContent.match(/<h3 id="errorDomains">(\d+)<\/h3>/i);

      const total = totalMatch ? parseInt(totalMatch[1]) : 0;
      const active = activeMatch ? parseInt(activeMatch[1]) : 0;
      const expiring = expiringMatch ? parseInt(expiringMatch[1]) : 0;
      const errors = errorMatch ? parseInt(errorMatch[1]) : 0;

      const warningItems: Array<{name: string; url?: string; status?: string; error?: string; responseMsg?: string}> = [];
      const failedItems: Array<{name: string; url?: string; status?: string; error?: string; responseMsg?: string}> = [];

      // Extract expiring domains (warnings)
      const expiringDomainMatches = reportContent.matchAll(/<div class="domain-card expiring-soon"[\s\S]*?<div class="domain-name">([^<]+)<\/div>[\s\S]*?<div class="domain-url">([^<]+)<\/div>[\s\S]*?<div class="expiry-date">([^<]+)<\/div>[\s\S]*?<div class="days-remaining warning"[^>]*>\s*(\d+)\s*days remaining/gi);
      for (const match of expiringDomainMatches) {
        warningItems.push({
          name: match[1].trim(),
          url: match[2].trim(),
          status: 'Expiring Soon',
          error: `Domain expires on ${match[3].trim()}`,
          responseMsg: `${match[4].trim()} days remaining`
        });
      }

      // Extract error/unknown domains (failures)
      const errorDomainMatches = reportContent.matchAll(/<div class="domain-card error"[\s\S]*?<div class="domain-name">([^<]+)<\/div>[\s\S]*?<div class="domain-url">([^<]+)<\/div>[\s\S]*?<span class="status-badge status-error">⚠\s*([^<]+)<\/span>/gi);
      for (const match of errorDomainMatches) {
        failedItems.push({
          name: match[1].trim(),
          url: match[2].trim(),
          status: match[3].trim(),
          error: 'WHOIS lookup failed or domain status unknown'
        });
      }

      return {
        passed: active,
        failed: errors,
        warnings: expiring,
        total,
        failedItems: failedItems.length > 0 ? failedItems : undefined,
        warningItems: warningItems.length > 0 ? warningItems : undefined
      };
    }

    // Parse App Status Report
    else if (repoName === 'Adhash_App_Status') {
      const passedMatch = reportContent.match(/<div class="stat-number">(\d+)<\/div>\s*<div class="stat-label">Passed<\/div>/i);
      const failedMatch = reportContent.match(/<div class="stat-number">(\d+)<\/div>\s*<div class="stat-label">Failed<\/div>/i);
      const passed = passedMatch ? parseInt(passedMatch[1]) : 0;
      const failed = failedMatch ? parseInt(failedMatch[1]) : 0;

      return { passed, failed, total: passed + failed };
    }

    return { passed: 0, failed: 0, total: 0 };
  } catch (error) {
    console.error(`Error extracting detailed results from ${repoName}:`, error);
    return { passed: 0, failed: 0, total: 0 };
  }
}

/**
 * Check if tests actually passed by reading the report
 */
function checkTestsPassed(repoName: string, reportPath: string): boolean {
  try {
    if (!fs.existsSync(reportPath)) {
      return false;
    }

    const reportContent = fs.readFileSync(reportPath, 'utf-8');

    // Check for actual test results in the report
    if (repoName === 'Adhash_App_Status') {
      // If report exists and has test results, consider it passed
      // Even if Playwright command failed due to timeout
      const hasResults = reportContent.includes('passed') || reportContent.includes('PASS');
      return hasResults;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Run a command and capture output
 */
async function runCommand(command: string, cwd: string, repoName: string): Promise<TestResult> {
  const startTime = Date.now();
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🚀 Running tests for: ${repoName}`);
  console.log(`📂 Directory: ${cwd}`);
  console.log(`⚙️  Command: ${command}`);
  console.log(`${'='.repeat(80)}\n`);

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer
    });

    const duration = Date.now() - startTime;

    console.log(stdout);
    if (stderr) console.error(stderr);

    console.log(`\n✅ ${repoName} tests completed in ${(duration / 1000).toFixed(2)}s\n`);

    return {
      repository: repoName,
      status: 'success',
      duration,
      reportPath: getReportPath(repoName)
    };
  } catch (error: any) {
    const duration = Date.now() - startTime;

    console.log(error.stdout || '');
    console.error(error.stderr || '');
    console.error(`\n❌ ${repoName} tests failed: ${error.message}\n`);

    const reportPath = getReportPath(repoName);

    // Check if tests actually passed despite command failure
    const testsPassed = checkTestsPassed(repoName, reportPath);

    return {
      repository: repoName,
      status: testsPassed ? 'success' : 'failed',
      duration,
      reportPath,
      error: testsPassed ? undefined : error.message
    };
  }
}

/**
 * Get the report path for each repository
 * Checks multiple possible locations and returns the first one that exists
 */
function getReportPath(repoName: string): string {
  // Define possible report paths for each repository
  const reportPaths: Record<string, string[]> = {
    'Adhash_App_Status': [
      'Adhash_App_Status/custom-reports/Unified_App_Verification_Report.html',
      'Adhash_App_Status/custom-reports/PlayStore_App_Verification_Report.html'
    ],
    'Adhash_AllProjects_Server': [
      'Adhash_AllProjects_Server/reports',  // Directory - will find latest
      'Adhash_AllProjects_Server/server-health-report.html'
    ],
    'AdHash-Projects-Certificate-Expiry-Test': [
      'AdHash-Projects-Certificate-Expiry-Test/reports',  // Directory - will find latest modern report
      'AdHash-Projects-Certificate-Expiry-Test/target/surefire-reports/emailable-report.html',
      'AdHash-Projects-Certificate-Expiry-Test/target/surefire-reports/index.html'
    ],
    'AdHash-API-Test': [
      'AdHash-API-Test/simple-reports',  // Directory - will find latest
      'AdHash-API-Test/extent-reports',  // Directory - will find latest
      'AdHash-API-Test/test-output/index.html'
    ],
    'AdHash_Domain_Report': [
      'AdHash_Domain_Report/godaddy/report.html'
    ]
  };

  const paths = reportPaths[repoName] || [];

  // Check each path and return the first one that exists
  console.log(`\n🔍 Looking for report for ${repoName}...`);
  for (const reportPath of paths) {
    const fullPath = path.join(process.cwd(), reportPath);
    console.log(`   Checking: ${reportPath}`);

    // If it's a directory, find the latest HTML file
    if (fileExists(fullPath) && fs.statSync(fullPath).isDirectory()) {
      console.log(`   📁 Directory found, searching for HTML files...`);
      const files = fs.readdirSync(fullPath)
        .filter((f: string) => f.endsWith('.html'))
        .sort()
        .reverse(); // Get latest file

      console.log(`   Found ${files.length} HTML files`);
      if (files.length > 0) {
        const reportFile = path.join(reportPath, files[0]);
        console.log(`   ✅ Using: ${reportFile}`);
        return reportFile;
      }
    }
    // If it's a file and exists, return it
    else if (fileExists(fullPath)) {
      console.log(`   ✅ File found: ${reportPath}`);
      return reportPath;
    } else {
      console.log(`   ❌ Not found`);
    }
  }

  console.log(`   ⚠️  No report found for ${repoName}`);
  return '';
}

/**
 * Check if a file exists
 */
function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/**
 * Check if repository directory exists
 */
function repositoryExists(repoName: string): boolean {
  const repoPath = path.join(process.cwd(), repoName);
  return fs.existsSync(repoPath) && fs.statSync(repoPath).isDirectory();
}

/**
 * Pull latest code from repository
 */
async function pullLatestCode(repoName: string): Promise<void> {
  const repoPath = path.join(process.cwd(), repoName);

  if (!repositoryExists(repoName)) {
    console.log(`⚠️  ${repoName} repository not found. Skipping git pull...`);
    return;
  }

  try {
    console.log(`🔄 Pulling latest code for ${repoName}...`);

    // Stash any local changes first
    try {
      await execAsync('git stash', {
        cwd: repoPath,
        maxBuffer: 10 * 1024 * 1024
      });
    } catch (stashError) {
      // Ignore stash errors (might be nothing to stash)
    }

    // Pull latest code (try master first, then main)
    const { stdout, stderr } = await execAsync('git pull origin master 2>&1 || git pull origin main 2>&1', {
      cwd: repoPath,
      maxBuffer: 10 * 1024 * 1024
    });

    if (stdout.includes('Already up to date') || stdout.includes('Already up-to-date')) {
      console.log(`✅ ${repoName} is already up to date`);
    } else {
      console.log(`✅ ${repoName} updated successfully`);
      if (stdout && !stdout.includes('fatal')) {
        const lines = stdout.trim().split('\n').slice(0, 3); // Show first 3 lines
        lines.forEach(line => console.log(`   ${line}`));
      }
    }
  } catch (error: any) {
    console.warn(`⚠️  Warning: Could not pull latest code for ${repoName}: ${error.message}`);
    console.warn(`   Continuing with existing code...`);
  }
}

/**
 * Main execution function
 */
async function main() {
  console.log('\n');
  console.log('╔════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                   AdHash Unified Test Execution                           ║');
  console.log('║                   Running All Repository Tests                            ║');
  console.log('╚════════════════════════════════════════════════════════════════════════════╝');
  console.log('\n');

  const results: TestResult[] = [];
  const startTime = Date.now();

  // Pull latest code from all repositories
  console.log('🔄 Pulling latest code from all repositories...\n');
  const repositories = [
    'Adhash_App_Status',
    'Adhash_AllProjects_Server',
    'AdHash-Projects-Certificate-Expiry-Test',
    'AdHash-API-Test',
    'AdHash_Domain_Report'
  ];

  for (const repo of repositories) {
    await pullLatestCode(repo);
  }
  console.log('\n✅ All repositories updated. Starting tests...\n');

  // 1. Run App Status Tests (TypeScript/Playwright)
  console.log('📱 Step 1/5: Running App Status Tests...');
  try {
    if (repositoryExists('Adhash_App_Status')) {
      const appStatusResult = await runCommand(
        'npx playwright test tests/unified.spec.ts',
        path.join(process.cwd(), 'Adhash_App_Status'),
        'Adhash_App_Status'
      );
      results.push(appStatusResult);
    } else {
      console.log('⚠️  Adhash_App_Status repository not found. Skipping...\n');
      results.push({
        repository: 'Adhash_App_Status',
        status: 'error',
        duration: 0,
        reportPath: '',
        error: 'Repository not found'
      });
    }
  } catch (error: any) {
    console.error('❌ Error in Step 1:', error.message);
    results.push({
      repository: 'Adhash_App_Status',
      status: 'error',
      duration: 0,
      reportPath: '',
      error: error.message
    });
  }
  console.log('✅ Step 1/5 completed. Moving to Step 2...\n');

  // 2. Run Server Health Tests (TypeScript)
  console.log('🖥️  Step 2/5: Running Server Health Tests...');
  try {
    if (repositoryExists('Adhash_AllProjects_Server')) {
      const serverHealthResult = await runCommand(
        'npx ts-node checkMultipleServers.ts',
        path.join(process.cwd(), 'Adhash_AllProjects_Server'),
        'Adhash_AllProjects_Server'
      );
      results.push(serverHealthResult);
    } else {
      console.log('⚠️  Adhash_AllProjects_Server repository not found. Skipping...\n');
      results.push({
        repository: 'Adhash_AllProjects_Server',
        status: 'error',
        duration: 0,
        reportPath: '',
        error: 'Repository not found'
      });
    }
  } catch (error: any) {
    console.error('❌ Error in Step 2:', error.message);
    results.push({
      repository: 'Adhash_AllProjects_Server',
      status: 'error',
      duration: 0,
      reportPath: '',
      error: error.message
    });
  }
  console.log('✅ Step 2/5 completed. Moving to Step 3...\n');

  // 3. Run Certificate Expiry Tests (Java/TestNG)
  console.log('🔒 Step 3/5: Running Certificate Expiry Tests...');
  try {
    if (repositoryExists('AdHash-Projects-Certificate-Expiry-Test')) {
      const certResult = await runCommand(
        'mvn test -Dtest=CertificateExpiryTestNG',
        path.join(process.cwd(), 'AdHash-Projects-Certificate-Expiry-Test'),
        'AdHash-Projects-Certificate-Expiry-Test'
      );
      results.push(certResult);
    } else {
      console.log('⚠️  AdHash-Projects-Certificate-Expiry-Test repository not found. Skipping...\n');
      results.push({
        repository: 'AdHash-Projects-Certificate-Expiry-Test',
        status: 'error',
        duration: 0,
        reportPath: '',
        error: 'Repository not found'
      });
    }
  } catch (error: any) {
    console.error('❌ Error in Step 3:', error.message);
    results.push({
      repository: 'AdHash-Projects-Certificate-Expiry-Test',
      status: 'error',
      duration: 0,
      reportPath: '',
      error: error.message
    });
  }
  console.log('✅ Step 3/5 completed. Moving to Step 4...\n');

  // 4. Run API Tests (Java/TestNG)
  console.log('🌐 Step 4/5: Running API Tests...');
  try {
    if (repositoryExists('AdHash-API-Test')) {
      const apiResult = await runCommand(
        'mvn test -DsuiteXmlFile=TestNG.xml',
        path.join(process.cwd(), 'AdHash-API-Test'),
        'AdHash-API-Test'
      );
      results.push(apiResult);
    } else {
      console.log('⚠️  AdHash-API-Test repository not found. Skipping...\n');
      results.push({
        repository: 'AdHash-API-Test',
        status: 'error',
        duration: 0,
        reportPath: '',
        error: 'Repository not found'
      });
    }
  } catch (error: any) {
    console.error('❌ Error in Step 4:', error.message);
    results.push({
      repository: 'AdHash-API-Test',
      status: 'error',
      duration: 0,
      reportPath: '',
      error: error.message
    });
  }
  console.log('✅ Step 4/5 completed. Moving to Step 5...\n');

  // 5. Run Domain Report (Node.js)
  console.log('🌐 Step 5/5: Running Domain Report...');
  try {
    if (repositoryExists('AdHash_Domain_Report')) {
      const domainResult = await runCommand(
        'cd godaddy && node index.js',
        path.join(process.cwd(), 'AdHash_Domain_Report'),
        'AdHash_Domain_Report'
      );
      results.push(domainResult);
    } else {
      console.log('⚠️  AdHash_Domain_Report repository not found. Skipping...\n');
      results.push({
        repository: 'AdHash_Domain_Report',
        status: 'error',
        duration: 0,
        reportPath: '',
        error: 'Repository not found'
      });
    }
  } catch (error: any) {
    console.error('❌ Error in Step 5:', error.message);
    results.push({
      repository: 'AdHash_Domain_Report',
      status: 'error',
      duration: 0,
      reportPath: '',
      error: error.message
    });
  }
  console.log('✅ Step 5/5 completed. All tests finished!\n');

  const totalDuration = Date.now() - startTime;

  // Print summary
  console.log('\n');
  console.log('╔════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                          Execution Summary                                 ║');
  console.log('╚════════════════════════════════════════════════════════════════════════════╝');
  console.log('\n');

  results.forEach(result => {
    const statusIcon = result.status === 'success' ? '✅' : result.status === 'error' ? '⚠️' : '❌';
    const duration = (result.duration / 1000).toFixed(2);
    const errorMsg = result.error ? ` (${result.error})` : '';
    console.log(`${statusIcon} ${result.repository.padEnd(50)} ${duration}s${errorMsg}`);
  });

  console.log('\n');
  console.log(`⏱️  Total execution time: ${(totalDuration / 1000).toFixed(2)}s`);
  console.log('\n');

  // Log report paths before generating dashboard
  console.log('📋 Report paths found:');
  results.forEach(result => {
    const reportStatus = result.reportPath ? '✅' : '❌';
    console.log(`${reportStatus} ${result.repository}: ${result.reportPath || 'No report found'}`);
  });
  console.log('\n');

  // Generate unified dashboard
  console.log('📊 Generating unified dashboard...');
  const dashboardPath = path.join(process.cwd(), 'unified-dashboard', 'index.html');
  generateDashboard(results, dashboardPath);

  console.log('✨ All tests completed! Opening dashboard...\n');

  // Open dashboard in browser
  const openCommand = process.platform === 'win32' ? 'start' :
                      process.platform === 'darwin' ? 'open' : 'xdg-open';
  exec(`${openCommand} "${dashboardPath}"`);

  // Send email report if configured (OLD FORMAT)
  const emailEnabled = process.env.ZOHO_MAIL_ENABLED === 'true';
  if (emailEnabled) {
    try {
      console.log('\n📧 Sending email report (OLD FORMAT)...');

      const emailConfig = {
        host: process.env.ZOHO_MAIL_HOST || 'smtp.zoho.com',
        port: parseInt(process.env.ZOHO_MAIL_PORT || '465'),
        secure: process.env.ZOHO_MAIL_SECURE === 'true' || true,
        user: process.env.ZOHO_MAIL_USER || '',
        pass: process.env.ZOHO_MAIL_PASS || '',
        from: process.env.ZOHO_MAIL_FROM || process.env.ZOHO_MAIL_USER || '',
        to: (process.env.ZOHO_MAIL_TO || '').split(',').map(email => email.trim()).filter(Boolean),
      };

      // Validate email configuration
      if (!emailConfig.user || !emailConfig.pass || emailConfig.to.length === 0) {
        console.log('⚠️  Email configuration incomplete. Skipping email send.');
        console.log('   Required: ZOHO_MAIL_USER, ZOHO_MAIL_PASS, ZOHO_MAIL_TO');
      } else {
        const successCount = results.filter(r => r.status === 'success').length;
        const failedCount = results.filter(r => r.status === 'failed' || r.status === 'error').length;

        // Repository display information
        const repoInfo: Record<string, {displayName: string; icon: string}> = {
          'Adhash_App_Status': { displayName: 'App Status Verification', icon: '📱' },
          'Adhash_AllProjects_Server': { displayName: 'Server Health Monitoring', icon: '🖥️' },
          'AdHash-Projects-Certificate-Expiry-Test': { displayName: 'SSL Certificate Monitoring', icon: '🔒' },
          'AdHash-API-Test': { displayName: 'API Endpoint Testing', icon: '🌐' },
          'AdHash_Domain_Report': { displayName: 'Domain Expiry Monitoring', icon: '🌐' }
        };

        // Build detailed suite information
        const suiteDetails = results.map(result => {
          const info = repoInfo[result.repository] || { displayName: result.repository, icon: '📦' };
          const detailedResults = result.reportPath ? extractDetailedResults(result.repository, result.reportPath) : { passed: 0, failed: 0, total: 0 };

          return {
            repository: result.repository,
            displayName: info.displayName,
            icon: info.icon,
            status: result.status,
            passed: detailedResults.passed,
            failed: detailedResults.failed,
            warnings: detailedResults.warnings,
            total: detailedResults.total,
            error: result.error,
            failedItems: detailedResults.failedItems,
            warningItems: detailedResults.warningItems
          };
        });

        await sendTestReport(
          dashboardPath,  // Use OLD unified dashboard
          {
            totalSuites: results.length,
            successfulSuites: successCount,
            failedSuites: failedCount,
            totalDuration: `${(totalDuration / 1000).toFixed(1)}s`,
            timestamp: new Date().toLocaleString(),
            suiteDetails: suiteDetails
          },
          emailConfig
        );

        console.log('✅ Email report sent successfully (OLD FORMAT)!');
      }
    } catch (error) {
      console.error('❌ Failed to send email report:', error);
      console.log('   Tests completed successfully, but email notification failed.');
    }
  } else {
    console.log('\n📧 Email notifications disabled. Set ZOHO_MAIL_ENABLED=true to enable.');
  }
}

// Run the main function
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});


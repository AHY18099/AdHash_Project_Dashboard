"use strict";
/**
 * Unified Dashboard Generator
 * Creates a beautiful HTML dashboard that links to all repository test reports
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateDashboard = generateDashboard;
var fs = require("fs");
var path = require("path");
var repoInfo = {
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
        description: 'WHOIS-based domain expiry tracking with 90-day warnings',
        icon: '🌐',
        testCount: '12 domains',
        technology: 'Node.js + WHOIS'
    }
};
/**
 * Parse test results from report files
 */
function parseTestResults(result) {
    try {
        // Check if report path exists (could be relative or absolute)
        var reportPath = result.reportPath;
        // If it's a relative path (starts with 'reports/'), make it absolute
        if (reportPath.startsWith('reports/')) {
            reportPath = path.join('unified-dashboard', reportPath);
        }
        if (!fs.existsSync(reportPath)) {
            return { passed: 0, failed: 0, total: 0 };
        }
        var reportContent = fs.readFileSync(reportPath, 'utf-8');
        // Parse based on repository type
        if (result.repository === 'Adhash_App_Status') {
            // Parse Playwright custom report - HTML format
            var passedMatch = reportContent.match(/<div class="stat-number">(\d+)<\/div>\s*<div class="stat-label">Passed<\/div>/i);
            var failedMatch = reportContent.match(/<div class="stat-number">(\d+)<\/div>\s*<div class="stat-label">Failed<\/div>/i);
            var passed = passedMatch ? parseInt(passedMatch[1]) : 0;
            var failed = failedMatch ? parseInt(failedMatch[1]) : 0;
            return { passed: passed, failed: failed, total: passed + failed };
        }
        if (result.repository === 'Adhash_AllProjects_Server') {
            // Parse server health report - HTML format
            var healthyMatch = reportContent.match(/<div class="label">Healthy Servers<\/div>\s*<div class="count">(\d+)<\/div>/i);
            var unhealthyMatch = reportContent.match(/<div class="label">Unhealthy Servers<\/div>\s*<div class="count">(\d+)<\/div>/i);
            var downMatch = reportContent.match(/<div class="label">Down Servers<\/div>\s*<div class="count">(\d+)<\/div>/i);
            var healthy = healthyMatch ? parseInt(healthyMatch[1]) : 0;
            var unhealthy = unhealthyMatch ? parseInt(unhealthyMatch[1]) : 0;
            var down = downMatch ? parseInt(downMatch[1]) : 0;
            // Extract failed server names (down servers only)
            var failedServers = [];
            var downServerMatches = reportContent.matchAll(/<div class="server-card inactive">[\s\S]*?<div class="server-name">([^<]+)<\/div>/gi);
            for (var _i = 0, downServerMatches_1 = downServerMatches; _i < downServerMatches_1.length; _i++) {
                var match = downServerMatches_1[_i];
                failedServers.push("\uD83D\uDEA8 ".concat(match[1].trim(), " (Down - Not Responding)"));
            }
            // Extract unhealthy servers with response codes (warnings)
            var warningServers = [];
            var unhealthyServerMatches = reportContent.matchAll(/<div class="server-card (?:active|unhealthy)">[\s\S]*?<span class="server-icon">⚠️<\/span>[\s\S]*?<div class="server-name">([^<]+)<\/div>[\s\S]*?<span class="detail-label">Response:<\/span>\s*<span class="detail-value">([^<]+)<\/span>/gi);
            for (var _a = 0, unhealthyServerMatches_1 = unhealthyServerMatches; _a < unhealthyServerMatches_1.length; _a++) {
                var match = unhealthyServerMatches_1[_a];
                var serverName = match[1].trim();
                var responseCode = match[2].trim();
                warningServers.push("\u26A0\uFE0F ".concat(serverName, " - Response: ").concat(responseCode));
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
            var totalMatch = reportContent.match(/<div class='number'>(\d+)<\/div><div class='label'>Total Tests<\/div>/i);
            var passedMatch = reportContent.match(/<div class='number'>✓\s*(\d+)<\/div><div class='label'>Passed<\/div>/i);
            var failedMatch = reportContent.match(/<div class='number'>✗\s*(\d+)<\/div><div class='label'>Failed<\/div>/i);
            var total = totalMatch ? parseInt(totalMatch[1]) : 0;
            var passed = passedMatch ? parseInt(passedMatch[1]) : 0;
            var totalFailed = failedMatch ? parseInt(failedMatch[1]) : 0;
            // Extract certificates: expired (=0 days) vs expiring soon (>0 and ≤30 days)
            var warningCerts = [];
            var failedCerts = [];
            // Match all failed rows (row-failed class)
            var failedRowMatches = reportContent.matchAll(/<tr class='row-failed'>[\s\S]*?<td>(\d+)<\/td>[\s\S]*?<td>([^<]+)<\/td>[\s\S]*?<td>([^<]+)<\/td>[\s\S]*?<td>(\d+)\s*days<\/td>[\s\S]*?<td>([^<]+)<\/td>/gi);
            for (var _b = 0, failedRowMatches_1 = failedRowMatches; _b < failedRowMatches_1.length; _b++) {
                var match = failedRowMatches_1[_b];
                var projectName = match[2].trim();
                var url = match[3].trim();
                var daysRemaining = parseInt(match[4]);
                var expiryDate = match[5].trim();
                if (daysRemaining === 0) {
                    // Expired certificate (=0 days) - FAILURE
                    failedCerts.push("\uD83D\uDEA8 ".concat(projectName, " - Expired (0 days) - ").concat(expiryDate));
                }
                else if (daysRemaining > 0 && daysRemaining <= 30) {
                    // Expiring soon (>0 and ≤30 days) - WARNING
                    warningCerts.push("\u26A0\uFE0F ".concat(projectName, " - Expires in ").concat(daysRemaining, " days - ").concat(expiryDate));
                }
            }
            return {
                passed: passed,
                failed: failedCerts.length,
                warnings: warningCerts.length,
                total: total,
                failedTests: failedCerts,
                warningTests: warningCerts
            };
        }
        if (result.repository === 'AdHash-API-Test') {
            // Parse API test report - HTML format
            var totalMatch = reportContent.match(/<div class="stat-number">(\d+)<\/div><div class="stat-label">Total Tests<\/div>/i);
            var passedMatch = reportContent.match(/<div class="stat-number">✓\s*(\d+)<\/div><div class="stat-label">Passed<\/div>/i);
            var failedMatch = reportContent.match(/<div class="stat-number">✗\s*(\d+)<\/div><div class="stat-label">Failed<\/div>/i);
            var total = totalMatch ? parseInt(totalMatch[1]) : 0;
            var passed = passedMatch ? parseInt(passedMatch[1]) : 0;
            var failed = failedMatch ? parseInt(failedMatch[1]) : 0;
            // Extract failed test names from table rows
            var failedTests = [];
            // Match full rows with status-fail
            var rowMatches = reportContent.matchAll(/<tr>[\s\S]*?<td class="status-fail">.*?Failed<\/td>[\s\S]*?<\/tr>/gi);
            for (var _c = 0, rowMatches_1 = rowMatches; _c < rowMatches_1.length; _c++) {
                var match = rowMatches_1[_c];
                // Extract project name and function from the row
                var projectMatch = match[0].match(/<td class="sno">\d+<\/td>\s*<td>([^<]+)<\/td>/);
                var functionMatch = match[0].match(/<span class="function-tag">([^<]+)<\/span>/);
                if (projectMatch && functionMatch) {
                    var projectName = projectMatch[1].trim();
                    var functionName = functionMatch[1].trim();
                    failedTests.push("".concat(projectName, " - ").concat(functionName));
                }
            }
            return { passed: passed, failed: failed, total: total, failedTests: failedTests };
        }
        if (result.repository === 'AdHash_Domain_Report') {
            // Parse domain report - HTML format
            var totalMatch = reportContent.match(/<h3 id="totalDomains">(\d+)<\/h3>/i);
            var activeMatch = reportContent.match(/<h3 id="activeDomains">(\d+)<\/h3>/i);
            var expiringMatch = reportContent.match(/<h3 id="expiringDomains"[^>]*>(\d+)<\/h3>/i);
            var errorMatch = reportContent.match(/<h3 id="errorDomains">(\d+)<\/h3>/i);
            var total = totalMatch ? parseInt(totalMatch[1]) : 0;
            var active = activeMatch ? parseInt(activeMatch[1]) : 0;
            var expiring = expiringMatch ? parseInt(expiringMatch[1]) : 0;
            var errors = errorMatch ? parseInt(errorMatch[1]) : 0;
            // Extract expiring domains (warnings)
            var warningDomains = [];
            var expiringDomainMatches = reportContent.matchAll(/<div class="domain-card expiring-soon"[\s\S]*?<div class="domain-name">([^<]+)<\/div>[\s\S]*?<div class="domain-url">([^<]+)<\/div>[\s\S]*?<div class="expiry-date">([^<]+)<\/div>[\s\S]*?<div class="days-remaining[^"]*">([^<]+)<\/div>/gi);
            for (var _d = 0, expiringDomainMatches_1 = expiringDomainMatches; _d < expiringDomainMatches_1.length; _d++) {
                var match = expiringDomainMatches_1[_d];
                var domainName = match[1].trim();
                var domainUrl = match[2].trim();
                var expiryDate = match[3].trim();
                var daysRemaining = match[4].trim();
                warningDomains.push("\u26A0\uFE0F ".concat(domainName, " (").concat(domainUrl, ") - ").concat(daysRemaining, " - ").concat(expiryDate));
            }
            // Extract error domains (failures)
            var failedDomains = [];
            var errorDomainMatches = reportContent.matchAll(/<div class="domain-card error-card"[\s\S]*?<div class="domain-name">([^<]+)<\/div>[\s\S]*?<div class="domain-url">([^<]+)<\/div>[\s\S]*?<div class="expiry-date">([^<]+)<\/div>/gi);
            for (var _e = 0, errorDomainMatches_1 = errorDomainMatches; _e < errorDomainMatches_1.length; _e++) {
                var match = errorDomainMatches_1[_e];
                var domainName = match[1].trim();
                var domainUrl = match[2].trim();
                var status_1 = match[3].trim();
                failedDomains.push("\uD83D\uDEA8 ".concat(domainName, " (").concat(domainUrl, ") - ").concat(status_1));
            }
            return {
                passed: active,
                failed: errors,
                warnings: expiring,
                total: total,
                failedTests: failedDomains,
                warningTests: warningDomains
            };
        }
        return { passed: 0, failed: 0, total: 0 };
    }
    catch (error) {
        console.error("Error parsing results for ".concat(result.repository, ":"), error);
        return { passed: 0, failed: 0, total: 0 };
    }
}
function generateDashboard(results, outputPath) {
    if (outputPath === void 0) { outputPath = 'unified-dashboard/index.html'; }
    var timestamp = new Date().toLocaleString();
    var totalDuration = results.reduce(function (sum, r) { return sum + r.duration; }, 0);
    // Create reports directory inside unified-dashboard
    var dashboardDir = path.dirname(outputPath);
    var reportsDir = path.join(dashboardDir, 'reports');
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir, { recursive: true });
    }
    // Create a README file in reports directory to ensure it's never empty
    var readmePath = path.join(reportsDir, 'README.txt');
    fs.writeFileSync(readmePath, 'This folder contains HTML report files from test executions.\nIf this folder is empty, it means no test reports were generated.\n');
    // Read report files and embed content
    console.log('\n📁 Reading report files to embed content...');
    console.log("\uD83D\uDCC2 Current working directory: ".concat(process.cwd()));
    results.forEach(function (result) {
        console.log("\n\uD83D\uDD0D Processing ".concat(result.repository, ":"));
        console.log("   Status: ".concat(result.status));
        console.log("   Report path from result: ".concat(result.reportPath || 'NOT SET'));
        if (result.reportPath) {
            // Convert relative path to absolute path
            var absoluteReportPath = path.isAbsolute(result.reportPath)
                ? result.reportPath
                : path.join(process.cwd(), result.reportPath);
            console.log("   Relative path: ".concat(result.reportPath));
            console.log("   Absolute path: ".concat(absoluteReportPath));
            var exists = fs.existsSync(absoluteReportPath);
            console.log("   File exists: ".concat(exists));
            if (!exists) {
                // Try to list the directory to see what's there
                var dir = path.dirname(absoluteReportPath);
                console.log("   Checking parent directory: ".concat(dir));
                if (fs.existsSync(dir)) {
                    var files = fs.readdirSync(dir);
                    console.log("   Files in directory: ".concat(files.join(', ')));
                }
                else {
                    console.log("   Parent directory does not exist!");
                }
            }
            if (exists) {
                try {
                    // Read the HTML content
                    var reportContent = fs.readFileSync(absoluteReportPath, 'utf-8');
                    result.reportContent = reportContent;
                    console.log("   \u2705 Embedded report content (".concat(reportContent.length, " bytes)"));
                }
                catch (error) {
                    console.error("   \u274C Error reading report for ".concat(result.repository, ":"), error);
                    result.reportContent = '';
                }
            }
            else {
                console.log("   \u26A0\uFE0F  Report file not found - will show \"Report Not Available\"");
                result.reportContent = '';
            }
        }
        else {
            console.log("   \u26A0\uFE0F  No report path provided - will show \"Report Not Available\"");
            result.reportContent = '';
        }
    });
    console.log('\n✅ Report embedding complete!\n');
    // Parse test results from reports
    results.forEach(function (result) {
        var parsed = parseTestResults(result);
        result.passed = parsed.passed;
        result.failed = parsed.failed;
        result.total = parsed.total;
        // Update actual status based on test results
        if (result.total > 0 && result.failed > 0) {
            result.status = 'failed';
        }
        else if (result.total > 0 && result.failed === 0) {
            result.status = 'success';
        }
    });
    // Calculate success/failed counts AFTER updating status based on actual test results
    var successCount = results.filter(function (r) { return r.status === 'success'; }).length;
    var failedCount = results.filter(function (r) { return r.status === 'failed'; }).length;
    var html = "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n    <meta charset=\"UTF-8\">\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n    <title>AdHash Unified Test Dashboard</title>\n    <style>\n        * {\n            margin: 0;\n            padding: 0;\n            box-sizing: border-box;\n        }\n\n        body {\n            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;\n            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);\n            min-height: 100vh;\n            padding: 20px 20px 60px 20px;\n        }\n\n        .container {\n            max-width: 1400px;\n            margin: 0 auto;\n        }\n\n        .top-section {\n            margin-bottom: 30px;\n        }\n\n        .bottom-section {\n            margin-top: 40px;\n            padding-top: 30px;\n            border-top: 2px solid rgba(255, 255, 255, 0.2);\n        }\n\n        .header {\n            background: white;\n            border-radius: 20px;\n            padding: 40px;\n            margin-bottom: 30px;\n            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.1);\n        }\n\n        .header h1 {\n            font-size: 42px;\n            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);\n            -webkit-background-clip: text;\n            -webkit-text-fill-color: transparent;\n            margin-bottom: 10px;\n            text-align: center;\n        }\n\n        .header .subtitle {\n            color: #666;\n            font-size: 18px;\n            margin-bottom: 20px;\n        }\n\n        .summary {\n            display: grid;\n            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));\n            gap: 20px;\n            margin-top: 20px;\n        }\n\n        .summary-card {\n            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);\n            padding: 20px;\n            border-radius: 15px;\n            text-align: center;\n        }\n\n        .summary-card .value {\n            font-size: 36px;\n            font-weight: bold;\n            color: #333;\n            margin-bottom: 5px;\n        }\n\n        .summary-card .label {\n            color: #666;\n            font-size: 14px;\n            text-transform: uppercase;\n            letter-spacing: 1px;\n        }\n\n        .summary-card.success .value { color: #10b981; }\n        .summary-card.failed .value { color: #ef4444; }\n        .summary-card.duration .value { color: #3b82f6; }\n\n        .reports-grid {\n            display: flex;\n            flex-direction: column;\n            gap: 16px;\n            margin-top: 30px;\n        }\n\n        .report-card {\n            background: white;\n            border-radius: 12px;\n            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);\n            transition: all 0.3s ease;\n            position: relative;\n            overflow: hidden;\n            border-left: 4px solid #667eea;\n        }\n\n        .report-card:hover {\n            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);\n        }\n\n        .report-card.success {\n            border-left-color: #10b981;\n        }\n\n        .report-card.failed {\n            border-left-color: #ef4444;\n        }\n\n        .report-card-main {\n            display: grid;\n            grid-template-columns: 1fr auto;\n            gap: 20px;\n            padding: 20px 24px;\n            align-items: center;\n            position: relative;\n        }\n\n        .report-icon-section {\n            display: flex;\n            align-items: center;\n            justify-content: center;\n        }\n\n        .report-icon {\n            font-size: 42px;\n            filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.1));\n        }\n\n        .report-info-section {\n            display: flex;\n            flex-direction: column;\n            gap: 8px;\n            min-width: 0;\n        }\n\n        .report-header-row {\n            display: flex;\n            align-items: center;\n            gap: 12px;\n            flex-wrap: wrap;\n        }\n\n        .report-title {\n            font-size: 18px;\n            font-weight: 700;\n            color: #1f2937;\n            margin: 0;\n        }\n\n        .report-status {\n            padding: 4px 12px;\n            border-radius: 12px;\n            font-size: 12px;\n            font-weight: 600;\n            white-space: nowrap;\n        }\n\n        .report-status.success {\n            background: #d1fae5;\n            color: #065f46;\n        }\n\n        .report-status.failed {\n            background: #fee2e2;\n            color: #991b1b;\n        }\n\n        .report-description {\n            color: #6b7280;\n            font-size: 13px;\n            line-height: 1.5;\n            margin: 0;\n        }\n\n        .report-meta {\n            display: flex;\n            flex-wrap: wrap;\n            gap: 8px;\n            margin-top: 4px;\n        }\n\n        .meta-badge {\n            background: #f3f4f6;\n            padding: 4px 10px;\n            border-radius: 6px;\n            font-size: 11px;\n            color: #4b5563;\n            font-weight: 500;\n            white-space: nowrap;\n        }\n\n        .report-status {\n            padding: 4px 12px;\n            border-radius: 12px;\n            font-size: 12px;\n            font-weight: 600;\n            white-space: nowrap;\n        }\n\n        .report-status.success {\n            background: #d1fae5;\n            color: #065f46;\n        }\n\n        .report-status.failed {\n            background: #fee2e2;\n            color: #991b1b;\n        }\n\n        .report-stats-section {\n            display: flex;\n            align-items: center;\n            gap: 12px;\n        }\n\n        .stats-group {\n            display: flex;\n            gap: 10px;\n            align-items: center;\n        }\n\n        .stat-item {\n            display: flex;\n            align-items: center;\n            gap: 4px;\n            padding: 6px 12px;\n            background: #f9fafb;\n            border-radius: 8px;\n            font-size: 13px;\n            font-weight: 600;\n            white-space: nowrap;\n        }\n\n        .stat-item.total {\n            color: #3b82f6;\n        }\n\n        .stat-item.passed {\n            color: #10b981;\n        }\n\n        .stat-item.warning {\n            color: #f59e0b;\n        }\n\n        .stat-item.failed {\n            color: #ef4444;\n        }\n\n        .view-report-btn {\n            display: inline-block;\n            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);\n            color: white;\n            padding: 12px 30px;\n            border-radius: 25px;\n            text-decoration: none;\n            font-weight: bold;\n            transition: opacity 0.3s ease;\n        }\n\n        .view-report-btn:hover {\n            opacity: 0.9;\n        }\n\n        .view-report-btn.disabled {\n            background: #9ca3af;\n            cursor: not-allowed;\n        }\n\n        .footer {\n            text-align: center;\n            color: white;\n            margin-top: 40px;\n            padding: 20px;\n        }\n\n        .error-message {\n            background: #fee2e2;\n            color: #991b1b;\n            padding: 10px;\n            border-radius: 10px;\n            margin-top: 10px;\n            font-size: 12px;\n        }\n\n        .test-counts {\n            display: flex;\n            gap: 15px;\n            margin: 15px 0;\n            flex-wrap: wrap;\n        }\n\n        .count-badge {\n            padding: 8px 16px;\n            border-radius: 20px;\n            font-size: 13px;\n            font-weight: bold;\n            display: inline-flex;\n            align-items: center;\n            gap: 5px;\n        }\n\n        .count-badge.total {\n            background: #e0e7ff;\n            color: #3730a3;\n        }\n\n        .count-badge.passed {\n            background: #d1fae5;\n            color: #065f46;\n        }\n\n        .count-badge.failed {\n            background: #fee2e2;\n            color: #991b1b;\n        }\n\n        .failed-tests {\n            background: #fef2f2;\n            border-left: 4px solid #ef4444;\n            padding: 12px 16px;\n            border-radius: 8px;\n            margin: 12px 24px 0 24px;\n        }\n\n        .failed-tests-title {\n            font-weight: bold;\n            color: #991b1b;\n            margin-bottom: 8px;\n            font-size: 13px;\n        }\n\n        .failed-test-item {\n            color: #7f1d1d;\n            font-size: 12px;\n            padding: 4px 0;\n            padding-left: 16px;\n            position: relative;\n        }\n\n        .failed-test-item::before {\n            content: '\u2022';\n            position: absolute;\n            left: 4px;\n            color: #ef4444;\n        }\n\n        .warning-tests {\n            background: #fffbeb;\n            border-left: 4px solid #f59e0b;\n            padding: 12px 16px;\n            border-radius: 8px;\n            margin: 12px 24px 0 24px;\n        }\n\n        .warning-tests-title {\n            font-weight: bold;\n            color: #92400e;\n            margin-bottom: 8px;\n            font-size: 13px;\n        }\n\n        .warning-test-item {\n            color: #78350f;\n            font-size: 12px;\n            padding: 4px 0;\n            padding-left: 16px;\n            position: relative;\n        }\n\n        .warning-test-item::before {\n            content: '\u2022';\n            position: absolute;\n            left: 4px;\n            color: #f59e0b;\n        }\n\n        .expand-btn {\n            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);\n            color: white;\n            border: none;\n            padding: 10px 20px;\n            border-radius: 8px;\n            cursor: pointer;\n            font-size: 13px;\n            font-weight: 600;\n            position: absolute;\n            bottom: 20px;\n            right: 24px;\n            display: flex;\n            align-items: center;\n            justify-content: center;\n            gap: 8px;\n            transition: all 0.3s ease;\n        }\n\n        .expand-btn:hover {\n            transform: translateY(-1px);\n            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);\n        }\n\n        .expand-btn.disabled {\n            background: #9ca3af;\n            cursor: not-allowed;\n            opacity: 0.6;\n        }\n\n        .expand-btn.disabled:hover {\n            transform: none;\n            box-shadow: none;\n        }\n\n        .detailed-report-container {\n            display: none;\n            margin: 60px 24px 16px 24px;\n            border: 2px solid #e5e7eb;\n            border-radius: 12px;\n            overflow: hidden;\n            background: white;\n        }\n\n        .detailed-report-container.expanded {\n            display: block;\n        }\n\n        .detailed-report-header {\n            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);\n            color: white;\n            padding: 16px 20px;\n            display: flex;\n            justify-content: space-between;\n            align-items: center;\n        }\n\n        .detailed-report-header h3 {\n            margin: 0;\n            font-size: 16px;\n            font-weight: 600;\n        }\n\n        .collapse-btn {\n            background: rgba(255, 255, 255, 0.2);\n            border: 1px solid rgba(255, 255, 255, 0.3);\n            color: white;\n            padding: 6px 16px;\n            border-radius: 6px;\n            cursor: pointer;\n            font-size: 13px;\n            font-weight: 500;\n            transition: all 0.2s ease;\n        }\n\n        .collapse-btn:hover {\n            background: rgba(255, 255, 255, 0.3);\n        }\n\n        .detailed-report-content {\n            padding: 0;\n            max-height: 600px;\n            overflow-y: auto;\n        }\n\n        .detailed-report-content iframe {\n            width: 100%;\n            min-height: 600px;\n            border: none;\n        }\n\n        .arrow-icon {\n            transition: transform 0.3s ease;\n        }\n\n        .expand-btn.expanded .arrow-icon {\n            transform: rotate(180deg);\n        }\n\n        .report-card-content {\n            padding-bottom: 60px;\n            position: relative;\n        }\n    </style>\n</head>\n<body>\n    <div class=\"container\">\n        <!-- TOP SECTION -->\n        <div class=\"top-section\">\n            <div class=\"header\">\n                <h1>Ad-Hash Projects Status Dashboard</h1>\n                <div class=\"subtitle\">Comprehensive test results from all repositories</div>\n                <div class=\"subtitle\">Generated: ".concat(timestamp, "</div>\n\n                <div class=\"summary\">\n                    <div class=\"summary-card success\">\n                        <div class=\"value\">").concat(successCount, "</div>\n                        <div class=\"label\">Successful</div>\n                    </div>\n                    <div class=\"summary-card failed\">\n                        <div class=\"value\">").concat(failedCount, "</div>\n                        <div class=\"label\">Failed</div>\n                    </div>\n                    <div class=\"summary-card\">\n                        <div class=\"value\">").concat(results.length, "</div>\n                        <div class=\"label\">Total Suites</div>\n                    </div>\n                    <div class=\"summary-card duration\">\n                        <div class=\"value\">").concat((totalDuration / 1000).toFixed(1), "s</div>\n                        <div class=\"label\">Total Duration</div>\n                    </div>\n                </div>\n            </div>\n        </div>\n\n        <!-- MAIN SECTION - TEST RESULTS -->\n        <div class=\"reports-grid\">\n").concat(results.map(function (result) { return generateReportCard(result); }).join('\n'), "\n        </div>\n\n        <!-- BOTTOM SECTION -->\n        <div class=\"bottom-section\">\n            <div class=\"footer\">\n                <p>Ad-Hash Technolabs Pvt Ltd - Automated Test Monitoring System</p>\n                <p style=\"margin-top: 10px; opacity: 0.8;\">All tests executed from original repositories</p>\n            </div>\n        </div>\n    </div>\n\n    <script>\n        function toggleReport(repoId) {\n            const container = document.getElementById('report-' + repoId);\n            const btn = document.getElementById('btn-' + repoId);\n\n            if (container.classList.contains('expanded')) {\n                container.classList.remove('expanded');\n                btn.classList.remove('expanded');\n                btn.innerHTML = '<span>\uD83D\uDCC4 View Detailed Report</span><span class=\"arrow-icon\">\u25BC</span>';\n            } else {\n                container.classList.add('expanded');\n                btn.classList.add('expanded');\n                btn.innerHTML = '<span>\uD83D\uDCC4 Hide Detailed Report</span><span class=\"arrow-icon\">\u25B2</span>';\n            }\n        }\n\n        function collapseReport(repoId) {\n            const container = document.getElementById('report-' + repoId);\n            const btn = document.getElementById('btn-' + repoId);\n\n            container.classList.remove('expanded');\n            btn.classList.remove('expanded');\n            btn.innerHTML = '<span>\uD83D\uDCC4 View Detailed Report</span><span class=\"arrow-icon\">\u25BC</span>';\n        }\n    </script>\n</body>\n</html>");
    // Create output directory if it doesn't exist
    var outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    // Write the HTML file
    fs.writeFileSync(outputPath, html, 'utf-8');
    console.log("\u2705 Dashboard generated: ".concat(outputPath));
}
function generateReportCard(result) {
    var info = repoInfo[result.repository];
    if (!info)
        return '';
    var duration = (result.duration / 1000).toFixed(2);
    // Parse test results from report
    var parsed = parseTestResults(result);
    var passed = parsed.passed, failed = parsed.failed, warnings = parsed.warnings, total = parsed.total, failedTests = parsed.failedTests, warningTests = parsed.warningTests;
    // Determine actual status based on test results
    // If we have test results, use them to determine status
    // Otherwise, fall back to the command execution status
    var actualStatus = result.status;
    if (total > 0 && failed > 0) {
        actualStatus = 'failed';
    }
    else if (total > 0 && failed === 0) {
        actualStatus = 'success';
    }
    var statusClass = actualStatus === 'success' ? 'success' : 'failed';
    var statusText = actualStatus === 'success' ? '✅ Passed' : '❌ Failed';
    // Generate test counts HTML
    var testCountsHtml = '';
    if (total > 0) {
        testCountsHtml = "\n                <div class=\"test-counts\">\n                    <span class=\"count-badge total\">\uD83D\uDCCA Total: ".concat(total, "</span>\n                    <span class=\"count-badge passed\">\u2705 Passed: ").concat(passed, "</span>\n                    ").concat(warnings && warnings > 0 ? "<span class=\"count-badge\" style=\"background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);\">\u26A0\uFE0F Warnings: ".concat(warnings, "</span>") : '', "\n                    ").concat(failed > 0 ? "<span class=\"count-badge failed\">\u274C Failed: ".concat(failed, "</span>") : '', "\n                </div>");
    }
    // Generate warning tests details HTML
    var warningTestsHtml = '';
    if (warningTests && warningTests.length > 0) {
        var warningTestsList = warningTests.map(function (test) { return "\n                        <div class=\"warning-test-item\">".concat(test, "</div>"); }).join('');
        // Determine title based on repository type
        var warningTitle = '⚠️ Warnings:';
        if (result.repository === 'Adhash_AllProjects_Server') {
            warningTitle = '⚠️ Unhealthy Servers (Warnings):';
        }
        else if (result.repository === 'AdHash-Projects-Certificate-Expiry-Test') {
            warningTitle = '⚠️ Certificates Expiring Soon (≤30 days):';
        }
        else if (result.repository === 'AdHash_Domain_Report') {
            warningTitle = '⚠️ Domains Expiring Soon (<90 days):';
        }
        warningTestsHtml = "\n                <div class=\"warning-tests\">\n                    <div class=\"warning-tests-title\">".concat(warningTitle, "</div>\n                    ").concat(warningTestsList, "\n                </div>");
    }
    // Generate failed tests details HTML
    var failedTestsHtml = '';
    if (failedTests && failedTests.length > 0) {
        var failedTestsList = failedTests.map(function (test) { return "\n                        <div class=\"failed-test-item\">".concat(test, "</div>"); }).join('');
        // Determine title based on repository type
        var failedTitle = '❌ Failed Tests:';
        if (result.repository === 'Adhash_AllProjects_Server') {
            failedTitle = '❌ Down Servers (Failed):';
        }
        else if (result.repository === 'AdHash-Projects-Certificate-Expiry-Test') {
            failedTitle = '❌ Expired Certificates (Failed):';
        }
        else if (result.repository === 'AdHash_Domain_Report') {
            failedTitle = '❌ Domain Lookup Errors:';
        }
        failedTestsHtml = "\n                <div class=\"failed-tests\">\n                    <div class=\"failed-tests-title\">".concat(failedTitle, "</div>\n                    ").concat(failedTestsList, "\n                </div>");
    }
    // Generate unique ID for this report
    var repoId = result.repository.replace(/[^a-zA-Z0-9]/g, '_');
    var reportContent = result.reportContent || '';
    var hasReport = reportContent.length > 0;
    // Create embedded report HTML
    var embeddedReportHtml = '';
    if (hasReport) {
        // Use data URI with base64 encoding for better compatibility
        var base64Content = Buffer.from(reportContent, 'utf-8').toString('base64');
        var dataUri = "data:text/html;base64,".concat(base64Content);
        embeddedReportHtml = "\n                <button class=\"expand-btn\" id=\"btn-".concat(repoId, "\" onclick=\"toggleReport('").concat(repoId, "')\">\n                    <span>\uD83D\uDCC4 View Detailed Report</span>\n                    <span class=\"arrow-icon\">\u25BC</span>\n                </button>\n\n                <div class=\"detailed-report-container\" id=\"report-").concat(repoId, "\">\n                    <div class=\"detailed-report-header\">\n                        <h3>\uD83D\uDCCA Detailed Test Report - ").concat(info.displayName, "</h3>\n                        <button class=\"collapse-btn\" onclick=\"collapseReport('").concat(repoId, "')\">\u2715 Close</button>\n                    </div>\n                    <div class=\"detailed-report-content\">\n                        <iframe src=\"").concat(dataUri, "\"></iframe>\n                    </div>\n                </div>");
    }
    else {
        embeddedReportHtml = "\n                <button class=\"expand-btn disabled\" disabled>\n                    <span>\uD83D\uDCC4 Report Not Available</span>\n                </button>";
    }
    // Create stats HTML for horizontal display
    var statsHtml = total > 0 ? "\n                    <div class=\"report-stats-section\">\n                        <div class=\"stats-group\">\n                            <div class=\"stat-item total\">\uD83D\uDCCA ".concat(total, "</div>\n                            <div class=\"stat-item passed\">\u2705 ").concat(passed, "</div>\n                            ").concat((warnings || 0) > 0 ? "<div class=\"stat-item warning\">\u26A0\uFE0F ".concat(warnings, "</div>") : '', "\n                            ").concat(failed > 0 ? "<div class=\"stat-item failed\">\u274C ".concat(failed, "</div>") : '', "\n                        </div>\n                    </div>") : '';
    return "            <div class=\"report-card ".concat(statusClass, "\">\n                <div class=\"report-card-content\">\n                    <div class=\"report-card-main\">\n                        <div class=\"report-info-section\">\n                            <div class=\"report-header-row\">\n                                <div class=\"report-title\">").concat(info.displayName, "</div>\n                                <div class=\"report-status ").concat(statusClass, "\">").concat(statusText, "</div>\n                            </div>\n                            <div class=\"report-description\">").concat(info.description, "</div>\n                            <div class=\"report-meta\">\n                                <span class=\"meta-badge\">\uD83D\uDCCA ").concat(info.testCount, "</span>\n                                <span class=\"meta-badge\">\u2699\uFE0F ").concat(info.technology, "</span>\n                                <span class=\"meta-badge\">\u23F1\uFE0F ").concat(duration, "s</span>\n                            </div>\n                        </div>\n\n                        ").concat(statsHtml, "\n                    </div>\n\n                    ").concat(warningTestsHtml, "\n\n                    ").concat(failedTestsHtml, "\n\n                    ").concat(embeddedReportHtml, "\n                </div>\n            </div>");
}

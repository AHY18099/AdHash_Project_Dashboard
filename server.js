const express = require('express');
const { exec } = require('child_process');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = 7777;

// Parse JSON bodies
app.use(express.json());

// Project-wise server organization
const projects = {
    'AutoChecker': {
        name: 'AutoChecker',
        icon: '🚗',
        servers: [
            { name: 'Auto Search', url: 'http://20.7.146.191:3000/' },
            { name: 'Manual Search', url: 'http://20.15.121.70:3000/' },
            { name: 'PartSouq', url: 'http://20.62.109.239:3000/' },
            { name: 'Admin', url: 'https://manage.autochecker.com/' },
            { name: 'Admin API', url: 'https://manageadminapi.autochecker.com/' },
            { name: 'Mobile API', url: 'https://managemobileapi.autochecker.com/' },
            { name: 'eBay API', url: 'https://ebaydev.autochecker.com/' }
        ]
    },
    'WavedIn': {
        name: 'WavedIn',
        icon: '🌊',
        servers: [
            { name: 'Mobile API', url: 'https://mobileliveapi.wavedin.app/' },
            { name: 'Super Admin', url: 'https://superadmin.wavedin.app/' }
        ]
    },
    'Zapai': {
        name: 'Zapai/ZapCRM',
        icon: '⚡',
        servers: [
            { name: 'Zapai Web', url: 'https://www.zapai.us/' },
            { name: 'ZapCRM Admin', url: 'https://zapcrm.io/' },
            { name: 'ZapCRM Lead', url: 'https://lead.zapcrm.io/' },
            { name: 'ZapCRM API', url: 'https://api.zapcrm.io/' }
        ]
    },
    'Algomax': {
        name: 'Algomax',
        icon: '📊',
        servers: [
            { name: 'GoPocket', url: 'https://gopocket.algomax.co/' }
        ]
    },
    'SMC': {
        name: 'SMC',
        icon: '🎬',
        servers: [
            { name: 'API', url: 'https://api.sendmovieclips.com/' }
        ]
    },
    'Metcalf': {
        name: 'Metcalf',
        icon: '🤖',
        servers: [
            { name: 'Web', url: 'https://metcalf.ai/' }
        ]
    },
    'AdHash': {
        name: 'AdHash',
        icon: '🚀',
        servers: [
            { name: 'Web', url: 'https://adhashtech.com/' }
        ]
    },
    'Humee': {
        name: 'Humee',
        icon: '💼',
        servers: [
            { name: 'Admin', url: 'https://humee.com/' },
            { name: 'API', url: 'https://api.humee.com/' }
        ]
    },
    'AiSignPro': {
        name: 'AiSignPro',
        icon: '✍️',
        servers: [
            { name: 'Admin', url: 'https://admin.aisignpro.com/' },
            { name: 'API', url: 'https://api.aisignpro.com/' }
        ]
    },
    'Synctag': {
        name: 'Synctag',
        icon: '🔗',
        servers: [
            { name: 'API', url: 'https://spark.synctag.com/' }
        ]
    }
};

// Flatten servers for backward compatibility
const servers = Object.values(projects).flatMap(project =>
    project.servers.map(server => ({
        ...server,
        name: `${project.name} - ${server.name}`,
        project: project.name
    }))
);

// Store SSE clients
let clients = [];

// API endpoint to get test suite counts WITHOUT running tests
app.get('/api/test-counts', (req, res) => {
    const fs = require('fs');
    const path = require('path');

    const counts = {
        appStatus: 0,
        serverHealth: 0,
        sslCertificate: 0,
        apiEndpoint: 0,
        domainExpiry: 0,
        total: 0
    };

    try {
        // Count App Status tests (from Adhash_App_Status/tests/unified.spec.ts)
        const appStatusTestPath = path.join(__dirname, 'Adhash_App_Status', 'tests', 'unified.spec.ts');
        if (fs.existsSync(appStatusTestPath)) {
            const content = fs.readFileSync(appStatusTestPath, 'utf8');
            // Count test() calls
            const testMatches = content.match(/test\(/g);
            counts.appStatus = testMatches ? testMatches.length : 0;
        }

        // Count Server Health tests (from Adhash_AllProjects_Server/monitorMultipleServers.ts)
        const serverHealthPath = path.join(__dirname, 'Adhash_AllProjects_Server', 'monitorMultipleServers.ts');
        if (fs.existsSync(serverHealthPath)) {
            const content = fs.readFileSync(serverHealthPath, 'utf8');
            // Count servers in the array
            const serverMatches = content.match(/{\s*name:/g);
            counts.serverHealth = serverMatches ? serverMatches.length : 0;
        }

        // Count SSL Certificate tests (from AdHash-Projects-Certificate-Expiry-Test/src/test/java)
        const certTestPath = path.join(__dirname, 'AdHash-Projects-Certificate-Expiry-Test', 'src', 'test', 'java', 'Certify', 'CertificateExpiryTestNG.java');
        if (fs.existsSync(certTestPath)) {
            const content = fs.readFileSync(certTestPath, 'utf8');
            // Count project entries in the array
            const projectMatches = content.match(/{\s*"/g);
            counts.sslCertificate = projectMatches ? projectMatches.length : 0;
        }

        // Count API tests (from AdHash-API-Test/TestNG.xml)
        const apiTestPath = path.join(__dirname, 'AdHash-API-Test', 'TestNG.xml');
        if (fs.existsSync(apiTestPath)) {
            const content = fs.readFileSync(apiTestPath, 'utf8');
            // Count include methods
            const includeMatches = content.match(/<include name="/g);
            counts.apiEndpoint = includeMatches ? includeMatches.length : 0;
        }

        // Count Domain Expiry tests (from AdHash_Domain_Report/godaddy/index.js)
        const domainTestPath = path.join(__dirname, 'AdHash_Domain_Report', 'godaddy', 'index.js');
        if (fs.existsSync(domainTestPath)) {
            const content = fs.readFileSync(domainTestPath, 'utf8');
            // Count domain entries
            const domainMatches = content.match(/domain:/g);
            counts.domainExpiry = domainMatches ? domainMatches.length : 0;
        }

        counts.total = counts.appStatus + counts.serverHealth + counts.sslCertificate + counts.apiEndpoint + counts.domainExpiry;

        res.json({
            status: 'success',
            counts: counts
        });
    } catch (error) {
        console.error('Error counting tests:', error);
        res.json({
            status: 'error',
            message: error.message,
            counts: counts
        });
    }
});

// Helper function to check if a process is actually running
function isProcessRunning(pid) {
    if (!pid) return false;
    try {
        // Sending signal 0 checks if process exists without killing it
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
}

// API endpoint to check if tests are running
app.get('/api/test-status', (req, res) => {
    // Auto-recover from stuck state: if testRunning is true but process is dead, reset state
    if (testRunning && !isProcessRunning(testProcessPid)) {
        console.log('⚠️ Test process is dead but flag is stuck. Auto-resetting state...');
        testRunning = false;
        testProcessPid = null;
        currentSuite = null;
    }

    res.json({
        running: testRunning,
        hasResults: testResults !== null
    });
});

// API endpoint to get test results
app.get('/api/test-results', (req, res) => {
    try {
        // Check if unified dashboard exists
        const unifiedDashboard = path.join(__dirname, 'unified-dashboard', 'index.html');
        if (!fs.existsSync(unifiedDashboard)) {
            return res.json({ status: 'no-results', message: 'No test results available yet' });
        }

        const html = fs.readFileSync(unifiedDashboard, 'utf8');

        // Calculate suite counts (not test counts)
        let passedSuites = 0;
        let failedSuites = 0;
        let warningSuites = 0;
        let skippedSuites = 0;
        let totalSuites = 5;
        let completedSuites = 0;

        // Extract stats for each suite - match all stat-item divs within stats-group
        const suites = [
            { name: 'App Status', regex: /App Status Verification[\s\S]*?<div class="stats-group">\s*((?:<div class="stat-item[^"]*">[\s\S]*?<\/div>\s*)+)<\/div>/ },
            { name: 'Server Health', regex: /Server Health Monitoring[\s\S]*?<div class="stats-group">\s*((?:<div class="stat-item[^"]*">[\s\S]*?<\/div>\s*)+)<\/div>/ },
            { name: 'SSL Certificate', regex: /SSL Certificate Monitoring[\s\S]*?<div class="stats-group">\s*((?:<div class="stat-item[^"]*">[\s\S]*?<\/div>\s*)+)<\/div>/ },
            { name: 'API Endpoint', regex: /API Endpoint Testing[\s\S]*?<div class="stats-group">\s*((?:<div class="stat-item[^"]*">[\s\S]*?<\/div>\s*)+)<\/div>/ },
            { name: 'Domain Expiry', regex: /Domain Expiry Monitoring[\s\S]*?<div class="stats-group">\s*((?:<div class="stat-item[^"]*">[\s\S]*?<\/div>\s*)+)<\/div>/ }
        ];

        // Helper function to parse stats from the captured stats-group HTML
        function parseStatsGroup(statsHtml) {
            const totalMatch = statsHtml.match(/<div class="stat-item total">[\s\S]*?(\d+)<\/div>/);
            const passedMatch = statsHtml.match(/<div class="stat-item passed">[\s\S]*?(\d+)<\/div>/);
            const warningMatch = statsHtml.match(/<div class="stat-item warning">[\s\S]*?(\d+)<\/div>/);

            return {
                total: totalMatch ? parseInt(totalMatch[1]) : 0,
                passed: passedMatch ? parseInt(passedMatch[1]) : 0,
                warning: warningMatch ? parseInt(warningMatch[1]) : 0
            };
        }

        suites.forEach(suite => {
            const match = html.match(suite.regex);
            if (match) {
                const stats = parseStatsGroup(match[1]);
                const total = stats.total;
                const passed = stats.passed;
                const warning = stats.warning;
                const failed = total - passed - warning;

                completedSuites++;

                // Determine suite status (priority: failed > warning > passed)
                if (failed > 0) {
                    failedSuites++;
                } else if (warning > 0) {
                    warningSuites++;
                } else if (passed === total && total > 0) {
                    passedSuites++;
                }
            }
        });

        // Skipped suites = total - completed
        skippedSuites = totalSuites - completedSuites;

        if (completedSuites > 0) {
            res.json({
                status: 'completed',
                passedSuites: passedSuites,
                failedSuites: failedSuites,
                warningSuites: warningSuites,
                skippedSuites: skippedSuites,
                totalSuites: totalSuites
            });
        } else {
            res.json({ status: 'no-results', message: 'No test results available yet' });
        }
    } catch (error) {
        console.error('Error getting test results:', error);
        res.json({ status: 'error', message: error.message });
    }
});

// API endpoint to get detailed test results per suite
app.get('/api/detailed-results', (req, res) => {
    const detailedResults = {
        app: { status: 'not-run', passed: 0, failed: 0, warning: 0, total: 0, details: [] },
        server: { status: 'not-run', passed: 0, failed: 0, warning: 0, total: 0, details: [] },
        cert: { status: 'not-run', passed: 0, failed: 0, warning: 0, total: 0, details: [] },
        api: { status: 'not-run', passed: 0, failed: 0, warning: 0, total: 0, details: [] },
        domain: { status: 'not-run', passed: 0, failed: 0, warning: 0, total: 0, details: [] }
    };

    try {
        // Parse App Status results from unified dashboard
        const unifiedDashboard = path.join(__dirname, 'unified-dashboard', 'index.html');
        if (fs.existsSync(unifiedDashboard)) {
            const html = fs.readFileSync(unifiedDashboard, 'utf8');

            // Extract App Status section
            const appMatch = html.match(/App Status Verification[\s\S]*?<div class="stat-item total">📊 (\d+)<\/div>[\s\S]*?<div class="stat-item passed">✅ (\d+)<\/div>/);
            if (appMatch) {
                const total = parseInt(appMatch[1]);
                const passed = parseInt(appMatch[2]);
                detailedResults.app.total = total;
                detailedResults.app.passed = passed;
                detailedResults.app.failed = total - passed;
                detailedResults.app.warning = 0;
                detailedResults.app.status = detailedResults.app.failed > 0 ? 'failed' : 'passed';
            }

            // Extract Server Health section - look for "22 servers" in meta-badge
            const serverTotalMatch = html.match(/Server Health Monitoring[\s\S]*?<span class="meta-badge">📊 (\d+) servers<\/span>/);
            const serverMatch = html.match(/Server Health Monitoring[\s\S]*?<div class="stat-item total">📊 (\d+)<\/div>[\s\S]*?<div class="stat-item passed">✅ (\d+)<\/div>[\s\S]*?<div class="stat-item warning">⚠️ (\d+)<\/div>/);
            if (serverMatch) {
                const total = serverTotalMatch ? parseInt(serverTotalMatch[1]) : parseInt(serverMatch[1]);
                const passed = parseInt(serverMatch[2]);
                const warning = parseInt(serverMatch[3]);
                detailedResults.server.total = total;
                detailedResults.server.passed = passed;
                detailedResults.server.warning = warning;
                detailedResults.server.failed = total - passed - warning;
                // Determine status: failed > warning > passed
                if (detailedResults.server.failed > 0) {
                    detailedResults.server.status = 'failed';
                } else if (detailedResults.server.warning > 0) {
                    detailedResults.server.status = 'warning';
                } else {
                    detailedResults.server.status = 'passed';
                }
            }

            // Extract SSL Certificate section
            const certMatch = html.match(/SSL Certificate Monitoring[\s\S]*?<div class="stat-item total">📊 (\d+)<\/div>[\s\S]*?<div class="stat-item passed">✅ (\d+)<\/div>[\s\S]*?<div class="stat-item warning">⚠️ (\d+)<\/div>/);
            if (certMatch) {
                const total = parseInt(certMatch[1]);
                const passed = parseInt(certMatch[2]);
                const warning = parseInt(certMatch[3]);
                detailedResults.cert.total = total;
                detailedResults.cert.passed = passed;
                detailedResults.cert.warning = warning;
                detailedResults.cert.failed = total - passed - warning;
                // Determine status: failed > warning > passed
                if (detailedResults.cert.failed > 0) {
                    detailedResults.cert.status = 'failed';
                } else if (detailedResults.cert.warning > 0) {
                    detailedResults.cert.status = 'warning';
                } else {
                    detailedResults.cert.status = 'passed';
                }
            }

            // Extract API Endpoint section
            const apiMatch = html.match(/API Endpoint Testing[\s\S]*?<div class="stat-item total">📊 (\d+)<\/div>[\s\S]*?<div class="stat-item passed">✅ (\d+)<\/div>/);
            if (apiMatch) {
                const total = parseInt(apiMatch[1]);
                const passed = parseInt(apiMatch[2]);
                detailedResults.api.total = total;
                detailedResults.api.passed = passed;
                detailedResults.api.failed = total - passed;
                detailedResults.api.warning = 0;
                detailedResults.api.status = detailedResults.api.failed > 0 ? 'failed' : 'passed';
            }

            // Extract Domain Expiry section
            const domainMatch = html.match(/Domain Expiry Monitoring[\s\S]*?<div class="stat-item total">📊 (\d+)<\/div>[\s\S]*?<div class="stat-item passed">✅ (\d+)<\/div>[\s\S]*?<div class="stat-item warning">⚠️ (\d+)<\/div>/);
            if (domainMatch) {
                const total = parseInt(domainMatch[1]);
                const passed = parseInt(domainMatch[2]);
                const warning = parseInt(domainMatch[3]);
                detailedResults.domain.total = total;
                detailedResults.domain.passed = passed;
                detailedResults.domain.warning = warning;
                detailedResults.domain.failed = total - passed - warning;
                // Determine status: failed > warning > passed
                if (detailedResults.domain.failed > 0) {
                    detailedResults.domain.status = 'failed';
                } else if (detailedResults.domain.warning > 0) {
                    detailedResults.domain.status = 'warning';
                } else {
                    detailedResults.domain.status = 'passed';
                }
            }
        }

        res.json({
            status: 'success',
            results: detailedResults
        });
    } catch (error) {
        console.error('Error parsing detailed results:', error);
        res.json({
            status: 'error',
            message: error.message,
            results: detailedResults
        });
    }
});

// API endpoint to get embedded HTML report for a specific suite
app.get('/api/embedded-report/:suite', (req, res) => {
    const suite = req.params.suite;

    // Map suite names to repository IDs (as they appear in unified dashboard)
    const suiteMapping = {
        'app': 'Adhash_App_Status',
        'server': 'Adhash_AllProjects_Server',
        'cert': 'AdHash_Projects_Certificate_Expiry_Test',
        'api': 'AdHash_API_Test',
        'domain': 'AdHash_Domain_Report'
    };

    const repoName = suiteMapping[suite];
    if (!repoName) {
        return res.status(400).json({ status: 'error', message: 'Invalid suite name' });
    }

    try {
        const unifiedDashboard = path.join(__dirname, 'unified-dashboard', 'index.html');
        if (!fs.existsSync(unifiedDashboard)) {
            return res.status(404).json({ status: 'error', message: 'Unified dashboard not found' });
        }

        const html = fs.readFileSync(unifiedDashboard, 'utf8');

        // Extract the iframe content for this suite
        const iframeRegex = new RegExp(`<div class="detailed-report-container" id="report-${repoName}">[\\s\\S]*?<iframe src="data:text/html;base64,([^"]+)"[\\s\\S]*?<\\/iframe>`, 'i');
        const match = html.match(iframeRegex);

        if (match && match[1]) {
            // Decode the base64 content
            const decodedHtml = Buffer.from(match[1], 'base64').toString('utf8');
            res.send(decodedHtml);
        } else {
            res.status(404).json({ status: 'error', message: 'Report not found for this suite' });
        }
    } catch (error) {
        console.error('Error getting embedded report:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Helper function to add log
function addLog(message, type = 'info') {
    testLogs.push({
        message,
        type,
        timestamp: new Date().toISOString()
    });
    console.log(`[${type.toUpperCase()}] ${message}`);
}

// API endpoint to get test logs
app.get('/api/test-logs', (req, res) => {
    const fromIndex = parseInt(req.query.from) || 0;
    const newLogs = testLogs.slice(fromIndex);

    res.json({
        status: 'success',
        logs: newLogs,
        nextIndex: testLogs.length,
        currentSuite: currentSuite
    });
});

// API endpoint to reset test state (for debugging)
app.post('/api/reset-state', (req, res) => {
    console.log('🔄 Resetting test state...');
    testRunning = false;
    testResults = null;
    testLogs = [];
    currentSuite = null;
    testProcessPid = null;
    res.json({ status: 'reset', message: 'Test state has been reset' });
});

// API endpoint to run a single test suite
app.post('/api/run-single-suite/:suite', (req, res) => {
    const { exec } = require('child_process');
    const suite = req.params.suite;

    // Map suite names to commands
    const suiteCommands = {
        'app': {
            name: 'App Status Verification',
            dir: 'Adhash_App_Status',
            command: 'mvn clean test -DsuiteXmlFile=TestNG.xml'
        },
        'server': {
            name: 'Server Health Monitoring',
            dir: 'Adhash_AllProjects_Server',
            command: 'npx ts-node checkMultipleServers.ts'
        },
        'cert': {
            name: 'SSL Certificate Monitoring',
            dir: 'AdHash-Projects-Certificate-Expiry-Test',
            command: 'mvn clean test -DsuiteXmlFile=TestNG.xml'
        },
        'api': {
            name: 'API Endpoint Testing',
            dir: 'AdHash-API-Test',
            command: 'mvn clean test -DsuiteXmlFile=TestNG.xml'
        },
        'domain': {
            name: 'Domain Expiry Monitoring',
            dir: 'AdHash_Domain_Report',
            command: 'cd godaddy && npm install && node index.js'
        }
    };

    const suiteConfig = suiteCommands[suite];
    if (!suiteConfig) {
        return res.status(400).json({ status: 'error', message: 'Invalid suite name' });
    }

    console.log(`\n🚀 Running ${suiteConfig.name}...`);
    addLog(`🚀 Running ${suiteConfig.name}...`, 'info');

    res.json({ status: 'success', message: `Running ${suiteConfig.name}...` });

    // Run the test suite
    const testProcess = exec(suiteConfig.command, { cwd: path.join(__dirname, suiteConfig.dir) });

    testProcess.stdout.on('data', (data) => {
        console.log(data.toString());
    });

    testProcess.stderr.on('data', (data) => {
        console.error(data.toString());
    });

    testProcess.on('exit', (code) => {
        console.log(`✅ ${suiteConfig.name} completed with code ${code}`);
        addLog(`✅ ${suiteConfig.name} completed`, code === 0 ? 'success' : 'error');

        // Trigger unified dashboard regeneration
        setTimeout(() => {
            const regenerateProcess = exec('npx ts-node run-all-tests.ts --regenerate-only', { cwd: __dirname });
            regenerateProcess.on('exit', () => {
                console.log('📊 Unified dashboard regenerated');
            });
        }, 1000);
    });
});

// API endpoint to trigger test run
app.post('/api/run-tests', (req, res) => {
    const { exec } = require('child_process');

    if (testRunning) {
        return res.json({ status: 'already-running', message: 'Tests are already running' });
    }

    console.log('\n🚀 Starting test execution...');
    testRunning = true;
    testResults = null;
    testLogs = [];
    currentSuite = null;
    testProcessPid = null;

    res.json({ status: 'started', message: 'Tests are running in the background...' });

    addLog('🚀 Starting sequential test execution...', 'info');
    addLog('📋 Running 5 test suites one by one...', 'info');

    // Run the unified test framework
    const testProcess = exec('npx ts-node run-all-tests.ts', { cwd: __dirname });

    // Store the process PID for state recovery
    testProcessPid = testProcess.pid;
    console.log(`📌 Test process started with PID: ${testProcessPid}`);

    // Capture stdout in real-time
    testProcess.stdout.on('data', (data) => {
        const output = data.toString();
        console.log(output);

        // Parse output to detect which suite is running
        if (output.includes('App Status')) {
            currentSuite = '📱 App Status Verification';
            addLog('Starting App Status Verification tests...', 'running');
        } else if (output.includes('Server Health')) {
            currentSuite = '🖥️ Server Health Monitoring';
            addLog('Starting Server Health Monitoring tests...', 'running');
        } else if (output.includes('SSL') || output.includes('Certificate')) {
            currentSuite = '🔒 SSL Certificate Monitoring';
            addLog('Starting SSL Certificate Monitoring tests...', 'running');
        } else if (output.includes('API Test')) {
            currentSuite = '🌐 API Endpoint Testing';
            addLog('Starting API Endpoint Testing tests...', 'running');
        } else if (output.includes('Domain Report') || output.includes('Domain Expiry')) {
            currentSuite = '🌐 Domain Expiry Monitoring';
            addLog('Starting Domain Expiry Monitoring tests...', 'running');
        }

        // Log test progress
        if (output.includes('PASS') || output.includes('✓')) {
            addLog(`✅ ${output.trim()}`, 'success');
        } else if (output.includes('FAIL') || output.includes('✗')) {
            addLog(`❌ ${output.trim()}`, 'error');
        } else if (output.trim().length > 0 && !output.includes('[')) {
            addLog(output.trim(), 'info');
        }
    });

    // Capture stderr
    testProcess.stderr.on('data', (data) => {
        const error = data.toString();
        if (error.trim().length > 0) {
            addLog(`⚠️ ${error.trim()}`, 'warning');
        }
    });

    // Function to parse and finalize results
    const finalizeResults = (code) => {
        if (!testRunning) return; // Already finalized

        testRunning = false;
        currentSuite = null;
        testProcessPid = null;

        if (code !== 0) {
            addLog(`⚠️ Test process exited with code ${code}`, 'warning');
        } else {
            addLog('✅ All tests completed successfully!', 'success');
        }

        addLog('📊 Parsing test results...', 'info');

        // Parse results from unified dashboard (always try to parse, even if exit code != 0)
        const dashboardPath = path.join(__dirname, 'unified-dashboard', 'index.html');
        if (fs.existsSync(dashboardPath)) {
            try {
                const html = fs.readFileSync(dashboardPath, 'utf8');

                // Extract summary stats
                const totalMatch = html.match(/Total Suites[^>]*>(\d+)/i);
                const successMatch = html.match(/Successful[^>]*>(\d+)/i);
                const failedMatch = html.match(/Failed[^>]*>(\d+)/i);

                const passed = successMatch ? parseInt(successMatch[1]) : 0;
                const failed = failedMatch ? parseInt(failedMatch[1]) : 0;

                testResults = {
                    status: 'completed',
                    totalTests: totalMatch ? parseInt(totalMatch[1]) : 0,
                    passed: passed,
                    failed: failed,
                    timestamp: new Date().toISOString()
                };

                addLog(`📊 Results: ${passed} passed, ${failed} failed`, passed > 0 && failed === 0 ? 'success' : 'warning');
                console.log('✅ Test results parsed and stored:', testResults);
            } catch (parseError) {
                console.error('Error parsing results:', parseError);
                addLog('⚠️ Could not parse test results', 'warning');
                testResults = {
                    status: 'completed',
                    message: 'Tests completed but could not parse results',
                    timestamp: new Date().toISOString()
                };
            }
        } else {
            addLog('❌ Dashboard file not found', 'error');
            testResults = {
                status: 'error',
                message: 'Dashboard file not generated',
                timestamp: new Date().toISOString()
            };
        }
    };

    // Handle exit event (fires when process exits, before streams close)
    testProcess.on('exit', (code) => {
        console.log(`📤 Test process exited with code ${code}`);
        // Wait a bit for streams to flush, then finalize
        setTimeout(() => finalizeResults(code), 2000);
    });

    // Handle close event (fires when all streams are closed)
    testProcess.on('close', (code) => {
        console.log(`🔒 Test process closed with code ${code}`);
        finalizeResults(code);
    });
});

// Main route - serve index.html directly (no redirect)
app.get('/', (req, res) => {
    // Reset test running state on server start
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve static files with no-cache headers (MUST be last to not override API routes)
app.use(express.static(__dirname, {
    setHeaders: (res, path) => {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
    }
}));

// Start server
app.listen(PORT, () => {
    testRunning = false;
    testResults = null;
    testLogs = [];
    currentSuite = null;

    console.log('\n╔════════════════════════════════════════════════════════════════════════════╗');
    console.log('║                   AdHash Unified Test Dashboard                           ║');
    console.log('║                        Running on Localhost                                ║');
    console.log('╚════════════════════════════════════════════════════════════════════════════╝\n');
    console.log(`🚀 Server is running at: http://localhost:${PORT}`);
    console.log(`📊 Unified Dashboard: http://localhost:${PORT}/`);
    console.log(`📈 Playwright Report: http://localhost:${PORT}/playwright-report`);
    console.log(`🔧 API Summary: http://localhost:${PORT}/api/test-summary`);
    console.log('\n✨ Press Ctrl+C to stop the server\n');
});


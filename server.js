const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 7777;

// Parse JSON bodies
app.use(express.json());

// Store test execution status
let testRunning = false;
let testResults = null;
let testLogs = [];
let currentSuite = null;
let testProcessPid = null;

// Store server logs
const serverLogs = [];
const MAX_LOGS = 100;

// Helper function to log messages to array
function logToArray(level, message) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        level: level,
        message: message
    };
    serverLogs.push(logEntry);

    // Keep only last MAX_LOGS entries
    if (serverLogs.length > MAX_LOGS) {
        serverLogs.shift();
    }

    // Also log to console
    console.log(`[${level.toUpperCase()}] ${message}`);
}

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
        status: testRunning ? 'running' : (testResults ? 'completed' : 'idle'),
        running: testRunning,
        hasResults: testResults !== null,
        currentSuite: currentSuite,
        results: testResults
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
    const logEntry = {
        message,
        type,
        timestamp: new Date().toISOString()
    };

    // Add to testLogs for backward compatibility
    testLogs.push(logEntry);

    // Also add to serverLogs so it appears in the UI
    serverLogs.push({
        timestamp: logEntry.timestamp,
        level: type,
        message: message
    });

    // Keep only last MAX_LOGS entries in serverLogs
    if (serverLogs.length > MAX_LOGS) {
        serverLogs.shift();
    }

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
        if (output.includes('Step 1/5') || output.includes('App Status')) {
            currentSuite = 'app-status';
            addLog('🚀 Starting App Status Verification tests...', 'running');
        } else if (output.includes('Step 2/5') || output.includes('Server Health')) {
            currentSuite = 'server-health';
            addLog('🚀 Starting Server Health Monitoring tests...', 'running');
        } else if (output.includes('Step 3/5') || output.includes('SSL') || output.includes('Certificate')) {
            currentSuite = 'ssl-cert';
            addLog('🚀 Starting SSL Certificate Monitoring tests...', 'running');
        } else if (output.includes('Step 4/5') || output.includes('API Test')) {
            currentSuite = 'api-test';
            addLog('🚀 Starting API Endpoint Testing tests...', 'running');
        } else if (output.includes('Step 5/5') || output.includes('Domain Report') || output.includes('Domain Expiry')) {
            currentSuite = 'domain-report';
            addLog('🚀 Starting Domain Expiry Monitoring tests...', 'running');
        }

        // Log npm install progress
        if (output.includes('npm install') || output.includes('added') || output.includes('packages')) {
            addLog(`📦 Installing dependencies (using cache)...`, 'info');
        }

        // Log test progress
        if (output.includes('PASS') || output.includes('✓') || output.includes('✅')) {
            addLog(`✅ ${output.trim()}`, 'success');
        } else if (output.includes('FAIL') || output.includes('✗') || output.includes('❌')) {
            addLog(`❌ ${output.trim()}`, 'error');
        } else if (output.trim().length > 0 && !output.includes('[') && !output.includes('npm WARN')) {
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

// API endpoint to get all projects
app.get('/api/projects', (req, res) => {
    try {
        const projectMappingPath = path.join(__dirname, 'config', 'project-mapping.json');
        if (!fs.existsSync(projectMappingPath)) {
            return res.status(404).json({ error: 'Project mapping not found' });
        }

        const projectData = JSON.parse(fs.readFileSync(projectMappingPath, 'utf8'));
        res.json(projectData);
    } catch (error) {
        console.error('Error loading projects:', error);
        res.status(500).json({ error: 'Failed to load projects' });
    }
});

// API endpoint to get a specific project
app.get('/api/project/:id', (req, res) => {
    try {
        const projectMappingPath = path.join(__dirname, 'config', 'project-mapping.json');
        if (!fs.existsSync(projectMappingPath)) {
            return res.status(404).json({ error: 'Project mapping not found' });
        }

        const projectData = JSON.parse(fs.readFileSync(projectMappingPath, 'utf8'));
        const project = projectData.projects.find(p => p.id === req.params.id);

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        res.json(project);
    } catch (error) {
        console.error('Error loading project:', error);
        res.status(500).json({ error: 'Failed to load project' });
    }
});

// API endpoint to get server logs
app.get('/api/logs', (req, res) => {
    try {
        // Return last 50 logs
        const recentLogs = serverLogs.slice(-50);
        res.json(recentLogs);
    } catch (error) {
        console.error('Error fetching logs:', error);
        res.status(500).json({ error: 'Failed to fetch logs' });
    }
});

// API endpoint to get project details
app.get('/api/project/:id', (req, res) => {
    try {
        const projectId = req.params.id;
        const projectMapping = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'project-mapping.json'), 'utf8'));
        const project = projectMapping.projects.find(p => p.id === projectId);

        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }

        res.json(project);
    } catch (error) {
        console.error('Error fetching project details:', error);
        res.status(500).json({ error: 'Failed to fetch project details' });
    }
});

// Load project mapping
function getProjectMapping() {
    try {
        const mappingPath = path.join(__dirname, 'config', 'project-mapping.json');
        const data = fs.readFileSync(mappingPath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error loading project mapping:', error);
        return { projects: [] };
    }
}

// Helper functions to get test results
function getAppTestResults(projectId) {
    try {
        // Get project configuration
        const mapping = getProjectMapping();
        const project = mapping.projects.find(p => p.id === projectId);

        if (!project || !project.apps || project.apps.length === 0) {
            return { total: 0, passed: 0, failed: 0, warning: 0, tests: [] };
        }

        // Parse the actual HTML report
        const reportPath = path.join(__dirname, 'Adhash_App_Status', 'custom-reports', 'Unified_App_Verification_Report.html');

        if (!fs.existsSync(reportPath)) {
            console.log('App Status report not found:', reportPath);
            return { total: 0, passed: 0, failed: 0, warning: 0, tests: [] };
        }

        const html = fs.readFileSync(reportPath, 'utf8');

        // Extract individual test results from the table
        // Count tests for this project's apps only
        let total = 0;
        let passed = 0;
        let failed = 0;

        const testDetails = [];

        // Each app has 2 tests (Play Store + App Store)
        project.apps.forEach(app => {
            const appName = app.name;
            const escapedName = appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            // Generate URLs from package IDs
            const playStoreUrl = app.playStore ? `https://play.google.com/store/apps/details?id=${app.playStore}` : (app.playStoreUrl || '#');
            const appStoreUrl = app.appStore ? `https://apps.apple.com/app/${app.appStore}` : (app.appStoreUrl || '#');

            // Look for test rows containing this app name
            // Pattern: <tr><td>number</td><td><strong>AppName</strong></td><td><span class="platform-text">Play Store</span></td>...<span class="status-badge status-pass/fail">
            // More specific pattern to avoid overlapping matches
            const playStorePattern = new RegExp(`<tr>\\s*<td>\\d+</td>\\s*<td><strong>${escapedName}</strong></td>\\s*<td><span class="platform-text">Play Store</span></td>[\\s\\S]*?<span class="status-badge status-(pass|fail)">`, 'gi');
            const appStorePattern = new RegExp(`<tr>\\s*<td>\\d+</td>\\s*<td><strong>${escapedName}</strong></td>\\s*<td><span class="platform-text">App Store</span></td>[\\s\\S]*?<span class="status-badge status-(pass|fail)">`, 'gi');

            const playStoreMatches = [...html.matchAll(playStorePattern)];
            const appStoreMatches = [...html.matchAll(appStorePattern)];

            playStoreMatches.forEach(match => {
                total++;
                const status = match[1];
                if (status === 'pass') {
                    passed++;
                    testDetails.push({
                        name: `${appName} - Play Store`,
                        platform: 'Play Store',
                        url: playStoreUrl,
                        status: 'passed',
                        type: 'app'
                    });
                } else {
                    failed++;
                    testDetails.push({
                        name: `${appName} - Play Store`,
                        platform: 'Play Store',
                        url: playStoreUrl,
                        status: 'failed',
                        type: 'app'
                    });
                }
            });

            appStoreMatches.forEach(match => {
                total++;
                const status = match[1];
                if (status === 'pass') {
                    passed++;
                    testDetails.push({
                        name: `${appName} - App Store`,
                        platform: 'App Store',
                        url: appStoreUrl,
                        status: 'passed',
                        type: 'app'
                    });
                } else {
                    failed++;
                    testDetails.push({
                        name: `${appName} - App Store`,
                        platform: 'App Store',
                        url: appStoreUrl,
                        status: 'failed',
                        type: 'app'
                    });
                }
            });
        });

        return {
            total: total,
            passed: passed,
            failed: failed,
            warning: 0,
            tests: testDetails
        };
    } catch (error) {
        console.error('Error getting app test results:', error);
        return { total: 0, passed: 0, failed: 0, warning: 0, tests: [] };
    }
}

function getServerTestResults(projectId) {
    try {
        // Get project configuration
        const mapping = getProjectMapping();
        const project = mapping.projects.find(p => p.id === projectId);

        if (!project || !project.servers || project.servers.length === 0) {
            return { total: 0, passed: 0, failed: 0, warning: 0, tests: [] };
        }

        // Find the latest server health report
        const reportsDir = path.join(__dirname, 'Adhash_AllProjects_Server', 'reports');

        if (!fs.existsSync(reportsDir)) {
            console.log('Server reports directory not found:', reportsDir);
            return { total: 0, passed: 0, failed: 0, warning: 0, tests: [] };
        }

        const files = fs.readdirSync(reportsDir).filter(f => f.startsWith('server-health-report-') && f.endsWith('.html'));

        if (files.length === 0) {
            console.log('No server health reports found');
            return { total: 0, passed: 0, failed: 0, warning: 0, tests: [] };
        }

        // Get the most recent report
        const latestReport = files.sort().reverse()[0];
        const reportPath = path.join(reportsDir, latestReport);
        const html = fs.readFileSync(reportPath, 'utf8');

        // Count servers for this project only
        let total = 0;
        let passed = 0;
        let failed = 0;
        let warning = 0;
        const testDetails = [];

        project.servers.forEach(server => {
            const serverName = server.name;

            // Look for server cards in the HTML
            // Pattern: <div class="server-card active/inactive">...<div class="server-name">ServerName</div>
            const escapedName = serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const serverPattern = new RegExp(`<div class="server-card (active|inactive)"[\\s\\S]{0,500}?<div class="server-name">${escapedName}`, 'i');
            const match = html.match(serverPattern);

            if (match) {
                total++;
                const cardStatus = match[1].toLowerCase();

                if (cardStatus === 'inactive') {
                    // Down server (🚨)
                    failed++;
                    testDetails.push({
                        name: serverName,
                        url: server.url || '#',
                        type: server.type || 'Server',
                        status: 'failed'
                    });
                } else {
                    // Active server - check icon to determine if healthy or unhealthy
                    const iconPattern = new RegExp(`<div class="server-card active"[\\s\\S]{0,500}?<div class="server-name">${escapedName}[\\s\\S]{0,200}?<span class="server-icon">([^<]+)</span>`, 'i');
                    const iconMatch = html.match(iconPattern);

                    if (iconMatch && iconMatch[1].includes('⚠️')) {
                        warning++; // Unhealthy
                        testDetails.push({
                            name: serverName,
                            url: server.url || '#',
                            type: server.type || 'Server',
                            status: 'warning'
                        });
                    } else {
                        passed++; // Healthy (✅)
                        testDetails.push({
                            name: serverName,
                            url: server.url || '#',
                            type: server.type || 'Server',
                            status: 'passed'
                        });
                    }
                }
            }
        });

        return {
            total: total,
            passed: passed,
            failed: failed,
            warning: warning,
            tests: testDetails
        };
    } catch (error) {
        console.error('Error getting server test results:', error);
        return { total: 0, passed: 0, failed: 0, warning: 0, tests: [] };
    }
}

function getSSLTestResults(projectId) {
    try {
        // Get project configuration
        const mapping = getProjectMapping();
        const project = mapping.projects.find(p => p.id === projectId);

        if (!project || !project.sslCerts || project.sslCerts.length === 0) {
            return { total: 0, passed: 0, failed: 0, warning: 0, tests: [] };
        }

        // Find the latest SSL certificate report
        const reportsDir = path.join(__dirname, 'AdHash-Projects-Certificate-Expiry-Test', 'reports');

        if (!fs.existsSync(reportsDir)) {
            console.log('SSL reports directory not found:', reportsDir);
            return { total: 0, passed: 0, failed: 0, warning: 0, tests: [] };
        }

        const files = fs.readdirSync(reportsDir).filter(f => f.startsWith('certificate-report-') && f.endsWith('.html'));

        if (files.length === 0) {
            console.log('No SSL certificate reports found');
            return { total: 0, passed: 0, failed: 0, warning: 0, tests: [] };
        }

        // Get the most recent report
        const latestReport = files.sort().reverse()[0];
        const reportPath = path.join(reportsDir, latestReport);
        const html = fs.readFileSync(reportPath, 'utf8');

        // Count SSL certificates for this project only
        let total = 0;
        let passed = 0;
        let failed = 0;
        let warning = 0;
        const testDetails = [];

        project.sslCerts.forEach(domain => {
            // Look for certificate rows in the table
            // Pattern: <tr class='row-ok/row-failed/row-warning'>...(up to 500 chars)...https://domain.com/
            const escapedDomain = domain.replace(/\./g, '\\.');
            const certPattern = new RegExp(`<tr class='(row-ok|row-failed|row-warning)'[^>]*>[\\s\\S]{0,500}?https?://${escapedDomain}/?<`, 'i');
            const match = html.match(certPattern);

            if (match) {
                total++;
                const rowClass = match[1].toLowerCase();

                // Check if certificate has days remaining (to distinguish warning from actual failure)
                // Pattern: <td>XX days</td> or <td>Expired</td>
                const daysPattern = new RegExp(`<tr class='${match[1]}'[^>]*>[\\s\\S]{0,500}?https?://${escapedDomain}/?<[\\s\\S]{0,200}?<td>([^<]+)</td>`, 'i');
                const daysMatch = html.match(daysPattern);

                let isExpired = false;
                let daysRemaining = null;
                if (daysMatch && daysMatch[1]) {
                    const daysText = daysMatch[1].trim().toLowerCase();
                    isExpired = daysText.includes('expired') || daysText === '0 days' || daysText === 'invalid';

                    // Extract numeric days remaining
                    const numMatch = daysText.match(/(\d+)\s*days?/);
                    if (numMatch) {
                        daysRemaining = parseInt(numMatch[1], 10);
                    }
                }

                if (rowClass === 'row-ok') {
                    passed++;
                    testDetails.push({
                        name: domain,
                        url: `https://${domain}`,
                        status: 'passed',
                        type: 'ssl',
                        daysRemaining: daysRemaining || 90
                    });
                } else if (rowClass === 'row-failed' || rowClass === 'row-warning') {
                    // SSL Certificate threshold: < 30 days = warning, expired = failed, >= 30 days = passed
                    if (isExpired) {
                        failed++;
                        testDetails.push({
                            name: domain,
                            url: `https://${domain}`,
                            status: 'failed',
                            type: 'ssl',
                            daysRemaining: 0
                        });
                    } else if (daysRemaining !== null && daysRemaining < 30) {
                        // Only mark as warning if less than 30 days
                        warning++;
                        testDetails.push({
                            name: domain,
                            url: `https://${domain}`,
                            status: 'warning',
                            type: 'ssl',
                            daysRemaining: daysRemaining
                        });
                    } else {
                        // >= 30 days should be passed, not warning
                        passed++;
                        testDetails.push({
                            name: domain,
                            url: `https://${domain}`,
                            status: 'passed',
                            type: 'ssl',
                            daysRemaining: daysRemaining || 30
                        });
                    }
                }
            }
        });

        return {
            total: total,
            passed: passed,
            failed: failed,
            warning: warning,
            tests: testDetails
        };
    } catch (error) {
        console.error('Error getting SSL test results:', error);
        return { total: 0, passed: 0, failed: 0, warning: 0, tests: [] };
    }
}

function getDomainTestResults(projectId) {
    try {
        // Get project configuration
        const mapping = getProjectMapping();
        const project = mapping.projects.find(p => p.id === projectId);

        if (!project || !project.domains || project.domains.length === 0) {
            return { total: 0, passed: 0, failed: 0, warning: 0, tests: [] };
        }

        // Parse the domain report
        const reportPath = path.join(__dirname, 'AdHash_Domain_Report', 'godaddy', 'report.html');

        if (!fs.existsSync(reportPath)) {
            console.log('Domain report not found:', reportPath);
            return { total: 0, passed: 0, failed: 0, warning: 0, tests: [] };
        }

        const html = fs.readFileSync(reportPath, 'utf8');

        // Count domains for this project only
        let total = 0;
        let passed = 0;
        let failed = 0;
        let warning = 0;
        const testDetails = [];

        // Filter to get only main/root domains (exclude subdomains)
        // A main domain has exactly 2 parts (e.g., "autochecker.com", "humee.io")
        // Subdomains have 3+ parts (e.g., "manage.autochecker.com", "api.humee.com")
        const mainDomains = project.domains.filter(domain => {
            const parts = domain.split('.');
            // Main domain: 2 parts (domain.tld) or special cases like co.uk (3 parts)
            // For simplicity, we'll check if it's in the HTML report
            return parts.length === 2 || (parts.length === 3 && ['co', 'com', 'org', 'net'].includes(parts[1]));
        });

        console.log(`🔍 Searching for ${mainDomains.length} main domains (filtered from ${project.domains.length} total) for project: ${projectId}`);
        if (mainDomains.length < project.domains.length) {
            const subdomains = project.domains.filter(d => !mainDomains.includes(d));
            console.log(`   ℹ️ Skipping ${subdomains.length} subdomains: ${subdomains.join(', ')}`);
        }

        mainDomains.forEach((domain, index) => {
            console.log(`   [${index + 1}/${mainDomains.length}] Looking for domain: ${domain}`);

            // Look for domain cards in the HTML
            // Pattern: <div class="domain-url">domain.com</div>...<div class="days-remaining...">XX days remaining...</div>
            // Updated to handle: class="days-remaining warning" and emoji at the end
            const escapedDomain = domain.replace(/\./g, '\\.');
            const domainPattern = new RegExp(`<div class="domain-url">${escapedDomain}</div>[\\s\\S]{0,500}?<div class="days-remaining[^"]*"[^>]*>\\s*(\\d+)\\s*days remaining`, 'i');
            const match = html.match(domainPattern);

            if (match) {
                console.log(`   ✅ Found domain: ${domain} (${match[1]} days remaining)`);
                total++;
                const daysRemaining = parseInt(match[1], 10);

                // Domain expiry threshold: < 90 days = warning, >= 90 days = passed
                if (daysRemaining < 90) {
                    warning++;
                    testDetails.push({
                        name: domain,
                        url: `https://${domain}`,
                        status: 'warning',
                        type: 'domain',
                        daysRemaining: daysRemaining
                    });
                } else {
                    passed++;
                    testDetails.push({
                        name: domain,
                        url: `https://${domain}`,
                        status: 'passed',
                        type: 'domain',
                        daysRemaining: daysRemaining
                    });
                }
            } else {
                console.log(`   ❌ Domain NOT found in report: ${domain}`);
            }
        });

        console.log(`📊 Domain Results for ${projectId}: Total=${total}, Passed=${passed}, Warning=${warning}, Failed=${failed}`);

        return {
            total: total,
            passed: passed,
            failed: failed,
            warning: warning,
            tests: testDetails
        };
    } catch (error) {
        console.error('Error getting domain test results:', error);
        return { total: 0, passed: 0, failed: 0, warning: 0, tests: [] };
    }
}

function getAPITestResults(projectId) {
    try {
        // Get project configuration
        const mapping = getProjectMapping();
        const project = mapping.projects.find(p => p.id === projectId);

        if (!project || !project.apis || project.apis.length === 0) {
            console.log(`⚠️ No APIs configured for project: ${projectId}`);
            return { total: 0, passed: 0, failed: 0, warning: 0, tests: [] };
        }

        console.log(`📊 Fetching API test results for ${projectId} (${project.apis.length} APIs configured)`);

        // Find the latest API test report
        const reportsDir = path.join(__dirname, 'AdHash-API-Test', 'simple-reports');

        if (!fs.existsSync(reportsDir)) {
            console.log('⚠️ API reports directory not found:', reportsDir);
            return { total: 0, passed: 0, failed: 0, warning: 0, tests: [] };
        }

        const files = fs.readdirSync(reportsDir).filter(f => f.startsWith('AdHash_API_Simple_Report_') && f.endsWith('.html'));

        if (files.length === 0) {
            console.log('⚠️ No API test reports found');
            return { total: 0, passed: 0, failed: 0, warning: 0, tests: [] };
        }

        // Get the most recent report
        const latestReport = files.sort().reverse()[0];
        const reportPath = path.join(reportsDir, latestReport);
        console.log(`📄 Reading API report: ${latestReport}`);
        const html = fs.readFileSync(reportPath, 'utf8');

        // Count API tests for this project only
        let total = 0;
        let passed = 0;
        let failed = 0;
        const testDetails = [];

        project.apis.forEach((api, index) => {
            const apiUrl = api.url;
            const apiName = api.name || apiUrl;

            console.log(`🔍 [${index + 1}/${project.apis.length}] Searching for API: ${apiName}`);
            console.log(`   URL: ${apiUrl}`);

            // Look for API test rows in the table by URL
            // Use a more specific pattern that matches the exact URL in the href attribute
            const escapedUrl = apiUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            // Match the specific row containing this exact URL
            // Pattern: <td class="url"><a href="EXACT_URL" ... followed by status column
            const apiPattern = new RegExp(`<td[^>]*class="url"[^>]*>\\s*<a\\s+href="${escapedUrl}"[^>]*>.*?</a>\\s*</td>\\s*<td[^>]*class="(status-ok|status-fail)"[^>]*>`, 'i');
            const match = html.match(apiPattern);

            if (match) {
                console.log(`   ✅ Found match! Status: ${match[1]}`);
                total++;
                const status = match[1].toLowerCase();

                // Extract request and response data from the details row
                // Find the row with this URL, then find the next details-row
                const rowPattern = new RegExp(`<tr>[\\s\\S]*?<td[^>]*class="url"[^>]*>\\s*<a\\s+href="${escapedUrl}"[^>]*>[\\s\\S]*?</tr>`, 'i');
                const rowMatch = html.match(rowPattern);

                let detailsMatch = null;
                if (rowMatch) {
                    // Get the position after the matched row
                    const rowEndIndex = html.indexOf(rowMatch[0]) + rowMatch[0].length;
                    const remainingHtml = html.substring(rowEndIndex, rowEndIndex + 20000); // Increased to 20000 to handle long response bodies

                    // Find the next details-row - look for the api-details div
                    // Match the entire api-details section by finding the opening div and then everything until </td></tr>
                    const detailsPattern = /<tr[^>]*class="details-row"[^>]*>[\s\S]*?<div[^>]*class="api-details"[^>]*>([\s\S]*?)<\/div>\s*<\/td>\s*<\/tr>/i;

                    // Alternative: Find api-details div and capture until we find </div> followed by </td>
                    const apiDetailsStart = remainingHtml.indexOf('<div class="api-details">');
                    if (apiDetailsStart !== -1) {
                        // Find the closing </td></tr> after api-details
                        const tdCloseIndex = remainingHtml.indexOf('</td>', apiDetailsStart);
                        if (tdCloseIndex !== -1) {
                            // Extract everything between <div class="api-details"> and </div> before </td>
                            const apiDetailsSection = remainingHtml.substring(apiDetailsStart, tdCloseIndex);
                            // Find the content inside api-details div
                            const contentStart = apiDetailsSection.indexOf('>') + 1;
                            const contentEnd = apiDetailsSection.lastIndexOf('</div>');
                            if (contentStart > 0 && contentEnd > contentStart) {
                                const detailsContent = apiDetailsSection.substring(contentStart, contentEnd);
                                detailsMatch = [apiDetailsSection, detailsContent];
                            }
                        }
                    }

                    if (detailsMatch) {
                        console.log(`   📦 Found details section for ${apiName}`);
                        console.log(`   📦 Details content length: ${detailsMatch[1].length} chars`);
                        // Log a sample of the content
                        const sample = detailsMatch[1].substring(0, 200).replace(/\s+/g, ' ');
                        console.log(`   📦 Details sample: ${sample}...`);
                    } else {
                        console.log(`   ⚠️ No details section found for ${apiName}`);
                        // Try to find if there's a details-row at all
                        if (remainingHtml.includes('details-row')) {
                            console.log(`   ℹ️ Found 'details-row' text but pattern didn't match`);
                            // Show what we found
                            const detailsRowIndex = remainingHtml.indexOf('details-row');
                            const snippet = remainingHtml.substring(detailsRowIndex, detailsRowIndex + 300);
                            console.log(`   ℹ️ Snippet: ${snippet.substring(0, 200).replace(/\s+/g, ' ')}...`);
                        }
                    }
                }

                let requestBody = null;
                let responseBody = null;
                let responseCode = null;
                let method = api.method || 'GET';

                if (detailsMatch) {
                    const detailsContent = detailsMatch[1];

                    // Extract method and status code
                    const methodMatch = detailsContent.match(/<span[^>]*class="method-badge method-(get|post|put|delete|patch)"[^>]*>(GET|POST|PUT|DELETE|PATCH)<\/span>/i);
                    if (methodMatch) {
                        method = methodMatch[2];
                    }

                    const statusCodeMatch = detailsContent.match(/<span[^>]*class="status-code[^"]*"[^>]*>Status:\s*(\d+)<\/span>/i);
                    if (statusCodeMatch) {
                        responseCode = statusCodeMatch[1];
                    }

                    // Extract request body
                    console.log(`   🔍 Looking for Request Body in details...`);
                    // Use a simpler, more robust regex that captures everything between the divs
                    const requestMatch = detailsContent.match(/<div[^>]*class="detail-label"[^>]*>\s*Request Body\s*<\/div>\s*<div[^>]*class="detail-value"[^>]*>([\s\S]*?)<\/div>/i);
                    if (requestMatch) {
                        console.log(`   ✅ Found Request Body match!`);
                        try {
                            // Decode HTML entities, Unicode escapes, and trim whitespace
                            let requestText = requestMatch[1]
                                .replace(/&quot;/g, '"')
                                .replace(/&lt;/g, '<')
                                .replace(/&gt;/g, '>')
                                .replace(/&amp;/g, '&')
                                .replace(/\\u003d/g, '=')  // Handle \u003d (=)
                                .replace(/\\u003c/g, '<')  // Handle \u003c (<)
                                .replace(/\\u003e/g, '>')  // Handle \u003e (>)
                                .trim();
                            console.log(`   📝 Request text (first 200 chars): ${requestText.substring(0, 200)}`);
                            if (requestText && requestText !== 'N/A' && requestText.length > 0) {
                                try {
                                    requestBody = JSON.parse(requestText);
                                    console.log(`   ✅ Parsed request body as JSON`);
                                } catch (jsonError) {
                                    // If not valid JSON, store as string
                                    requestBody = requestText;
                                    console.log(`   ✅ Stored request body as string (${requestText.length} chars)`);
                                }
                            }
                        } catch (e) {
                            console.log(`   ❌ Error processing request body: ${e.message}`);
                        }
                    } else {
                        console.log(`   ⚠️ Request Body pattern did not match`);
                        // Try to find if "Request Body" text exists
                        if (detailsContent.includes('Request Body')) {
                            console.log(`   ℹ️ Found "Request Body" text in details`);
                            // Show a snippet around "Request Body"
                            const idx = detailsContent.indexOf('Request Body');
                            const snippet = detailsContent.substring(Math.max(0, idx - 50), Math.min(detailsContent.length, idx + 300));
                            console.log(`   📝 Snippet: ${snippet.replace(/\s+/g, ' ').substring(0, 200)}`);
                        }
                    }

                    // Extract response body
                    console.log(`   🔍 Looking for Response Body in details...`);
                    // Use a simpler, more robust regex that captures everything between the divs
                    const responseMatch = detailsContent.match(/<div[^>]*class="detail-label"[^>]*>\s*Response Body\s*<\/div>\s*<div[^>]*class="detail-value"[^>]*>([\s\S]*?)<\/div>/i);
                    if (responseMatch) {
                        console.log(`   ✅ Found Response Body match!`);
                        try {
                            // Decode HTML entities, Unicode escapes, and trim whitespace
                            let responseText = responseMatch[1]
                                .replace(/&quot;/g, '"')
                                .replace(/&lt;/g, '<')
                                .replace(/&gt;/g, '>')
                                .replace(/&amp;/g, '&')
                                .replace(/\\u003d/g, '=')  // Handle \u003d (=)
                                .replace(/\\u003c/g, '<')  // Handle \u003c (<)
                                .replace(/\\u003e/g, '>')  // Handle \u003e (>)
                                .trim();
                            console.log(`   📝 Response text (first 200 chars): ${responseText.substring(0, 200)}`);
                            if (responseText && responseText !== 'N/A' && responseText.length > 0) {
                                try {
                                    // Try to parse as JSON
                                    responseBody = JSON.parse(responseText);
                                    console.log(`   ✅ Parsed response body as JSON`);
                                } catch (jsonError) {
                                    // If not valid JSON, store as string (truncate if too long)
                                    responseBody = responseText.length > 500 ? responseText.substring(0, 500) + '...' : responseText;
                                    console.log(`   ✅ Stored response body as string (${responseBody.length} chars)`);
                                }
                            }
                        } catch (e) {
                            console.log(`   ❌ Error processing response body: ${e.message}`);
                        }
                    } else {
                        console.log(`   ⚠️ Response Body pattern did not match`);
                        // Try to find if "Response Body" text exists
                        if (detailsContent.includes('Response Body')) {
                            console.log(`   ℹ️ Found "Response Body" text in details`);
                            // Show a snippet around "Response Body"
                            const idx = detailsContent.indexOf('Response Body');
                            const snippet = detailsContent.substring(Math.max(0, idx - 50), Math.min(detailsContent.length, idx + 300));
                            console.log(`   📝 Snippet: ${snippet.replace(/\s+/g, ' ').substring(0, 200)}`);
                        }
                    }
                }

                if (status === 'status-ok') {
                    passed++;
                    testDetails.push({
                        name: apiName,
                        method: method,
                        url: apiUrl,
                        status: 'passed',
                        type: 'api',
                        responseCode: responseCode || '200',
                        requestBody: requestBody,
                        responseBody: responseBody
                    });
                } else if (status === 'status-fail') {
                    failed++;
                    testDetails.push({
                        name: apiName,
                        method: method,
                        url: apiUrl,
                        status: 'failed',
                        type: 'api',
                        responseCode: responseCode || '500',
                        requestBody: requestBody,
                        responseBody: responseBody
                    });
                }
            } else {
                // If no match found, log for debugging
                console.log(`   ❌ No match found for API: ${apiName}`);
                console.log(`   URL: ${apiUrl}`);
            }
        });

        console.log(`📊 API Results for ${projectId}: Total=${total}, Passed=${passed}, Failed=${failed}, Tests=${testDetails.length}`);

        return {
            total: total,
            passed: passed,
            failed: failed,
            warning: 0,
            tests: testDetails
        };
    } catch (error) {
        console.error('Error getting API test results:', error);
        return { total: 0, passed: 0, failed: 0, warning: 0, tests: [] };
    }
}

// API endpoint to get test results for a project
app.get('/api/project/:id/test-results', (req, res) => {
    try {
        const projectId = req.params.id;
        console.log(`📊 Fetching test results for project: ${projectId}`);

        const results = {
            apps: getAppTestResults(projectId),
            servers: getServerTestResults(projectId),
            ssl: getSSLTestResults(projectId),
            domains: getDomainTestResults(projectId),
            apis: getAPITestResults(projectId)
        };

        console.log(`✅ Test results for ${projectId}:`, JSON.stringify(results, null, 2));
        res.json(results);
    } catch (error) {
        console.error('❌ Error fetching test results:', error);
        res.status(500).json({ error: 'Failed to fetch test results', message: error.message });
    }
});

// Main route - serve project dashboard
app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, 'public', 'project-dashboard.html'));
});

// Legacy dashboard route
app.get('/dashboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
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

    // Log server startup
    logToArray('info', `Server started successfully on port ${PORT}`);
    logToArray('info', 'Project dashboard available at http://localhost:' + PORT);
});


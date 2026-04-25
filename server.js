const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = Number(process.env.PORT) || 7777;

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
const DASHBOARD_STATE_PATH = path.join(__dirname, 'test-results', 'dashboard-state.json');
const DOMAIN_REPORT_OUTPUT_PATH = path.join(__dirname, 'godaddy', 'report.html');
const CERTIFICATE_REPORT_OUTPUT_PATH = path.join(__dirname, 'suite-reports', 'AdHash_Projects_Certificate_Expiry_Test.html');
const DOMAIN_MODULE_REPORT_PATH = path.join(__dirname, 'final-dashboard-bundle', 'module-reports', 'domain.html');
const SSL_MODULE_REPORT_PATH = path.join(__dirname, 'final-dashboard-bundle', 'module-reports', 'ssl.html');
const EXPIRY_WARNING_DAYS = 30;
const WORKSPACE_SUITES = {
    app: {
        id: 'app',
        name: 'App Status Verification',
        repository: 'Adhash_App_Status',
        specPath: 'tests/app-status/playstore.spec.ts',
        countKey: 'appStatus',
        countPattern: /test\(/g
    },
    server: {
        id: 'server',
        name: 'Server Health Monitoring',
        repository: 'Adhash_AllProjects_Server',
        specPath: 'tests/server-health/server-check.spec.ts',
        countKey: 'serverHealth',
        countPattern: /\{\s*name:/g
    },
    cert: {
        id: 'cert',
        name: 'SSL Certificate Monitoring',
        repository: 'AdHash-Projects-Certificate-Expiry-Test',
        specPath: 'tests/certificate/cert-expiry.spec.ts',
        countKey: 'sslCertificate',
        countPattern: /\{\s*name:/g
    },
    api: {
        id: 'api',
        name: 'API Endpoint Testing',
        repository: 'AdHash-API-Test',
        specPath: 'tests/api/api-tests.spec.ts',
        countKey: 'apiEndpoint',
        countPattern: /\{\s*name:/g
    },
    domain: {
  id: 'domain',
  name: 'Domain Expiry Monitoring',
  repository: 'AdHash_Domain_Report',
  specPath: '__external__',
  countKey: 'domainExpiry',
  countPattern: /Checking\s+([^(]+)\s+\(([^)]+)\)\.\.\./g
}
};

function isSuiteConfigured(config) {
  if (!config) return false;

  if (config.id === 'domain') {
    return fs.existsSync('D:\\Automation\\AdHash_Domain_Report_Standalone\\godaddy\\package.json');
  }

  return !!(config.specPath && fs.existsSync(path.join(__dirname, config.specPath)));
}

function countSuiteTests(config) {
    if (!config || !config.specPath || !config.countPattern) {
        return 0;
    }

    const suiteFilePath = path.join(__dirname, config.specPath);
    if (!fs.existsSync(suiteFilePath)) {
        return 0;
    }

    const content = fs.readFileSync(suiteFilePath, 'utf8');
    const matches = content.match(config.countPattern);
    return matches ? matches.length : 0;
}

function createDefaultDetailedResults() {
    return {
        app: { status: 'not-run', passed: 0, failed: 0, warning: 0, total: 0, details: [] },
        server: { status: 'not-run', passed: 0, failed: 0, warning: 0, total: 0, details: [] },
        cert: { status: 'not-run', passed: 0, failed: 0, warning: 0, total: 0, details: [] },
        api: { status: 'not-run', passed: 0, failed: 0, warning: 0, total: 0, details: [] },
        domain: {
            status: 'unavailable',
            passed: 0,
            failed: 0,
            warning: 0,
            total: 0,
            details: [],
            message: WORKSPACE_SUITES.domain.unavailableMessage
        }
    };
}

function readDashboardState() {
    if (!fs.existsSync(DASHBOARD_STATE_PATH)) {
        return null;
    }

    try {
        return JSON.parse(fs.readFileSync(DASHBOARD_STATE_PATH, 'utf8'));
    } catch (error) {
        console.error('Error reading dashboard state:', error);
        return null;
    }
}

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
    const counts = {
        appStatus: 0,
        serverHealth: 0,
        sslCertificate: 0,
        apiEndpoint: 0,
        domainExpiry: 0,
        total: 0
    };

    try {
        Object.values(WORKSPACE_SUITES).forEach((config) => {
            counts[config.countKey] = isSuiteConfigured(config) ? countSuiteTests(config) : 0;
        });

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
        const state = readDashboardState();
        if (!state || !state.summary) {
            return res.json({ status: 'no-results', message: 'No test results available yet' });
        }
        res.json({
            status: 'completed',
            passedSuites: state.summary.passedSuites,
            failedSuites: state.summary.failedSuites,
            warningSuites: state.summary.warningSuites,
            skippedSuites: state.summary.skippedSuites,
            totalSuites: state.summary.totalSuites
        });
    } catch (error) {
        console.error('Error getting test results:', error);
        res.json({ status: 'error', message: error.message });
    }
});

// API endpoint to get detailed test results per suite
app.get('/api/detailed-results', (req, res) => {
    const detailedResults = createDefaultDetailedResults();

    try {
        const state = readDashboardState();
        if (state && state.suites) {
            Object.assign(detailedResults, state.suites);
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

    const suiteConfig = WORKSPACE_SUITES[suite];
    if (!suiteConfig) {
        return res.status(400).json({ status: 'error', message: 'Invalid suite name' });
    }

    if (!isSuiteConfigured(suiteConfig)) {
        const message = suiteConfig.unavailableMessage || 'Not configured in current workspace';
        addLog(`⚠️ ${suiteConfig.name}: ${message}`, 'warning');
        return res.status(400).json({ status: 'error', message });
    }

    console.log(`\n🚀 Running ${suiteConfig.name}...`);
    addLog(`🚀 Running ${suiteConfig.name}...`, 'info');

    res.json({ status: 'success', message: `Running ${suiteConfig.name}...` });

    // Run the suite through the workspace-root runner
    const testProcess = exec(`npx ts-node run-all-tests.ts --suite ${suite}`, { cwd: __dirname });

    testProcess.stdout.on('data', (data) => {
        console.log(data.toString());
    });

    testProcess.stderr.on('data', (data) => {
        console.error(data.toString());
    });

    testProcess.on('exit', (code) => {
        console.log(`✅ ${suiteConfig.name} completed with code ${code}`);
        addLog(`✅ ${suiteConfig.name} completed`, code === 0 ? 'success' : 'error');
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
 addLog('📋 Running configured suites, including external domain monitoring...', 'info');
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
        if (output.includes('Running App Status Tests')) {
            currentSuite = 'app-status';
            addLog('🚀 Starting App Status Verification tests...', 'running');
        } else if (output.includes('Running Server Health Tests')) {
            currentSuite = 'server-health';
            addLog('🚀 Starting Server Health Monitoring tests...', 'running');
        } else if (output.includes('Running Certificate Expiry Tests')) {
            currentSuite = 'ssl-cert';
            addLog('🚀 Starting SSL Certificate Monitoring tests...', 'running');
        } else if (output.includes('Running API Tests')) {
            currentSuite = 'api-test';
            addLog('🚀 Starting API Endpoint Testing tests...', 'running');
        } else if (output.includes('Domain Expiry Monitoring is not configured in current workspace')) {
            addLog('⚠️ Domain Expiry Monitoring is not configured in current workspace', 'warning');
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

        const state = readDashboardState();
        if (state && state.summary) {
            try {
                testResults = {
                    status: 'completed',
                    totalTests: state.summary.totalSuites,
                    passed: state.summary.passedSuites,
                    failed: state.summary.failedSuites,
                    timestamp: new Date().toISOString()
                };

                addLog(`📊 Results: ${state.summary.passedSuites} passed, ${state.summary.failedSuites} failed, ${state.summary.skippedSuites} skipped`, state.summary.failedSuites === 0 ? 'success' : 'warning');
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
        attachProjectDomainStatuses(projectData.projects || [], readDashboardState());
        attachProjectSslDetails(projectData.projects || [], readDashboardState());
        attachProjectServerStatuses(projectData.projects || []);
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
        attachProjectDomainStatuses(projectData.projects || [], readDashboardState());
        attachProjectSslDetails(projectData.projects || [], readDashboardState());
        attachProjectServerStatuses(projectData.projects || []);
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
        attachProjectDomainStatuses(projectMapping.projects || [], readDashboardState());
        attachProjectSslDetails(projectMapping.projects || [], readDashboardState());
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

const suiteConfigCache = {
    apps: null,
    certificates: null,
    apis: null,
    domains: null,
    domainsCacheKey: null,
    suiteRows: {}
};

const SKIPPED_SERVER_URL_FRAGMENT = '20.62.109.239';
const SKIPPED_SERVER_NAME = 'AutoChecker - PartSouq';
const SKIPPED_SERVER_MESSAGE = 'Skipped by QA (known issue / external dependency)';

function normalizeText(value) {
    return (value || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeUrl(value) {
    return (value || '').toString().trim().replace(/\/+$/, '').toLowerCase();
}

function normalizeApiMethod(value) {
    return (value || 'GET').toString().trim().toUpperCase();
}

function normalizeApiName(value) {
    return normalizeText((value || '').toString().trim());
}

function buildApiStableKey(method, url, name) {
    return `${normalizeApiMethod(method)}::${normalizeUrl(url)}::${normalizeApiName(name)}`;
}

function isSkippedServerDefinition(server) {
    return Boolean(server && ((server.name || '') === SKIPPED_SERVER_NAME || String(server.url || '').includes(SKIPPED_SERVER_URL_FRAGMENT)));
}

function buildSkippedServerResult(server) {
    return {
        name: server.name,
        url: server.url || '#',
        type: 'server',
        status: 'skipped',
        message: SKIPPED_SERVER_MESSAGE,
        responseTime: 0,
        duration: '0s'
    };
}

function dedupeApiResults(details) {
    const deduped = new Map();

    (details || []).forEach((detail) => {
        if (!detail) {
            return;
        }

        deduped.set(buildApiStableKey(detail.method, detail.url, detail.name), detail);
    });

    return Array.from(deduped.values());
}

function classifyApiStatus(responseCode, expectedStatus) {
    const parsedResponseCode = typeof responseCode === 'number'
        ? responseCode
        : (/^\d+$/.test(String(responseCode || '').trim()) ? parseInt(String(responseCode).trim(), 10) : null);
    const parsedExpectedStatus = typeof expectedStatus === 'number'
        ? expectedStatus
        : (/^\d+$/.test(String(expectedStatus || '').trim()) ? parseInt(String(expectedStatus).trim(), 10) : undefined);

    if (typeof parsedExpectedStatus === 'number') {
        if (parsedResponseCode !== parsedExpectedStatus) {
            return 'failed';
        }

        if (parsedExpectedStatus >= 300 && parsedExpectedStatus < 400) {
            return 'warning';
        }

        return 'passed';
    }

    if (parsedResponseCode === null) {
        return 'failed';
    }

    if (parsedResponseCode >= 200 && parsedResponseCode < 300) {
        return 'passed';
    }

    if (parsedResponseCode >= 300 && parsedResponseCode < 400) {
        return 'warning';
    }

    return 'failed';
}

function normalizeSslHost(value) {
    const trimmed = (value || '').toString().trim();
    if (!trimmed) {
        return '';
    }

    if (/^https?:\/\//i.test(trimmed)) {
        try {
            return new URL(trimmed).hostname.toLowerCase();
        } catch (error) {
            return '';
        }
    }

    return trimmed.replace(/^https?:\/\//i, '').split('/')[0].replace(/:\d+$/, '').toLowerCase();
}

function normalizeDomainValue(value) {
    return String(value || '')
        .replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '')
        .replace(/\/$/, '')
        .toLowerCase();
}

function buildTrackedDetailKey(type, domain, url) {
    return `${type}::${normalizeDomainValue(domain || url || '')}`;
}

function getTrackedDetailScore(detail) {
    let score = 0;

    if (detail && detail.expiryDate) {
        score += 3;
    }

    if (detail && detail.expiryDateIST && detail.expiryDateIST !== 'N/A') {
        score += 2;
    }

    if (detail && detail.daysRemaining !== null && detail.daysRemaining !== undefined && !Number.isNaN(Number(detail.daysRemaining))) {
        score += 3;
    }

    if (detail && detail.reason) {
        score += 2;
    }

    if (detail && detail.status === 'passed') {
        score += 3;
    } else if (detail && (detail.status === 'warning' || detail.status === 'expiring')) {
        score += 2;
    } else if (detail && (detail.status === 'failed' || detail.status === 'error')) {
        score += 1;
    }

    return score;
}

function pickPreferredTrackedDetail(existing, incoming) {
    if (!existing) {
        return incoming;
    }

    const existingScore = getTrackedDetailScore(existing);
    const incomingScore = getTrackedDetailScore(incoming);

    if (incomingScore > existingScore) {
        return {
            ...existing,
            ...incoming,
            domain: incoming.domain || existing.domain,
            url: incoming.url || existing.url,
            expiryDate: incoming.expiryDate || existing.expiryDate,
            expiryDateIST: incoming.expiryDateIST && incoming.expiryDateIST !== 'N/A' ? incoming.expiryDateIST : existing.expiryDateIST,
            daysRemaining: incoming.daysRemaining ?? existing.daysRemaining,
            reason: incoming.reason || existing.reason
        };
    }

    return {
        ...incoming,
        ...existing,
        domain: existing.domain || incoming.domain,
        url: existing.url || incoming.url,
        expiryDate: existing.expiryDate || incoming.expiryDate,
        expiryDateIST: existing.expiryDateIST && existing.expiryDateIST !== 'N/A' ? existing.expiryDateIST : incoming.expiryDateIST,
        daysRemaining: existing.daysRemaining ?? incoming.daysRemaining,
        reason: existing.reason || incoming.reason
    };
}

function dedupeTrackedResults(type, details) {
    const deduped = new Map();

    (details || []).forEach((detail) => {
        if (!detail) {
            return;
        }

        const normalizedDomain = normalizeDomainValue(detail.domain || detail.url);
        if (!normalizedDomain) {
            return;
        }

        const normalizedDetail = {
            ...detail,
            domain: normalizedDomain,
            url: detail.url || `https://${normalizedDomain}`
        };
        const key = buildTrackedDetailKey(type, normalizedDetail.domain, normalizedDetail.url);
        deduped.set(key, pickPreferredTrackedDetail(deduped.get(key), normalizedDetail));
    });

    return Array.from(deduped.values());
}

function normalizeDaysRemaining(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

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

function getExpiryStatus(daysRemaining, hasError = false) {
    const normalizedDays = normalizeDaysRemaining(daysRemaining);

    if (hasError || normalizedDays === null) {
        return 'failed';
    }

    if (normalizedDays < 0) {
        return 'failed';
    }

    if (normalizedDays <= EXPIRY_WARNING_DAYS) {
        return 'warning';
    }

    return 'passed';
}

function toDomainDetailStatus(status) {
    if (status === 'warning') {
        return 'expiring';
    }

    if (status === 'failed') {
        return 'error';
    }

    return 'active';
}

function normalizeDomainDetail(detail) {
    const daysRemaining = normalizeDaysRemaining(detail && detail.daysRemaining);
    const status = toDomainDetailStatus(
        getExpiryStatus(daysRemaining, detail && detail.status === 'error' && daysRemaining === null)
    );

    return {
        ...detail,
        url: (detail && detail.url) || (detail && detail.domain ? `https://${normalizeDomainValue(detail.domain)}` : undefined),
        domain: normalizeDomainValue(detail && detail.domain),
        daysRemaining,
        status,
        reason: detail && detail.reason ? String(detail.reason) : undefined
    };
}

function normalizeSslDetail(detail) {
    const daysRemaining = normalizeDaysRemaining(detail && detail.daysRemaining);
    const status = getExpiryStatus(daysRemaining, detail && detail.status === 'failed' && daysRemaining === null);

    return {
        ...detail,
        domain: normalizeDomainValue(detail && detail.domain),
        url: (detail && detail.url) || (detail && detail.domain ? `https://${normalizeDomainValue(detail.domain)}` : undefined),
        daysRemaining,
        status,
        reason: detail && detail.reason ? String(detail.reason) : undefined
    };
}

function formatToIST(value) {
    if (!value) return 'N/A';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'N/A';
    return new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    }).format(date) + ' IST';
}

function getProjectSslEntries(project) {
    const rawEntries = (project && Array.isArray(project.ssl) && project.ssl.length > 0)
        ? project.ssl
        : ((project && Array.isArray(project.sslCerts)) ? project.sslCerts : []);
    const seen = new Set();

    return rawEntries
        .map((entry) => normalizeSslHost(entry))
        .filter((entry) => {
            if (!entry || seen.has(entry)) {
                return false;
            }

            seen.add(entry);
            return true;
        });
}

function decodeHtml(value) {
    return (value || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
}

function stripHtml(value) {
    return decodeHtml((value || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/pre>/gi, '\n')
        .replace(/<\/details>/gi, '\n')
        .replace(/<\/summary>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\n\s+/g, '\n')
        .replace(/[ \t]+/g, ' '));
}

function decodeBase64Value(value) {
    if (!value) {
        return undefined;
    }

    try {
        return Buffer.from(value, 'base64').toString('utf8');
    } catch (error) {
        return undefined;
    }
}

function normalizePlayStoreValue(playStore) {
    if (!playStore || typeof playStore !== 'string') {
        return null;
    }

    const trimmed = playStore.trim();
    if (!trimmed) {
        return null;
    }

    if (/^https?:\/\//i.test(trimmed)) {
        try {
            const url = new URL(trimmed);
            const packageName = url.searchParams.get('id') || '';

            if (!packageName) {
                return null;
            }

            return {
                packageName,
                expectedUrl: trimmed
            };
        } catch (error) {
            return null;
        }
    }

    return {
        packageName: trimmed,
        expectedUrl: `https://play.google.com/store/apps/details?id=${trimmed}`
    };
}

function getSuiteReportPath(repository) {
    return path.join(__dirname, 'suite-reports', `${repository.replace(/[^a-zA-Z0-9]/g, '_')}.html`);
}

function readSuiteRows(repository) {
    if (suiteConfigCache.suiteRows[repository]) {
        return suiteConfigCache.suiteRows[repository];
    }

    const reportPath = getSuiteReportPath(repository);
    if (!fs.existsSync(reportPath)) {
        console.warn('Suite report not found:', reportPath);
        suiteConfigCache.suiteRows[repository] = [];
        return suiteConfigCache.suiteRows[repository];
    }

    const html = fs.readFileSync(reportPath, 'utf8');
    const rowPattern = /<tr class="test-row (passed|failed|skipped)">[\s\S]*?<td class="test-name">([^<]+)<\/td>[\s\S]*?<span class="status-badge [^"]+">([^<]+)<\/span>[\s\S]*?<td class="test-duration">([^<]+)<\/td>[\s\S]*?<td class="test-details"([^>]*)>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/gi;
    const rows = [];

    for (const match of html.matchAll(rowPattern)) {
        const attributes = match[5] || '';
        const requestBodyMatch = attributes.match(/data-request-body="([^"]*)"/i);
        const responseBodyMatch = attributes.match(/data-response-body="([^"]*)"/i);
        const responseCodeMatch = attributes.match(/data-response-code="([^"]*)"/i);
        const expectedStatusMatch = attributes.match(/data-expected-status="([^"]*)"/i);

        rows.push({
            status: match[1].toLowerCase(),
            title: decodeHtml(match[2]),
            badge: decodeHtml(match[3]).toLowerCase(),
            duration: decodeHtml(match[4]),
            details: stripHtml(match[6]),
            requestBody: decodeBase64Value(requestBodyMatch && requestBodyMatch[1]),
            responseBody: decodeBase64Value(responseBodyMatch && responseBodyMatch[1]),
            responseCode: decodeHtml(responseCodeMatch && responseCodeMatch[1]),
            expectedStatus: decodeHtml(expectedStatusMatch && expectedStatusMatch[1])
        });
    }

    suiteConfigCache.suiteRows[repository] = rows;
    return rows;
}

function findSuiteRow(rows, expectedTitle) {
    const normalizedExpected = normalizeText(expectedTitle);
    return rows.find((row) => normalizeText(row.title) === normalizedExpected);
}

function loadAppSuiteDefinitions() {
    if (suiteConfigCache.apps) {
        return suiteConfigCache.apps;
    }

    const mapping = getProjectMapping();
    suiteConfigCache.apps = (mapping.projects || [])
        .flatMap((project) => project.apps || [])
        .map((app) => {
            const normalized = normalizePlayStoreValue(app && app.playStore);
            if (!app || !app.name || !normalized) {
                return null;
            }

            return {
                appName: app.name,
                packageName: normalized.packageName,
                expectedUrl: normalized.expectedUrl
            };
        })
        .filter(Boolean);

    return suiteConfigCache.apps;
}

function loadCertificateSuiteDefinitions() {
    if (suiteConfigCache.certificates) {
        return suiteConfigCache.certificates;
    }

    const mapping = getProjectMapping();
    const seen = new Set();
    suiteConfigCache.certificates = (mapping.projects || [])
        .flatMap((project) => getProjectSslEntries(project).map((url) => ({
            name: url,
            url
        })))
        .filter((entry) => {
            const key = normalizeSslHost(entry.url);
            if (!key || seen.has(key)) {
                return false;
            }

            seen.add(key);
            return true;
        });

    return suiteConfigCache.certificates;
}

function loadApiSuiteDefinitions() {
    if (suiteConfigCache.apis) {
        return suiteConfigCache.apis;
    }

    const mapping = getProjectMapping();
    suiteConfigCache.apis = (mapping.projects || [])
        .flatMap((project) => project.apis || [])
        .filter((entry) => entry && entry.name && entry.url && entry.method)
        .map((entry) => ({
            name: entry.name,
            url: entry.url,
            method: entry.method,
            expectedStatus: entry.expectedStatus
        }));

    return suiteConfigCache.apis;
}

function loadDomainReportEntries() {
    const state = readDashboardState();
    const stateGeneratedAt = state && state.generatedAt ? state.generatedAt : '';

    if (suiteConfigCache.domains && suiteConfigCache.domainsCacheKey === stateGeneratedAt) {
        return suiteConfigCache.domains;
    }

    const domainDetails = state && state.suites && state.suites.domain && Array.isArray(state.suites.domain.details)
        ? state.suites.domain.details
        : [];

    const stateEntries = domainDetails
        .map((detail) => {
            const normalizedDetail = normalizeDomainDetail(detail);
            const normalizedDomain = normalizeSslHost(normalizedDetail && normalizedDetail.domain);
            if (!normalizedDomain) {
                return null;
            }

            let status = 'failed';
            if (normalizedDetail.status === 'active') {
                status = 'passed';
            } else if (normalizedDetail.status === 'expiring') {
                status = 'warning';
            } else if (normalizedDetail.status === 'error') {
                status = 'failed';
            }

            return {
                name: normalizedDomain,
                domain: normalizedDomain,
                status,
                expiryDate: normalizedDetail.expiryDate || null,
                expiryDateIST: normalizedDetail.expiryDateIST || formatToIST(normalizedDetail.expiryDate),
                daysRemaining: normalizedDetail.daysRemaining ?? null,
                details: ''
            };
        })
        .filter(Boolean);

    const htmlEntries = [];
    if (fs.existsSync(DOMAIN_REPORT_OUTPUT_PATH)) {
        const html = fs.readFileSync(DOMAIN_REPORT_OUTPUT_PATH, 'utf8');
        const cardPattern = /<div class="domain-card(?: expiring-soon| error)?"[^>]*>[\s\S]*?<div class="days-remaining(?: [^"]+)?"[^>]*>[\s\S]*?<\/div>[\s\S]*?<\/div>[\s\S]*?<\/div>/gi;

        for (const cardMatch of html.matchAll(cardPattern)) {
            const cardHtml = cardMatch[0];
            const nameMatch = cardHtml.match(/<div class="domain-name">([^<]+)<\/div>/i);
            const domainMatch = cardHtml.match(/<div class="domain-url">([^<]+)<\/div>/i);
            const badgeClassMatch = cardHtml.match(/<span class="status-badge ([^"]+)">/i);
            const expiryDateMatch = cardHtml.match(/<div class="expiry-date">([^<]+)<\/div>/i);
            const expiryDateISTMatch = cardHtml.match(/<div class="expiry-date-ist">([^<]+)<\/div>/i);
            const daysTextMatch = cardHtml.match(/<div class="days-remaining(?: [^"]+)?"[^>]*>\s*([^<]+)\s*<\/div>/i);

            if (!nameMatch || !domainMatch || !badgeClassMatch || !expiryDateMatch) {
                continue;
            }

            const badgeClass = badgeClassMatch[1] || '';
            const daysText = decodeHtml((daysTextMatch && daysTextMatch[1]) || '');
            const daysRemaining = normalizeDaysRemaining(daysText);
            const status = classifyExpiryStatus(daysRemaining, !badgeClass.includes('status-active'));

            htmlEntries.push({
                name: decodeHtml(nameMatch[1]),
                domain: decodeHtml(domainMatch[1]),
                status,
                expiryDate: decodeHtml(expiryDateMatch[1]),
                expiryDateIST: decodeHtml((expiryDateISTMatch && expiryDateISTMatch[1]) || '') || formatToIST(decodeHtml(expiryDateMatch[1])),
                daysRemaining,
                details: daysText
            });
        }
    }

    if (fs.existsSync(DOMAIN_MODULE_REPORT_PATH)) {
        const html = fs.readFileSync(DOMAIN_MODULE_REPORT_PATH, 'utf8');
        const cardPattern = /<article class="report-card [^"]+">[\s\S]*?<\/article>/gi;

        for (const cardMatch of html.matchAll(cardPattern)) {
            const cardHtml = cardMatch[0];
            const nameMatch = cardHtml.match(/<h2>([^<]+)<\/h2>/i);
            const badgeMatch = cardHtml.match(/<span class="badge [^"]+">([^<]+)<\/span>/i);
            if (!nameMatch) {
                continue;
            }

            const fields = {};
            for (const fieldMatch of cardHtml.matchAll(/<div class="field(?: [^"]+)?">\s*<div class="field-label">([^<]+)<\/div>\s*<div class="field-value">([\s\S]*?)<\/div>\s*<\/div>/gi)) {
                fields[decodeHtml(fieldMatch[1])] = stripHtml(fieldMatch[2]);
            }

            const domain = decodeHtml(nameMatch[1]);
            const statusText = decodeHtml((badgeMatch && badgeMatch[1]) || '').toLowerCase();
            htmlEntries.push({
                name: domain,
                domain,
                url: fields.URL || `https://${normalizeDomainValue(domain)}`,
                status: statusText === 'failed' ? 'failed' : statusText === 'warning' ? 'warning' : 'passed',
                expiryDate: fields['Expiry Date (UTC)'] || null,
                expiryDateIST: fields['Expiry Date (IST)'] || formatToIST(fields['Expiry Date (UTC)']),
                daysRemaining: normalizeDaysRemaining(fields['Days Remaining']),
                details: fields['Domain Status'] || statusText
            });
        }
    }

    const entries = dedupeTrackedResults('domain', [...stateEntries, ...htmlEntries].map(normalizeDomainDetail));

    suiteConfigCache.domains = entries;
    suiteConfigCache.domainsCacheKey = stateGeneratedAt;
    return suiteConfigCache.domains;
}

function loadSslReportEntries() {
    const state = readDashboardState();
    const stateGeneratedAt = state && state.generatedAt ? state.generatedAt : '';

    if (suiteConfigCache.ssl && suiteConfigCache.sslCacheKey === stateGeneratedAt) {
        return suiteConfigCache.ssl;
    }

    const stateDetails = state && state.suites && state.suites.cert && Array.isArray(state.suites.cert.details)
        ? state.suites.cert.details
        : [];

    const normalizedStateEntries = stateDetails
        .map((detail) => normalizeSslDetail(detail))
        .filter((detail) => normalizeSslHost(detail && (detail.domain || detail.url)))
        .map((detail) => ({
            domain: normalizeSslHost(detail.domain || detail.url),
            url: detail.url || `https://${normalizeSslHost(detail.domain || detail.url)}`,
            status: detail.status,
            expiryDate: detail.expiryDate || null,
            expiryDateIST: detail.expiryDateIST || formatToIST(detail.expiryDate),
            daysRemaining: detail.daysRemaining ?? null,
            reason: detail.reason || ''
        }));

    const htmlEntries = [];
    if (fs.existsSync(CERTIFICATE_REPORT_OUTPUT_PATH)) {
        const html = fs.readFileSync(CERTIFICATE_REPORT_OUTPUT_PATH, 'utf8');
        const cardPattern = /<div class="cert-card(?: expiring-soon| error)?"[^>]*>[\s\S]*?<div class="days-remaining(?: [^"]+)?"[^>]*>[\s\S]*?<\/div>[\s\S]*?<\/div>[\s\S]*?<\/div>/gi;

        for (const cardMatch of html.matchAll(cardPattern)) {
            const cardHtml = cardMatch[0];
            const nameMatch = cardHtml.match(/<div class="cert-name">([^<]+)<\/div>/i);
            const urlMatch = cardHtml.match(/<div class="cert-url">([^<]+)<\/div>/i);
            const badgeClassMatch = cardHtml.match(/<span class="status-badge ([^"]+)">/i);
            const expiryDateMatch = cardHtml.match(/<div class="expiry-date">([^<]+)<\/div>/i);
            const expiryDateISTMatch = cardHtml.match(/<div class="expiry-date-ist">([^<]+)<\/div>/i);
            const daysTextMatch = cardHtml.match(/<div class="days-remaining(?: [^"]+)?"[^>]*>\s*([^<]+)\s*<\/div>/i);
            const reasonMatch = cardHtml.match(/<div class="error-reason">(?:<strong>[^<]+<\/strong>\s*)?([^<]+)<\/div>/i);

            if (!nameMatch || !urlMatch || !badgeClassMatch || !expiryDateMatch) {
                continue;
            }

            const badgeClass = badgeClassMatch[1] || '';
            const url = decodeHtml(urlMatch[1]);
            const domain = normalizeSslHost(decodeHtml(nameMatch[1]) || url);
            const daysText = decodeHtml((daysTextMatch && daysTextMatch[1]) || '');
            const daysRemaining = normalizeDaysRemaining(daysText);
            const status = classifyExpiryStatus(daysRemaining, badgeClass.includes('status-error'));

            htmlEntries.push({
                domain,
                url: url || `https://${domain}`,
                status,
                expiryDate: decodeHtml(expiryDateMatch[1]),
                expiryDateIST: decodeHtml((expiryDateISTMatch && expiryDateISTMatch[1]) || '') || formatToIST(decodeHtml(expiryDateMatch[1])),
                daysRemaining,
                reason: decodeHtml((reasonMatch && reasonMatch[1]) || '') || daysText
            });
        }
    }

    if (fs.existsSync(SSL_MODULE_REPORT_PATH)) {
        const html = fs.readFileSync(SSL_MODULE_REPORT_PATH, 'utf8');
        const cardPattern = /<article class="report-card [^"]+">[\s\S]*?<\/article>/gi;

        for (const cardMatch of html.matchAll(cardPattern)) {
            const cardHtml = cardMatch[0];
            const nameMatch = cardHtml.match(/<h2>([^<]+)<\/h2>/i);
            const badgeMatch = cardHtml.match(/<span class="badge [^"]+">([^<]+)<\/span>/i);
            if (!nameMatch) {
                continue;
            }

            const fields = {};
            for (const fieldMatch of cardHtml.matchAll(/<div class="field(?: [^"]+)?">\s*<div class="field-label">([^<]+)<\/div>\s*<div class="field-value">([\s\S]*?)<\/div>\s*<\/div>/gi)) {
                fields[decodeHtml(fieldMatch[1])] = stripHtml(fieldMatch[2]);
            }

            const domain = normalizeSslHost(decodeHtml(nameMatch[1]) || fields.URL);
            const statusText = decodeHtml((badgeMatch && badgeMatch[1]) || '').toLowerCase();
            htmlEntries.push({
                domain,
                url: fields.URL || `https://${domain}`,
                status: statusText === 'failed' ? 'failed' : statusText === 'warning' ? 'warning' : 'passed',
                expiryDate: fields['Expiry Date (UTC)'] || null,
                expiryDateIST: fields['Expiry Date (IST)'] || formatToIST(fields['Expiry Date (UTC)']),
                daysRemaining: normalizeDaysRemaining(fields['Days Remaining']),
                reason: fields['Certificate Status'] || statusText
            });
        }
    }

    const mergedEntries = dedupeTrackedResults('ssl', [...normalizedStateEntries, ...htmlEntries].map(normalizeSslDetail));

    suiteConfigCache.ssl = mergedEntries;
    suiteConfigCache.sslCacheKey = stateGeneratedAt;
    return suiteConfigCache.ssl;
}

function createEmptySuiteResult() {
    return { total: 0, passed: 0, failed: 0, warning: 0, skipped: 0, tests: [] };
}

function getProjectDomainStatus(project, domainDetails) {
    const configuredDomains = new Set((project.domains || []).map((projectDomain) => normalizeDomainValue(projectDomain)).filter(Boolean));
    const matched = dedupeTrackedResults('domain', (domainDetails || []).map(normalizeDomainDetail)).filter((detail) =>
        configuredDomains.has(normalizeDomainValue(detail.domain || detail.url))
    );

    const total = matched.length;
    const passed = matched.filter((detail) => detail.status === 'active').length;
    const warning = matched.filter((detail) => detail.status === 'expiring').length;
    const failed = matched.filter((detail) => detail.status === 'error').length;

    return { total, passed, warning, failed, matched };
}

function getProjectSslDetails(project, sslDetails) {
    const sslEntries = getProjectSslEntries(project);
    const configuredSslEntries = new Set(sslEntries.map((entry) => normalizeDomainValue(entry)).filter(Boolean));
    const sslResults = dedupeTrackedResults('ssl', (sslDetails || []).map(normalizeSslDetail)).filter((detail) =>
        configuredSslEntries.has(normalizeDomainValue(detail.domain || detail.url))
    );
    return sslResults;
}

function attachProjectDomainStatuses(projects, dashboardState) {
    const domainDetails = loadDomainReportEntries().map(normalizeDomainDetail);

    projects.forEach((project) => {
        const status = getProjectDomainStatus(project, domainDetails);
        project.domainStatus = {
            total: status.total,
            passed: status.passed,
            warning: status.warning,
            failed: status.failed
        };
    });
}

function attachProjectSslDetails(projects, dashboardState) {
    const sslDetails = loadSslReportEntries().map(normalizeSslDetail);

    projects.forEach((project) => {
        project.sslDetails = getProjectSslDetails(project, sslDetails);
    });
}

function attachProjectServerStatuses(projects) {
    (projects || []).forEach((project) => {
        const serverResults = getServerTestResults(project.id);
        const serverByKey = new Map((serverResults.tests || []).map((test) => [`${normalizeText(test.name)}::${normalizeUrl(test.url)}`, test]));

        project.servers = (project.servers || []).map((server) => {
            const key = `${normalizeText(server.name)}::${normalizeUrl(server.url)}`;
            const matched = serverByKey.get(key);

            if (matched) {
                return {
                    ...server,
                    status: matched.status,
                    message: matched.message || matched.reason,
                    responseTime: matched.responseTime ?? 0
                };
            }

            if (isSkippedServerDefinition(server)) {
                return {
                    ...server,
                    status: 'skipped',
                    message: SKIPPED_SERVER_MESSAGE,
                    responseTime: 0
                };
            }

            return server;
        });
    });
}

function getAppTestResults(projectId) {
    try {
        const mapping = getProjectMapping();
        const project = mapping.projects.find((entry) => entry.id === projectId);

        if (!project || !project.apps || project.apps.length === 0) {
            return createEmptySuiteResult();
        }

        const rows = readSuiteRows('Adhash_App_Status');
        const definitions = loadAppSuiteDefinitions();
        const result = createEmptySuiteResult();

        project.apps.forEach((app) => {
            const definition = definitions.find((entry) => normalizeText(entry.appName) === normalizeText(app.name));
            if (!definition) {
                return;
            }

            const row = findSuiteRow(rows, `Verify ${definition.appName} on Play Store`);
            if (!row || row.status === 'skipped') {
                return;
            }

            result.total++;
            if (row.status === 'passed') {
                result.passed++;
            } else {
                result.failed++;
            }

            result.tests.push({
                name: definition.appName,
                platform: 'Play Store',
                url: definition.expectedUrl,
                status: row.status,
                type: 'app'
            });
        });

        return result;
    } catch (error) {
        console.error('Error getting app test results:', error);
        return createEmptySuiteResult();
    }
}

function getServerTestResults(projectId) {
    try {
        const mapping = getProjectMapping();
        const project = mapping.projects.find((entry) => entry.id === projectId);

        if (!project || !project.servers || project.servers.length === 0) {
            return createEmptySuiteResult();
        }

        const rows = readSuiteRows('Adhash_AllProjects_Server');
        const result = createEmptySuiteResult();

        project.servers.forEach((server) => {
            const row = findSuiteRow(rows, `Check ${server.name} health`);
            if (!row && !isSkippedServerDefinition(server)) {
                return;
            }

            if (isSkippedServerDefinition(server) || row.status === 'skipped') {
                result.total++;
                result.skipped++;
                result.tests.push(buildSkippedServerResult(server));
                return;
            }

            result.total++;
            if (row.status === 'passed') {
                result.passed++;
            } else {
                result.failed++;
            }

            result.tests.push({
                name: server.name,
                url: server.url || '#',
                type: 'server',
                status: row.status,
                message: row.details || row.badge,
                responseTime: 0
            });
        });

        return result;
    } catch (error) {
        console.error('Error getting server test results:', error);
        return createEmptySuiteResult();
    }
}

function getSSLTestResults(projectId) {
    try {
        const sslDetails = dedupeTrackedResults('ssl', loadSslReportEntries().map(normalizeSslDetail));
        const mapping = getProjectMapping();
        const project = mapping.projects.find((entry) => entry.id === projectId);

        const sslEntries = getProjectSslEntries(project);

        if (!project || sslEntries.length === 0) {
            return createEmptySuiteResult();
        }

        const result = createEmptySuiteResult();

        const matched = dedupeTrackedResults('ssl', getProjectSslDetails(project, sslDetails));

        result.total = matched.length;
        result.passed = matched.filter((detail) => detail.status === 'passed').length;
        result.warning = matched.filter((detail) => detail.status === 'warning').length;
        result.failed = matched.filter((detail) => detail.status === 'failed').length;
        result.details = matched;

        matched.forEach((detail) => {
            result.tests.push({
                name: detail.domain,
                url: detail.url,
                status: detail.status,
                type: 'ssl',
                expiryDate: detail.expiryDate,
                expiryDateIST: detail.expiryDateIST || formatToIST(detail.expiryDate),
                daysRemaining: detail.daysRemaining,
                reason: detail.reason
            });
        });

        return result;
    } catch (error) {
        console.error('Error getting SSL test results:', error);
        return createEmptySuiteResult();
    }
}

function getDomainTestResults(projectId) {
    try {
        const domainDetails = dedupeTrackedResults('domain', loadDomainReportEntries().map(normalizeDomainDetail));
        const mapping = getProjectMapping();
        const project = mapping.projects.find((entry) => entry.id === projectId);

        if (!project || !project.domains || project.domains.length === 0) {
            return createEmptySuiteResult();
        }

        const result = createEmptySuiteResult();
        const status = getProjectDomainStatus(project, domainDetails);

        result.total = status.total;
        result.passed = status.passed;
        result.warning = status.warning;
        result.failed = status.failed;

        status.matched.forEach((detail) => {
            result.tests.push({
                name: detail.domain,
                url: detail.url || `https://${detail.domain}`,
                status: detail.status === 'active' ? 'passed' : detail.status === 'expiring' ? 'warning' : 'failed',
                type: 'domain',
                expiryDate: detail.expiryDate || null,
                expiryDateIST: detail.expiryDateIST || formatToIST(detail.expiryDate),
                daysRemaining: detail.daysRemaining ?? null
            });
        });

        return result;
    } catch (error) {
        console.error('Error getting domain test results:', error);
        return createEmptySuiteResult();
    }
}

function getAPITestResults(projectId) {
    try {
        const dashboardState = readDashboardState();
        const apiSuite = dashboardState && dashboardState.suites ? dashboardState.suites.api : null;
        const apiDetails = apiSuite && Array.isArray(apiSuite.details) ? apiSuite.details : [];
        const mapping = getProjectMapping();
        const project = mapping.projects.find((entry) => entry.id === projectId);

        if (!project || !project.apis || project.apis.length === 0) {
            return createEmptySuiteResult();
        }

        const result = createEmptySuiteResult();
        const projectApiKeys = new Set((project.apis || []).map((api) => buildApiStableKey(api.method, api.url, api.name)));

        let apiResults = dedupeApiResults(
            apiDetails.filter((detail) => detail && projectApiKeys.has(buildApiStableKey(detail.method, detail.url, detail.name)))
        );

        const rows = readSuiteRows('AdHash_API_Test');
        apiResults = apiResults.map((detail) => {
            const row = findSuiteRow(rows, `${normalizeApiMethod(detail.method)} ${detail.name}`);
            return {
                ...detail,
                duration: detail.duration || row?.duration,
                requestBody: detail.requestBody || row?.requestBody,
                responseBody: detail.responseBody || row?.responseBody
            };
        });
        const existingKeys = new Set(apiResults.map((detail) => buildApiStableKey(detail.method, detail.url, detail.name)));

        project.apis.forEach((api) => {
            const stableKey = buildApiStableKey(api.method, api.url, api.name);
            if (existingKeys.has(stableKey)) {
                return;
            }

            const method = (api.method || 'GET').toUpperCase();
            const row = findSuiteRow(rows, `${method} ${api.name}`);
            if (!row || row.status === 'skipped') {
                return;
            }

            const expectedStatus = typeof api.expectedStatus === 'number'
                ? api.expectedStatus
                : (/^\d+$/.test(String(row.expectedStatus || '').trim()) ? parseInt(String(row.expectedStatus).trim(), 10) : undefined);
            const status = classifyApiStatus(row.responseCode, expectedStatus);

            apiResults.push({
                name: api.name,
                url: api.url,
                method,
                duration: row.duration,
                requestBody: row.requestBody || (normalizeApiMethod(method) === 'GET' ? 'No request body' : 'Payload not provided'),
                responseBody: row.responseBody || 'No response body',
                responseCode: row.responseCode,
                expectedStatus,
                status,
                type: 'api'
            });
            existingKeys.add(stableKey);
        });

        result.tests = dedupeApiResults(apiResults);
        result.total = result.tests.length;
        result.passed = result.tests.filter((detail) => detail.status === 'passed').length;
        result.warning = result.tests.filter((detail) => detail.status === 'warning').length;
        result.failed = result.tests.filter((detail) => detail.status === 'failed').length;

        return result;
    } catch (error) {
        console.error('Error getting API test results:', error);
        return createEmptySuiteResult();
    }
}

// API endpoint to get test results for a project
app.get('/api/project/:id/test-results', (req, res) => {
    try {
        const projectId = req.params.id;

        const results = {
            apps: getAppTestResults(projectId),
            servers: getServerTestResults(projectId),
            ssl: getSSLTestResults(projectId),
            domains: getDomainTestResults(projectId),
            apis: getAPITestResults(projectId)
        };

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


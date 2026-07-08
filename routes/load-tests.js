'use strict';
/**
 * routes/load-tests.js
 * Server-side load testing engine — k6 only.
 */

const router = require('express').Router();
const fs     = require('fs');
const path       = require('path');
const crypto     = require('crypto');

// ── AES-128-ECB encryption (PKCS7 padding via Node crypto) ──
function aesEncrypt(plaintext, key) {
    const keyBuf = Buffer.from(key, 'utf8').slice(0, 16);
    const cipher = crypto.createCipheriv('aes-128-ecb', keyBuf, null);
    cipher.setAutoPadding(true);
    return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
}

// ── AES-128-CBC encryption/decryption ──
function aesCbcEncrypt(plaintext, key, iv) {
    const keyBuf = Buffer.from(key, 'utf8').slice(0, 16);
    const ivBuf  = Buffer.from(iv,  'utf8').slice(0, 16);
    const cipher = crypto.createCipheriv('aes-128-cbc', keyBuf, ivBuf);
    cipher.setAutoPadding(true);
    return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
}
function aesCbcDecrypt(b64, key, iv) {
    const keyBuf = Buffer.from(key, 'utf8').slice(0, 16);
    const ivBuf  = Buffer.from(iv,  'utf8').slice(0, 16);
    const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuf, ivBuf);
    decipher.setAutoPadding(true);
    return Buffer.concat([decipher.update(Buffer.from(b64, 'base64')), decipher.final()]).toString('utf8');
}

// ── Walk a parsed JSON value, replacing "__VAR:key__" sentinels with vars[key] ──
function _applyVarsToObj(obj, vars) {
    if (typeof obj === 'string') {
        const exact = obj.match(/^__VAR:(\w+)__$/);
        if (exact) return vars[exact[1]] !== undefined ? String(vars[exact[1]]) : '';
        return obj.replace(/__VAR:(\w+)__/g, (_, k) => vars[k] !== undefined ? vars[k] : '');
    }
    if (Array.isArray(obj)) return obj.map(v => _applyVarsToObj(v, vars));
    if (obj !== null && typeof obj === 'object') {
        const out = {};
        for (const k of Object.keys(obj)) out[k] = _applyVarsToObj(obj[k], vars);
        return out;
    }
    return obj;
}

// ── Dynamic payload generator ──
function buildDynPayloads(dynCfg, vus) {
    const results   = [];
    const startIdx  = parseInt(dynCfg.startIndex) || 1;
    const phoneBase = BigInt(dynCfg.phoneBase || '7100000000');
    const templateStr = dynCfg.template || '{}';
    // Pre-parse template once with sentinels so we have a safe JSON structure
    const templateParsed = JSON.parse(
        templateStr.replace(/"?\{\{(\w+)\}\}"?/g, (_, k) => `"__VAR:${k}__"`)
    );

    for (let i = 0; i < vus; i++) {
        const idx   = startIdx + i;
        const phone = String(phoneBase + BigInt(i));
        const email = `${dynCfg.emailPrefix}${idx}@${dynCfg.emailDomain}`;
        const name  = `${dynCfg.namePrefix}${idx}`;
        const vars  = {
            index: String(idx), email, phoneNumber: phone, name,
            timestamp: String(Date.now()), random: String(Math.floor(Math.random() * 1e9)),
            uuid: crypto.randomUUID(),
        };
        if (dynCfg.extraKey) vars[dynCfg.extraKey] = dynCfg.extraVal || '';

        const filledObj = _applyVarsToObj(templateParsed, vars);
        const bodyStr   = JSON.stringify(filledObj);

        let finalBody = bodyStr;
        if (dynCfg.encrypt && dynCfg.encKey) {
            const encField  = dynCfg.encField || 'encryptedData';
            const encrypted = aesEncrypt(bodyStr, dynCfg.encKey);
            finalBody = JSON.stringify({ [encField]: encrypted });
        }
        results.push({ vars, finalBody, email, phoneNumber: phone });
    }
    return results;
}

const REPORTS_DIR = path.join(__dirname, '..', 'reports', 'load-tests');
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

const RUNS_DIR = path.join(REPORTS_DIR, 'runs');
if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR, { recursive: true });

// ── In-memory run registry (survives across requests, cleared on restart) ──
const _runs = new Map(); // runId → { status, config, metrics, instance, startTime, logs, timeline }

// ── Auth helper ── reuse pattern from server.js
function isAuth(req) {
    // Allow if isAuthenticated is globally available (mounted after auth middleware)
    if (req.user || req.session?.authenticated) return true;
    const jwt = req.headers.authorization?.split(' ')[1] || req.query.token;
    if (!jwt) return false;
    try {
        const secret = process.env.JWT_SECRET || 'adhash-qa-jwt-secret-change-in-production-2026';
        require('jsonwebtoken').verify(jwt, secret);
        return true;
    } catch { return false; }
}
function auth(req, res, next) {
    if (!isAuth(req)) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

// ── Role-based VU limits ──
function maxVUs(req) {
    try {
        const secret = process.env.JWT_SECRET || 'adhash-qa-jwt-secret-change-in-production-2026';
        const jwt = req.headers.authorization?.split(' ')[1] || req.query.token;
        const payload = require('jsonwebtoken').verify(jwt, secret);
        if (payload.role === 'super_admin') return 1000;
        if (payload.role === 'admin')       return 200;
    } catch {}
    return 50;
}

// ── Mask sensitive header values in logs/reports ──
const SENSITIVE_HEADERS = new Set(['authorization','cookie','x-api-key','token','x-auth-token']);
function maskHeaders(headers = {}) {
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
        out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? '***masked***' : v;
    }
    return out;
}

// ── Percentile helper ──
function pct(arr, p) {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const i = Math.floor(s.length * p / 100);
    return s[Math.min(i, s.length - 1)];
}

// ── Pass/Risk/Fail verdict ──
function verdict(metrics, cfg) {
    const successRate = metrics.totalReqs > 0 ? (metrics.okReqs / metrics.totalReqs) * 100 : 0;
    const errRate     = 100 - successRate;
    const p95         = metrics.p95 || 0;
    const latThresh   = cfg.p95Threshold || 3000;

    if (successRate >= 98 && errRate <= 2 && p95 <= latThresh)           return 'PASS';
    if (successRate < 95  || errRate > 5  || p95 > latThresh * 2)        return 'FAIL';
    return 'RISK';
}

// ── Default metrics object shape ──
const defaultMetrics = {
    totalReqs: 0, okReqs: 0, errReqs: 0, rps: 0,
    avgLatency: 0, p50: 0, p90: 0, p95: 0, p99: 0,
    minLatency: 0, maxLatency: 0, errRate: 0,
    dataSent: 0, dataRecv: 0, statusCodes: {},
    latencies: [], rpsHistory: [], latHistory: [],
    errHistory: [], activeUsersHistory: [], tickTimes: [],
};

// ══════════════════════════════════════════════════════════════════════════════
// Scenario persistence helpers — MongoDB (collection: load_test_scenarios)
// ══════════════════════════════════════════════════════════════════════════════
const { getDB } = require('../src/db');

function _scenariosCol() {
    return getDB().collection('load_test_scenarios');
}

async function _dbLoadScenarios() {
    const docs = await _scenariosCol().find({}).sort({ updatedAt: -1 }).toArray();
    return docs.map(({ _id, ...d }) => d);
}

async function _dbSaveScenario(scenario) {
    await _scenariosCol().updateOne(
        { id: scenario.id },
        { $set: scenario },
        { upsert: true }
    );
}

async function _dbDeleteScenario(id) {
    const result = await _scenariosCol().deleteOne({ id });
    return result.deletedCount > 0;
}

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/load-test/start  — k6 only
// ══════════════════════════════════════════════════════════════════════════════
router.post('/start', auth, async (req, res) => {
    // ── Validate k6 binary before starting ──
    const { spawn: spawnCheck } = require('child_process');
    const k6PathCheck = process.env.K6_PATH || 'k6';
    try {
        await new Promise((resolve, reject) => {
            const check = spawnCheck(k6PathCheck, ['version'], { timeout: 5000 });
            check.on('close', code => code === 0 ? resolve() : reject(new Error('k6 check failed')));
            check.on('error', reject);
        });
    } catch {
        return res.status(500).json({ error: 'k6 is not installed or not found. Install k6 from https://k6.io or set the K6_PATH environment variable.' });
    }

    // ── If caller sends full scenario (steps array), use it directly ──
    if (req.body.steps || req.body.scenario) {
        const scenario = req.body.scenario || req.body;
        const vus      = Math.min(Math.max(1, parseInt(scenario.vus) || 10), maxVUs(req));
        const duration = Math.min(300, Math.max(5, parseInt(scenario.duration) || 30));
        const runId    = 'lt_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
        const startTime = new Date().toISOString();
        const cfg = { ...scenario, vus, duration, startTime, scenarioMode: true };
        const runState = {
            runId, status: 'initializing', config: cfg,
            metrics: { ...defaultMetrics },
            logs: [], timeline: [{ time: startTime, event: 'Test started', phase: 'Initializing' }],
            startTime, endTime: null, instance: null, verdict: null,
            reportPath: null, reportJsonPath: null, perRequestResults: [],
        };
        _runs.set(runId, runState);
        res.json({ runId, status: 'initializing' });
        setImmediate(() => _executeK6Run(runId, cfg, runState));
        return;
    }

    // ── Single-URL mode: convert to single-step k6 scenario ──
    const {
        projectName, environment, url, method = 'GET',
        headers = {}, body: reqBody, queryParams = {},
        vus = 10, duration = 30, rampup = 0,
        timeout = 5000, rps,
        scenarioType = 'Baseline Load Test',
        stopOnErrorRate, stopOnP95,
        p95Threshold = 3000,
        executedBy = 'Dashboard',
        dynamicConfig = null,
    } = req.body || {};

    if (!url)      return res.status(400).json({ error: 'url is required' });
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'url must start with http:// or https://' });

    const limit     = maxVUs(req);
    const actualVUs = Math.min(Math.max(1, parseInt(vus) || 10), limit);
    const actualDur = Math.min(300, Math.max(5, parseInt(duration) || 30));

    for (const [, run] of _runs) {
        if (run.status === 'running' && run.config.url === url) {
            return res.status(409).json({ error: `A test is already running for ${url}` });
        }
    }

    // Build query string
    const qs      = Object.keys(queryParams).length ? '?' + new URLSearchParams(queryParams).toString() : '';
    const fullUrl = url + qs;

    // Build single-step scenario from Configure Test inputs
    const singleStep = {
        id:      'step1',
        name:    scenarioType,
        enabled: true,
        method:  method.toUpperCase(),
        url:     fullUrl,
        headers: maskHeaders(headers),
        body:    reqBody || null,
        assertions: [],
        captures: [],
        requestEncryption: { enabled: false },
        responseDecryption: { enabled: false },
        thinkTime: 0,
        retryCount: 0,
        timeout,
    };

    // Merge dynamic config into scenario dynamicData if provided
    const dynamicData = dynamicConfig ? {
        emailPrefix: dynamicConfig.emailPrefix,
        emailDomain: dynamicConfig.emailDomain,
        startIndex:  dynamicConfig.startIndex,
        phoneBase:   dynamicConfig.phoneBase,
        namePrefix:  dynamicConfig.namePrefix,
    } : {};

    const scenario = {
        scenarioName: `${scenarioType} — ${projectName || 'Project'}`,
        projectName, environment, mode: 'single',
        vus: actualVUs, duration: actualDur, rampup,
        timeout, rps, scenarioType, scenarioMode: true,
        p95Threshold, stopOnErrorRate, stopOnP95,
        executedBy, url: fullUrl,
        steps: [singleStep],
        globalVars: {},
        dynamicData,
    };

    const runId     = 'lt_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    const startTime = new Date().toISOString();
    const cfg       = { ...scenario, startTime };

    const runState = {
        runId, status: 'initializing', config: cfg,
        metrics: { ...defaultMetrics },
        logs: [], timeline: [{ time: startTime, event: 'Test started', phase: 'Initializing' }],
        startTime, endTime: null, instance: null, verdict: null,
        reportPath: null, reportJsonPath: null, perRequestResults: [],
    };
    _runs.set(runId, runState);
    res.json({ runId, status: 'initializing' });
    setImmediate(() => _executeK6Run(runId, cfg, runState));
});

// ── Save JSON + HTML report ──
function _saveResults(runId, state) {
    try {
        const jsonPath = path.join(REPORTS_DIR, `${runId}.json`);
        const htmlPath = path.join(REPORTS_DIR, `${runId}.html`);
        const template = _loadTemplate();
        fs.writeFileSync(jsonPath, JSON.stringify(_serializeState(state), null, 2));
        fs.writeFileSync(htmlPath, _generateHtml(state, template));
        state.reportPath     = htmlPath;
        state.reportJsonPath = jsonPath;
    } catch (e) {
        console.error('[load-test] save failed:', e.message);
    }
}

function _serializeState(state) {
    const s = { ...state };
    delete s.instance;
    return s;
}

// ── Template store (simple JSON file) ──
const TEMPLATE_FILE = path.join(REPORTS_DIR, '_template.json');
function _loadTemplate() {
    try { return JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8')); } catch { return {}; }
}

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/load-test/status/:runId
// ══════════════════════════════════════════════════════════════════════════════
router.get('/status/:runId', auth, (req, res) => {
    const state = _runs.get(req.params.runId);
    if (!state) return res.status(404).json({ error: 'Run not found' });

    const elapsed = state.startTime
        ? Math.round((Date.now() - new Date(state.startTime).getTime()) / 1000) : 0;
    const remaining = Math.max(0, (state.config.duration || 30) - elapsed);

    res.json({
        runId:             req.params.runId,
        status:            state.status,
        verdict:           state.verdict,
        elapsed,
        remaining,
        config:            state.config,
        metrics:           state.metrics,
        logs:              state.logs.slice(-50),
        timeline:          state.timeline,
        phase:             state.timeline.length ? state.timeline[state.timeline.length - 1].phase : 'Initializing',
        perRequestResults: state.perRequestResults || [],
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/load-test/results/:runId
// ══════════════════════════════════════════════════════════════════════════════
router.get('/results/:runId', auth, (req, res) => {
    // Try memory first, then disk
    let state = _runs.get(req.params.runId);
    if (!state) {
        const jsonPath = path.join(REPORTS_DIR, `${req.params.runId}.json`);
        if (!fs.existsSync(jsonPath)) return res.status(404).json({ error: 'Results not found' });
        state = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    }
    res.json(_serializeState(state));
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/load-test/report/:runId  — view HTML
// ══════════════════════════════════════════════════════════════════════════════
router.get('/report/:runId', auth, (req, res) => {
    const htmlPath = path.join(REPORTS_DIR, `${req.params.runId}.html`);
    if (!fs.existsSync(htmlPath)) return res.status(404).send('<h2>Report not found</h2>');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(fs.readFileSync(htmlPath, 'utf8'));
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/load-test/report/:runId/download
// ══════════════════════════════════════════════════════════════════════════════
router.get('/report/:runId/download', auth, (req, res) => {
    const htmlPath = path.join(REPORTS_DIR, `${req.params.runId}.html`);
    if (!fs.existsSync(htmlPath)) return res.status(404).json({ error: 'Report not found' });
    const state = _runs.get(req.params.runId);
    const proj  = state?.config?.projectName || 'LoadTest';
    const ts    = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="LoadTest-${proj}-${ts}.html"`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(fs.readFileSync(htmlPath, 'utf8'));
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/load-test/stop/:runId
// ══════════════════════════════════════════════════════════════════════════════
router.post('/stop/:runId', auth, (req, res) => {
    const state = _runs.get(req.params.runId);
    if (!state) return res.status(404).json({ error: 'Run not found' });
    if (state.status !== 'running') return res.json({ ok: true, status: state.status });
    if (state.instance) {
        try {
            if (typeof state.instance.kill === 'function') state.instance.kill('SIGTERM');
        } catch {}
    }
    state.status  = 'stopped';
    state.endTime = new Date().toISOString();
    state.timeline.push({ time: state.endTime, event: 'Stopped by user', phase: 'Stopped' });
    state.verdict = verdict(state.metrics, state.config);
    _saveResults(req.params.runId, state);
    res.json({ ok: true, runId: req.params.runId, status: 'stopped' });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/load-test/history
// ══════════════════════════════════════════════════════════════════════════════
router.get('/history', auth, (req, res) => {
    const rows = [];

    // Scan disk for saved JSON reports
    if (fs.existsSync(REPORTS_DIR)) {
        for (const f of fs.readdirSync(REPORTS_DIR)) {
            if (!f.endsWith('.json') || f.startsWith('_')) continue;
            try {
                const data = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8'));
                rows.push({
                    runId:        data.runId,
                    projectName:  data.config?.projectName || '—',
                    environment:  data.config?.environment || '—',
                    scenarioType: data.config?.scenarioType || '—',
                    vus:          data.config?.vus || 0,
                    duration:     data.config?.duration || 0,
                    startTime:    data.startTime,
                    endTime:      data.endTime,
                    status:       data.status,
                    verdict:      data.verdict,
                    executedBy:   data.config?.executedBy || '—',
                    successRate:  data.metrics?.totalReqs > 0
                        ? parseFloat(((data.metrics.okReqs / data.metrics.totalReqs) * 100).toFixed(1))
                        : 0,
                    p95:          data.metrics?.p95 || 0,
                    hasReport:    fs.existsSync(path.join(REPORTS_DIR, f.replace('.json', '.html'))),
                });
            } catch {}
        }
    }

    rows.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    res.json({ runs: rows });
});

// ══════════════════════════════════════════════════════════════════════════════
// DELETE /api/load-test/history/:runId
// ══════════════════════════════════════════════════════════════════════════════
router.delete('/history/:runId', auth, (req, res) => {
    const id  = req.params.runId;
    const json = path.join(REPORTS_DIR, `${id}.json`);
    const html = path.join(REPORTS_DIR, `${id}.html`);
    if (fs.existsSync(json)) fs.unlinkSync(json);
    if (fs.existsSync(html)) fs.unlinkSync(html);
    _runs.delete(id);
    res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/load-test/demo-report
// ══════════════════════════════════════════════════════════════════════════════
router.post('/demo-report', auth, (req, res) => {
    const runId = 'lt_demo_' + Date.now();
    const startTime = new Date(Date.now() - 65000).toISOString();
    const endTime   = new Date().toISOString();

    const rpsH   = Array.from({ length: 60 }, (_, i) => parseFloat((85 + Math.sin(i / 5) * 8 + Math.random() * 4).toFixed(1)));
    const latH   = Array.from({ length: 60 }, (_, i) => parseFloat((120 + Math.cos(i / 4) * 15 + Math.random() * 10).toFixed(1)));
    const errH   = Array.from({ length: 60 }, ()    => parseFloat((0.3 + Math.random() * 0.4).toFixed(2)));
    const auH    = Array.from({ length: 60 }, ()    => 100);

    const state = {
        runId, status: 'completed',
        startTime, endTime,
        verdict: 'PASS',
        config: {
            projectName: req.body?.projectName || 'Ad-Hash',
            environment: req.body?.environment || 'QA',
            url: req.body?.url || 'https://adhash.com/',
            baseUrl: 'https://adhash.com/',
            method: 'GET', vus: 100, duration: 60, rampup: 10,
            timeout: 5000, scenarioType: req.body?.scenarioType || 'Baseline Load Test',
            p95Threshold: 3000, executedBy: 'Demo Generator',
            headers: {}, startTime,
        },
        metrics: {
            totalReqs: 5240, okReqs: 5187, errReqs: 53,
            rps: 87.3, avgLatency: 124, p50: 110, p90: 185, p95: 210, p99: 380,
            minLatency: 48, maxLatency: 892, errRate: 1.01,
            dataSent: 2621440, dataRecv: 52428800,
            statusCodes: { 200: 5187, 500: 30, 503: 23 },
            rpsHistory: rpsH, latHistory: latH, errHistory: errH,
            activeUsersHistory: auH,
            tickTimes: Array.from({ length: 60 }, (_, i) => new Date(Date.now() - (59 - i) * 1000).toISOString()),
        },
        logs: [
            { time: startTime, event: 'Test started', phase: 'Initializing' },
            { time: new Date(Date.now() - 55000).toISOString(), event: 'Ramp-up started', phase: 'Ramp-up' },
            { time: new Date(Date.now() - 45000).toISOString(), event: 'Peak users reached (100 VUs)', phase: 'Running' },
            { time: new Date(Date.now() - 5000).toISOString(),  event: 'Test completing', phase: 'Running' },
            { time: endTime, event: 'Test completed — 5240 requests · RPS 87.3 · P95 210ms', phase: 'Completed' },
        ],
        timeline: [
            { time: startTime, event: 'Test started', phase: 'Initializing' },
            { time: new Date(Date.now() - 55000).toISOString(), event: 'Ramp-up started', phase: 'Ramp-up' },
            { time: new Date(Date.now() - 45000).toISOString(), event: 'Peak users reached', phase: 'Running' },
            { time: endTime, event: 'Test completed', phase: 'Completed' },
            { time: new Date(Date.now() + 500).toISOString(), event: 'Report generated', phase: 'Completed' },
        ],
    };

    _runs.set(runId, state);
    _saveResults(runId, state);
    res.json({ runId, status: 'completed', verdict: 'PASS' });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/load-test/save-template
// ══════════════════════════════════════════════════════════════════════════════
router.post('/save-template', auth, (req, res) => {
    try {
        fs.writeFileSync(TEMPLATE_FILE, JSON.stringify(req.body || {}, null, 2));
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/load-test/report-template
// ══════════════════════════════════════════════════════════════════════════════
router.get('/report-template', auth, (req, res) => {
    res.json(_loadTemplate());
});

// ══════════════════════════════════════════════════════════════════════════════
// SCENARIO CRUD  /api/load-test/scenarios
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/load-test/scenarios — list all
router.get('/scenarios', auth, async (req, res) => {
    try {
        const scenarios = await _dbLoadScenarios();
        res.json({ scenarios });
    } catch (e) {
        res.status(500).json({ error: 'Failed to load scenarios: ' + e.message });
    }
});

// POST /api/load-test/scenarios — create
router.post('/scenarios', auth, async (req, res) => {
    try {
        const scenario = { ...req.body, id: crypto.randomUUID(), updatedAt: new Date().toISOString() };
        await _dbSaveScenario(scenario);
        res.status(201).json(scenario);
    } catch (e) {
        res.status(500).json({ error: 'Failed to save scenario: ' + e.message });
    }
});

// GET /api/load-test/scenarios/:id — get one
router.get('/scenarios/:id', auth, async (req, res) => {
    try {
        const col = _scenariosCol();
        const doc = await col.findOne({ id: req.params.id });
        if (!doc) return res.status(404).json({ error: 'Scenario not found' });
        const { _id, ...scenario } = doc;
        res.json(scenario);
    } catch (e) {
        res.status(500).json({ error: 'Failed to get scenario: ' + e.message });
    }
});

// PUT /api/load-test/scenarios/:id — update
router.put('/scenarios/:id', auth, async (req, res) => {
    try {
        const scenario = { ...req.body, id: req.params.id, updatedAt: new Date().toISOString() };
        await _dbSaveScenario(scenario);
        res.json(scenario);
    } catch (e) {
        res.status(500).json({ error: 'Failed to update scenario: ' + e.message });
    }
});

// DELETE /api/load-test/scenarios/:id — delete
router.delete('/scenarios/:id', auth, async (req, res) => {
    try {
        const deleted = await _dbDeleteScenario(req.params.id);
        if (!deleted) return res.status(404).json({ error: 'Scenario not found' });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete scenario: ' + e.message });
    }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/load-test/decrypt — k6 calls this at runtime to decrypt a response
// body server-side (Node crypto), avoiding k6 WebCrypto API issues entirely.
// No auth required — only accepts base64 ciphertext, returns decrypted JSON field.
// ══════════════════════════════════════════════════════════════════════════════
router.post('/decrypt', (req, res) => {
    try {
        const { ciphertext, key, iv, jsonPath } = req.body;
        if (!ciphertext || !key || !iv) return res.status(400).json({ error: 'Missing fields' });
        const plaintext = aesCbcDecrypt(ciphertext, key, iv);
        const parsed = JSON.parse(plaintext);
        const value = jsonPath
            ? jsonPath.split('.').reduce((o, k) => (o && o[k] !== undefined) ? o[k] : '', parsed)
            : parsed;
        res.json({ value: value !== undefined ? value : '' });
    } catch (e) {
        res.status(200).json({ value: '' }); // never crash k6 run on decrypt failure
    }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/load-test/encrypt — k6 calls this at runtime to encrypt a request
// body with runtime variable values (e.g. emailVerificationToken from Step 3).
// ══════════════════════════════════════════════════════════════════════════════
router.post('/encrypt', (req, res) => {
    try {
        const { plaintext, key, iv, outputField } = req.body;
        if (!plaintext || !key || !iv) return res.status(400).json({ error: 'Missing fields' });
        const encrypted = aesCbcEncrypt(plaintext, key, iv);
        const field = outputField || 'encryptedData';
        res.json({ body: JSON.stringify({ [field]: encrypted }) });
    } catch (e) {
        res.status(200).json({ body: '{}' });
    }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/load-test/scenario/k6-script — generate downloadable k6 script
// ══════════════════════════════════════════════════════════════════════════════
router.post('/scenario/k6-script', auth, (req, res) => {
    const scenario = req.body;
    try {
        const script = _scenarioToK6Script(scenario);
        res.setHeader('Content-Type', 'application/javascript');
        res.setHeader('Content-Disposition', `attachment; filename="k6-${(scenario.scenarioName || 'scenario').replace(/\s+/g, '-')}.js"`);
        res.send(script);
    } catch (e) {
        res.status(400).json({ error: 'Script generation failed: ' + e.message });
    }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/load-test/scenario/dry-run — run with vus=1, duration=30
// ══════════════════════════════════════════════════════════════════════════════
router.post('/scenario/dry-run', auth, async (req, res) => {
    const scenario = { ...req.body, vus: 1, duration: 30, threads: 1 };
    const runId    = 'lt_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    const startTime = new Date().toISOString();
    const cfg = { ...scenario, startTime, scenarioMode: true };
    const runState = {
        runId, status: 'initializing', config: cfg,
        metrics: { ...defaultMetrics },
        logs: [], timeline: [{ time: startTime, event: 'Dry-run started', phase: 'Initializing' }],
        startTime, endTime: null, instance: null, verdict: null,
        reportPath: null, reportJsonPath: null, perRequestResults: [],
    };
    _runs.set(runId, runState);
    res.json({ runId, status: 'initializing' });
    setImmediate(() => _executeK6Run(runId, cfg, runState));
});

// ══════════════════════════════════════════════════════════════════════════════
// k6 scenario helpers
// ══════════════════════════════════════════════════════════════════════════════

function _scenarioToK6Script(scenario) {
    const {
        vus = 10, duration = 30, rampup = 0, timeout = 5000,
        p95Threshold = 3000, stopOnErrorRate, stopOnP95,
        globalVars = {}, dynamicData = {}, steps = [],
        scenarioName = 'Load Test',
    } = scenario;
    // For workflow scenarios: each VU runs the full flow exactly once → iterations = vus
    const iterations = vus;

    const enabledSteps = steps.filter(s => s.enabled !== false);

    // Build per-VU data array (for dynamic data)
    // Generate enough rows to cover all iterations with buffer
    const iterEstimate = Math.ceil(vus * (scenario.duration || 30) * 1.5);
    const dataArray = _buildK6DataArray(scenario, Math.max(vus, iterations, iterEstimate, 100));

    // Build options
    // Workflow scenarios use shared-iterations: N VUs each run the full flow once simultaneously.
    // Single-step tests use duration-based execution.
    const isWorkflow = enabledSteps.length > 1;
    let optionsStr;
    if (isWorkflow) {
        // shared-iterations: exactly vus iterations total, spread across vus VUs
        // Each VU runs the full Step1→Step2→Step3→Step4 flow exactly once
        const graceTime = Math.max(30, duration);
        optionsStr = `export const options = {
  scenarios: {
    registration_flow: {
      executor: 'shared-iterations',
      vus: ${vus},
      iterations: ${iterations},
      maxDuration: '${graceTime}s',
    },
  },
  thresholds: {
    'http_req_duration{isProxy:false}': ['p(95)<${p95Threshold}'],
    'http_req_failed{isProxy:false}': ['rate<0.10'],
    ${stopOnErrorRate ? `'http_req_failed{isProxy:false}': ['rate<${stopOnErrorRate / 100}'],` : ''}
  },
};`;
    } else if (rampup > 0) {
        optionsStr = `export const options = {
  stages: [
    { duration: '${rampup}s', target: ${vus} },
    { duration: '${Math.max(1, duration - rampup)}s', target: ${vus} },
  ],
  thresholds: {
    http_req_duration: ['p(95)<${p95Threshold}'],
    ${stopOnErrorRate ? `'http_req_failed': ['rate<${stopOnErrorRate / 100}'],` : ''}
  },
};`;
    } else {
        optionsStr = `export const options = {
  vus: ${vus},
  duration: '${duration}s',
  thresholds: {
    http_req_duration: ['p(95)<${p95Threshold}'],
    ${stopOnErrorRate ? `'http_req_failed': ['rate<${stopOnErrorRate / 100}'],` : ''}
  },
};`;
    }

    // Build data array string
    const dataStr = JSON.stringify(dataArray, null, 2);

    // Build global vars
    const varsStr = JSON.stringify(globalVars, null, 2);

    // Build steps code
    const stepsCode = enabledSteps.map((step, idx) => _generateStepCode(step, idx)).join('\n\n');

    // Check if any step uses response decryption
    const needsDecrypt = enabledSteps.some(s => s.responseDecryption?.enabled && s.responseDecryption?.key);

    return `import http from 'k6/http';
import { sleep, check } from 'k6';
import { Rate, Counter, Trend } from 'k6/metrics';

// ── Generated by AdHash Load Test Center ──
// Scenario: ${scenarioName}
// Generated: ${new Date().toISOString()}

${optionsStr}

const DATA = ${dataStr};
const GLOBAL_VARS = ${varsStr};

// Server-side crypto proxies — Node.js AES-CBC (avoids k6 WebCrypto limitations)
const _BASE_URL = '${process.env.DASHBOARD_URL || 'https://adhashprojectdashboard-production.up.railway.app'}';
const DECRYPT_URL = _BASE_URL + '/api/load-test/decrypt';
const ENCRYPT_URL = _BASE_URL + '/api/load-test/encrypt';

function _get(obj, path) {
  return path.split('.').reduce((o, k) => (o && o[k] !== undefined) ? o[k] : undefined, obj);
}

function _resolveVars(str, vars) {
  if (typeof str !== 'string') return str;
  return str.replace(/\\{\\{(\\w+)\\}\\}/g, (_, k) => vars[k] !== undefined ? vars[k] : '{{' + k + '}}');
}

function _resolveObj(obj, vars) {
  if (typeof obj === 'string') return _resolveVars(obj, vars);
  if (Array.isArray(obj)) return obj.map(v => _resolveObj(v, vars));
  if (obj !== null && typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = _resolveObj(obj[k], vars);
    return out;
  }
  return obj;
}

export default function () {
  // With shared-iterations (1 iteration per VU), __VU is 1-based and unique per VU.
  // __ITER resets to 0 for each VU so all VUs pick the same row — use __VU-1 instead.
  const vuIdx = (__VU - 1) % DATA.length;
  const vuData = DATA[vuIdx];
  const vars = Object.assign({}, GLOBAL_VARS, vuData);

${stepsCode}
}
`;
}

function _generateStepCode(step, idx) {
    const varName = `resp${idx + 1}`;
    const method  = (step.method || 'GET').toUpperCase();
    const retryCount = step.retryCount || 0;
    const thinkTime  = step.thinkTime  || 0;

    // Build params
    const paramsObj = {
        tags:    { step: step.name || `Step${idx+1}`, stepId: step.id || `step${idx+1}` },
        timeout: Math.round((step.timeout || 5000) / 1000) + 's',
    };

    // Build headers resolution
    let headersCode = '';
    if (step.headers && Object.keys(step.headers).length > 0) {
        headersCode = `  const _headers${idx+1} = _resolveObj(${JSON.stringify(step.headers)}, vars);\n`;
        paramsObj.headers = `__HEADERS_REF_${idx+1}__`;
    }

    // Build body resolution
    let bodyCode = '';
    let bodyRef  = 'null';
    if (['POST','PUT','PATCH'].includes(method) && step.body) {
        let bodyVal = step.body;
        const enc = step.requestEncryption;
        if (enc?.enabled) {
            const bodyStr = typeof bodyVal === 'object' ? JSON.stringify(bodyVal) : bodyVal;
            // Check if body contains {{vars}} that are only known at runtime (captured from prior steps)
            // These cannot be pre-encrypted — must encrypt at runtime via proxy
            const hasRuntimeVars = /\{\{[^}]+\}\}/.test(bodyStr);
            if (hasRuntimeVars) {
                // Runtime encrypt: resolve vars first, then call /api/load-test/encrypt
                bodyCode = [
                    `  const _plainBody${idx+1} = _resolveVars(${JSON.stringify(bodyStr)}, vars);`,
                    `  console.log('VU=' + __VU + ' STEP${idx+1} PLAIN_REQ=' + _plainBody${idx+1});`,
                    `  const _encResp${idx+1} = http.post(ENCRYPT_URL, JSON.stringify({ plaintext: _plainBody${idx+1}, key: ${JSON.stringify(enc.key)}, iv: ${JSON.stringify(enc.iv || '')}, outputField: ${JSON.stringify(enc.outputField || 'encryptedData')} }), { headers: { 'Content-Type': 'application/json' }, tags: { isProxy: 'true' }, timeout: '5s' });`,
                    `  const _body${idx+1} = ((_encResp${idx+1}.json() || {}).body) || '{}';`,
                    `  console.log('VU=' + __VU + ' STEP${idx+1} ENC_REQ=' + _body${idx+1});`,
                ].join('\n') + '\n';
                bodyRef = `_body${idx+1}`;
            } else {
                // No runtime vars — use pre-encrypted body from DATA array (faster)
                bodyRef = `vuData._encryptedBody_step${idx+1} || null`;
            }
        } else {
            if (typeof bodyVal === 'object') bodyVal = JSON.stringify(bodyVal);
            bodyCode = `  const _body${idx+1} = _resolveVars(${JSON.stringify(bodyVal)}, vars);\n`;
            bodyRef  = `_body${idx+1}`;
        }
    }

    // Build params string (replace header reference placeholder)
    const paramsStr = JSON.stringify(paramsObj)
        .replace(`"__HEADERS_REF_${idx+1}__"`, `_headers${idx+1}`);

    // Build URL
    const urlCode = `  const _url${idx+1} = _resolveVars(${JSON.stringify(step.url || '')}, vars);\n`;

    // HTTP call
    let httpCall;
    if (method === 'GET' || method === 'DELETE' || method === 'HEAD') {
        httpCall = `  const ${varName} = http.${method.toLowerCase()}(_url${idx+1}, ${paramsStr});`;
    } else {
        httpCall = `  const ${varName} = http.${method.toLowerCase()}(_url${idx+1}, ${bodyRef}, ${paramsStr});`;
    }

    // Assertions
    let assertCode = '';
    if (step.assertions && step.assertions.length > 0) {
        const checks = step.assertions.map(a => {
            if (a.type === 'status')   return `    '${step.name || 'step'} status ${a.expected}': r => r.status === ${a.expected}`;
            if (a.type === 'jsonPath') return `    '${step.name || 'step'} has ${a.path}': r => { try { const j = r.json(); return _get(j, '${a.path}') !== undefined; } catch { return false; } }`;
            if (a.type === 'contains') return `    '${step.name || 'step'} contains ${a.value}': r => (r.body || '').includes(${JSON.stringify(a.value)})`;
            return '';
        }).filter(Boolean).join(',\n');
        if (checks) assertCode = `  check(${varName}, {\n${checks}\n  });\n`;
    } else {
        assertCode = `  check(${varName}, { '${step.name || 'step'} ok': r => r.status >= 200 && r.status < 400 });\n`;
    }

    // Captures — if responseDecryption is enabled, call server-side decrypt proxy
    let captureCode = '';
    if (step.captures && step.captures.length > 0) {
        const dec = step.responseDecryption;
        if (dec?.enabled && dec.key && dec.iv) {
            // Call /api/load-test/decrypt (Node.js AES-CBC) — avoids k6 WebCrypto issues
            captureCode = step.captures.map(cap => {
                if (!cap.varName || !cap.jsonPath) return '';
                return [
                    `  try {`,
                    `    const _raw${idx+1} = ${varName}.json();`,
                    `    const _encField${idx+1} = (_raw${idx+1} && _raw${idx+1}['${dec.inputField || 'encryptedData'}']) || '';`,
                    `    const _decResp${idx+1} = http.post(`,
                    `      DECRYPT_URL,`,
                    `      JSON.stringify({ ciphertext: _encField${idx+1}, key: ${JSON.stringify(dec.key)}, iv: ${JSON.stringify(dec.iv)}, jsonPath: '${cap.jsonPath}' }),`,
                    `      { headers: { 'Content-Type': 'application/json' }, tags: { isProxy: 'true' }, timeout: '5s' }`,
                    `    );`,
                    `    vars['${cap.varName}'] = (_decResp${idx+1}.json() || {}).value || '';`,
                    `    console.log('VU=' + __VU + ' STEP${idx+1} captured ${cap.varName}=' + String(vars['${cap.varName}']).substring(0,60));`,
                    `  } catch(e) { vars['${cap.varName}'] = ''; console.log('VU=' + __VU + ' STEP${idx+1} capture error: ' + e); }`,
                ].join('\n');
            }).filter(Boolean).join('\n') + '\n';
        } else {
            captureCode = step.captures.map(cap => {
                if (!cap.varName || !cap.jsonPath) return '';
                return `  try { const _j${idx+1} = ${varName}.json(); vars['${cap.varName}'] = _get(_j${idx+1}, '${cap.jsonPath}'); } catch {}`;
            }).filter(Boolean).join('\n') + '\n';
        }
    }

    // Think time
    const thinkCode = thinkTime > 0 ? `  sleep(${(thinkTime / 1000).toFixed(3)});\n` : '';

    // Retry wrapper
    let retryWrapStart = '', retryWrapEnd = '';
    if (retryCount > 0) {
        retryWrapStart = `  let _retries${idx+1} = 0;\n  while (_retries${idx+1} <= ${retryCount}) {\n  _retries${idx+1}++;\n`;
        retryWrapEnd   = `  if (${varName}.status >= 200 && ${varName}.status < 400) break;\n  if (_retries${idx+1} > ${retryCount}) break;\n  sleep(${((step.retryDelay||500)/1000).toFixed(3)});\n  }\n`;
    }

    const code = [
        `  // ── Step ${idx+1}: ${step.name || 'Step'} ──\n`,
        urlCode,
        headersCode,
        bodyCode,
        retryWrapStart,
        httpCall + '\n',
        `  console.log('VU=' + __VU + ' STEP${idx+1}[' + ${varName}.status + '] ENC_RES=' + ${varName}.body.substring(0,400));\n`,
        assertCode,
        captureCode,
        retryWrapEnd,
        thinkCode,
    ].join('');

    return code;
}

function _buildK6DataArray(scenario, count) {
    const { dynamicData = {}, globalVars = {}, steps = [] } = scenario;
    // If no explicit startIndex, derive one from current minute so each run uses
    // fresh emails automatically (e.g. run at 14:37 → starts at loadtest14370001)
    const defaultStart = parseInt(String(Date.now()).slice(-6)); // last 6 digits of ms timestamp
    const startIdx   = parseInt(dynamicData.startIndex) || defaultStart;
    const phoneBase  = BigInt(dynamicData.phoneBase || '7100000000');
    const emailPrefix  = dynamicData.emailPrefix  || 'loadtest';
    const emailDomain  = dynamicData.emailDomain  || 'mailinator.com';
    const namePrefix   = dynamicData.namePrefix   || 'Load Test';

    const result = [];
    for (let i = 0; i < count; i++) {
        const idx   = startIdx + i;
        const email = `${emailPrefix}${idx}@${emailDomain}`;
        const phone = String(phoneBase + BigInt(i));
        const name  = `${namePrefix} ${idx}`;
        const vuData = {
            index:       String(idx),
            email,
            phoneNumber: phone,
            name,
            timestamp:   String(Date.now() + i),
            random:      String(Math.floor(Math.random() * 1e9)),
            uuid:        crypto.randomUUID(),
        };

        // If customData source, merge that record
        if (dynamicData.source === 'json' && dynamicData.customData && dynamicData.customData[i]) {
            Object.assign(vuData, dynamicData.customData[i]);
        }

        // Pre-encrypt step bodies if requestEncryption is enabled
        for (const step of steps) {
            if (step.requestEncryption?.enabled && step.body) {
                try {
                    let bodyStr = typeof step.body === 'string' ? step.body : JSON.stringify(step.body);
                    // Resolve vars in body
                    bodyStr = bodyStr.replace(/\{\{(\w+)\}\}/g, (_, k) =>
                        vuData[k] !== undefined ? vuData[k] : (globalVars[k] !== undefined ? globalVars[k] : '')
                    );
                    const enc = step.requestEncryption;
                    let encrypted;
                    if (enc.algorithm === 'AES-128-CBC') {
                        encrypted = aesCbcEncrypt(bodyStr, enc.key || '', enc.iv || '');
                    } else {
                        encrypted = aesEncrypt(bodyStr, enc.key || '');
                    }
                    const field = enc.outputField || 'encryptedData';
                    vuData[`_encryptedBody_step${steps.indexOf(step) + 1}`] = JSON.stringify({ [field]: encrypted });
                } catch {}
            }
        }

        result.push(vuData);
    }
    return result;
}

async function _executeK6Run(runId, cfg, state, addLog, addTimeline) {
    if (!addLog) {
        addLog = (event, phase, extra = {}) => {
            const entry = { time: new Date().toISOString(), event, phase, ...extra };
            state.logs.push(entry);
            if (state.logs.length > 500) state.logs.shift();
        };
        addTimeline = (event, phase) => {
            state.timeline.push({ time: new Date().toISOString(), event, phase });
        };
    }

    const { spawn } = require('child_process');
    const k6Path    = process.env.K6_PATH || 'k6';
    const runId_    = runId;

    try {
        // Generate k6 script
        const script     = _scenarioToK6Script(cfg);
        const scriptFile = path.join(RUNS_DIR, `${runId_}.k6.js`);
        const metricsFile = path.join(RUNS_DIR, `${runId_}.metrics.jsonl`);
        fs.writeFileSync(scriptFile, script);

        state.status       = 'running';
        state._metricsFile = metricsFile;
        addLog('k6 script generated', 'Running');
        addTimeline('k6 run started', 'Running');

        const k6Args = [
            'run',
            '--out', `json=${metricsFile}`,
            '--no-usage-report',
            '--log-output', 'stdout',
        ];

        // For multi-step workflows (shared-iterations) or rampup stages, options are fully
        // defined in the script — do NOT pass --vus/--duration CLI flags, they override
        // options.scenarios in the script and switch k6 to duration-based execution,
        // which breaks shared-iterations (VUs loop instead of running once each).
        const enabledStepCount = Array.isArray(cfg.steps) ? cfg.steps.filter(s => s.enabled !== false).length : 0;
        const isWorkflowRun = cfg.scenarioMode && enabledStepCount > 1;
        if (!isWorkflowRun && (!cfg.rampup || cfg.rampup === 0)) {
            k6Args.push('--vus',      String(cfg.vus || 10));
            k6Args.push('--duration', (cfg.duration || 30) + 's');
        }

        k6Args.push(scriptFile);

        const proc = spawn(k6Path, k6Args, {
            env:   { ...process.env, K6_NO_SETUP_MESSAGE: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        state.instance = proc;

        // vuStepMap accumulates partial step data keyed by "VU:step"
        const vuStepMap = {};

        let stdoutBuf = '';
        proc.stdout.on('data', chunk => {
            stdoutBuf += chunk.toString();
            const lines = stdoutBuf.split('\n');
            stdoutBuf   = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                addLog(line.trim().substring(0, 200), 'Running');

                // Parse structured VU/step log lines emitted by the k6 script
                // Format: ...msg="VU=N STEPN PLAIN_REQ=..." or ENC_REQ / ENC_RES
                const msgMatch = line.match(/msg="VU=(\d+) STEP(\d+) (PLAIN_REQ|ENC_REQ|ENC_RES(?:_DEC)?|captured \w+)=(.+?)(?:"\s*source=|"$)/);
                if (msgMatch) {
                    const [, vu, step, kind, val] = msgMatch;
                    const key = `${vu}:${step}`;
                    if (!vuStepMap[key]) vuStepMap[key] = { vu: parseInt(vu), step: parseInt(step) };
                    if (kind === 'PLAIN_REQ') vuStepMap[key].plainReq = val;
                    else if (kind === 'ENC_REQ') vuStepMap[key].encReq = val;
                    else if (kind.startsWith('ENC_RES')) {
                        // check if this is status line: ENC_RES has format VU=N STEPN[STATUS] ENC_RES=...
                        const statusMatch = line.match(/STEP\d+\[(\d+)\]/);
                        if (statusMatch) vuStepMap[key].status = parseInt(statusMatch[1]);
                        vuStepMap[key].encRes = val;
                        // finalize this step entry
                        if (!state.perRequestResults) state.perRequestResults = [];
                        const existing = state.perRequestResults.findIndex(r => r.vu === parseInt(vu) && r.step === parseInt(step));
                        if (existing >= 0) state.perRequestResults[existing] = { ...vuStepMap[key] };
                        else state.perRequestResults.push({ ...vuStepMap[key] });
                    }
                } else {
                    // Also catch the combined status line: VU=N STEPN[STATUS] ENC_RES=...
                    const statusLine = line.match(/msg="VU=(\d+) STEP(\d+)\[(\d+)\] ENC_RES=(.+?)(?:"\s*source=|"$)/);
                    if (statusLine) {
                        const [, vu, step, status, encRes] = statusLine;
                        const key = `${vu}:${step}`;
                        if (!vuStepMap[key]) vuStepMap[key] = { vu: parseInt(vu), step: parseInt(step) };
                        vuStepMap[key].status = parseInt(status);
                        vuStepMap[key].encRes = encRes;
                        if (!state.perRequestResults) state.perRequestResults = [];
                        const existing = state.perRequestResults.findIndex(r => r.vu === parseInt(vu) && r.step === parseInt(step));
                        if (existing >= 0) state.perRequestResults[existing] = { ...vuStepMap[key] };
                        else state.perRequestResults.push({ ...vuStepMap[key] });
                    }
                }
            }
        });
        proc.stderr.on('data', chunk => {
            const lines = chunk.toString().split('\n');
            for (const line of lines) {
                if (line.trim()) addLog('[k6] ' + line.trim().substring(0, 200), 'Running');
            }
        });

        // Live metrics reader — poll metrics file every 2s
        let metricsFilePos = 0;
        const latencies    = [];
        const metricsInterval = setInterval(() => {
            if (!fs.existsSync(metricsFile)) return;
            const content    = fs.readFileSync(metricsFile, 'utf8');
            const newContent = content.slice(metricsFilePos);
            metricsFilePos   = content.length;
            const lines      = newContent.split('\n').filter(l => l.trim());
            _processK6MetricLines(lines, state.metrics, latencies, cfg);
        }, 2000);

        await new Promise((resolve) => {
            proc.on('close', (code) => {
                clearInterval(metricsInterval);
                resolve(code);
            });
        });

        // Final parse of metrics file
        if (fs.existsSync(metricsFile)) {
            const allContent  = fs.readFileSync(metricsFile, 'utf8');
            const allLines    = allContent.split('\n').filter(l => l.trim());
            const finalLatencies = [];
            _processK6MetricLines(allLines, state.metrics, finalLatencies, cfg);
            if (finalLatencies.length > 0) {
                const m   = state.metrics;
                m.p50     = Math.round(pct(finalLatencies, 50));
                m.p90     = Math.round(pct(finalLatencies, 90));
                m.p95     = Math.round(pct(finalLatencies, 95));
                m.p99     = Math.round(pct(finalLatencies, 99));
                m.minLatency = Math.round(Math.min(...finalLatencies));
                m.maxLatency = Math.round(Math.max(...finalLatencies));
                m.avgLatency = parseFloat((finalLatencies.reduce((a, b) => a + b, 0) / finalLatencies.length).toFixed(1));
            }
        }

        state.status  = 'completed';
        state.endTime = new Date().toISOString();
        state.verdict = verdict(state.metrics, cfg);
        addLog(`k6 test completed — ${state.metrics.totalReqs} reqs · P95 ${state.metrics.p95}ms`, 'Completed');
        addTimeline('Test completed', 'Completed');
        _saveResults(runId_, state);

    } catch (err) {
        state.status  = 'failed';
        state.endTime = new Date().toISOString();
        if (err.code === 'ENOENT') {
            state.logs.push({ time: new Date().toISOString(), event: 'k6 not found. Please install k6 from https://k6.io or set K6_PATH env var.', phase: 'Failed' });
        } else {
            state.logs.push({ time: new Date().toISOString(), event: 'k6 run failed: ' + err.message, phase: 'Failed' });
        }
        _saveResults(runId_, state);
    }
}

function _processK6MetricLines(lines, m, latencies, cfg) {
    for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.type !== 'Point') continue;

        const metric = entry.metric;
        const value  = entry.data?.value;
        const tags   = entry.data?.tags || {};

        if (metric === 'http_reqs') {
            if (tags.isProxy === 'true') continue; // exclude proxy calls from metrics
            m.totalReqs++;
            const isOk = tags.status && parseInt(tags.status) >= 200 && parseInt(tags.status) < 400;
            if (isOk) m.okReqs++;
            else m.errReqs++;
            const sc = tags.status || '0';
            m.statusCodes = m.statusCodes || {};
            m.statusCodes[sc] = (m.statusCodes[sc] || 0) + 1;
        } else if (metric === 'http_req_duration') {
            if (value !== undefined && tags.isProxy !== 'true') {
                latencies.push(value);
                // Update RPS approximately
                const elapsed = (Date.now() - new Date(m._startTs || Date.now()).getTime()) / 1000 || 1;
                m.rps = parseFloat((m.totalReqs / Math.max(elapsed, 1)).toFixed(2));
            }
        }
    }
    if (m.totalReqs > 0) {
        m.errRate = parseFloat(((m.errReqs / m.totalReqs) * 100).toFixed(2));
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// HTML REPORT GENERATOR
// ══════════════════════════════════════════════════════════════════════════════
function _generateHtml(state, tmpl = {}) {
    const cfg  = state.config  || {};
    const m    = state.metrics || {};
    const t    = tmpl;

    const companyName  = t.companyName  || 'AdHash Technology';
    const reportTitle  = t.reportTitle  || 'Load Test Execution Report';
    const headerColor  = t.headerColor  || '#1e293b';
    const footerText   = t.footerText   || 'AdHash Project Control Center · Authorized Personnel Only';
    const confidText   = t.confidentialityText || 'CONFIDENTIAL — For authorized review only';

    const preparedBy   = t.preparedBy   || cfg.executedBy || 'QA Team';
    const reviewedBy   = t.reviewedBy   || '—';
    const approvedBy   = t.approvedBy   || '—';
    const clientName   = t.clientName   || '—';
    const releaseVer   = t.releaseVersion || '—';
    const sprintName   = t.sprintName   || '—';
    const buildNumber  = t.buildNumber  || '—';
    const remarks      = t.remarks      || '';

    const vd = state.verdict || 'FAIL';
    const vdColor = vd === 'PASS' ? '#10b981' : vd === 'RISK' ? '#f59e0b' : '#ef4444';
    const vdBg    = vd === 'PASS' ? '#d1fae5' : vd === 'RISK' ? '#fef3c7' : '#fee2e2';
    const vdTxt   = vd === 'PASS' ? '#065f46' : vd === 'RISK' ? '#78350f' : '#7f1d1d';

    const successRate = m.totalReqs > 0 ? ((m.okReqs / m.totalReqs) * 100).toFixed(2) : '0.00';
    const errRateDisp = m.totalReqs > 0 ? ((m.errReqs / m.totalReqs) * 100).toFixed(2) : '0.00';

    const dur = (state.startTime && state.endTime)
        ? Math.round((new Date(state.endTime) - new Date(state.startTime)) / 1000) + 's'
        : (cfg.duration || 0) + 's';

    const fmtBytes = (b) => b > 1048576 ? (b / 1048576).toFixed(2) + ' MB' : b > 1024 ? (b / 1024).toFixed(1) + ' KB' : (b || 0) + ' B';

    // Recommendation text
    let recText = '', qaRec = '', recColor = '';
    if (vd === 'PASS') {
        recText  = 'Application performance is stable under the tested load. This result can be considered acceptable from a performance testing perspective for the tested scenario.';
        qaRec    = 'GO';
        recColor = '#10b981';
    } else if (vd === 'RISK') {
        recText  = 'Application performance is partially acceptable, but some latency or error rate risks were observed. Recommended to review backend logs, API response time, database queries, and infrastructure scaling before production release.';
        qaRec    = 'CONDITIONAL GO';
        recColor = '#f59e0b';
    } else {
        recText  = 'Application performance is not acceptable under the tested load. High error rate or latency was observed. Recommended to stop release until performance issues are fixed and retested.';
        qaRec    = 'NO-GO';
        recColor = '#ef4444';
    }

    // Chart data as JSON for inline script
    const rpsH   = JSON.stringify(m.rpsHistory   || []);
    const latH   = JSON.stringify(m.latHistory   || []);
    const errH   = JSON.stringify(m.errHistory   || []);
    const auH    = JSON.stringify(m.activeUsersHistory || []);
    const labels = JSON.stringify((m.tickTimes   || []).map((_, i) => i + 's'));
    const scMap  = m.statusCodes || {};
    const scLabels = JSON.stringify(Object.keys(scMap));
    const scData   = JSON.stringify(Object.values(scMap));

    // Status code rows
    const scRows = Object.entries(scMap).map(([code, count]) => {
        const total = m.totalReqs || 1;
        const pct   = ((count / total) * 100).toFixed(1);
        const color = code.startsWith('2') ? '#10b981' : code.startsWith('3') ? '#3b82f6' : code.startsWith('4') ? '#f59e0b' : '#ef4444';
        return `<tr><td style="color:${color};font-weight:700">${code}</td><td>${count}</td><td>${pct}%</td></tr>`;
    }).join('');

    // Timeline rows
    const tlRows = (state.timeline || []).map(e =>
        `<tr><td style="color:#64748b;font-size:11px">${new Date(e.time).toLocaleString('en-IN')}</td><td>${e.phase}</td><td>${e.event}</td></tr>`
    ).join('');

    // Log rows (last 20)
    const logRows = (state.logs || []).slice(-20).map(l =>
        `<tr><td style="color:#64748b;font-size:11px">${new Date(l.time).toLocaleString('en-IN')}</td><td>${l.phase}</td><td>${l.event}</td></tr>`
    ).join('');

    // Build per-VU request/response log section
    const _esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const _tryFmt = s => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s || '—'; } };
    const _statusColor = code => {
        const c = parseInt(code);
        if (c >= 200 && c < 300) return '#10b981';
        if (c >= 400 && c < 500) return '#f59e0b';
        return '#ef4444';
    };
    const perReq = state.perRequestResults || [];
    let vuRequestLogHtml = '';
    if (perReq.length > 0) {
        // Group by VU
        const byVU = {};
        for (const r of perReq) {
            if (!byVU[r.vu]) byVU[r.vu] = [];
            byVU[r.vu].push(r);
        }
        const vuNums = Object.keys(byVU).map(Number).sort((a,b)=>a-b);
        // Get step URLs from cfg steps
        const stepUrls = (cfg.steps || []).filter(s => s.enabled !== false).map(s => s.url || '');
        const stepMethods = (cfg.steps || []).filter(s => s.enabled !== false).map(s => s.method || 'POST');

        vuRequestLogHtml = vuNums.map(vuNum => {
            const steps = byVU[vuNum].sort((a,b) => a.step - b.step);
            const stepsHtml = steps.map(r => {
                const stepIdx = r.step - 1;
                const url = stepUrls[stepIdx] || '—';
                const method = stepMethods[stepIdx] || 'POST';
                const statusColor = _statusColor(r.status);
                const statusBadge = r.status
                    ? `<span style="background:${statusColor}22;color:${statusColor};border:1px solid ${statusColor};padding:2px 10px;border-radius:12px;font-size:12px;font-weight:700">${r.status}</span>`
                    : `<span style="color:#94a3b8">—</span>`;

                return `
<div style="border:1px solid #e2e8f0;border-radius:8px;margin-bottom:12px;overflow:hidden">
  <div style="background:#f1f5f9;padding:10px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
    <span style="background:#3b82f6;color:#fff;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700">Step ${r.step}</span>
    <span style="font-size:11px;font-weight:700;color:#64748b;background:#e2e8f0;padding:2px 8px;border-radius:4px">${_esc(method)}</span>
    <span style="font-size:12px;font-family:monospace;color:#1e293b;word-break:break-all">${_esc(url)}</span>
    <span style="margin-left:auto">${statusBadge}</span>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:0;border-top:1px solid #e2e8f0">
    <div style="padding:12px 16px;border-right:1px solid #e2e8f0">
      <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">📤 Request — Plain (Decrypted)</div>
      <pre style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:10px;font-size:11px;margin:0;white-space:pre-wrap;word-break:break-all;color:#1e293b;max-height:180px;overflow-y:auto">${_esc(_tryFmt(r.plainReq))}</pre>
    </div>
    <div style="padding:12px 16px">
      <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">🔒 Request — Encrypted (Sent to API)</div>
      <pre style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:10px;font-size:11px;margin:0;white-space:pre-wrap;word-break:break-all;color:#7c3aed;max-height:180px;overflow-y:auto">${_esc(_tryFmt(r.encReq))}</pre>
    </div>
  </div>
  <div style="padding:12px 16px;border-top:1px solid #e2e8f0">
    <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">📥 Response (from API)</div>
    <pre style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:10px;font-size:11px;margin:0;white-space:pre-wrap;word-break:break-all;color:${statusColor};max-height:180px;overflow-y:auto">${_esc(_tryFmt(r.encRes))}</pre>
  </div>
</div>`;
            }).join('');

            return `
<div style="border:2px solid #3b82f6;border-radius:10px;margin-bottom:20px;overflow:hidden">
  <div style="background:#1e3a5f;color:#fff;padding:12px 20px;font-size:14px;font-weight:700;display:flex;align-items:center;gap:10px">
    <span style="background:#3b82f6;padding:3px 12px;border-radius:20px;font-size:13px">VU ${vuNum}</span>
    <span style="font-size:12px;font-weight:400;color:#93c5fd">${steps.length} step(s) recorded</span>
  </div>
  <div style="padding:16px">${stepsHtml}</div>
</div>`;
        }).join('');
    }

    const genTime = new Date().toLocaleString('en-IN', {
        weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata'
    }) + ' IST';

    const show = (key, def = true) => t[key] !== false && def;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${reportTitle} — ${cfg.projectName || 'Project'}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Arial,sans-serif;background:#f1f5f9;color:#1e293b;line-height:1.5}
.page{max-width:1100px;margin:0 auto;padding:24px}
.rpt-header{background:${headerColor};color:#fff;border-radius:16px;padding:36px 40px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:16px}
.rpt-brand{font-size:28px;font-weight:800;letter-spacing:-.5px}
.rpt-brand span{color:#60a5fa}
.rpt-meta{text-align:right}
.rpt-meta .title{font-size:18px;font-weight:700;margin-bottom:4px}
.rpt-meta .sub{font-size:12px;opacity:.75}
.badge{display:inline-block;padding:5px 16px;border-radius:20px;font-size:12px;font-weight:700}
.badge-env{background:rgba(59,130,246,.2);color:#93c5fd}
.badge-type{background:rgba(139,92,246,.2);color:#c4b5fd}
.verdict-badge{font-size:20px;font-weight:900;padding:10px 28px;border-radius:12px;background:${vdBg};color:${vdTxt};border:2px solid ${vdColor}}
.section{background:#fff;border-radius:12px;padding:24px;margin-bottom:20px;box-shadow:0 1px 4px rgba(0,0,0,.06)}
.section h2{font-size:15px;font-weight:700;color:#1e293b;margin-bottom:16px;padding-bottom:10px;border-bottom:2px solid #e2e8f0;display:flex;align-items:center;gap:8px}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.kpi{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;text-align:center}
.kpi-val{font-size:24px;font-weight:800;line-height:1}
.kpi-lbl{font-size:11px;color:#64748b;margin-top:4px;text-transform:uppercase;letter-spacing:.5px}
.kpi-val.green{color:#10b981}.kpi-val.red{color:#ef4444}.kpi-val.blue{color:#3b82f6}.kpi-val.amber{color:#f59e0b}.kpi-val.purple{color:#8b5cf6}
.cfg-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.cfg-row{display:flex;flex-direction:column;gap:2px}
.cfg-lbl{font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px}
.cfg-val{font-size:13px;font-weight:600;color:#334155}
.exec-box{background:linear-gradient(135deg,#f0f9ff,#e0f2fe);border:1px solid #bae6fd;border-radius:10px;padding:20px;font-size:14px;color:#0c4a6e;line-height:1.7}
table{width:100%;border-collapse:collapse}
th{padding:11px 14px;background:#f8fafc;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#64748b;text-align:left;border-bottom:2px solid #e2e8f0}
td{padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:13px}
tr:hover td{background:#f8fafc}
.chart-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:700px){.chart-grid{grid-template-columns:1fr}.rpt-header{flex-direction:column}.rpt-meta{text-align:left}.kpi-grid{grid-template-columns:repeat(2,1fr)}}
.chart-box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px}
.chart-box h4{font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px}
.rec-box{padding:16px 20px;border-radius:10px;font-size:14px;line-height:1.7;border-left:4px solid ${recColor};background:${vdBg}}
.rel-row{display:flex;gap:20px;flex-wrap:wrap}
.rel-item{flex:1;min-width:180px;background:#f8fafc;border-radius:10px;padding:16px;border:1px solid #e2e8f0}
.rel-item .label{font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;margin-bottom:6px}
.rel-item .value{font-size:15px;font-weight:800;color:${recColor}}
.custom-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-top:12px}
footer{text-align:center;padding:24px;color:#94a3b8;font-size:11px;border-top:1px solid #e2e8f0;margin-top:8px}
</style>
</head>
<body>
<div class="page">

<!-- HEADER -->
<div class="rpt-header">
  <div>
    <div class="rpt-brand"><span>${companyName.split(' ')[0]}</span> ${companyName.split(' ').slice(1).join(' ')}</div>
    <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
      <span class="badge badge-env">${cfg.environment || 'Unknown'}</span>
      <span class="badge badge-type">${cfg.scenarioType || 'Load Test'}</span>
      <span class="badge" style="background:rgba(245,158,11,.2);color:#fbbf24">⚡ Engine: k6</span>
      <span class="badge" style="background:rgba(139,92,246,.15);color:#c4b5fd">${cfg.mode === 'single' || !cfg.steps?.length || cfg.steps?.length === 1 ? 'Single API Test' : 'Workflow Scenario'}</span>
    </div>
  </div>
  <div class="rpt-meta">
    <div class="title">${reportTitle}</div>
    <div class="sub">Project: <strong>${cfg.projectName || '—'}</strong></div>
    <div class="sub">Generated: ${genTime}</div>
    <div class="sub">Executed by: ${preparedBy}</div>
    <div style="margin-top:12px"><span class="verdict-badge">⬤ ${vd}</span></div>
  </div>
</div>

${show('showExecutiveSummary') ? `
<!-- EXECUTIVE SUMMARY -->
<div class="section">
  <h2>📋 Executive Summary</h2>
  <div class="exec-box">
    This load test was executed to validate the stability and response time of <strong>${cfg.projectName || 'the application'}</strong>
    under concurrent user traffic in the <strong>${cfg.environment || 'unknown'}</strong> environment.
    The test ran a <strong>${cfg.scenarioType || 'load'}</strong> scenario with <strong>${cfg.vus} virtual users</strong>
    for <strong>${cfg.duration} seconds</strong> against <strong>${cfg.url}</strong>.
    Based on the configured thresholds and observed metrics, the final result is
    <strong style="color:${vdColor}">${vd}</strong>.
    ${vd === 'PASS' ? 'The application handled the load within acceptable performance boundaries.' :
      vd === 'RISK' ? 'Some metrics are approaching risk thresholds — review recommended before release.' :
      'Performance issues were detected — remediation required before production deployment.'}
  </div>
</div>` : ''}

<!-- FINAL STATUS -->
<div class="section">
  <h2>🏆 Final Status</h2>
  <div style="display:flex;align-items:center;gap:24px;flex-wrap:wrap">
    <div style="font-size:48px;font-weight:900;color:${vdColor}">${vd}</div>
    <div class="kpi-grid" style="flex:1">
      <div class="kpi"><div class="kpi-val green">${successRate}%</div><div class="kpi-lbl">Success Rate</div></div>
      <div class="kpi"><div class="kpi-val ${parseFloat(errRateDisp) > 5 ? 'red' : 'amber'}">${errRateDisp}%</div><div class="kpi-lbl">Error Rate</div></div>
      <div class="kpi"><div class="kpi-val blue">${m.p95 || 0}ms</div><div class="kpi-lbl">P95 Latency</div></div>
      <div class="kpi"><div class="kpi-val purple">${m.rps || 0}</div><div class="kpi-lbl">Avg RPS</div></div>
    </div>
  </div>
</div>

${show('showTestConfig') ? `
<!-- TEST CONFIGURATION -->
<div class="section">
  <h2>⚙ Test Configuration</h2>
  <div class="cfg-grid">
    <div class="cfg-row"><div class="cfg-lbl">Project</div><div class="cfg-val">${cfg.projectName || '—'}</div></div>
    <div class="cfg-row"><div class="cfg-lbl">Environment</div><div class="cfg-val">${cfg.environment || '—'}</div></div>
    <div class="cfg-row"><div class="cfg-lbl">URL</div><div class="cfg-val" style="word-break:break-all">${cfg.url || '—'}</div></div>
    <div class="cfg-row"><div class="cfg-lbl">HTTP Method</div><div class="cfg-val">${cfg.method || 'GET'}</div></div>
    <div class="cfg-row"><div class="cfg-lbl">Scenario Type</div><div class="cfg-val">${cfg.scenarioType || '—'}</div></div>
    <div class="cfg-row"><div class="cfg-lbl">Engine</div><div class="cfg-val">⚡ k6 (server-side)</div></div>
    <div class="cfg-row"><div class="cfg-lbl">Concurrent Users</div><div class="cfg-val">${cfg.vus}</div></div>
    <div class="cfg-row"><div class="cfg-lbl">Ramp-up</div><div class="cfg-val">${cfg.rampup || 0}s</div></div>
    <div class="cfg-row"><div class="cfg-lbl">Duration</div><div class="cfg-val">${cfg.duration}s</div></div>
    <div class="cfg-row"><div class="cfg-lbl">Timeout</div><div class="cfg-val">${cfg.timeout || 5000}ms</div></div>
    <div class="cfg-row"><div class="cfg-lbl">P95 Threshold</div><div class="cfg-val">${cfg.p95Threshold || 3000}ms</div></div>
    <div class="cfg-row"><div class="cfg-lbl">Start Time</div><div class="cfg-val">${cfg.startTime ? new Date(cfg.startTime).toLocaleString('en-IN') : '—'}</div></div>
    <div class="cfg-row"><div class="cfg-lbl">End Time</div><div class="cfg-val">${state.endTime ? new Date(state.endTime).toLocaleString('en-IN') : '—'}</div></div>
  </div>
</div>` : ''}

${show('showMetricCards') ? `
<!-- KEY METRICS -->
<div class="section">
  <h2>📊 Key Metrics</h2>
  <div class="kpi-grid">
    <div class="kpi"><div class="kpi-val blue">${m.totalReqs || 0}</div><div class="kpi-lbl">Total Requests</div></div>
    <div class="kpi"><div class="kpi-val green">${m.okReqs || 0}</div><div class="kpi-lbl">Success</div></div>
    <div class="kpi"><div class="kpi-val red">${m.errReqs || 0}</div><div class="kpi-lbl">Failures</div></div>
    <div class="kpi"><div class="kpi-val green">${successRate}%</div><div class="kpi-lbl">Success Rate</div></div>
    <div class="kpi"><div class="kpi-val amber">${m.avgLatency || 0}ms</div><div class="kpi-lbl">Avg Latency</div></div>
    <div class="kpi"><div class="kpi-val amber">${m.p50 || 0}ms</div><div class="kpi-lbl">P50 Latency</div></div>
    <div class="kpi"><div class="kpi-val amber">${m.p90 || 0}ms</div><div class="kpi-lbl">P90 Latency</div></div>
    <div class="kpi"><div class="kpi-val blue">${m.p95 || 0}ms</div><div class="kpi-lbl">P95 Latency</div></div>
    <div class="kpi"><div class="kpi-val purple">${m.p99 || 0}ms</div><div class="kpi-lbl">P99 Latency</div></div>
    <div class="kpi"><div class="kpi-val green">${m.minLatency || 0}ms</div><div class="kpi-lbl">Min Latency</div></div>
    <div class="kpi"><div class="kpi-val red">${m.maxLatency || 0}ms</div><div class="kpi-lbl">Max Latency</div></div>
    <div class="kpi"><div class="kpi-val purple">${m.rps || 0}</div><div class="kpi-lbl">RPS</div></div>
    <div class="kpi"><div class="kpi-val blue">${dur}</div><div class="kpi-lbl">Duration</div></div>
    <div class="kpi"><div class="kpi-val amber">${fmtBytes(m.dataSent || 0)}</div><div class="kpi-lbl">Data Sent</div></div>
    <div class="kpi"><div class="kpi-val amber">${fmtBytes(m.dataRecv || 0)}</div><div class="kpi-lbl">Data Received</div></div>
  </div>
</div>` : ''}

${show('showCharts') ? `
<!-- CHARTS -->
<div class="section">
  <h2>📈 Performance Charts</h2>
  <div class="chart-grid">
    <div class="chart-box"><h4>RPS over Time</h4><canvas id="ch-rps" height="140"></canvas></div>
    <div class="chart-box"><h4>Avg Latency (ms) over Time</h4><canvas id="ch-lat" height="140"></canvas></div>
    <div class="chart-box"><h4>Error Rate (%) over Time</h4><canvas id="ch-err" height="140"></canvas></div>
    <div class="chart-box"><h4>Active Users over Time</h4><canvas id="ch-vus" height="140"></canvas></div>
    <div class="chart-box"><h4>Status Code Distribution</h4><canvas id="ch-sc" height="140"></canvas></div>
    <div class="chart-box"><h4>Success vs Failure</h4><canvas id="ch-sf" height="140"></canvas></div>
  </div>
</div>` : ''}

${scRows && show('showErrorSummary') ? `
<!-- STATUS CODE DISTRIBUTION -->
<div class="section">
  <h2>🔢 Status Code Distribution</h2>
  <table><thead><tr><th>Status Code</th><th>Count</th><th>Percentage</th></tr></thead>
  <tbody>${scRows}</tbody></table>
</div>` : ''}

${show('showTimeline') ? `
<!-- TIMELINE -->
<div class="section">
  <h2>⏱ Test Timeline</h2>
  <table><thead><tr><th>Time</th><th>Phase</th><th>Event</th></tr></thead>
  <tbody>${tlRows}</tbody></table>
</div>` : ''}

${vuRequestLogHtml ? `
<!-- VU REQUEST/RESPONSE LOG -->
<div class="section">
  <h2>🔬 Load Request &amp; Response Log</h2>
  <p style="font-size:13px;color:#64748b;margin-bottom:16px">
    Full request and response for every step executed by each Virtual User.
    Each step shows the plain (decrypted) request body, the encrypted body actually sent to the API, and the raw API response.
  </p>
  ${vuRequestLogHtml}
</div>` : ''}

${show('showTimeline') && logRows ? `
<!-- ACTIVITY LOG -->
<div class="section">
  <h2>📋 Activity Log (last 20 entries)</h2>
  <table><thead><tr><th>Time</th><th>Phase</th><th>Message</th></tr></thead>
  <tbody>${logRows}</tbody></table>
</div>` : ''}

${show('showRecommendations') ? `
<!-- RECOMMENDATIONS -->
<div class="section">
  <h2>💡 QA Recommendation</h2>
  <div class="rec-box">${recText}</div>
</div>

<!-- RELEASE DECISION -->
<div class="section">
  <h2>🚀 Release Decision</h2>
  <div class="rel-row">
    <div class="rel-item"><div class="label">QA Recommendation</div><div class="value">${qaRec}</div></div>
    <div class="rel-item"><div class="label">Based On</div><div class="value" style="font-size:13px;font-weight:600;color:#334155">Success ${successRate}% · Error ${errRateDisp}% · P95 ${m.p95 || 0}ms</div></div>
    <div class="rel-item"><div class="label">Next Action</div><div class="value" style="font-size:13px;font-weight:600;color:#334155">${vd === 'PASS' ? 'Proceed to release' : vd === 'RISK' ? 'Review and retest' : 'Fix and retest'}</div></div>
  </div>
</div>` : ''}

<!-- CUSTOM FIELDS -->
${(preparedBy !== 'QA Team' || reviewedBy !== '—' || clientName !== '—') ? `
<div class="section">
  <h2>📝 Report Details</h2>
  <div class="custom-grid">
    <div class="cfg-row"><div class="cfg-lbl">Prepared By</div><div class="cfg-val">${preparedBy}</div></div>
    <div class="cfg-row"><div class="cfg-lbl">Reviewed By</div><div class="cfg-val">${reviewedBy}</div></div>
    <div class="cfg-row"><div class="cfg-lbl">Approved By</div><div class="cfg-val">${approvedBy}</div></div>
    <div class="cfg-row"><div class="cfg-lbl">Client Name</div><div class="cfg-val">${clientName}</div></div>
    <div class="cfg-row"><div class="cfg-lbl">Release Version</div><div class="cfg-val">${releaseVer}</div></div>
    <div class="cfg-row"><div class="cfg-lbl">Sprint</div><div class="cfg-val">${sprintName}</div></div>
    <div class="cfg-row"><div class="cfg-lbl">Build Number</div><div class="cfg-val">${buildNumber}</div></div>
    ${remarks ? `<div class="cfg-row" style="grid-column:1/-1"><div class="cfg-lbl">Remarks</div><div class="cfg-val">${remarks}</div></div>` : ''}
  </div>
</div>` : ''}

<footer>
  <div>${footerText}</div>
  <div style="margin-top:4px">${confidText}</div>
  <div style="margin-top:4px">Report ID: ${state.runId} · Generated: ${genTime}</div>
</footer>

</div><!-- .page -->

${show('showCharts') ? `
<script>
(function(){
  const rpsH=${rpsH}, latH=${latH}, errH=${errH}, auH=${auH}, lbl=${labels};
  const scL=${scLabels}, scD=${scData};
  const ok=${m.okReqs || 0}, err=${m.errReqs || 0};
  const def=(id,label,data,color,fill)=>{
    const c=document.getElementById(id);if(!c)return;
    new Chart(c,{type:'line',data:{labels:lbl,datasets:[{label,data,borderColor:color,backgroundColor:color+'22',fill:fill||false,tension:.4,pointRadius:0,borderWidth:2}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{x:{display:false},y:{grid:{color:'#e2e8f0'},ticks:{color:'#64748b',font:{size:10}}}}}});
  };
  def('ch-rps','RPS',rpsH,'#3b82f6',true);
  def('ch-lat','Latency',latH,'#f59e0b',true);
  def('ch-err','Error %',errH,'#ef4444',true);
  def('ch-vus','VUs',auH,'#8b5cf6',true);
  const sc=document.getElementById('ch-sc');
  if(sc&&scL.length)new Chart(sc,{type:'doughnut',data:{labels:scL,datasets:[{data:scD,backgroundColor:['#10b981','#3b82f6','#f59e0b','#ef4444','#8b5cf6']}]},options:{responsive:true,plugins:{legend:{position:'right',labels:{font:{size:10}}}}}});
  const sf=document.getElementById('ch-sf');
  if(sf)new Chart(sf,{type:'doughnut',data:{labels:['Success','Failure'],datasets:[{data:[ok,err],backgroundColor:['#10b981','#ef4444']}]},options:{responsive:true,plugins:{legend:{position:'right',labels:{font:{size:10}}}}}});
})();
<\/script>` : ''}
</body>
</html>`;
}

module.exports = router;

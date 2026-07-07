'use strict';
/**
 * routes/load-tests.js
 * Server-side load testing engine using autocannon (static) and
 * custom concurrent fetch loop (dynamic payloads).
 */

const router   = require('express').Router();
const autocannon = require('autocannon');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');

const DEFAULT_EMAIL_VERIFICATION_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6ImxvYWR0ZXN0MUBtYWlsaW5hdG9yLmNvbSIsInB1cnBvc2UiOiJlbWFpbC12ZXJpZmllZCIsImlhdCI6MTc4MzQwODc4OSwiZXhwIjoxNzgzNDA5Njg5fQ.90EgVLbTeJh-8orjPXivCIH3tNLkB1CN7CZwPoiTbok';

// ── AES-128-ECB encryption (PKCS7 padding via Node crypto) ──
function aesEncrypt(plaintext, key) {
    const keyBuf = Buffer.from(key, 'utf8').slice(0, 16); // 16 bytes = AES-128
    const cipher = crypto.createCipheriv('aes-128-ecb', keyBuf, null);
    cipher.setAutoPadding(true); // PKCS7
    return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
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
        templateStr.replace(/\{\{(\w+)\}\}/g, (_, k) => `"__VAR:${k}__"`)
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
            emailVerificationToken: DEFAULT_EMAIL_VERIFICATION_TOKEN,
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

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/load-test/start
// ══════════════════════════════════════════════════════════════════════════════
router.post('/start', auth, async (req, res) => {
    const {
        projectName, environment, url, method = 'GET',
        headers = {}, body: reqBody, queryParams = {},
        vus = 10, duration = 30, rampup = 5,
        timeout = 5000, rps,
        scenarioType = 'Baseline Load Test',
        scenarioSteps = [],
        stopOnErrorRate, stopOnP95,
        p95Threshold = 3000,
        executedBy = 'Dashboard',
        dynamicMode = false,
        dynamicConfig = null,
    } = req.body || {};

    // ── Validation ──
    if (!url)      return res.status(400).json({ error: 'url is required' });
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'url must start with http:// or https://' });
    if (!duration) return res.status(400).json({ error: 'duration is required' });

    const limit = maxVUs(req);
    const actualVUs = Math.min(Math.max(1, parseInt(vus) || 10), limit);
    const actualDur = Math.min(300, Math.max(5, parseInt(duration) || 30));

    // ── Prevent duplicate runs on same URL ──
    for (const [, run] of _runs) {
        if (run.status === 'running' && run.config.url === url) {
            return res.status(409).json({ error: `A test is already running for ${url}` });
        }
    }

    const runId    = 'lt_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    const startTime = new Date().toISOString();

    // Build query string
    const qs = Object.keys(queryParams).length
        ? '?' + new URLSearchParams(queryParams).toString() : '';
    const fullUrl = url + qs;

    const cfg = {
        projectName, environment, url: fullUrl, baseUrl: url,
        method, headers: maskHeaders(headers), body: reqBody,
        vus: actualVUs, duration: actualDur, rampup,
        timeout, rps, scenarioType, scenarioSteps,
        p95Threshold, stopOnErrorRate, stopOnP95,
        executedBy, startTime,
        dynamicMode: !!dynamicMode,
        dynamicConfig: dynamicMode ? dynamicConfig : null,
    };

    const runState = {
        runId, status: 'initializing', config: cfg,
        metrics: { totalReqs: 0, okReqs: 0, errReqs: 0, rps: 0,
            avgLatency: 0, p50: 0, p90: 0, p95: 0, p99: 0,
            minLatency: 0, maxLatency: 0, errRate: 0,
            dataSent: 0, dataRecv: 0, statusCodes: {},
            latencies: [], rpsHistory: [], latHistory: [],
            errHistory: [], activeUsersHistory: [], tickTimes: [],
        },
        logs: [], timeline: [{ time: startTime, event: 'Test started', phase: 'Initializing' }],
        startTime, endTime: null, instance: null, verdict: null,
        reportPath: null, reportJsonPath: null,
        perRequestResults: [],
    };
    _runs.set(runId, runState);

    res.json({ runId, status: 'initializing' });

    // ── Run autocannon asynchronously ──
    setImmediate(() => _executeRun(runId, cfg, runState));
});

async function _executeRun(runId, cfg, state) {
    const addLog = (event, phase, extra = {}) => {
        const entry = { time: new Date().toISOString(), event, phase, ...extra };
        state.logs.push(entry);
        if (state.logs.length > 500) state.logs.shift();
    };
    const addTimeline = (event, phase) => {
        state.timeline.push({ time: new Date().toISOString(), event, phase });
    };

    try {
        state.status = 'running';
        addLog('Test started', 'Running');
        addTimeline('Test started', 'Running');

        // ── DYNAMIC MODE: concurrent fetch with unique payloads ──
        if (cfg.dynamicMode && cfg.dynamicConfig) {
            return await _executeDynamicRun(runId, cfg, state, addLog, addTimeline);
        }

        addLog('Ramp-up started', 'Ramp-up');
        addTimeline('Ramp-up started', 'Ramp-up');

        // Build autocannon options
        const acOpts = {
            url:             cfg.url,
            connections:     cfg.vus,
            duration:        cfg.duration,
            timeout:         Math.round((cfg.timeout || 5000) / 1000),
            method:          (cfg.method || 'GET').toUpperCase(),
            headers:         cfg.headers || {},
            ...(cfg.body ? { body: typeof cfg.body === 'string' ? cfg.body : JSON.stringify(cfg.body) } : {}),
            ...(cfg.rps   ? { amount: undefined, overallRate: cfg.rps } : {}),
            // Ramp-up via pipelining stages (approximated with connectionRate)
            ...(cfg.rampup > 0 ? { connectionRate: Math.ceil(cfg.vus / Math.max(1, cfg.rampup)) } : {}),
        };

        const latAll = [];
        let tickOkCount = 0, tickErrCount = 0, lastTickTime = Date.now();

        const instance = autocannon(acOpts, (err, result) => {
            // Final callback — populate metrics from autocannon summary
            if (err) {
                state.status  = 'failed';
                state.endTime = new Date().toISOString();
                addLog('Test failed: ' + err.message, 'Failed');
                addTimeline('Test failed: ' + err.message, 'Failed');
                _saveResults(runId, state);
                return;
            }

            const m = state.metrics;
            m.totalReqs   = result.requests.total;
            m.okReqs      = result['2xx'] || (result.requests.total - (result.errors || 0) - (result.timeouts || 0));
            m.errReqs     = (result.errors || 0) + (result.timeouts || 0);
            m.rps         = parseFloat(result.requests.mean.toFixed(2));
            m.avgLatency  = parseFloat(result.latency.mean.toFixed(1));
            m.p50         = result.latency.p50  || 0;
            m.p90         = result.latency.p90  || 0;
            m.p95         = result.latency.p95  || 0;
            m.p99         = result.latency.p99  || 0;
            m.minLatency  = result.latency.min  || 0;
            m.maxLatency  = result.latency.max  || 0;
            m.dataSent    = result.throughput?.total || 0;
            m.dataRecv    = result.throughput?.total || 0;
            m.errRate     = m.totalReqs > 0 ? parseFloat(((m.errReqs / m.totalReqs) * 100).toFixed(2)) : 0;

            state.status  = 'completed';
            state.endTime = new Date().toISOString();
            state.verdict = verdict(m, cfg);

            addLog(`Test completed — ${m.totalReqs} reqs · RPS ${m.rps} · P95 ${m.p95}ms`, 'Completed');
            addTimeline('Test completed', 'Completed');
            addTimeline('Generating report', 'Generating report');

            _saveResults(runId, state);
            addTimeline('Report generated', 'Completed');
        });

        state.instance = instance;

        // Intercept per-response events for live metrics
        instance.on('response', (client, statusCode, resBytes, responseTime) => {
            const m = state.metrics;
            m.totalReqs++;
            if (statusCode >= 200 && statusCode < 400) m.okReqs++;
            else m.errReqs++;
            latAll.push(responseTime);
            tickOkCount  += (statusCode >= 200 && statusCode < 400) ? 1 : 0;
            tickErrCount += (statusCode >= 200 && statusCode < 400) ? 0 : 1;
            m.dataRecv   += resBytes;
            m.statusCodes[statusCode] = (m.statusCodes[statusCode] || 0) + 1;
        });

        instance.on('tick', () => {
            const now   = Date.now();
            const secDelta = (now - lastTickTime) / 1000 || 1;
            const m     = state.metrics;
            const rps   = parseFloat((tickOkCount / secDelta).toFixed(1));
            const avgLat = latAll.length ? parseFloat((latAll.reduce((s, v) => s + v, 0) / latAll.length).toFixed(1)) : 0;
            const errRate = m.totalReqs > 0 ? parseFloat(((m.errReqs / m.totalReqs) * 100).toFixed(2)) : 0;

            m.rps        = rps;
            m.avgLatency = avgLat;
            m.p50        = Math.round(pct(latAll, 50));
            m.p90        = Math.round(pct(latAll, 90));
            m.p95        = Math.round(pct(latAll, 95));
            m.p99        = Math.round(pct(latAll, 99));
            m.minLatency = latAll.length ? Math.round(Math.min(...latAll)) : 0;
            m.maxLatency = latAll.length ? Math.round(Math.max(...latAll)) : 0;
            m.errRate    = errRate;

            m.rpsHistory.push(rps);
            m.latHistory.push(avgLat);
            m.errHistory.push(errRate);
            m.tickTimes.push(new Date().toISOString());
            m.activeUsersHistory.push(cfg.vus);

            if (m.rpsHistory.length > 300) {
                m.rpsHistory.shift(); m.latHistory.shift();
                m.errHistory.shift(); m.tickTimes.shift();
                m.activeUsersHistory.shift();
            }

            tickOkCount = 0; tickErrCount = 0; lastTickTime = now;

            // Safety stops
            if (cfg.stopOnErrorRate && errRate > cfg.stopOnErrorRate) {
                addLog(`Auto-stop: error rate ${errRate}% > threshold ${cfg.stopOnErrorRate}%`, 'Stopped', { warn: true });
                addTimeline(`Auto-stopped: error rate threshold breached`, 'Stopped');
                instance.stop();
            }
            if (cfg.stopOnP95 && m.p95 > cfg.stopOnP95) {
                addLog(`Auto-stop: P95 ${m.p95}ms > threshold ${cfg.stopOnP95}ms`, 'Stopped', { warn: true });
                addTimeline(`Auto-stopped: P95 latency threshold breached`, 'Stopped');
                instance.stop();
            }
        });

        addTimeline('Peak users reached', 'Running');

    } catch (err) {
        state.status  = 'failed';
        state.endTime = new Date().toISOString();
        state.logs.push({ time: new Date().toISOString(), event: 'Fatal error: ' + err.message, phase: 'Failed' });
        _saveResults(runId, state);
    }
}

// ── Dynamic concurrent execution ──
async function _executeDynamicRun(runId, cfg, state, addLog, addTimeline) {
    const fetch = (...a) => import('node-fetch').then(m => m.default(...a)).catch(() => {
        // fallback to built-in fetch (Node 18+)
        return globalThis.fetch(...a);
    });

    const dynCfg = cfg.dynamicConfig;
    const vus    = cfg.vus;
    const payloads = buildDynPayloads(dynCfg, vus);

    addLog(`Dynamic mode: firing ${vus} concurrent requests`, 'Running');
    addTimeline(`Firing ${vus} concurrent requests`, 'Running');

    const hdrs = { 'Content-Type': 'application/json', ...(cfg.headers || {}) };
    // Remove masked values
    Object.keys(hdrs).forEach(k => { if (hdrs[k] === '***masked***') delete hdrs[k]; });

    const m = state.metrics;
    const latAll = [];
    const perResults = [];

    const t0 = Date.now();
    const promises = payloads.map(async (payload, idx) => {
        const reqStart = Date.now();
        let status = 0, responseTime = 0, error = null, responsePreview = '';
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), cfg.timeout || 5000);
            const res = await fetch(cfg.url, {
                method: (cfg.method || 'POST').toUpperCase(),
                headers: hdrs,
                body: payload.finalBody,
                signal: controller.signal,
            });
            clearTimeout(timer);
            responseTime = Date.now() - reqStart;
            status = res.status;
            const text = await res.text().catch(() => '');
            responsePreview = text.substring(0, 200);
        } catch (e) {
            responseTime = Date.now() - reqStart;
            error = e.message || 'Request failed';
            status = 0;
        }

        const ok = status >= 200 && status < 400;
        m.totalReqs++;
        if (ok) m.okReqs++; else m.errReqs++;
        latAll.push(responseTime);
        m.statusCodes[status] = (m.statusCodes[status] || 0) + 1;

        perResults[idx] = {
            index: idx + 1,
            email: payload.email,
            phoneNumber: payload.phoneNumber,
            status,
            responseTime,
            ok,
            error,
            responsePreview,
        };
        addLog(`Request ${idx+1} → ${status} ${responseTime}ms ${payload.email}`, 'Running');
    });

    await Promise.all(promises);

    const elapsed = (Date.now() - t0) / 1000 || 1;
    m.rps         = parseFloat((m.totalReqs / elapsed).toFixed(2));
    m.avgLatency  = latAll.length ? parseFloat((latAll.reduce((s,v)=>s+v,0)/latAll.length).toFixed(1)) : 0;
    m.p50         = Math.round(pct(latAll, 50));
    m.p90         = Math.round(pct(latAll, 90));
    m.p95         = Math.round(pct(latAll, 95));
    m.p99         = Math.round(pct(latAll, 99));
    m.minLatency  = latAll.length ? Math.round(Math.min(...latAll)) : 0;
    m.maxLatency  = latAll.length ? Math.round(Math.max(...latAll)) : 0;
    m.errRate     = m.totalReqs > 0 ? parseFloat(((m.errReqs / m.totalReqs) * 100).toFixed(2)) : 0;

    state.perRequestResults = perResults;
    state.status  = 'completed';
    state.endTime = new Date().toISOString();
    state.verdict = verdict(m, cfg);

    addLog(`Dynamic test done — ${m.okReqs}/${m.totalReqs} passed · P95 ${m.p95}ms`, 'Completed');
    addTimeline('Dynamic test completed', 'Completed');
    _saveResults(runId, state);
}

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
        try { state.instance.stop(); } catch {}
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

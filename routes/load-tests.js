'use strict';
/**
 * routes/load-tests.js
 * Server-side load testing engine — k6 only.
 */

const router = require('express').Router();
const fs     = require('fs');
const path       = require('path');
const crypto     = require('crypto');
const mongoose   = require('mongoose');

// ── MongoDB schema for persisting load test reports across deploys ──
const _ltReportSchema = new mongoose.Schema({
    runId:       { type: String, required: true, unique: true },
    startTime:   String,
    projectName: String,
    environment: String,
    scenarioType: String,
    vus:         Number,
    duration:    Number,
    verdict:     String,
    executedBy:  String,
    successRate: Number,
    p95:         Number,
    jsonData:    String, // full serialized state as JSON string
    htmlData:    String, // generated HTML report
}, { collection: 'load_test_reports' });
const LTReport = mongoose.models.LTReport || mongoose.model('LTReport', _ltReportSchema);

// ── MongoDB schema for per-project/per-environment server configuration ──
const _ltServerConfigSchema = new mongoose.Schema({
    projectName:   { type: String, required: true },
    envType:       { type: String, required: true, enum: ['production', 'staging'] },
    serverName:    String,
    cloudProvider: String,
    publicIp:      String,
    instanceType:  String,
    vcpu:          Number,
    memoryGb:      Number,
    storageGb:     Number,
    os:            String,
    region:        String,
    elasticIp:     { type: Boolean, default: false },
    status:        { type: String, default: 'Running' },
    notes:         String,
    // Architecture flags — drive the "What this configuration means" explanation
    // and the onboarding-scale recommendation's gap detection. Optional/unknown
    // (undefined) is treated as "not present" everywhere these are read, never
    // silently assumed true.
    hasLoadBalancer: { type: Boolean, default: false },
    hasReadReplica:  { type: Boolean, default: false },
    hasCacheLayer:   { type: Boolean, default: false },
    hasAutoScaling:  { type: Boolean, default: false },
    updatedAt:     { type: Date, default: Date.now },
}, { collection: 'load_test_server_configs' });
_ltServerConfigSchema.index({ projectName: 1, envType: 1 }, { unique: true });
const LTServerConfig = mongoose.models.LTServerConfig || mongoose.model('LTServerConfig', _ltServerConfigSchema);

// ── In-memory server-config cache ──
// _generateHtml() runs synchronously from several call sites (some not async),
// so it reads server configs from this cache rather than querying Mongo inline.
// The cache is refreshed on every server-config write/delete and lazily warmed
// on first read after a cold start.
const _serverConfigCache = new Map(); // key: `${projectName}::${envType}` -> doc
let _serverConfigCacheWarmed = false;

let _serverConfigWarmPromise = null;
async function _warmServerConfigCache() {
    try {
        const docs = await LTServerConfig.find({}).lean();
        for (const doc of docs) _serverConfigCache.set(`${doc.projectName}::${doc.envType}`, doc);
        _serverConfigCacheWarmed = true;
    } catch (e) {
        console.error('[load-test] server-config cache warm failed:', e.message);
        // Allow the NEXT call to retry the DB fetch instead of permanently reusing
        // this failed attempt's promise — otherwise a transient Mongo hiccup (a
        // known recurring incident for this app) on the very first warm would
        // silently disable the cache for the rest of the process's lifetime.
        _serverConfigWarmPromise = null;
    }
}

// Ensures the cache is warm before any report reads it. Previously the cache warm
// was fire-and-forget on first read, so the very first report generated after a
// cold start/Railway restart would see an empty cache and silently render no
// Server Configuration section — self-healing on the NEXT report, which made it
// look like "the report only works if Server Config was opened first" when it was
// really just a boot-order race. Callers that can await (all report-generation
// call sites, which run inside async route handlers) should use this; callers
// that cannot (none currently) fall back to the old fire-and-forget behavior.
async function ensureServerConfigCacheWarm() {
    if (_serverConfigCacheWarmed) return;
    if (!_serverConfigWarmPromise) _serverConfigWarmPromise = _warmServerConfigCache();
    await _serverConfigWarmPromise;
}

function getServerConfigsForProject(projectName) {
    if (!_serverConfigCacheWarmed) _warmServerConfigCache(); // fire-and-forget fallback for sync callers
    const out = {};
    for (const doc of _serverConfigCache.values()) {
        if (doc.projectName === projectName) out[doc.envType] = doc;
    }
    return out;
}

// ── Server sizing recommendation ─────────────────────────────────────────────
// Compares the configured EC2 instance (vCPU/RAM) against observed load test
// results (VUs, RPS, P95 latency, error rate) and flags under-/over-provisioning.
// AWS t3 burstable family reference: t3.medium (2vCPU/4GB) is comfortable up to
// roughly 50-80 concurrent VUs / ~150 RPS for typical Node/PHP CRUD workloads
// before CPU credits exhaust and latency/error rate degrade — used as the
// baseline heuristic below.
// ── Root-cause classification from status-code distribution ─────────────────
// k6 reports status 0 for requests that never got an HTTP response at all
// (connection refused/reset, DNS failure, TCP-level timeout) — this is the
// strongest signal of server-side resource exhaustion (out of file descriptors,
// connection backlog full, process OOM-killed) as opposed to an application-level
// error (4xx/5xx), which the app itself is still alive to generate.
function classifyFailureRootCause(metrics, testCfg) {
    const causes = [];
    const total = metrics?.totalReqs || 0;
    if (!total) return causes;

    const sc = metrics.statusCodes || {};
    const connFailures = sc['0'] || 0;
    const serverErrors = Object.entries(sc).reduce((s, [code, n]) => code.startsWith('5') ? s + n : s, 0);
    const clientErrors  = Object.entries(sc).reduce((s, [code, n]) => code.startsWith('4') ? s + n : s, 0);
    const connPct   = (connFailures / total) * 100;
    const serverPct = (serverErrors / total) * 100;
    const clientPct = (clientErrors / total) * 100;

    const p95 = metrics.p95 || 0;
    const p95Thr = testCfg?.p95Threshold || 3000;
    const avgLat = metrics.avgLatency || 0;
    const vus = testCfg?.vus || 0;
    const rps = metrics.rps || 0;

    if (connPct > 1) {
        causes.push({
            severity: connPct > 10 ? 'critical' : 'high',
            title: `Connection-level failures (${connPct.toFixed(1)}% of requests)`,
            detail: `${connFailures.toLocaleString()} of ${total.toLocaleString()} requests never received an HTTP response (connection refused/reset, or a TCP-level timeout) at ${vus} concurrent VUs. This is a server resource-exhaustion signal, not an application bug — the OS/process ran out of capacity to accept or complete connections (exhausted file descriptors, full listen backlog, worker process crash/OOM, or the reverse proxy/load balancer rejecting connections).`,
        });
    }
    if (serverPct > 1) {
        causes.push({
            severity: serverPct > 10 ? 'critical' : 'high',
            title: `Server-side errors — HTTP 5xx (${serverPct.toFixed(1)}% of requests)`,
            detail: `${serverErrors.toLocaleString()} requests received a 5xx response, meaning the application process was still running and responding, but failed to complete the request — commonly caused by database connection pool exhaustion, an unhandled exception under concurrent load, or a downstream dependency (DB/cache/third-party API) timing out under the added concurrency.`,
        });
    }
    if (clientPct > 5) {
        causes.push({
            severity: 'info',
            title: `Client-side errors — HTTP 4xx (${clientPct.toFixed(1)}% of requests)`,
            detail: `${clientErrors.toLocaleString()} requests received a 4xx response. This is usually a test-data or auth-token issue (expired/invalid token, duplicate unique-key conflicts under concurrent VUs) rather than a server capacity problem — review the scenario configuration before concluding the server needs more capacity.`,
        });
    }
    if (p95 > p95Thr * 1.5 && connPct <= 1 && serverPct <= 1) {
        causes.push({
            severity: p95 > p95Thr * 3 ? 'high' : 'medium',
            title: `Severe latency degradation without hard errors (P95 ${p95}ms vs ${p95Thr}ms threshold)`,
            detail: `Requests are mostly succeeding, but queuing well beyond the acceptance threshold. This points to CPU/event-loop saturation or a slow downstream dependency (database, third-party API) rather than outright resource exhaustion — the server is still up, but too slow under this concurrency level to meet the latency SLA.`,
        });
    }
    if (!causes.length && rps > 0 && vus > 0 && (rps / vus) < 0.3) {
        causes.push({
            severity: 'medium',
            title: 'Low throughput-per-VU without explicit errors',
            detail: `Only ~${(rps / vus).toFixed(2)} requests/sec per virtual user — most VUs are spending their time waiting rather than completing requests. Often caused by slow per-request processing (unoptimized queries, synchronous I/O) rather than a hard capacity ceiling; worth profiling the endpoint under test directly before scaling infrastructure.`,
        });
    }
    return causes;
}

// ══════════════════════════════════════════════════════════════════════════════
// CAPACITY ENGINE — configuration-driven reference data + verdict thresholds.
// Kept independent of the report template so it can be reused/edited without
// touching HTML-generation code, and so recommendations aren't hand-authored
// per report.
// ══════════════════════════════════════════════════════════════════════════════

// Instance tier reference table — vCPU/RAM/comfortable & max VU guidance per
// instance type. These are conservative planning heuristics for a typical
// Node/PHP CRUD-style workload (burstable t3 family vs. compute-optimized c6i),
// NOT a guarantee for any specific application — always validate with a real
// load test at each tier. Edit this table to reflect your own benchmarked
// numbers as real data becomes available; it is the single source of truth
// for every scaling suggestion in the report (nothing is hardcoded per-report).
const INSTANCE_TIER_TABLE = [
    { instanceType: 't3.medium',    vcpu: 2,  ramGb: 4,   comfortableMaxVUs: 35,   recommendedMaxVUs: 50,    estMaxConnections: 512,   tier: 'Tier 1', use: 'Small workload / dev-staging' },
    { instanceType: 't3.large',     vcpu: 2,  ramGb: 8,   comfortableMaxVUs: 60,   recommendedMaxVUs: 90,    estMaxConnections: 1024,  tier: 'Tier 1', use: 'Small-medium workload' },
    { instanceType: 'c6i.xlarge',   vcpu: 4,  ramGb: 8,   comfortableMaxVUs: 140,  recommendedMaxVUs: 200,   estMaxConnections: 2048,  tier: 'Tier 2', use: 'Medium workload' },
    { instanceType: 'c6i.2xlarge',  vcpu: 8,  ramGb: 16,  comfortableMaxVUs: 320,  recommendedMaxVUs: 450,   estMaxConnections: 4096,  tier: 'Tier 2', use: 'Medium-high workload' },
    { instanceType: 'c6i.4xlarge',  vcpu: 16, ramGb: 32,  comfortableMaxVUs: 700,  recommendedMaxVUs: 1000,  estMaxConnections: 8192,  tier: 'Tier 3', use: 'High workload, single node' },
    { instanceType: 'c6i.8xlarge',  vcpu: 32, ramGb: 64,  comfortableMaxVUs: 1500, recommendedMaxVUs: 2200,  estMaxConnections: 16384, tier: 'Tier 3', use: 'High workload, single node ceiling' },
];

// Verdict thresholds — configurable rather than hardcoded inline at each call
// site. CPU saturation bands, per the feature spec: 0-70 comfortable, 70-85
// RISK, 85-100 high risk (still FAIL-banded for the table's PASS/RISK/FAIL
// labeling), >100 FAIL/capacity exceeded.
const CAPACITY_VERDICT_THRESHOLDS = {
    cpuComfortableMaxPct: 70,
    cpuRiskMaxPct:         85,
    // Beyond this multiple of the highest ACTUALLY TESTED VU count, a projection
    // is far enough from validated data that it should read as "Requires Re-test"
    // rather than a numeric PASS/RISK/FAIL — extrapolating 50x past a single data
    // point is not a meaningful estimate. On its own this under-serves a LOW-VU
    // tested run (e.g. tested at 10 VUs — 20x is only 200, so most of the required
    // 50..10,000 tiers would show nothing but "beyond model range," gutting the
    // enterprise-scale table for exactly the smoke-test runs QA repeats most
    // often). retestBeyondSaturationMultiple below provides a second, independent
    // ceiling based on the SERVER's own comfortable capacity rather than the one
    // test's VU count — the effective boundary is whichever is more permissive,
    // so a low-VU test on a capable server still gets numeric projections across
    // the full required range, while a genuinely wild extrapolation (e.g. 10,000
    // VUs projected from a 2-VU smoke test) still gets flagged.
    retestBeyondMultipleOfTestedVus: 20,
    // Beyond this multiple of comfortable-capacity-implied saturation (i.e. this
    // many times the VU count that would reach ~100% modeled CPU), treat the
    // projection as beyond range regardless of how low the tested VU count was.
    retestBeyondSaturationMultiple: 50,
};

// Estimate the comfortable/recommended max VUs for an arbitrary (vcpu, ramGb)
// pair by finding the closest-or-better matching tier in INSTANCE_TIER_TABLE.
// Falls back to the simple vusPerVcpu heuristic if nothing in the table fits.
function _lookupTierForSpec(vcpu, ramGb) {
    const exact = INSTANCE_TIER_TABLE.find(t => t.vcpu === vcpu && t.ramGb === ramGb);
    if (exact) return exact;
    // Closest tier at or below this vCPU count (conservative — never assume more capacity
    // than benchmarked). Multiple tiers can tie on vCPU (e.g. t3.medium and t3.large both
    // have 2 vCPU) — break the tie by RAM proximity so a server with more RAM at the same
    // vCPU doesn't silently resolve to the smaller-RAM tier, which could otherwise produce
    // a self-contradictory report (e.g. "current: t3.large" immediately followed by a
    // scaling step recommending an upgrade TO t3.large).
    const atOrBelowVcpu = INSTANCE_TIER_TABLE.filter(t => t.vcpu <= vcpu);
    if (!atOrBelowVcpu.length) return null;
    const maxVcpu = Math.max(...atOrBelowVcpu.map(t => t.vcpu));
    const candidates = atOrBelowVcpu.filter(t => t.vcpu === maxVcpu);
    candidates.sort((a, b) => Math.abs(a.ramGb - ramGb) - Math.abs(b.ramGb - ramGb));
    return candidates[0] || null;
}

// ── Capacity table: which VU levels are likely to PASS/RISK/FAIL on the
// current server spec, extrapolated from the observed saturation at the tested
// VU count. Extended to enterprise scale (50 through 10,000 VUs) with CPU/RAM/
// P95/error-rate projections. This is a heuristic estimate, not a guarantee —
// always re-test at each tier before treating it as validated capacity.
function buildCapacityTable(serverCfg, testedMetrics, testCfg) {
    const vcpu  = serverCfg?.vcpu || 0;
    const ramGb = serverCfg?.memoryGb || 0;
    const testedVus = testCfg?.vus || 0;
    if (!vcpu || !testedVus) return [];

    const tier = _lookupTierForSpec(vcpu, ramGb);
    const vusPerVcpu = 30; // fallback heuristic if no table tier matches at all
    const comfortableMaxVUs = tier ? tier.comfortableMaxVUs : vcpu * vusPerVcpu * (CAPACITY_VERDICT_THRESHOLDS.cpuComfortableMaxPct / 100);
    // CPU per VU, derived from THIS test's own observed load — the whole basis for
    // every projection below is "what did we actually measure at the tested VU count."
    const estCapacityAt100Pct = comfortableMaxVUs / (CAPACITY_VERDICT_THRESHOLDS.cpuComfortableMaxPct / 100);
    const cpuPerVu = 100 / estCapacityAt100Pct; // % CPU saturation contributed by one VU

    const testedP95 = testedMetrics?.p95 || null;
    const testedErrPct = testedMetrics?.totalReqs > 0 ? ((testedMetrics.errReqs || 0) / testedMetrics.totalReqs) * 100 : null;
    const hasRamData = false; // no RAM-utilization monitoring is wired into this k6 runner yet — never fabricate it

    const REQUIRED_LEVELS = [50, 100, 250, 500, 1000, 2500, 5000, 10000];
    const levels = [...new Set([...REQUIRED_LEVELS, testedVus])].sort((a, b) => a - b);
    // Two independent ceilings, whichever is more permissive wins — see the
    // comment on CAPACITY_VERDICT_THRESHOLDS for why a single VU-multiple bound
    // would gut the table for low-VU tested runs on a capable server.
    const retestBeyondByTestedVus  = testedVus * CAPACITY_VERDICT_THRESHOLDS.retestBeyondMultipleOfTestedVus;
    const retestBeyondBySaturation = estCapacityAt100Pct * CAPACITY_VERDICT_THRESHOLDS.retestBeyondSaturationMultiple;
    const retestBeyond = Math.max(retestBeyondByTestedVus, retestBeyondBySaturation);

    return levels.map(v => {
        const isTested = v === testedVus;
        // Real, UNCAPPED saturation — never clamp this. A hard cap (e.g. min(999, ...))
        // makes every VU level past the cap threshold collapse to the identical clamped
        // number, so 500 and 10,000 VUs looked indistinguishable in the report. The
        // model keeps scaling internally; only the DISPLAY switches to a qualitative
        // label once we're far enough past the tested baseline that a numeric estimate
        // would be misleadingly precise (see beyondModelRange below).
        const cpuPercentRaw = cpuPerVu * v;
        // Beyond this many multiples of the tested VU count, treat the projection as
        // "beyond model range" rather than printing a number nobody should trust —
        // this reuses the same boundary as the REQUIRES RE-TEST verdict band, since
        // both represent "too far from validated data to extrapolate meaningfully."
        const beyondModelRange = !isTested && v > retestBeyond;

        // P95 latency projection: only a documented, simple linear-with-saturation
        // model — explicitly NOT claimed to be accurate, only directionally useful.
        // Latency tends to degrade faster than linearly as saturation approaches
        // 100%, so beyond the comfortable band we apply a step-up multiplier —
        // this is a heuristic, clearly labeled as an estimate in the report. The
        // multiplier itself is UNCAPPED (no ceiling on saturationRatio) so latency
        // keeps growing distinguishably at every tier instead of flat-lining.
        let projectedP95 = null;
        if (testedP95 !== null) {
            if (isTested) {
                projectedP95 = testedP95;
            } else {
                const saturationRatio = cpuPercentRaw / 100;
                const degradeMultiplier = saturationRatio <= 0.7 ? 1 + saturationRatio * 0.5
                    : saturationRatio <= 1 ? 1.35 + (saturationRatio - 0.7) * 3
                    : 2.25 + (saturationRatio - 1) * 5; // uncapped — keeps rising past 100% saturation
                projectedP95 = Math.round(testedP95 * degradeMultiplier);
            }
        }

        let verdict, verdictColor;
        if (beyondModelRange) {
            // Qualitative, not numeric — an extrapolation this far past the last
            // validated data point isn't a meaningful estimate, so the report says
            // so plainly instead of printing a fake precise CPU%/latency number.
            verdict = 'REQUIRES RE-TEST'; verdictColor = '#6B7280';
        } else if (cpuPercentRaw > 100) {
            verdict = 'FAIL'; verdictColor = '#DC2626';
        } else if (cpuPercentRaw >= CAPACITY_VERDICT_THRESHOLDS.cpuRiskMaxPct) {
            verdict = 'RISK'; verdictColor = '#D97706'; // 85-100%: high risk, still RISK-banded verdict per spec
        } else if (cpuPercentRaw >= CAPACITY_VERDICT_THRESHOLDS.cpuComfortableMaxPct) {
            verdict = 'RISK'; verdictColor = '#D97706';
        } else {
            verdict = 'PASS'; verdictColor = '#059669';
        }
        // A tested run's verdict must reflect what actually happened, not just the
        // CPU-heuristic projection — a high error rate or blown P95 threshold is
        // ground truth and overrides the model for that one row.
        if (isTested && testCfg?.p95Threshold) {
            if (testedErrPct > 5 || (testedP95 && testedP95 > testCfg.p95Threshold * 2)) { verdict = 'FAIL'; verdictColor = '#DC2626'; }
            else if (testedErrPct > 1 || (testedP95 && testedP95 > testCfg.p95Threshold)) { verdict = 'RISK'; verdictColor = '#D97706'; }
        }

        return {
            vus: v,
            isTested,
            dataType: isTested ? 'TESTED' : 'PROJECTED',
            beyondModelRange,
            // cpuPercent/p95 stay as real (uncapped, still-distinguishable) numbers for
            // internal use/testing even when beyondModelRange is true — the REPORT
            // TEMPLATE is what switches to the qualitative label for display, so the
            // underlying data is never silently discarded, just not shown as a false-
            // precision figure.
            cpuPercent: cpuPercentRaw,
            cpuNA: false,
            ramPercent: null,
            ramNA: !hasRamData,
            p95: beyondModelRange ? null : projectedP95,
            p95Raw: projectedP95,
            p95NA: projectedP95 === null,
            errorRatePct: isTested ? testedErrPct : null,
            errorRateNA: isTested ? testedErrPct === null : true,
            verdict, verdictColor,
        };
    });
}

// ── "What This Configuration Means" — plain-language capacity explanation ───
// Ties the raw spec (vCPU/RAM/instance type) and named architecture gaps
// (load balancer / read replica / cache / auto-scaling, read straight from
// Server Config — never guessed) to the actual tested ceiling, so the report
// explains WHY the number is what it is rather than just stating it.
function buildConfigExplanation(serverCfg, capacityTable, testedVus, testedMetrics, testCfg) {
    if (!serverCfg || !serverCfg.vcpu) return null;
    const vcpu = serverCfg.vcpu;
    const ramGb = serverCfg.memoryGb || 0;
    const tier = _lookupTierForSpec(vcpu, ramGb);
    const comfortableMaxVUs = tier ? tier.comfortableMaxVUs : Math.round(vcpu * 30 * (CAPACITY_VERDICT_THRESHOLDS.cpuComfortableMaxPct / 100));
    const recommendedMaxVUs = tier ? tier.recommendedMaxVUs : Math.round(comfortableMaxVUs * 1.4);

    // "At-risk zone" is bounded by the comfortable ceiling and the point the
    // tested run itself showed real trouble (or the recommended max if the
    // test didn't reach it) — grounded in the actual capacity table rows,
    // not a second, disconnected heuristic.
    const testedRow = (capacityTable || []).find(r => r.isTested);
    const failsAt = testedRow && (testedRow.verdict === 'FAIL' || testedRow.verdict === 'RISK') ? testedVus : recommendedMaxVUs;

    const p95 = testedMetrics?.p95 || null;
    const p50 = testedMetrics?.p50 || null;
    const p99 = testedMetrics?.p99 || null;
    const p95Thr = testCfg?.p95Threshold || 3000;

    const archFlags = {
        loadBalancer: !!serverCfg.hasLoadBalancer,
        readReplica:  !!serverCfg.hasReadReplica,
        cacheLayer:   !!serverCfg.hasCacheLayer,
        autoScaling:  !!serverCfg.hasAutoScaling,
    };

    const reasons = [];
    reasons.push(`${vcpu} vCPU means only ${vcpu} request${vcpu === 1 ? '' : 's'} can execute CPU-bound work in true parallel — everything else queues${p50 !== null && p99 !== null ? `, which is why the P50→P99 latency spread (${p50}ms → ${p99}ms) ${(p99 - p50) > p95Thr ? 'is already wide' : 'widens'} at just ${testedVus} VUs` : ''}.`);
    if (ramGb > 0 && ramGb <= 8) {
        reasons.push(`${ramGb}GB RAM leaves limited headroom for the application heap, database connection buffers, and OS overhead once concurrent connections climb into the hundreds.`);
    }
    if (!archFlags.loadBalancer) {
        reasons.push(`Single instance with no load balancer on file — this is both a single point of failure and a hard resource ceiling: there's no second node to fail over to or share load with.`);
    }
    if (!archFlags.cacheLayer) {
        reasons.push(`No cache layer (Redis/Memcached) on file — every request likely re-hits the database directly, which is typically the first real bottleneck, often before CPU itself maxes out.`);
    }
    if (!archFlags.readReplica) {
        reasons.push(`No read replica on file — all reads and writes compete for the same database instance's capacity.`);
    }
    if (!archFlags.autoScaling) {
        reasons.push(`No auto-scaling on file — capacity is fixed regardless of real-time demand.`);
    }

    return {
        instanceType: serverCfg.instanceType || `${vcpu} vCPU / ${ramGb}GB`,
        comfortableMaxVUs,
        atRiskLow: comfortableMaxVUs,
        atRiskHigh: Math.max(comfortableMaxVUs, testedVus),
        failsAt: Math.round(failsAt),
        archFlags,
        reasons,
        testedVus,
    };
}

// ── Onboarding action library — keyed by detected "gap type," not a single
// hardcoded paragraph. Each entry only fires when the corresponding condition
// is true for the run's actual server config/test data, so the assembled
// recommendation reflects real gaps rather than a canned script. Edit this
// table to adjust wording/ownership/timeline guidance without touching the
// report template or the gap-detection logic below.
const ONBOARDING_ACTION_LIBRARY = {
    retestAtIntermediateTiers: {
        phase: 'immediate',
        owner: 'QA/Perf team',
        timeline: 'This week, before any onboarding',
        text: (ctx) => `Re-test at 100, 250, and 500 VUs on the CURRENT box to get real (not projected) data — projections above ${ctx.testedVus} VUs (the highest tier actually tested) are not reliable enough to plan against.`,
    },
    enableApm: {
        phase: 'immediate',
        owner: 'Platform/DevOps',
        timeline: 'This week, before any onboarding',
        text: () => `Turn on APM (Datadog, New Relic, or self-hosted Prometheus/Grafana) so CPU, RAM, DB connections, and event-loop lag are visible during the next test, not just latency.`,
    },
    dbSlowQueryLogging: {
        phase: 'immediate',
        owner: 'Backend team',
        timeline: 'This week, before any onboarding',
        text: () => `Add database slow-query logging and run EXPLAIN on the top 10 most-hit queries.`,
    },
    addLoadBalancerMultiInstance: {
        phase: 'shortTerm',
        owner: 'Platform/DevOps',
        timeline: '3-5 business days minimum for provisioning + testing',
        // Only fires when hasLoadBalancer is false — skips this step entirely if
        // a load balancer is already on file, per the "skip what's already in place" requirement.
        gap: (ctx) => !ctx.archFlags.loadBalancer,
        text: (ctx) => `Move off single-instance: minimum 2-3× ${ctx.nextTierHint || 'c6i.xlarge (4 vCPU/8GB)'} behind a load balancer (AWS ALB), health-checked, with sticky sessions only if session state requires it.`,
    },
    addCacheLayer: {
        phase: 'shortTerm',
        owner: 'Backend team',
        timeline: 'Can start in parallel today',
        gap: (ctx) => !ctx.archFlags.cacheLayer,
        text: () => `Add a caching layer (Redis) in front of read-heavy endpoints — this typically removes the largest chunk of DB load before any other change.`,
    },
    increaseDbPoolSize: {
        phase: 'shortTerm',
        owner: 'Backend team',
        timeline: 'Can start in parallel today',
        text: () => `Increase the MongoDB/SQL connection pool size and confirm connections are released (check for leaks via db.serverStatus().connections or the equivalent for your database).`,
    },
    moveSessionOffPath: {
        phase: 'shortTerm',
        owner: 'Backend team',
        timeline: 'Can start in parallel today',
        text: () => `Move session/auth checks off the synchronous request path where possible.`,
    },
    autoScalingGroup: {
        phase: 'mediumTerm',
        owner: 'Platform/DevOps',
        timeline: 'Design + provision alongside DB scaling',
        gap: (ctx) => !ctx.archFlags.autoScaling,
        text: () => `Auto-scaling group: 4-12 application nodes scaling on CPU/request-queue-depth, not a fixed fleet — traffic during onboarding is rarely flat.`,
    },
    dbReadReplica: {
        phase: 'mediumTerm',
        owner: 'Backend team / DBA',
        timeline: 'Size alongside app tier, not after',
        gap: (ctx) => !ctx.archFlags.readReplica,
        text: () => `Database: move to a managed cluster with at least one read replica; route reads there. If using MongoDB Atlas/RDS, size the instance class alongside the app tier, not after.`,
    },
    cdn: {
        phase: 'mediumTerm',
        owner: 'Platform/DevOps',
        timeline: 'Design + provision alongside DB scaling',
        text: () => `CDN (CloudFront/Cloudflare) for static assets and cacheable API responses to cut origin load.`,
    },
    rateLimitingQueue: {
        phase: 'mediumTerm',
        owner: 'Backend team',
        timeline: 'Design + provision alongside DB scaling',
        text: () => `Rate limiting / queueing (e.g. a job queue for non-critical writes) so a traffic spike degrades gracefully instead of cascading into a full outage.`,
    },
    retestEachTier: {
        phase: 'mediumTerm',
        owner: 'QA/Perf team',
        timeline: 'One re-test per tier — do not skip tiers',
        text: () => `Re-test at each tier (250 → 500 → 1,000 → 2,500 → 5,000 → 10,000) as infrastructure is added — do NOT go live at high concurrency on the basis of a projection alone.`,
    },
};

// Assembles the "If Onboarding 1,000-10,000+ Concurrent Users" recommendation
// from real detected gaps (config explanation's archFlags + the capacity
// table's verdict at the target range) rather than one fixed paragraph.
// Returns null when the current config already comfortably covers the range
// (nothing to recommend).
function buildOnboardingRecommendation(configExplanation, capacityTable, scalingPath) {
    if (!configExplanation) return null;
    const targetVus = 1000; // low end of the "1,000-10,000+" range this section addresses
    if (configExplanation.comfortableMaxVUs >= targetVus) return null; // already comfortable at this scale — nothing to recommend

    const ctx = {
        testedVus: configExplanation.testedVus,
        archFlags: configExplanation.archFlags,
        nextTierHint: scalingPath?.steps?.[0]?.recommendation,
    };

    const gapMultiple = targetVus / Math.max(1, configExplanation.comfortableMaxVUs);

    const actionsByPhase = { immediate: [], shortTerm: [], mediumTerm: [] };
    for (const [key, action] of Object.entries(ONBOARDING_ACTION_LIBRARY)) {
        if (action.gap && !action.gap(ctx)) continue; // skip actions for gaps that don't apply — infra already in place
        actionsByPhase[action.phase].push({ key, owner: action.owner, timeline: action.timeline, text: action.text(ctx) });
    }

    // High-scale infrastructure warnings for 1,000+ reuse the same threshold-gated
    // list the Scaling Recommendation Path already computed for this target, so
    // the two sections never disagree on what "beyond CPU" means at this scale.
    const highScaleWarnings = scalingPath?.highScaleWarnings || [];

    return {
        currentInstanceType: configExplanation.instanceType,
        comfortableMaxVUs: configExplanation.comfortableMaxVUs,
        gapMultiple: Math.round(gapMultiple),
        actionsByPhase,
        highScaleWarnings,
        // If none of the immediate/short-term work can realistically happen before
        // a hard deadline, the honest fallback is to throttle onboarding rather than
        // let uncontrolled load hit infrastructure that's already shown risk at a
        // much lower tier than the target.
        fallbackAdvice: `If "tomorrow" is a hard deadline and none of the above can be done in time: the honest recommendation is to cap registration/onboarding (staged rollout, waitlist, or a concurrency limiter) rather than let uncontrolled load hit an infrastructure that has already shown ${configExplanation.atRiskLow < configExplanation.testedVus ? 'RISK-level' : 'capacity'} degradation at just ${configExplanation.testedVus} VUs.`,
    };
}

// ── Scaling Recommendation Path ──────────────────────────────────────────────
// Walks INSTANCE_TIER_TABLE from the current tier forward until the target VU
// level is covered, recommending the next instance type at each step and
// horizontal scaling once a single node can no longer reasonably serve the
// target load. Entirely config-driven — no per-report hardcoding.
function buildScalingRecommendationPath(serverCfg, targetVus) {
    const vcpu = serverCfg?.vcpu || 0;
    const ramGb = serverCfg?.memoryGb || 0;
    if (!vcpu || !targetVus) return null;

    const currentTier = _lookupTierForSpec(vcpu, ramGb);
    const comfortableMaxVUs = currentTier ? currentTier.comfortableMaxVUs : vcpu * 30 * 0.7;
    if (targetVus <= comfortableMaxVUs) return null; // already within comfortable capacity — nothing to recommend

    const steps = [];
    const sortedTiers = [...INSTANCE_TIER_TABLE].sort((a, b) => a.vcpu - b.vcpu);
    const startIdx = currentTier ? sortedTiers.findIndex(t => t.instanceType === currentTier.instanceType) : -1;
    let coveredUpTo = comfortableMaxVUs;
    let lowerBound = comfortableMaxVUs;

    for (let i = startIdx + 1; i < sortedTiers.length && coveredUpTo < targetVus; i++) {
        const t = sortedTiers[i];
        steps.push({
            rangeLow: Math.round(lowerBound), rangeHigh: Math.round(t.comfortableMaxVUs),
            recommendation: `${t.instanceType} (${t.vcpu} vCPU / ${t.ramGb} GB)`,
            note: t.tier,
        });
        lowerBound = t.comfortableMaxVUs;
        coveredUpTo = t.comfortableMaxVUs;
    }

    // Beyond the largest single-node tier in the table, recommend horizontal scaling.
    if (coveredUpTo < targetVus) {
        const largest = sortedTiers[sortedTiers.length - 1];
        const nodesNeeded = Math.ceil(targetVus / largest.comfortableMaxVUs);
        steps.push({
            rangeLow: Math.round(lowerBound), rangeHigh: targetVus,
            recommendation: `${nodesNeeded}+ × ${largest.instanceType} behind a load balancer (horizontal scale-out)`,
            note: 'Multi-node',
        });
    }

    // High-scale infrastructure considerations — CPU is rarely the only bottleneck
    // once a single node's comfortable ceiling is exceeded by a wide margin.
    const highScaleWarnings = [];
    if (targetVus >= 1000) {
        highScaleWarnings.push(
            'Database connections and DB-server CPU — a connection pool sized for one node will exhaust well before application CPU does across multiple app instances.',
            'Application-level connection pooling and per-instance file descriptor / worker-thread limits.',
        );
    }
    if (targetVus >= 2500) {
        highScaleWarnings.push(
            'Network throughput between app instances and the database/cache layer.',
            'Read replicas or a caching layer (e.g. Redis) in front of the database to offload read traffic.',
        );
    }
    if (targetVus >= 5000) {
        highScaleWarnings.push(
            'Load balancer capacity and connection limits — verify the LB tier itself scales to this concurrency.',
            'External/third-party API rate limits — downstream dependencies may cap out before your own infrastructure does.',
            'Session storage strategy — in-memory sessions do not scale horizontally without a shared store.',
        );
    }
    if (targetVus >= 10000) {
        highScaleWarnings.push(
            'CDN for static content to keep app instances free for dynamic request handling.',
            'Disk I/O on database/cache nodes at sustained high write volume.',
        );
    }

    return {
        currentInstanceType: serverCfg.instanceType || `${vcpu} vCPU / ${ramGb}GB`,
        comfortableMaxVUs: Math.round(comfortableMaxVUs),
        targetVus,
        steps,
        highScaleWarnings,
    };
}

function computeServerRecommendation(serverCfg, metrics, testCfg) {
    if (!serverCfg) {
        return { level: 'unknown', title: 'No server configuration on file', detail: 'Add this environment’s server specs in the Server Config tab to get a sizing recommendation.', rootCauses: [], capacityTable: [], scalingPath: null, configExplanation: null, onboardingRecommendation: null };
    }
    const vcpu   = serverCfg.vcpu   || 0;
    const ramGb  = serverCfg.memoryGb || 0;
    if (!vcpu) {
        return { level: 'unknown', title: 'Server specs incomplete', detail: 'vCPU count is not set for this environment — fill it in on the Server Config tab to get an accurate sizing recommendation.', rootCauses: [], capacityTable: [], scalingPath: null, configExplanation: null, onboardingRecommendation: null };
    }
    const vus    = testCfg?.vus || 0;
    const rps    = metrics?.rps || 0;
    const p95    = metrics?.p95 || 0;
    const p95Thr = testCfg?.p95Threshold || 3000;
    const errPct = metrics?.totalReqs > 0 ? ((metrics.errReqs || 0) / metrics.totalReqs) * 100 : 0;

    // Rough capacity ceiling per vCPU for a t3-class burstable instance under sustained load.
    const vusPerVcpu = 30;
    const estCapacity = vcpu * vusPerVcpu;
    const saturationPct = estCapacity > 0 ? Math.min(999, (vus / estCapacity) * 100) : 0;

    const latencyBreached = p95 > p95Thr;
    const highError       = errPct > 5;
    const nearCapacity     = saturationPct >= 80;
    const overCapacity     = saturationPct >= 100;

    const rootCauses    = classifyFailureRootCause(metrics, testCfg);
    const capacityTable = buildCapacityTable(serverCfg, metrics, testCfg);
    // Scaling path targets the VU level actually validated by this test — the
    // report answers "how do I safely reach the load I just tested/plan to test."
    const scalingPath   = buildScalingRecommendationPath(serverCfg, vus);
    const configExplanation = buildConfigExplanation(serverCfg, capacityTable, vus, metrics, testCfg);
    const onboardingRecommendation = buildOnboardingRecommendation(configExplanation, capacityTable, scalingPath);

    if (overCapacity || (latencyBreached && highError)) {
        const nextTier = vcpu <= 2 ? 't3.large (2 vCPU → upgrade to 2/8GB or 4 vCPU)' : vcpu <= 4 ? 't3.xlarge (4 vCPU / 16GB)' : 't3.2xlarge (8 vCPU / 32GB) or move to a load-balanced multi-instance setup';
        return {
            level: 'upgrade',
            title: `Upgrade recommended — current instance is under-provisioned for ${vus} VUs`,
            detail: `At ${vus} concurrent VUs (~${rps} RPS) against a ${vcpu}-vCPU/${ramGb}GB instance, estimated CPU saturation is ~${saturationPct.toFixed(0)}%. Observed P95 latency (${p95}ms) ${latencyBreached ? `exceeded the ${p95Thr}ms threshold` : 'was within threshold'} and error rate was ${errPct.toFixed(2)}%. Consider upgrading to ${nextTier}, or scale horizontally behind a load balancer if traffic is expected to grow further.`,
            rootCauses, capacityTable, scalingPath, configExplanation, onboardingRecommendation,
        };
    }
    if (nearCapacity || latencyBreached || errPct > 1) {
        return {
            level: 'watch',
            title: 'Monitor — instance is approaching its comfortable capacity',
            detail: `Estimated CPU saturation ~${saturationPct.toFixed(0)}% at ${vus} VUs on a ${vcpu}-vCPU/${ramGb}GB instance. P95 latency was ${p95}ms (threshold ${p95Thr}ms) with a ${errPct.toFixed(2)}% error rate. Current sizing is adequate for this test, but re-test at higher VU counts before assuming headroom for production peak traffic.`,
            rootCauses, capacityTable, scalingPath, configExplanation, onboardingRecommendation,
        };
    }
    return {
        level: 'ok',
        title: 'Current instance sizing is adequate',
        detail: `At ${vus} VUs (~${rps} RPS), estimated CPU saturation is only ~${saturationPct.toFixed(0)}% of the ${vcpu}-vCPU/${ramGb}GB instance's comfortable capacity. P95 latency (${p95}ms) was within the ${p95Thr}ms threshold and the error rate (${errPct.toFixed(2)}%) was low. No sizing change needed for this load profile.`,
        rootCauses, capacityTable, scalingPath, configExplanation, onboardingRecommendation,
    };
}

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

// ── Typed value resolution for JSON request bodies (Node-side, used by the
// trial-run handlers: step-run, step-run-all) ──
// A string that is EXACTLY "{{varName}}" (nothing else) resolves to the captured
// variable's real JSON type (object/array/number/boolean/null) instead of being
// stringified. A string with embedded text around {{varName}} (e.g. "Bearer {{token}}")
// keeps the existing scalar string-interpolation behavior via resolveStr — this is
// what preserves backward compatibility with every existing scenario.
function resolveValueTyped(value, vars, resolveStr) {
    if (typeof value === 'string') {
        const m = value.match(/^\{\{(\w+)\}\}$/);
        if (m) {
            const v = vars[m[1]];
            return v !== undefined ? v : value;
        }
        return resolveStr(value);
    }
    if (Array.isArray(value)) return value.map(v => resolveValueTyped(v, vars, resolveStr));
    if (value !== null && typeof value === 'object') {
        const out = {};
        for (const k of Object.keys(value)) out[k] = resolveValueTyped(value[k], vars, resolveStr);
        return out;
    }
    return value;
}

// ── Build a multipart/form-data request body from step.multipartFields ──
// Used by the trial-run handlers (step-run, step-run-all), which talk to the
// target server directly via Node's http/https rather than through k6.
// Returns { buffer, contentType } — contentType includes the boundary and must
// be set verbatim as the request's Content-Type header (never set manually
// by the caller beyond this).
// RFC 7578 §4.2: a value inside a quoted Content-Disposition parameter must not
// itself contain CR, LF, or an unescaped double-quote — strip CR/LF and escape
// quotes/backslashes so a crafted field name/filename can't break out of the
// header line (which busboy/multer would otherwise silently mis-parse or drop).
function _mpHeaderValue(s) {
    return String(s).replace(/[\r\n]/g, '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildMultipartBody(fields, resolveStr) {
    const boundary = '----AdHashLoadTest' + crypto.randomBytes(12).toString('hex');
    const parts = [];
    for (const f of (fields || [])) {
        if (!f.name) continue;
        const safeName = _mpHeaderValue(f.name);
        if (f.type === 'file') {
            if (!f.dataBase64) continue; // no file chosen yet — skip rather than send an empty part
            const fileBuf = Buffer.from(f.dataBase64, 'base64');
            const filename = _mpHeaderValue(f.filename || 'file');
            const mime = f.mimeType || 'application/octet-stream';
            parts.push(Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="${safeName}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`
            ));
            parts.push(fileBuf);
            parts.push(Buffer.from('\r\n'));
        } else {
            const value = resolveStr ? resolveStr(f.value || '') : (f.value || '');
            parts.push(Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="${safeName}"\r\n\r\n${value}\r\n`
            ));
        }
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return { buffer: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
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
    const docs = await _scenariosCol().find({}).sort({ updatedAt: -1 }).maxTimeMS(8000).toArray();
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

// ── Save JSON + HTML report (disk + MongoDB) ──
async function _saveResults(runId, state) {
    try {
        const jsonPath = path.join(REPORTS_DIR, `${runId}.json`);
        const htmlPath = path.join(REPORTS_DIR, `${runId}.html`);
        const template = _loadTemplate();
        const serialized = _serializeState(state);
        await ensureServerConfigCacheWarm();
        const htmlStr    = _generateHtml(state, template);
        fs.writeFileSync(jsonPath, JSON.stringify(serialized, null, 2));
        fs.writeFileSync(htmlPath, htmlStr);
        state.reportPath     = htmlPath;
        state.reportJsonPath = jsonPath;

        // Persist to MongoDB so reports survive Railway redeploys
        const sr = serialized.metrics?.totalReqs > 0
            ? parseFloat(((serialized.metrics.okReqs / serialized.metrics.totalReqs) * 100).toFixed(1))
            : 0;
        LTReport.findOneAndUpdate(
            { runId },
            {
                runId,
                startTime:    serialized.startTime,
                projectName:  serialized.config?.projectName || '—',
                environment:  serialized.config?.environment || '—',
                scenarioType: serialized.config?.scenarioType || '—',
                vus:          serialized.config?.vus || 0,
                duration:     serialized.config?.duration || 0,
                verdict:      serialized.verdict || 'FAIL',
                executedBy:   serialized.config?.executedBy || 'Dashboard',
                successRate:  sr,
                p95:          serialized.metrics?.p95 || 0,
                jsonData:     JSON.stringify(serialized),
                htmlData:     htmlStr,
            },
            { upsert: true, new: true }
        ).catch(e => console.error('[load-test] MongoDB save failed:', e.message));
    } catch (e) {
        console.error('[load-test] save failed:', e.message);
    }
}

function _serializeState(state) {
    const s = { ...state };
    delete s.instance;
    if (!s.stepSummary && s.perRequestResults) {
        s.stepSummary = _buildStepSummary(s.perRequestResults, s.config);
    }
    return s;
}

// ── Template store (simple JSON file) ──
const TEMPLATE_FILE = path.join(REPORTS_DIR, '_template.json');

const _defaultTemplate = {
    companyName:         'Ad-Hash Technolabs Pvt Ltd',
    reportTitle:         'Load Test Execution Report',
    headerColor:         '#1e293b',
    preparedBy:          'QA Team',
    clientName:          'Ad-Hash Technolabs',
    reviewedBy:          'Senior QA',
    approvedBy:          'QA Lead',
    releaseVersion:      'v1.0.0',
    footerText:          'Ad-Hash Technolabs Pvt Ltd · Authorized Personnel Only',
    confidentialityText: 'CONFIDENTIAL — For authorized review only',
};

// ── MongoDB schema for template (1 doc, key='default') ──
const _ltTemplateSchema = new mongoose.Schema({
    key:  { type: String, default: 'default' },
    data: Object,
}, { collection: 'load_test_template' });
const LTTemplate = mongoose.models.LTTemplate || mongoose.model('LTTemplate', _ltTemplateSchema);

function _loadTemplate() {
    // Read from disk (fast, in-process deploy)
    try { return { ..._defaultTemplate, ...JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8')) }; } catch { return { ..._defaultTemplate }; }
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
        stepSummary:       _buildStepSummary(state.perRequestResults || [], state.config),
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
router.get('/report/:runId', auth, async (req, res) => {
    const htmlPath = path.join(REPORTS_DIR, `${req.params.runId}.html`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    if (fs.existsSync(htmlPath)) {
        return res.send(fs.readFileSync(htmlPath, 'utf8'));
    }
    // Disk file missing (ephemeral Railway FS wiped) — try MongoDB
    try {
        const doc = await LTReport.findOne({ runId: req.params.runId }, { htmlData: 1, jsonData: 1 }).lean();
        if (doc?.htmlData) {
            fs.writeFileSync(htmlPath, doc.htmlData);
            return res.send(doc.htmlData);
        }
        // htmlData missing but jsonData present — regenerate HTML from saved state
        if (doc?.jsonData) {
            const state = JSON.parse(doc.jsonData);
            const template = _loadTemplate();
            await ensureServerConfigCacheWarm();
            const html = _generateHtml(state, template);
            fs.writeFileSync(htmlPath, html);
            // Also persist htmlData so next time is instant
            LTReport.updateOne({ runId: req.params.runId }, { $set: { htmlData: html } }).catch(() => {});
            return res.send(html);
        }
    } catch {}
    res.status(404).send('<h2>Report not found</h2>');
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/load-test/report/:runId/download?logs=1  (full)
// GET /api/load-test/report/:runId/download?logs=0  (strip VU req/res log)
// ══════════════════════════════════════════════════════════════════════════════
router.get('/report/:runId/download', auth, async (req, res) => {
    const htmlPath = path.join(REPORTS_DIR, `${req.params.runId}.html`);
    // Restore from MongoDB if disk file missing
    if (!fs.existsSync(htmlPath)) {
        try {
            const doc = await LTReport.findOne({ runId: req.params.runId }, { htmlData: 1, jsonData: 1 }).lean();
            if (doc?.htmlData) {
                fs.writeFileSync(htmlPath, doc.htmlData);
            } else if (doc?.jsonData) {
                const state = JSON.parse(doc.jsonData);
                await ensureServerConfigCacheWarm();
                const html = _generateHtml(state, _loadTemplate());
                fs.writeFileSync(htmlPath, html);
                LTReport.updateOne({ runId: req.params.runId }, { $set: { htmlData: html } }).catch(() => {});
            }
        } catch {}
    }
    if (!fs.existsSync(htmlPath)) return res.status(404).json({ error: 'Report not found' });
    const state   = _runs.get(req.params.runId);
    const proj    = state?.config?.projectName || 'LoadTest';
    const ts      = new Date().toISOString().slice(0, 10);
    const withLogs = req.query.logs !== '0'; // default: include logs
    const suffix  = withLogs ? 'WithLogs' : 'NoLogs';

    let html = fs.readFileSync(htmlPath, 'utf8');
    if (!withLogs) {
        // Strip the VU log section: remove from the highlighted section opening tag to its closing </div>
        // The section is wrapped in <div class="log-section" id="vu-log-section">...</div>
        html = html.replace(
            /<!-- VU REQUEST\/RESPONSE LOG[\s\S]*?<div class="log-section" id="vu-log-section">[\s\S]*?<\/div>\s*(?=<!--|\$\{|<div class="section|<footer)/,
            `<!-- VU Request/Response Log removed — use "Download With Logs" for full report -->\n`
        );
        // Simpler fallback: remove between the two known comment markers
        if (html.includes('id="vu-log-section"')) {
            // Walk the DOM-like string: find opening div, count nesting, remove to closing div
            const startMarker = '<div class="log-section" id="vu-log-section">';
            const startIdx = html.indexOf(startMarker);
            if (startIdx !== -1) {
                let depth = 0, i = startIdx, found = false;
                while (i < html.length) {
                    if (html.startsWith('<div', i)) depth++;
                    else if (html.startsWith('</div>', i)) {
                        depth--;
                        if (depth === 0) {
                            html = html.slice(0, startIdx) +
                                `\n<div class="section"><h2>🔬 Load Request &amp; Response Log</h2><p style="color:#64748b;font-size:13px;padding:12px 0">⚠ Omitted in this version. Download the <strong>With Logs</strong> version for full payload details.</p></div>\n` +
                                html.slice(i + 6);
                            found = true;
                            break;
                        }
                    }
                    i++;
                }
            }
        }
    }

    res.setHeader('Content-Disposition', `attachment; filename="LoadTest-${proj}-${ts}-${suffix}.html"`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/load-test/stop/:runId
// ══════════════════════════════════════════════════════════════════════════════
router.post('/stop/:runId', auth, async (req, res) => {
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
    await _saveResults(req.params.runId, state);
    res.json({ ok: true, runId: req.params.runId, status: 'stopped' });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/load-test/history — reads from MongoDB (persistent) + disk (current session)
// ══════════════════════════════════════════════════════════════════════════════
router.get('/history', auth, async (req, res) => {
    try {
        // Primary: fetch all from MongoDB (survives redeploys)
        // Use a 8s timeout so a slow/disconnected MongoDB doesn't hang the page
        let dbRows = [];
        try {
            dbRows = await LTReport.find({}, {
                runId:1, startTime:1, projectName:1, environment:1, scenarioType:1,
                vus:1, duration:1, verdict:1, executedBy:1, successRate:1, p95:1, _id:0
            }).sort({ startTime: -1 }).maxTimeMS(8000).lean();
        } catch (dbErr) {
            console.warn('[load-test] MongoDB history query failed, using disk only:', dbErr.message);
        }

        const seen = new Set(dbRows.map(r => r.runId));
        const rows = dbRows.map(r => ({ ...r, hasReport: true }));

        // Fallback: also include any disk reports not yet in MongoDB (e.g. current session before save)
        if (fs.existsSync(REPORTS_DIR)) {
            for (const f of fs.readdirSync(REPORTS_DIR)) {
                if (!f.endsWith('.json') || f.startsWith('_')) continue;
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(REPORTS_DIR, f), 'utf8'));
                    if (seen.has(data.runId)) continue;
                    rows.push({
                        runId:        data.runId,
                        projectName:  data.config?.projectName || '—',
                        environment:  data.config?.environment || '—',
                        scenarioType: data.config?.scenarioType || '—',
                        vus:          data.config?.vus || 0,
                        duration:     data.config?.duration || 0,
                        startTime:    data.startTime,
                        verdict:      data.verdict || (data.status === 'failed' ? 'FAIL' : null),
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
    } catch (e) {
        console.error('[load-test] history error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════════════════════
// DELETE /api/load-test/history/:runId
// ══════════════════════════════════════════════════════════════════════════════
router.delete('/history/:runId', auth, async (req, res) => {
    const id  = req.params.runId;
    const json = path.join(REPORTS_DIR, `${id}.json`);
    const html = path.join(REPORTS_DIR, `${id}.html`);
    if (fs.existsSync(json)) fs.unlinkSync(json);
    if (fs.existsSync(html)) fs.unlinkSync(html);
    _runs.delete(id);
    await LTReport.deleteOne({ runId: id }).catch(() => {});
    res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/load-test/demo-report
// ══════════════════════════════════════════════════════════════════════════════
router.post('/demo-report', auth, async (req, res) => {
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
    await _saveResults(runId, state);
    res.json({ runId, status: 'completed', verdict: 'PASS' });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/load-test/save-template
// ══════════════════════════════════════════════════════════════════════════════
router.post('/save-template', auth, async (req, res) => {
    try {
        const data = req.body || {};
        fs.writeFileSync(TEMPLATE_FILE, JSON.stringify(data, null, 2));
        // Also persist to MongoDB so template survives redeploys
        await LTTemplate.findOneAndUpdate({ key: 'default' }, { key: 'default', data }, { upsert: true }).catch(() => {});
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/load-test/report-template
// ══════════════════════════════════════════════════════════════════════════════
router.get('/report-template', auth, async (req, res) => {
    // Try disk first (fast)
    try {
        const diskData = JSON.parse(fs.readFileSync(TEMPLATE_FILE, 'utf8'));
        return res.json({ ..._defaultTemplate, ...diskData });
    } catch {}
    // Disk empty (redeploy wiped it) — restore from MongoDB
    try {
        const doc = await LTTemplate.findOne({ key: 'default' }).lean();
        if (doc?.data) {
            // Restore to disk for subsequent calls
            fs.writeFileSync(TEMPLATE_FILE, JSON.stringify(doc.data, null, 2));
            return res.json({ ..._defaultTemplate, ...doc.data });
        }
    } catch {}
    // No saved template anywhere — return defaults
    res.json(_defaultTemplate);
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
        console.error('[load-test] scenarios fetch error:', e.message);
        // Return empty list so the UI renders gracefully instead of showing "Error:"
        res.json({ scenarios: [], _warning: 'Could not load scenarios: ' + e.message });
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
// SERVER CONFIG CRUD  /api/load-test/server-config
// One document per (projectName, envType) pair — envType is 'production' or 'staging'.
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/load-test/server-config?projectName=SyncTag — list configs (optionally filtered by project)
router.get('/server-config', auth, async (req, res) => {
    try {
        const filter = {};
        if (req.query.projectName) filter.projectName = req.query.projectName;
        const configs = await LTServerConfig.find(filter).sort({ projectName: 1, envType: 1 }).lean();
        res.json({ configs });
    } catch (e) {
        console.error('[load-test] server-config fetch error:', e.message);
        res.json({ configs: [], _warning: 'Could not load server configs: ' + e.message });
    }
});

// POST /api/load-test/server-config — create or update (upsert by projectName+envType)
router.post('/server-config', auth, async (req, res) => {
    try {
        const { projectName, envType } = req.body || {};
        if (!projectName) return res.status(400).json({ error: 'projectName is required' });
        if (!['production', 'staging'].includes(envType)) return res.status(400).json({ error: 'envType must be "production" or "staging"' });

        const data = { ...req.body, updatedAt: new Date() };
        const doc = await LTServerConfig.findOneAndUpdate(
            { projectName, envType },
            { $set: data },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        ).lean();
        _serverConfigCache.set(`${projectName}::${envType}`, doc);
        res.status(201).json(doc);
    } catch (e) {
        res.status(500).json({ error: 'Failed to save server config: ' + e.message });
    }
});

// DELETE /api/load-test/server-config/:id — delete
router.delete('/server-config/:id', auth, async (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        return res.status(400).json({ error: 'Invalid server config id' });
    }
    try {
        const existing = await LTServerConfig.findById(req.params.id).lean();
        const result = await LTServerConfig.deleteOne({ _id: req.params.id });
        if (!result.deletedCount) return res.status(404).json({ error: 'Server config not found' });
        if (existing) _serverConfigCache.delete(`${existing.projectName}::${existing.envType}`);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to delete server config: ' + e.message });
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
            ? jsonPath.replace(/^\$\.?/, '').split('.').filter(Boolean)
                .reduce((o, k) => (o != null && o[k] !== undefined) ? o[k] : '', parsed)
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
// POST /api/load-test/step-run — single-step trial run (VU1 preview)
// Body: { step, globalVars, capturedVars, dynamicData }
// Returns: { status, responseTime, rawBody, decryptedBody, headers, capturedValues, error }
// ══════════════════════════════════════════════════════════════════════════════
router.post('/step-run', auth, async (req, res) => {
    const { step, globalVars: _rawGlobalVars = {}, capturedVars = {}, dynamicData = {}, baseUrl: _baseUrl = '' } = req.body || {};
    // Inject baseUrl so {{baseUrl}} resolves in step URLs; strip trailing slash to avoid double-slash
    const globalVars = _baseUrl ? Object.assign({ baseUrl: _baseUrl.replace(/\/+$/, '') }, _rawGlobalVars) : _rawGlobalVars;
    if (!step) return res.status(400).json({ error: 'step is required' });

    const http = require('http');
    const https = require('https');
    const { URL } = require('url');

    // Build VU1 data row — respects startIndex from Dynamic Test Data config
    const vu1Data = (() => {
        const startIndex  = parseInt(dynamicData.startIndex) || 1;
        const idx         = startIndex; // VU1 → first index in the configured range
        const emailPrefix = dynamicData.emailPrefix || 'testuser';
        const emailDomain = dynamicData.emailDomain || 'mailinator.com';
        const phoneBase   = BigInt(dynamicData.phoneBase || '7100000000');
        return {
            index: String(idx),
            email: `${emailPrefix}${idx}@${emailDomain}`,
            phoneNumber: String(phoneBase), // VU1 = base phone
            name: `${dynamicData.namePrefix || 'TestUser'} ${idx}`,
            timestamp: String(Date.now()),
            random: String(Math.floor(Math.random() * 1e9)),
            uuid: crypto.randomUUID(),
        };
    })();

    // Merge vars: globals → VU1 dynamic data → captured vars from prior steps
    const vars = Object.assign({}, globalVars, vu1Data, capturedVars);

    function resolveStr(s) {
        if (typeof s !== 'string') return s;
        return s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] !== undefined ? vars[k] : `{{${k}}}`);
    }
    function resolveObj(o) {
        if (typeof o === 'string') return resolveStr(o);
        if (Array.isArray(o)) return o.map(resolveObj);
        if (o !== null && typeof o === 'object') {
            const out = {};
            for (const k of Object.keys(o)) out[k] = resolveObj(o[k]);
            return out;
        }
        return o;
    }

    try {
        const method  = (step.method || 'GET').toUpperCase();
        const rawUrl  = resolveStr(step.url || '');
        const isMultipart = step.bodyType === 'multipart';
        const baseHeaders = isMultipart
            ? Object.fromEntries(Object.entries(resolveObj(step.headers || {})).filter(([k]) => k.toLowerCase() !== 'content-type'))
            : Object.assign({ 'Content-Type': 'application/json' }, resolveObj(step.headers || {}));
        const headers = baseHeaders;

        // Build body
        let bodyStr = null;   // string body (JSON/form-urlencoded/raw)
        let bodyBuf = null;   // Buffer body (multipart) — takes precedence over bodyStr when set
        let resolvedBodyPlain = null; // pre-encryption resolved body for debug display
        if (isMultipart && ['POST','PUT','PATCH'].includes(method)) {
            const mp = buildMultipartBody(step.multipartFields || [], resolveStr);
            bodyBuf = mp.buffer;
            headers['Content-Type'] = mp.contentType;
            resolvedBodyPlain = `Multipart/Form-Data\n` + (step.multipartFields || [])
                .filter(f => f.name)
                .map(f => f.type === 'file' ? `${f.name} = ${f.filename || '(no file chosen)'}` : `${f.name} = ${resolveStr(f.value || '')}`)
                .join('\n');
        } else if (['POST','PUT','PATCH'].includes(method) && step.body) {
            const enc = step.requestEncryption;
            if (enc?.enabled && enc.key) {
                // Encryption requires a plaintext string — typed object/array injection
                // doesn't apply here (whole-value {{var}} placeholders stringify as before).
                let bv = step.body;
                if (typeof bv === 'object') bv = JSON.stringify(bv);
                bv = resolveStr(bv);
                resolvedBodyPlain = bv;
                try {
                    const encField = enc.outputField || 'encryptedData';
                    const algo     = enc.algorithm || 'AES-128-CBC';
                    let encrypted;
                    if (algo === 'AES-128-ECB') {
                        encrypted = aesEncrypt(bv, enc.key);
                    } else {
                        // AES-128-CBC — IV defaults to key if not specified (WavedIn pattern)
                        const iv = enc.iv || enc.key;
                        encrypted = aesCbcEncrypt(bv, enc.key, iv);
                    }
                    bodyStr = JSON.stringify({ [encField]: encrypted });
                } catch(e) { bodyStr = bv; }
            } else if (typeof step.body === 'object' && step.body !== null) {
                // Object/array-typed body: resolve the TEMPLATE via resolveValueTyped so a
                // whole-value "{{captured}}" placeholder injects a real captured object/array
                // (from an Object/Array capture) instead of stringifying to "[object Object]".
                // JSON.stringify happens only after resolution.
                const resolved = resolveValueTyped(step.body, vars, resolveStr);
                bodyStr = JSON.stringify(resolved);
                resolvedBodyPlain = bodyStr;
            } else {
                bodyStr = resolveStr(step.body);
                resolvedBodyPlain = bodyStr;
            }
        }

        // Make the HTTP request via Node built-ins (no extra deps)
        const result = await new Promise((resolve) => {
            let parsed;
            try { parsed = new URL(rawUrl); } catch(e) { return resolve({ error: 'Invalid URL: ' + rawUrl }); }
            const lib = parsed.protocol === 'https:' ? https : http;
            const outBody = bodyBuf || (bodyStr ? Buffer.from(bodyStr) : null);
            const opts = {
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method,
                headers: { ...headers },
                timeout: 10000,
            };
            if (outBody) {
                opts.headers['Content-Length'] = outBody.length;
            }
            const t0 = Date.now();
            const req2 = lib.request(opts, (resp) => {
                const chunks = [];
                resp.on('data', c => chunks.push(c));
                resp.on('end', () => {
                    const rawBody = Buffer.concat(chunks).toString('utf8');
                    resolve({
                        status: resp.statusCode,
                        responseTime: Date.now() - t0,
                        rawBody,
                        resHeaders: resp.headers,
                    });
                });
            });
            req2.on('error', e => resolve({ error: e.message, status: 0, responseTime: Date.now() - t0, rawBody: '' }));
            req2.on('timeout', () => { req2.destroy(); resolve({ error: 'Request timed out', status: 0, responseTime: 10000, rawBody: '' }); });
            if (outBody) req2.write(outBody);
            req2.end();
        });

        if (result.error && !result.rawBody) {
            return res.json({ ok: false, error: result.error, status: result.status || 0, responseTime: result.responseTime || 0 });
        }

        // Try to decrypt response if response decryption is configured
        // or if request encryption is on (same key/IV used for response)
        let decryptedBody = null;
        const dec  = step.responseDecryption;
        const enc2 = step.requestEncryption;
        const decAlgo  = (dec?.enabled && dec.algorithm)  ? dec.algorithm  : (enc2?.enabled ? (enc2.algorithm || 'AES-128-CBC') : 'AES-128-CBC');
        const decKey   = (dec?.enabled && dec.key)  ? dec.key  : (enc2?.enabled && enc2.key  ? enc2.key  : null);
        const decIv    = (dec?.enabled && dec.iv)   ? dec.iv   : (enc2?.enabled && enc2.iv   ? enc2.iv   : (decKey || null));
        const decField = (dec?.enabled && dec.inputField) ? dec.inputField : (enc2?.enabled ? (enc2.outputField || 'encryptedData') : 'encryptedData');

        let parsedRaw = null;
        try { parsedRaw = JSON.parse(result.rawBody); } catch(_) {}

        function _tryDecryptCipher(ciphertext, algo, key, iv) {
            if (!ciphertext || typeof ciphertext !== 'string') return null;
            try {
                let plain;
                if (algo === 'AES-128-ECB') {
                    const decipher = require('crypto').createDecipheriv('aes-128-ecb', Buffer.from(key, 'utf8').slice(0, 16), null);
                    decipher.setAutoPadding(true);
                    plain = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
                } else {
                    plain = aesCbcDecrypt(ciphertext, key, iv || key);
                }
                try { return JSON.parse(plain); } catch(_) { return plain; }
            } catch(_) { return null; }
        }

        if (decKey) {
            // Case 1: response is JSON object with a cipher field e.g. { key: "..." }
            if (parsedRaw && typeof parsedRaw === 'object') {
                const ciphertext = parsedRaw[decField] || '';
                if (ciphertext) {
                    decryptedBody = _tryDecryptCipher(ciphertext, decAlgo, decKey, decIv);
                }
            }
            // Case 2: entire response body is a raw base64 cipher string (no JSON wrapper)
            if (!decryptedBody && result.rawBody && typeof result.rawBody === 'string') {
                const trimmed = result.rawBody.trim().replace(/^"|"$/g, ''); // strip surrounding quotes if any
                if (/^[A-Za-z0-9+/]+=*$/.test(trimmed) && trimmed.length > 20) {
                    decryptedBody = _tryDecryptCipher(trimmed, decAlgo, decKey, decIv);
                }
            }
            // Case 3: response is JSON string (entire body is a quoted base64 string)
            if (!decryptedBody && parsedRaw && typeof parsedRaw === 'string') {
                decryptedBody = _tryDecryptCipher(parsedRaw, decAlgo, decKey, decIv);
            }
        }

        // Extract captures
        const capturedValues = {};
        if (step.captures && step.captures.length > 0) {
            const src = decryptedBody || parsedRaw;
            for (const cap of step.captures) {
                if (!cap.varName || !cap.jsonPath) continue;
                try {
                    const val = cap.jsonPath.replace(/^\$\.?/, '').split('.').filter(Boolean)
                        .reduce((o, k) => (o != null ? o[k] : undefined), src);
                    if (val !== undefined) capturedValues[cap.varName] = val;
                } catch(_) {}
            }
        }

        res.json({
            ok: true,
            status: result.status,
            responseTime: result.responseTime,
            rawBody: result.rawBody,
            parsedRaw,
            decryptedBody,
            capturedValues,
            resolvedUrl: rawUrl,
            resolvedBody: resolvedBodyPlain,
        });
    } catch(e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/load-test/step-run-all — run a single step as all configured VUs
// Body: { step, vus, globalVars, capturedVarsByVu, dynamicData }
// capturedVarsByVu: array indexed by VU (0-based) — captured vars from prior steps per VU
// Returns: { results: [{ vu, status, responseTime, capturedValues, ok, resolvedUrl }] }
// ══════════════════════════════════════════════════════════════════════════════
router.post('/step-run-all', auth, async (req, res) => {
    const { step, vus = 1, globalVars: _rawGlobalVars = {}, capturedVarsByVu = [], dynamicData = {}, baseUrl: _baseUrl = '' } = req.body || {};
    // Inject baseUrl so {{baseUrl}} resolves in step URLs; strip trailing slash
    const globalVars = _baseUrl ? Object.assign({ baseUrl: _baseUrl.replace(/\/+$/, '') }, _rawGlobalVars) : _rawGlobalVars;
    if (!step) return res.status(400).json({ error: 'step is required' });
    // Debug: log what captured vars came in
    console.log('[step-run-all] step.name=', step.name, 'vus=', vus, 'capturedVarsByVu=', JSON.stringify(capturedVarsByVu));

    const http  = require('http');
    const https = require('https');
    const { URL } = require('url');

    const startIndex  = parseInt(dynamicData.startIndex) || 1;
    const emailPrefix = dynamicData.emailPrefix  || 'testuser';
    const emailDomain = dynamicData.emailDomain  || 'mailinator.com';
    const phoneBase   = BigInt(dynamicData.phoneBase || '7100000000');
    const namePrefix  = dynamicData.namePrefix   || 'TestUser';

    // Run all VUs concurrently (capped at 50 to avoid overwhelming the server)
    const vuCount = Math.min(Math.max(1, parseInt(vus) || 1), 50);

    function buildVuData(vuIdx) {
        const idx = startIndex + vuIdx;
        return {
            index:       String(idx),
            email:       `${emailPrefix}${idx}@${emailDomain}`,
            phoneNumber: String(phoneBase + BigInt(vuIdx)),
            name:        `${namePrefix} ${idx}`,
            timestamp:   String(Date.now()),
            random:      String(Math.floor(Math.random() * 1e9)),
            uuid:        crypto.randomUUID(),
        };
    }

    // Execute a single HTTP request with vars already merged, return { status, responseTime, rawBody, error }
    async function fireRequest(vars, resolveStr, resolveObj) {
        const method  = (step.method || 'GET').toUpperCase();
        const rawUrl  = resolveStr(step.url || '');
        const isMultipart = step.bodyType === 'multipart';
        const headers = isMultipart
            ? Object.fromEntries(Object.entries(resolveObj(step.headers || {})).filter(([k]) => k.toLowerCase() !== 'content-type'))
            : Object.assign({ 'Content-Type': 'application/json' }, resolveObj(step.headers || {}));

        let bodyStr = null;
        let bodyBuf = null;
        if (isMultipart && ['POST','PUT','PATCH'].includes(method)) {
            const mp = buildMultipartBody(step.multipartFields || [], resolveStr);
            bodyBuf = mp.buffer;
            headers['Content-Type'] = mp.contentType;
        } else if (['POST','PUT','PATCH'].includes(method) && step.body) {
            const enc = step.requestEncryption;
            if (enc?.enabled && enc.key) {
                // Encryption requires a plaintext string — typed object/array injection
                // doesn't apply here (whole-value {{var}} placeholders stringify as before).
                let bv = step.body;
                if (typeof bv === 'object') bv = JSON.stringify(bv);
                bv = resolveStr(bv);
                try {
                    const encField = enc.outputField || 'encryptedData';
                    const iv = enc.iv || enc.key;
                    const encrypted = enc.algorithm === 'AES-128-ECB' ? aesEncrypt(bv, enc.key) : aesCbcEncrypt(bv, enc.key, iv);
                    bodyStr = JSON.stringify({ [encField]: encrypted });
                } catch(_) { bodyStr = bv; }
            } else if (typeof step.body === 'object' && step.body !== null) {
                // Object/array-typed body: resolve the TEMPLATE via resolveValueTyped so a
                // whole-value "{{captured}}" placeholder injects a real captured object/array
                // instead of stringifying to "[object Object]". JSON.stringify happens after.
                bodyStr = JSON.stringify(resolveValueTyped(step.body, vars, resolveStr));
            } else {
                bodyStr = resolveStr(step.body);
            }
        }

        const result = await new Promise((resolve) => {
            let parsed;
            try { parsed = new URL(rawUrl); } catch(e) { return resolve({ error: 'Invalid URL', status: 0, responseTime: 0, rawBody: '' }); }
            const lib  = parsed.protocol === 'https:' ? https : http;
            const outBody = bodyBuf || (bodyStr ? Buffer.from(bodyStr) : null);
            const opts = {
                hostname: parsed.hostname,
                port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path:     parsed.pathname + parsed.search,
                method,
                headers:  { ...headers },
                timeout:  15000,
            };
            if (outBody) opts.headers['Content-Length'] = outBody.length;
            const t0   = Date.now();
            const req2 = lib.request(opts, (resp) => {
                const chunks = [];
                resp.on('data', c => chunks.push(c));
                resp.on('end', () => resolve({ status: resp.statusCode, responseTime: Date.now() - t0, rawBody: Buffer.concat(chunks).toString('utf8'), resolvedUrl: rawUrl, headers }));
            });
            req2.on('error', e => resolve({ error: e.message, status: 0, responseTime: Date.now() - t0, rawBody: '', resolvedUrl: rawUrl, headers }));
            req2.on('timeout', () => { req2.destroy(); resolve({ error: 'Timeout', status: 0, responseTime: 15000, rawBody: '', resolvedUrl: rawUrl, headers }); });
            if (outBody) req2.write(outBody);
            req2.end();
        });
        return result;
    }

    // Decrypt response body and extract captures
    function decryptAndCapture(result) {
        let parsedRaw = null;
        try { parsedRaw = JSON.parse(result.rawBody); } catch(_) {}
        let decryptedBody = null;
        const dec  = step.responseDecryption;
        const enc2 = step.requestEncryption;
        const decKey  = (dec?.enabled && dec.key) ? dec.key : (enc2?.enabled ? enc2.key : null);
        const decIv   = (dec?.enabled && dec.iv)  ? dec.iv  : (enc2?.enabled ? (enc2.iv || enc2.key) : decKey);
        const decAlgo = (dec?.enabled ? dec.algorithm : enc2?.algorithm) || 'AES-128-CBC';
        const decField = (dec?.enabled && dec.inputField) ? dec.inputField : (enc2?.outputField || 'encryptedData');
        function _tryDecryptCipherRA(ciphertext, algo, key, iv) {
            if (!ciphertext || typeof ciphertext !== 'string') return null;
            try {
                let plain;
                if (algo === 'AES-128-ECB') {
                    const decipher = require('crypto').createDecipheriv('aes-128-ecb', Buffer.from(key, 'utf8').slice(0, 16), null);
                    decipher.setAutoPadding(true);
                    plain = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
                } else {
                    plain = aesCbcDecrypt(ciphertext, key, iv || key);
                }
                try { return JSON.parse(plain); } catch(_) { return plain; }
            } catch(_) { return null; }
        }
        if (decKey) {
            // Case 1: JSON object with a cipher field e.g. { key: "..." }
            if (parsedRaw && typeof parsedRaw === 'object' && parsedRaw[decField]) {
                decryptedBody = _tryDecryptCipherRA(parsedRaw[decField], decAlgo, decKey, decIv);
            }
            // Case 2: entire response body is a raw base64 cipher string
            if (!decryptedBody && result.rawBody) {
                const trimmed = result.rawBody.trim().replace(/^"|"$/g, '');
                if (/^[A-Za-z0-9+/]+=*$/.test(trimmed) && trimmed.length > 20) {
                    decryptedBody = _tryDecryptCipherRA(trimmed, decAlgo, decKey, decIv);
                }
            }
            // Case 3: response is a JSON-quoted base64 string e.g. "base64data..."
            if (!decryptedBody && parsedRaw && typeof parsedRaw === 'string') {
                decryptedBody = _tryDecryptCipherRA(parsedRaw, decAlgo, decKey, decIv);
            }
        }
        const capturedValues = {};
        const src = decryptedBody || parsedRaw;
        if (step.captures && src) {
            for (const cap of step.captures) {
                if (!cap.varName || !cap.jsonPath) continue;
                try {
                    const val = cap.jsonPath.replace(/^\$\.?/, '').split('.').filter(Boolean)
                        .reduce((o, k) => (o != null ? o[k] : undefined), src);
                    if (val !== undefined) capturedValues[cap.varName] = val;
                } catch(_) {}
            }
        }
        return capturedValues;
    }

    async function runOneVu(vuIdx) {
        const vuData       = buildVuData(vuIdx);
        const capturedVars = capturedVarsByVu[vuIdx] || capturedVarsByVu[0] || {};
        const baseVars     = Object.assign({}, globalVars, vuData, capturedVars);

        function makeResolvers(vars) {
            const resolveStr = (s) => {
                if (typeof s !== 'string') return s;
                return s.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] !== undefined ? vars[k] : `{{${k}}}`);
            };
            const resolveObj = (o) => {
                if (typeof o === 'string') return resolveStr(o);
                if (Array.isArray(o)) return o.map(resolveObj);
                if (o !== null && typeof o === 'object') {
                    const out = {};
                    for (const k of Object.keys(o)) out[k] = resolveObj(o[k]);
                    return out;
                }
                return o;
            };
            return { resolveStr, resolveObj };
        }

        const fe = step.forEach;
        if (fe?.enabled && fe.arrayVar && fe.injectAs) {
            // forEach mode: iterate over a captured array, fire once per item
            const arr = baseVars[fe.arrayVar];
            if (!Array.isArray(arr) || arr.length === 0) {
                return { vu: vuIdx + 1, status: 0, responseTime: 0, ok: false,
                         capturedValues: {}, resolvedUrl: step.url || '', error: `forEach: {{${fe.arrayVar}}} is empty or not an array`,
                         vuEmail: baseVars.email, vuPhone: baseVars.phoneNumber, resolvedHeaders: {}, rawBody: '',
                         forEachResults: [] };
            }
            const forEachResults = [];
            let totalTime = 0;
            for (const item of arr) {
                const itemVal = fe.itemPath
                    ? fe.itemPath.split('.').reduce((o, k) => (o != null ? o[k] : undefined), item)
                    : item;
                const loopVars = Object.assign({}, baseVars, { [fe.injectAs]: itemVal });
                const { resolveStr, resolveObj } = makeResolvers(loopVars);
                const result = await fireRequest(loopVars, resolveStr, resolveObj);
                const capturedValues = decryptAndCapture(result);
                const ok = result.status >= 200 && result.status < 400;
                totalTime += result.responseTime || 0;
                forEachResults.push({ item: itemVal, status: result.status, responseTime: result.responseTime, ok,
                                      rawBody: result.rawBody ? result.rawBody.substring(0, 200) : '', error: result.error || null });
            }
            const allOk = forEachResults.every(r => r.ok);
            const passCount = forEachResults.filter(r => r.ok).length;
            const resolvedHeadersDebug = {};
            const { resolveStr: rs0, resolveObj: ro0 } = makeResolvers(baseVars);
            for (const [k, v] of Object.entries(Object.assign({ 'Content-Type': 'application/json' }, ro0(step.headers || {})))) {
                resolvedHeadersDebug[k] = v;
            }
            return { vu: vuIdx + 1, status: allOk ? 200 : forEachResults.find(r => !r.ok)?.status || 500,
                     responseTime: totalTime, ok: allOk, capturedValues: {},
                     resolvedUrl: step.url || '', error: allOk ? null : `${forEachResults.length - passCount}/${forEachResults.length} iterations failed`,
                     vuEmail: baseVars.email, vuPhone: baseVars.phoneNumber,
                     resolvedHeaders: resolvedHeadersDebug,
                     rawBody: `forEach: ${passCount}/${forEachResults.length} passed`,
                     forEachResults };
        }

        // Normal (non-forEach) mode
        const { resolveStr, resolveObj } = makeResolvers(baseVars);
        const result = await fireRequest(baseVars, resolveStr, resolveObj);
        const capturedValues = decryptAndCapture(result);
        const ok = result.status >= 200 && result.status < 400;
        console.log('[step-run-all] VU', vuIdx + 1, 'status=', result.status, 'capturedValues=', JSON.stringify(capturedValues));
        const resolvedHeadersDebug = {};
        for (const [k, v] of Object.entries(result.headers || {})) resolvedHeadersDebug[k] = v;
        return { vu: vuIdx + 1, status: result.status, responseTime: result.responseTime, ok, capturedValues,
                 resolvedUrl: result.resolvedUrl || '', error: result.error || null,
                 vuEmail: baseVars.email, vuPhone: baseVars.phoneNumber,
                 resolvedHeaders: resolvedHeadersDebug, rawBody: result.rawBody ? result.rawBody.substring(0, 300) : '' };
    }

    try {
        const results = await Promise.all(
            Array.from({ length: vuCount }, (_, i) => runOneVu(i))
        );
        const pass = results.filter(r => r.ok).length;
        const fail = results.length - pass;
        res.json({ ok: true, results, summary: { total: results.length, pass, fail, passRate: Math.round((pass / results.length) * 100) } });
    } catch(e) {
        res.status(500).json({ ok: false, error: e.message });
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
        const graceTime = Math.max(60, duration + 60);
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

    // Build global vars — inject baseUrl from scenario.url so {{baseUrl}} resolves in step URLs
    const baseUrl = (scenario.url || '').replace(/\/+$/, ''); // strip trailing slash
    const effectiveGlobalVars = baseUrl ? Object.assign({ baseUrl }, globalVars) : globalVars;
    const varsStr = JSON.stringify(effectiveGlobalVars, null, 2);

    // Build steps code
    const stepsCode = enabledSteps.map((step, idx) => _generateStepCode(step, idx)).join('\n\n');

    // Check if any step uses response decryption
    const needsDecrypt = enabledSteps.some(s => s.responseDecryption?.enabled && s.responseDecryption?.key);

    // NOTE on the doubled backslashes in regex literals below (e.g. \\{\\{...\\}\\}):
    // this entire return value is a JS template literal — its text gets parsed a SECOND
    // time, by k6/goja, when the generated script runs. Each \\ here collapses to a single
    // \ in the generated script's source, which is what produces a normal, working regex
    // like /\{\{(\w+)\}\}/g there. Do not "simplify" these to single backslashes — that
    // would remove the escaping in the generated script and break the regex.
    return `import http from 'k6/http';
import { sleep, check } from 'k6';
import { Rate, Counter, Trend } from 'k6/metrics';

// ── Generated by AdHash Load Test Center ──
// Scenario: ${scenarioName}
// Generated: ${new Date().toISOString()}

${optionsStr}

const DATA = ${dataStr};
const GLOBAL_VARS = ${varsStr};

// ── Pure-JS AES-128-CBC — synchronous, no WebCrypto, verified against Node.js crypto ──
// k6's http module deadlocks inside async functions; crypto.subtle requires await.
// Solution: full AES in pure JS so the default function stays synchronous.
function _gmul(a,b){let p=0;for(let i=0;i<8;i++){if(b&1)p^=a;const h=a&0x80;a=(a<<1)&0xff;if(h)a^=0x1b;b>>=1;}return p;}
const _S=(function(){const s=new Uint8Array(256);let p=1,q=1;do{p=p^(p<<1)^(p&0x80?0x1b:0);p&=0xff;q^=q<<1;q^=q<<2;q^=q<<4;q^=(q&0x80?0x09:0);q&=0xff;s[p]=(q^((q<<1|q>>7)&0xff)^((q<<2|q>>6)&0xff)^((q<<3|q>>5)&0xff)^((q<<4|q>>4)&0xff)^0x63)&0xff;}while(p!==1);s[0]=0x63;return s;})();
const _Si=new Uint8Array(256);for(let i=0;i<256;i++)_Si[_S[i]]=i;
const _Rc=[0,1,2,4,8,16,32,64,128,27,54];
function _expKey(k){const w=new Uint32Array(44);for(let i=0;i<4;i++)w[i]=(k[4*i]<<24|k[4*i+1]<<16|k[4*i+2]<<8|k[4*i+3])>>>0;for(let i=4;i<44;i++){let t=w[i-1];if(i%4===0)t=(((_S[(t>>16)&0xff]<<24)|(_S[(t>>8)&0xff]<<16)|(_S[t&0xff]<<8)|_S[(t>>24)&0xff])^(_Rc[i/4]<<24))>>>0;w[i]=(w[i-4]^t)>>>0;}return w;}
function _ark(s,w,rd){for(let c=0;c<4;c++){const k=w[rd*4+c];s[0][c]^=(k>>24)&0xff;s[1][c]^=(k>>16)&0xff;s[2][c]^=(k>>8)&0xff;s[3][c]^=k&0xff;}}
function _encBlk(src,w){const s=[[src[0],src[4],src[8],src[12]],[src[1],src[5],src[9],src[13]],[src[2],src[6],src[10],src[14]],[src[3],src[7],src[11],src[15]]];_ark(s,w,0);for(let rd=1;rd<10;rd++){for(let r=0;r<4;r++)for(let c=0;c<4;c++)s[r][c]=_S[s[r][c]];[s[1][0],s[1][1],s[1][2],s[1][3]]=[s[1][1],s[1][2],s[1][3],s[1][0]];[s[2][0],s[2][1],s[2][2],s[2][3]]=[s[2][2],s[2][3],s[2][0],s[2][1]];[s[3][0],s[3][1],s[3][2],s[3][3]]=[s[3][3],s[3][0],s[3][1],s[3][2]];for(let c=0;c<4;c++){const a=s[0][c],b=s[1][c],cc=s[2][c],d=s[3][c];s[0][c]=_gmul(2,a)^_gmul(3,b)^cc^d;s[1][c]=a^_gmul(2,b)^_gmul(3,cc)^d;s[2][c]=a^b^_gmul(2,cc)^_gmul(3,d);s[3][c]=_gmul(3,a)^b^cc^_gmul(2,d);}_ark(s,w,rd);}for(let r=0;r<4;r++)for(let c=0;c<4;c++)s[r][c]=_S[s[r][c]];[s[1][0],s[1][1],s[1][2],s[1][3]]=[s[1][1],s[1][2],s[1][3],s[1][0]];[s[2][0],s[2][1],s[2][2],s[2][3]]=[s[2][2],s[2][3],s[2][0],s[2][1]];[s[3][0],s[3][1],s[3][2],s[3][3]]=[s[3][3],s[3][0],s[3][1],s[3][2]];_ark(s,w,10);return[s[0][0],s[1][0],s[2][0],s[3][0],s[0][1],s[1][1],s[2][1],s[3][1],s[0][2],s[1][2],s[2][2],s[3][2],s[0][3],s[1][3],s[2][3],s[3][3]];}
function _decBlk(src,w){const s=[[src[0],src[4],src[8],src[12]],[src[1],src[5],src[9],src[13]],[src[2],src[6],src[10],src[14]],[src[3],src[7],src[11],src[15]]];_ark(s,w,10);for(let rd=9;rd>0;rd--){[s[1][0],s[1][1],s[1][2],s[1][3]]=[s[1][3],s[1][0],s[1][1],s[1][2]];[s[2][0],s[2][1],s[2][2],s[2][3]]=[s[2][2],s[2][3],s[2][0],s[2][1]];[s[3][0],s[3][1],s[3][2],s[3][3]]=[s[3][1],s[3][2],s[3][3],s[3][0]];for(let r=0;r<4;r++)for(let c=0;c<4;c++)s[r][c]=_Si[s[r][c]];_ark(s,w,rd);for(let c=0;c<4;c++){const a=s[0][c],b=s[1][c],cc=s[2][c],d=s[3][c];s[0][c]=_gmul(14,a)^_gmul(11,b)^_gmul(13,cc)^_gmul(9,d);s[1][c]=_gmul(9,a)^_gmul(14,b)^_gmul(11,cc)^_gmul(13,d);s[2][c]=_gmul(13,a)^_gmul(9,b)^_gmul(14,cc)^_gmul(11,d);s[3][c]=_gmul(11,a)^_gmul(13,b)^_gmul(9,cc)^_gmul(14,d);}}[s[1][0],s[1][1],s[1][2],s[1][3]]=[s[1][3],s[1][0],s[1][1],s[1][2]];[s[2][0],s[2][1],s[2][2],s[2][3]]=[s[2][2],s[2][3],s[2][0],s[2][1]];[s[3][0],s[3][1],s[3][2],s[3][3]]=[s[3][1],s[3][2],s[3][3],s[3][0]];for(let r=0;r<4;r++)for(let c=0;c<4;c++)s[r][c]=_Si[s[r][c]];_ark(s,w,0);return[s[0][0],s[1][0],s[2][0],s[3][0],s[0][1],s[1][1],s[2][1],s[3][1],s[0][2],s[1][2],s[2][2],s[3][2],s[0][3],s[1][3],s[2][3],s[3][3]];}
function _hexToBytes(h){const a=new Uint8Array(h.length/2);for(let i=0;i<a.length;i++)a[i]=parseInt(h.slice(i*2,i*2+2),16);return a;}
function _strToBytes(s){const a=new Uint8Array(s.length);for(let i=0;i<s.length;i++)a[i]=s.charCodeAt(i)&255;return a;}
function _bytesToStr(a){return String.fromCharCode(...a);}
const _B64='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function _b64enc(d){let o='',i=0;for(;i+2<d.length;i+=3){const n=(d[i]<<16)|(d[i+1]<<8)|d[i+2];o+=_B64[(n>>18)&63]+_B64[(n>>12)&63]+_B64[(n>>6)&63]+_B64[n&63];}if(i+1===d.length){const n=d[i]<<16;o+=_B64[(n>>18)&63]+_B64[(n>>12)&63]+'==';}else if(i+2===d.length){const n=(d[i]<<16)|(d[i+1]<<8);o+=_B64[(n>>18)&63]+_B64[(n>>12)&63]+_B64[(n>>6)&63]+'=';}return o;}
function _b64dec(s){const lk={};for(let i=0;i<64;i++)lk[_B64[i]]=i;s=s.replace(/=+$/,'');const o=new Uint8Array(Math.floor(s.length*3/4));let bi=0;for(let i=0;i<s.length;i+=4){const a=lk[s[i]]||0,b=lk[s[i+1]]||0,c=lk[s[i+2]]||0,d=lk[s[i+3]]||0,n=(a<<18)|(b<<12)|(c<<6)|d;o[bi++]=(n>>16)&255;if(s[i+2]!=null)o[bi++]=(n>>8)&255;if(s[i+3]!=null)o[bi++]=n&255;}return o;}
// Keys/IVs are UTF-8 strings sliced to 16 bytes — matching Node.js Buffer.from(key,'utf8').slice(0,16)
function _aesEncrypt(plain,keyStr,ivStr){const key=_strToBytes(keyStr).slice(0,16),iv=_strToBytes(ivStr).slice(0,16),w=_expKey(key),raw=_strToBytes(plain),pad=16-(raw.length%16),data=new Uint8Array(raw.length+pad);data.set(raw);for(let i=raw.length;i<data.length;i++)data[i]=pad;const out=new Uint8Array(data.length);let prev=Array.from(iv);for(let i=0;i<data.length;i+=16){const blk=[];for(let j=0;j<16;j++)blk[j]=data[i+j]^prev[j];const enc=_encBlk(blk,w);for(let j=0;j<16;j++)out[i+j]=enc[j];prev=enc;}return _b64enc(out);}
function _aesDecrypt(b64ct,keyStr,ivStr){const key=_strToBytes(keyStr).slice(0,16),iv=_strToBytes(ivStr).slice(0,16),w=_expKey(key),data=_b64dec(b64ct),out=new Uint8Array(data.length);let prev=Array.from(iv);for(let i=0;i<data.length;i+=16){const blk=Array.from(data.slice(i,i+16)),dec=_decBlk(blk,w);for(let j=0;j<16;j++)out[i+j]=dec[j]^prev[j];prev=blk;}const pad=out[out.length-1];return _bytesToStr(out.slice(0,out.length-pad));}

function _get(obj, path) {
  return path.replace(/^\$\.?/, '').split('.').filter(Boolean)
    .reduce((o, k) => (o != null && o[k] !== undefined) ? o[k] : undefined, obj);
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

// ── Typed value resolution for JSON request bodies ──
// A string that is EXACTLY "{{varName}}" (nothing else) resolves to the captured
// variable's real JSON type (object/array/number/boolean/null) rather than being
// stringified. A string with embedded text around {{varName}} (e.g. "Bearer {{token}}")
// keeps the existing scalar string-interpolation behavior — this is what preserves
// backward compatibility with every existing scenario.
function _resolveValue(value, vars) {
  if (typeof value === 'string') {
    const m = value.match(/^\\{\\{(\\w+)\\}\\}$/);
    if (m) {
      const v = vars[m[1]];
      return v !== undefined ? v : value;
    }
    return _resolveVars(value, vars);
  }
  if (Array.isArray(value)) return value.map(v => _resolveValue(v, vars));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = _resolveValue(value[k], vars);
    return out;
  }
  return value;
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
        timeout: Math.round(Math.max(5000, step.timeout || 5000) / 1000) + 's',
    };

    const isMultipart = step.bodyType === 'multipart';

    // Build headers resolution — for multipart, strip any user-set Content-Type so k6
    // can set its own multipart/form-data boundary (never set it manually).
    let headersCode = '';
    const stepHeaders = isMultipart && step.headers
        ? Object.fromEntries(Object.entries(step.headers).filter(([k]) => k.toLowerCase() !== 'content-type'))
        : step.headers;
    if (stepHeaders && Object.keys(stepHeaders).length > 0) {
        headersCode = `  const _headers${idx+1} = _resolveObj(${JSON.stringify(stepHeaders)}, vars);\n`;
        paramsObj.headers = `__HEADERS_REF_${idx+1}__`;
    }

    // Build body resolution
    let bodyCode = '';
    let bodyRef  = 'null';
    if (isMultipart && ['POST','PUT','PATCH'].includes(method)) {
        // Multipart bodies are never AES-encrypted (see UI: Request Encryption is disabled
        // for multipart steps) and never JSON.stringify'd — k6 recognizes a plain object
        // containing http.file() results and sets multipart/form-data + boundary itself.
        const fields = step.multipartFields || [];
        const fieldLines = fields.map((f, fi) => {
            if (!f.name) return '';
            if (f.type === 'file') {
                if (!f.dataBase64) return ''; // no file chosen yet — skip rather than send an empty part
                const mime = f.mimeType || 'application/octet-stream';
                return `    ${JSON.stringify(f.name)}: http.file(_b64dec(${JSON.stringify(f.dataBase64)}).buffer, ${JSON.stringify(f.filename || 'file')}, ${JSON.stringify(mime)}),`;
            }
            return `    ${JSON.stringify(f.name)}: _resolveVars(${JSON.stringify(f.value || '')}, vars),`;
        }).filter(Boolean).join('\n');
        bodyCode = `  const _body${idx+1} = {\n${fieldLines}\n  };\n`;
        bodyRef  = `_body${idx+1}`;
    } else if (['POST','PUT','PATCH'].includes(method) && step.body) {
        let bodyVal = step.body;
        const enc = step.requestEncryption;
        if (enc?.enabled) {
            const bodyStr = typeof bodyVal === 'object' ? JSON.stringify(bodyVal) : bodyVal;
            // Check if body contains {{vars}} that are only known at runtime (captured from prior steps)
            // These cannot be pre-encrypted — must encrypt at runtime via proxy
            const hasRuntimeVars = /\{\{[^}]+\}\}/.test(bodyStr);
            if (hasRuntimeVars) {
                // Runtime encrypt: resolve vars first, then encrypt in-process via k6 crypto.subtle
                bodyCode = [
                    `  const _plainBody${idx+1} = _resolveVars(${JSON.stringify(bodyStr)}, vars);`,
                    `  console.log('VU=' + __VU + ' STEP${idx+1} PLAIN_REQ=' + _plainBody${idx+1});`,
                    `  const _encVal${idx+1} = _aesEncrypt(_plainBody${idx+1}, ${JSON.stringify(enc.key)}, ${JSON.stringify(enc.iv || '')});`,
                    `  const _body${idx+1} = JSON.stringify({ ${JSON.stringify(enc.outputField || 'encryptedData')}: _encVal${idx+1} });`,
                    `  console.log('VU=' + __VU + ' STEP${idx+1} ENC_REQ=' + _body${idx+1}.substring(0,100));`,
                ].join('\n') + '\n';
                bodyRef = `_body${idx+1}`;
            } else {
                // No runtime vars — use pre-encrypted body from DATA array (faster).
                // Safety check: a missing key here means _buildK6DataArray's precompute
                // pass and this step's numbering diverged (a generator bug), or the DATA
                // array genuinely wasn't built for this step. Fail loudly with the exact
                // step number and expected key instead of silently sending a null body —
                // a null body previously produced a confusing downstream HTTP 400 with no
                // indication that the request body was never generated at all.
                const bodyKey = `_encryptedBody_step${idx+1}`;
                bodyCode = [
                    `  if (vuData['${bodyKey}'] === undefined) {`,
                    `    throw new Error('MISSING PRECOMPUTED REQUEST BODY\\nStep: ${idx+1}\\nVariable: vuData.${bodyKey}\\nReason: this step is configured for pre-encrypted request-body injection, but no matching entry was generated in the per-VU DATA array. Sending null would silently break this request.');`,
                    `  }`,
                    `  const _body${idx+1} = vuData['${bodyKey}'];`,
                ].join('\n') + '\n';
                bodyRef = `_body${idx+1}`;
            }
        } else if (typeof bodyVal === 'object' && bodyVal !== null) {
            // Object/array-typed request body: resolve the TEMPLATE (not a stringified copy) via
            // _resolveValue so a whole-value "{{captured}}" placeholder can inject a real captured
            // object/array (from an Object/Array capture) instead of stringifying to "[object Object]".
            // JSON.stringify happens only after resolution, at the HTTP-call boundary.
            bodyCode = `  const _bodyTemplate${idx+1} = ${JSON.stringify(bodyVal)};\n` +
                       `  const _body${idx+1} = JSON.stringify(_resolveValue(_bodyTemplate${idx+1}, vars));\n`;
            bodyRef  = `_body${idx+1}`;
        } else {
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

    // Captures — decrypt response before extracting if needed
    let captureCode = '';
    if (step.captures && step.captures.length > 0) {
        const dec = step.responseDecryption;
        // Use explicit responseDecryption config, OR fall back to requestEncryption key/IV
        // (API responses are encrypted with the same key when request encryption is on)
        const enc = step.requestEncryption;
        const decKey  = (dec?.enabled && dec.key)  ? dec.key  : (enc?.enabled && enc.key  ? enc.key  : null);
        // IV defaults to key when not explicitly set — matches server-side: iv = enc.iv || enc.key
        const decIv   = (dec?.enabled && dec.iv)   ? dec.iv   : (enc?.enabled && enc.iv   ? enc.iv   : decKey);
        const decField = (dec?.enabled && dec.inputField) ? dec.inputField : (enc?.enabled ? (enc.outputField || 'encryptedData') : 'encryptedData');

        if (decKey) {
            // Decrypt response in-process via k6 crypto.subtle (no proxy round-trip)
            captureCode = step.captures.map(cap => {
                if (!cap.varName || !cap.jsonPath) return '';
                return [
                    `  try {`,
                    `    const _raw${idx+1} = ${varName}.json();`,
                    `    const _encField${idx+1} = (_raw${idx+1} && _raw${idx+1}['${decField}']) || '';`,
                    `    const _decText${idx+1} = _aesDecrypt(_encField${idx+1}, ${JSON.stringify(decKey)}, ${JSON.stringify(decIv)});`,
                    `    const _decJson${idx+1} = JSON.parse(_decText${idx+1});`,
                    `    vars['${cap.varName}'] = _get(_decJson${idx+1}, '${cap.jsonPath}') || '';`,
                    `    console.log('VU=' + __VU + ' STEP${idx+1} captured ${cap.varName}=' + String(vars['${cap.varName}']).substring(0,60));`,
                    `  } catch(e) { vars['${cap.varName}'] = ''; console.log('VU=' + __VU + ' STEP${idx+1} capture error: ' + e); }`,
                ].join('\n');
            }).filter(Boolean).join('\n') + '\n';
        } else {
            captureCode = step.captures.map(cap => {
                if (!cap.varName || !cap.jsonPath) return '';
                return `  try { const _j${idx+1} = ${varName}.json(); vars['${cap.varName}'] = _get(_j${idx+1}, '${cap.jsonPath}'); console.log('VU=' + __VU + ' STEP${idx+1} captured ${cap.varName}=' + String(vars['${cap.varName}']).substring(0,60)); } catch {}`;
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
        `  console.log('VU=' + __VU + ' STEP${idx+1}[' + ${varName}.status + '] ENC_RES=' + (${varName}.body || '').substring(0,400));\n`,
        assertCode,
        captureCode,
        retryWrapEnd,
        thinkCode,
    ].join('');

    return code;
}

function _buildK6DataArray(scenario, count) {
    const { dynamicData = {}, globalVars = {}, steps = [] } = scenario;
    // Precomputed body keys (_encryptedBody_stepN) are numbered by position among
    // ENABLED steps only — this must exactly match _generateStepCode's numbering,
    // which iterates `enabledSteps = steps.filter(s => s.enabled !== false)` and
    // keys each generated request as `_encryptedBody_step${idx+1}` using that
    // filtered array's index. Numbering from the unfiltered `steps` array here
    // (as before) diverges the moment ANY step before this one is disabled —
    // e.g. a disabled Step 10 shifts every subsequent step's full-array position
    // away from its enabled-only position, silently orphaning later steps' keys.
    const enabledSteps = steps.filter(s => s.enabled !== false);
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

        // Pre-encrypt step bodies if requestEncryption is enabled (never for multipart — binary
        // files can't be wrapped inside encryptedData, and the UI disables this toggle for it).
        // Iterate enabledSteps (not the raw steps array) and key by ITS index — this must stay
        // structurally identical to _generateStepCode's `enabledSteps.map((step, idx) => ...)`
        // numbering, or a disabled step anywhere in the scenario silently orphans every
        // precomputed-body key for every enabled step that comes after it.
        enabledSteps.forEach((step, stepIdx) => {
            if (step.bodyType !== 'multipart' && step.requestEncryption?.enabled && step.body) {
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
                    vuData[`_encryptedBody_step${stepIdx + 1}`] = JSON.stringify({ [field]: encrypted });
                } catch {}
            }
        });

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
        addLog('Test script generated', 'Running');
        addTimeline('Load test run started', 'Running');

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
                if (line.trim()) addLog(line.trim().substring(0, 200), 'Running');
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
        addLog(`Load test completed — ${state.metrics.totalReqs} reqs · P95 ${state.metrics.p95}ms`, 'Completed');
        addTimeline('Test completed', 'Completed');
        await _saveResults(runId_, state);

    } catch (err) {
        state.status  = 'failed';
        state.verdict = 'FAIL';
        state.endTime = new Date().toISOString();
        if (err.code === 'ENOENT') {
            state.logs.push({ time: new Date().toISOString(), event: 'Load test engine not found. Please check K6_PATH env var.', phase: 'Failed' });
        } else {
            state.logs.push({ time: new Date().toISOString(), event: 'k6 run failed: ' + err.message, phase: 'Failed' });
        }
        await _saveResults(runId_, state);
    }
}

// Build per-step summary from perRequestResults: [{step, stepName, pass, fail, total, passRate}]
function _buildStepSummary(perReq, cfg) {
    const steps = {};
    const stepNames = {};
    if (cfg && cfg.scenario && cfg.scenario.steps) {
        cfg.scenario.steps.forEach((s, i) => { stepNames[i + 1] = s.name || `Step ${i + 1}`; });
    }
    for (const r of perReq) {
        const n = r.step || 1;
        if (!steps[n]) steps[n] = { step: n, stepName: stepNames[n] || `Step ${n}`, pass: 0, fail: 0 };
        const ok = r.status >= 200 && r.status < 400;
        if (ok) steps[n].pass++; else steps[n].fail++;
    }
    return Object.values(steps)
        .sort((a, b) => a.step - b.step)
        .map(s => ({ ...s, total: s.pass + s.fail, passRate: s.pass + s.fail > 0 ? Math.round((s.pass / (s.pass + s.fail)) * 100) : 0 }));
}

function _processK6MetricLines(lines, m, latencies, cfg) {
    // Per-second buckets for time-series charts: { [secKey]: { reqs, errs, lats[], vus } }
    if (!m._buckets) m._buckets = {};

    for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.type !== 'Point') continue;

        const metric = entry.metric;
        const value  = entry.data?.value;
        const tags   = entry.data?.tags || {};
        const ts     = entry.data?.time ? new Date(entry.data.time) : new Date();
        const secKey = Math.floor(ts.getTime() / 1000); // 1-second bucket

        if (!m._buckets[secKey]) m._buckets[secKey] = { reqs: 0, errs: 0, lats: [], vus: 0 };
        const bucket = m._buckets[secKey];

        if (metric === 'http_reqs') {
            if (tags.isProxy === 'true') continue;
            m.totalReqs++;
            const isOk = tags.status && parseInt(tags.status) >= 200 && parseInt(tags.status) < 400;
            if (isOk) m.okReqs++;
            else { m.errReqs++; bucket.errs++; }
            bucket.reqs++;
            const sc = tags.status || '0';
            m.statusCodes = m.statusCodes || {};
            m.statusCodes[sc] = (m.statusCodes[sc] || 0) + 1;
            if (!m._startTs) m._startTs = ts.getTime();
        } else if (metric === 'http_req_duration') {
            if (value !== undefined && tags.isProxy !== 'true') {
                latencies.push(value);
                bucket.lats.push(value);
                const elapsed = (Date.now() - (m._startTs || Date.now())) / 1000 || 1;
                m.rps = parseFloat((m.totalReqs / Math.max(elapsed, 1)).toFixed(2));
            }
        } else if (metric === 'vus') {
            if (value !== undefined) bucket.vus = Math.max(bucket.vus, value);
        }
    }

    if (m.totalReqs > 0) {
        m.errRate = parseFloat(((m.errReqs / m.totalReqs) * 100).toFixed(2));
    }

    // Rebuild time-series arrays from buckets (sorted by second)
    const keys = Object.keys(m._buckets).map(Number).sort((a, b) => a - b);
    if (keys.length > 0) {
        m.rpsHistory          = keys.map(k => m._buckets[k].reqs);
        m.latHistory          = keys.map(k => {
            const ls = m._buckets[k].lats;
            return ls.length ? parseFloat((ls.reduce((a, b) => a + b, 0) / ls.length).toFixed(1)) : 0;
        });
        m.errHistory          = keys.map(k => {
            const b = m._buckets[k];
            return b.reqs > 0 ? parseFloat(((b.errs / b.reqs) * 100).toFixed(2)) : 0;
        });
        m.activeUsersHistory  = keys.map(k => m._buckets[k].vus);
        m.tickTimes           = keys.map(k => new Date(k * 1000).toISOString());
        // Aggregate avgLatency live
        if (latencies.length > 0) {
            m.avgLatency = parseFloat((latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1));
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// HTML REPORT GENERATOR
// ══════════════════════════════════════════════════════════════════════════════
function _generateHtml(state, tmpl = {}) {
    const cfg  = state.config  || {};
    const m    = state.metrics || {};
    const t    = tmpl;

    const companyName  = t.companyName  || 'Ad-Hash Technolabs Pvt Ltd';
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

    // ── Server capacity/scaling analysis — computed once here so both the Server
    // Configuration section AND the Recommendation section (onboarding sub-section)
    // can reference the same result without recomputing it. ──
    const _serverEnvKey = /prod/i.test(cfg.environment || '') ? 'production' : 'staging';
    const _serverCfgForRun = getServerConfigsForProject(cfg.projectName || '')[_serverEnvKey];
    const serverRec = computeServerRecommendation(_serverCfgForRun, m, cfg);

    // ── Certified Performance Tester level QA Recommendation ──
    let recText = '', qaRec = '', recColor = '';
    const p95ms    = m.p95 || 0;
    const p50ms    = m.p50 || 0;
    const p99ms    = m.p99 || 0;
    const avgLat   = m.avgLatency || 0;
    const errPct   = parseFloat(errRateDisp);
    const totalR   = m.totalReqs || 0;
    const failedR  = m.errReqs   || 0;
    const okR      = m.okReqs    || 0;
    const p95Thr   = cfg.p95Threshold || 3000;
    const vusCount = cfg.vus || 0;
    const durSec   = cfg.duration || 0;
    const rps      = m.rps || 0;
    const testWindow = `${new Date(state.startTime || Date.now()).toLocaleString('en-IN')} – ${new Date(state.endTime || Date.now()).toLocaleString('en-IN')}`;

    // Derived insights
    const latSpread   = p99ms - p50ms;          // p99–p50 spread indicates tail-latency risk
    const latSpreadHigh = latSpread > 1500;      // wide spread = unstable response times
    const throughputPerVU = totalR > 0 && vusCount > 0 ? (totalR / vusCount).toFixed(1) : '—';
    const avgRespOk   = avgLat <= p95Thr * 0.5;  // avg is comfortably within budget

    const h = (txt, color) => `<p style="margin-top:14px;font-weight:800;font-size:12px;color:${color};text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid ${color}33;padding-bottom:4px">${txt}</p>`;

    if (vd === 'PASS') {
        recText = `
          ${h('📊 Test Outcome Summary', '#065f46')}
          <p>All performance acceptance criteria were satisfied under the validated load of <strong>${vusCount} concurrent Virtual Users (VUs)</strong> executing <strong>${cfg.steps?.filter(s=>s.enabled!==false).length || 1} API step(s)</strong> over <strong>${durSec}s</strong> (${cfg.scenarioType || 'Baseline Load Test'}).</p>
          ${h('📈 Observed Performance Profile', '#065f46')}
          <ul style="margin:4px 0 0 18px;line-height:2">
            <li><strong>Success Rate:</strong> ${successRate}% (${okR.toLocaleString()} of ${totalR.toLocaleString()} requests) — meets the ≥99% acceptance criterion.</li>
            <li><strong>P50 (median) latency:</strong> ${p50ms}ms — half of all requests responded faster than this. Indicates good baseline performance.</li>
            <li><strong>P95 latency:</strong> ${p95ms}ms — below the configured threshold of ${p95Thr}ms. 95% of users experienced sub-threshold response times.</li>
            <li><strong>P99 latency:</strong> ${p99ms}ms — worst-case experienced by top 1% of requests. ${p99ms <= p95Thr * 1.5 ? 'Acceptable variance from P95.' : 'Slightly elevated; monitor in production under higher concurrency.'}</li>
            <li><strong>Latency spread (P99–P50):</strong> ${latSpread}ms — ${latSpreadHigh ? '⚠ Moderate spread detected. Response times are not fully stable; intermittent slowdowns possible under peak traffic.' : 'Tight distribution. Response times are consistent across the VU pool.'}</li>
            <li><strong>Average latency:</strong> ${avgLat}ms — ${avgRespOk ? 'well within the response budget' : 'approaching threshold; verify under higher VU counts'}.</li>
            <li><strong>Throughput:</strong> ${rps} RPS · ${throughputPerVU} requests/VU — throughput is proportional to VU count, no saturation observed.</li>
            <li><strong>Error rate:</strong> ${errPct}% — no systematic failure pattern. Any isolated errors are within noise tolerance.</li>
          </ul>
          ${h('✅ QA Sign-Off Criteria Met', '#065f46')}
          <ul style="margin:4px 0 0 18px;line-height:2">
            <li>P95 ≤ ${p95Thr}ms threshold: <strong style="color:#10b981">PASS</strong> (actual: ${p95ms}ms)</li>
            <li>Error rate &lt; 1%: <strong style="color:#10b981">PASS</strong> (actual: ${errPct}%)</li>
            <li>Success rate ≥ 99%: <strong style="color:#10b981">PASS</strong> (actual: ${successRate}%)</li>
          </ul>
          ${h('🔭 Observations & Proactive Guidance for QA Team', '#065f46')}
          <ul style="margin:4px 0 0 18px;line-height:2">
            <li><strong>Test Coverage Gap:</strong> This test validated ${vusCount} VUs. Before production release, run a <strong>Stress Test at 2–3× this VU count</strong> to identify the application's breaking point and ensure headroom.</li>
            <li><strong>Soak Test:</strong> Run this scenario for <strong>30+ minutes at current VU count</strong> to detect memory leaks, connection pool degradation, and heap growth over time. Short tests can mask long-running stability issues.</li>
            <li><strong>Spike Test:</strong> Simulate a sudden traffic burst (e.g., 0 → ${vusCount * 3} VUs in 5s) to validate auto-scaling, queue behaviour, and circuit-breaker effectiveness.</li>
            ${latSpreadHigh ? `<li><strong>Latency Variance (P99–P50 = ${latSpread}ms):</strong> The spread is wide. Investigate whether specific steps (check the VU log) consistently have higher tail latency. Garbage collection pauses, DB lock contention, or third-party API variance are common causes.</li>` : ''}
            <li><strong>Baseline Regression:</strong> Save this report as the performance baseline. On every future build, compare P95, RPS, and success rate against this baseline to detect performance regressions early.</li>
          </ul>
          ${h('🛠 Guidance for Development Team', '#065f46')}
          <ul style="margin:4px 0 0 18px;line-height:2">
            <li>Current performance is acceptable. To maintain it as user base grows: monitor production APM dashboards for P95 drift, DB slow-query logs, and connection pool saturation.</li>
            <li>If any endpoint's P95 is within 30% of the threshold today, profile and optimise proactively — do not wait for a test failure.</li>
            <li>Implement <strong>rate-limiting and circuit-breakers</strong> on high-traffic endpoints to protect stability during unexpected spikes beyond tested VU levels.</li>
          </ul>`;
        qaRec    = 'GO — RELEASE APPROVED';
        recColor = '#10b981';

    } else if (vd === 'RISK') {
        const highLatency = p95ms > p95Thr;
        const highErr     = errPct >= 1 && errPct < 10;
        const latRatio    = p95Thr > 0 ? (p95ms / p95Thr).toFixed(2) : '—';
        recText = `
          ${h('⚠ Test Outcome Summary', '#92400e')}
          <p><strong>Performance risks were detected</strong> under <strong>${vusCount} VUs</strong> over <strong>${durSec}s</strong>. The application met some but not all acceptance criteria. <strong>Conditional release is permitted only after risk review and sign-off by the release manager.</strong></p>
          ${h('📈 Observed Performance Profile', '#92400e')}
          <ul style="margin:4px 0 0 18px;line-height:2">
            <li><strong>Success rate:</strong> ${successRate}% (${okR.toLocaleString()} passed, ${failedR.toLocaleString()} failed of ${totalR.toLocaleString()} total)</li>
            <li><strong>P95 latency:</strong> ${p95ms}ms ${highLatency ? `— <strong style="color:#b45309">EXCEEDS threshold by ${p95ms - p95Thr}ms (${latRatio}× the ${p95Thr}ms limit)</strong>` : `— within ${p95Thr}ms threshold`}</li>
            <li><strong>P99 latency:</strong> ${p99ms}ms · <strong>P50:</strong> ${p50ms}ms · <strong>Avg:</strong> ${avgLat}ms</li>
            <li><strong>Error rate:</strong> ${errPct}% ${highErr ? `— <strong style="color:#b45309">${failedR} requests failed</strong>` : '— within tolerance'}</li>
            <li><strong>Throughput:</strong> ${rps} RPS — ${rps > 0 ? 'active traffic generated' : 'verify metrics output'}</li>
          </ul>
          ${h('🔍 Root Cause Analysis', '#92400e')}
          <ul style="margin:4px 0 0 18px;line-height:2">
            ${highLatency ? `<li><strong>Latency degradation at P95 (${p95ms}ms, ${latRatio}× threshold):</strong> Concurrent request queuing is building up under load. Most common causes: (1) unindexed MongoDB/SQL queries that execute fast for 1 user but serialise under 10+; (2) synchronous I/O blocking Node.js event loop; (3) downstream service (auth, payment, email) not scaled proportionally to load.</li>` : ''}
            ${highErr ? `<li><strong>Elevated error rate (${errPct}%, ${failedR} failures):</strong> Review the status code distribution table above. HTTP 5xx = server-side: check for unhandled exceptions, OOM, DB write failures. HTTP 4xx at scale = likely rate-limiting or token/session exhaustion per VU.</li>` : ''}
            ${latSpreadHigh ? `<li><strong>High latency variance (P99–P50 = ${latSpread}ms):</strong> The tail of the distribution is significantly longer than the median. This is a hallmark of intermittent resource contention — connection pool wait times, GC pauses, or lock waits in the database layer.</li>` : ''}
            ${!highLatency && !highErr ? `<li>Metrics are at or near threshold boundaries. The application is operating at the edge of its current capacity at ${vusCount} VUs. Any increase in traffic or payload complexity could push results into FAIL territory.</li>` : ''}
          </ul>
          ${h('🛠 Actions for Development Team', '#92400e')}
          <ul style="margin:4px 0 0 18px;line-height:2">
            <li><strong>Instrument during the test window (${testWindow}):</strong> Pull APM traces, DB slow-query logs, and CPU/memory graphs for this exact window. Correlate spikes with the ramp-up phase.</li>
            <li><strong>Database:</strong> Run <code>EXPLAIN</code> / <code>db.collection.explain("executionStats")</code> on queries executing during peak load. Add compound indexes on high-frequency filter fields.</li>
            <li><strong>Connection pool:</strong> Increase MongoDB <code>maxPoolSize</code> and verify connections are being released correctly (no leak). Check via <code>db.serverStatus().connections</code>.</li>
            <li><strong>Event loop blocking:</strong> Use <code>--prof</code> or <code>clinic.js flame</code> to identify CPU-heavy synchronous code paths.</li>
            <li><strong>Downstream services:</strong> If any step has consistently high latency in the VU log, isolate whether the bottleneck is your API or an external dependency (add <code>x-response-time</code> headers).</li>
            <li><strong>Caching:</strong> For read-heavy steps (e.g., user lookup, config fetch), add Redis caching with TTL appropriate to data freshness requirements.</li>
          </ul>
          ${h('🔬 Actions for QA Team', '#92400e')}
          <ul style="margin:4px 0 0 18px;line-height:2">
            <li><strong>Raise a P2 performance defect</strong> and attach this report. Include the specific failing step from the VU Request Log as evidence.</li>
            <li><strong>Do not close the defect</strong> until a retest at the same VU count passes all thresholds. Partial retests (lower VU count) do not count.</li>
            <li><strong>Soak Test:</strong> Schedule a 30-minute soak at ${vusCount} VUs post-fix to confirm the fix holds under sustained load (not just the first 60s).</li>
            <li><strong>Regression check:</strong> Compare P95 and error rate against any prior PASS baseline. Confirm the fix did not regress previously-passing endpoints.</li>
            <li>If the release deadline cannot be postponed, obtain <strong>explicit written sign-off</strong> from the release manager acknowledging the performance risk and the conditions under which the application will be monitored post-release.</li>
          </ul>`;
        qaRec    = 'CONDITIONAL GO — RISK ACCEPTED';
        recColor = '#f59e0b';

    } else {
        // FAIL
        const criticalErr = errPct >= 10;
        const criticalLat = p95ms > p95Thr * 2;
        const latRatio    = p95Thr > 0 ? (p95ms / p95Thr).toFixed(1) : '—';
        recText = `
          ${h('🚫 Test Outcome Summary', '#991b1b')}
          <p><strong>Performance test FAILED.</strong> The application did not meet the minimum acceptance criteria under <strong>${vusCount} VUs</strong> over <strong>${durSec}s</strong>. <span style="color:#dc2626;font-weight:800">RELEASE BLOCKED</span> — do not proceed to production until all issues are resolved, fixed, and retested to PASS.</p>
          ${h('📈 Failure Metrics Summary', '#991b1b')}
          <ul style="margin:4px 0 0 18px;line-height:2">
            <li><strong>Success rate:</strong> ${successRate}% — <strong style="color:#dc2626">${failedR.toLocaleString()} out of ${totalR.toLocaleString()} requests failed</strong> (threshold: ≥99%)</li>
            <li><strong>Error rate:</strong> ${errPct}% ${criticalErr ? `— <strong style="color:#dc2626">CRITICAL: systemic failure rate indicates infrastructure-level saturation</strong>` : ''}</li>
            <li><strong>P95 latency:</strong> ${p95ms}ms ${criticalLat ? `— <strong style="color:#dc2626">${latRatio}× the ${p95Thr}ms threshold. Severe saturation.</strong>` : `— exceeds ${p95Thr}ms threshold`}</li>
            <li><strong>P99 latency:</strong> ${p99ms}ms · <strong>P50:</strong> ${p50ms}ms · <strong>Avg:</strong> ${avgLat}ms · <strong>Spread:</strong> ${latSpread}ms</li>
            <li><strong>Throughput:</strong> ${rps} RPS across ${vusCount} VUs</li>
          </ul>
          ${h('🔍 Root Cause Analysis', '#991b1b')}
          <ul style="margin:4px 0 0 18px;line-height:2">
            ${criticalErr ? `<li><strong>Systemic error rate (${errPct}%):</strong> This level of failure (${failedR} requests) indicates the application is crashing, exhausting resources, or hitting hard infrastructure limits. Check: (1) Node.js process crashes in PM2/Railway logs; (2) MongoDB connection pool exhaustion (<code>MongoPoolExhaustedError</code>); (3) OS-level file descriptor limits (<code>ulimit -n</code>); (4) Memory OOM causing process restarts.</li>` : ''}
            ${criticalLat ? `<li><strong>Severe latency degradation (P95 ${p95ms}ms = ${latRatio}× threshold):</strong> The API is receiving requests faster than it can process them — a textbook throughput saturation pattern. Every additional VU worsens response time non-linearly. The current architecture cannot sustain ${vusCount} concurrent users at this workload. Root causes: single-threaded CPU saturation, unindexed DB queries becoming table scans at scale, or a downstream service bottleneck without connection pooling.</li>` : ''}
            ${!criticalErr && errPct > 0 ? `<li><strong>Elevated error rate (${errPct}%, ${failedR} failures):</strong> Review the status code distribution above. Map each failing step in the VU Request Log to its HTTP status to identify whether failures are auth-related (401/403), validation (400), rate-limited (429), or server errors (5xx).</li>` : ''}
            ${!criticalLat && p95ms > p95Thr ? `<li><strong>P95 threshold breach (${p95ms}ms &gt; ${p95Thr}ms):</strong> Response times are consistently above acceptable limits under concurrent load. This confirms a scalability bottleneck exists in the current implementation.</li>` : ''}
            <li><strong>Test Window:</strong> ${testWindow} — check all server-side logs, APM traces, and DB slow-query logs for this exact window.</li>
          </ul>
          ${h('🛠 Immediate Actions for Development Team', '#991b1b')}
          <ul style="margin:4px 0 0 18px;line-height:2">
            <li><strong>Step 1 — Triage:</strong> Pull server logs for the test window. Look for <code>FATAL</code>, <code>ENOMEM</code>, <code>ECONNREFUSED</code>, <code>MongoPoolExhaustedError</code>, and unhandled promise rejections. This identifies whether it is a crash, resource exhaustion, or a logic error.</li>
            <li><strong>Step 2 — Isolate the bottleneck layer:</strong> Use <code>clinic.js flame</code> or Node.js <code>--prof</code> + <code>node --prof-process</code> to identify CPU-bound code paths. Check if the event loop is blocked by synchronous operations (JSON.parse on large payloads, bcrypt, file I/O).</li>
            <li><strong>Step 3 — Database profiling:</strong> Enable MongoDB profiler (<code>db.setProfilingLevel(1, {slowms: 100})</code>) during a rerun at lower VU count. Review <code>db.system.profile</code> for queries with <code>millis &gt; 100</code> and add the missing indexes.</li>
            <li><strong>Step 4 — Connection pool sizing:</strong> Check current <code>maxPoolSize</code> in Mongoose/MongoClient config. Increase to <code>min(50, VUs × steps)</code>. Confirm connections are released — wrap all DB calls in try/finally or use the ORM's managed sessions.</li>
            <li><strong>Step 5 — Horizontal scaling check:</strong> If a single Node.js instance is saturated, validate with <code>pm2 start --instances max</code> (cluster mode) before the next load test to confirm the bottleneck is CPU-bound and not I/O-bound.</li>
            <li><strong>Step 6 — Downstream dependencies:</strong> Review each step in the VU log for consistently high response times. If Step N is slow for every VU, the bottleneck is in that API's backend. Add <code>X-Response-Time</code> headers and compare server-processing vs. network time.</li>
          </ul>
          ${h('🔬 Actions for QA Team', '#991b1b')}
          <ul style="margin:4px 0 0 18px;line-height:2">
            <li><strong>Raise a P1 (Critical) performance defect</strong> immediately. Attach this full report (with logs version) as evidence. Set the severity to Blocker and link it to the current release milestone.</li>
            <li><strong>Run 1-VU smoke test first:</strong> If 1 VU also fails, this is a functional defect — escalate to the dev team as a Priority 0 issue before any performance work begins. Do not treat a functional bug as a performance problem.</li>
            <li><strong>Binary VU search:</strong> Once 1 VU passes, find the maximum stable VU count by testing at: 1 → 2 → 5 → 10 → 20 VUs. The point where errors appear is the application's current concurrency ceiling. Document it in the defect.</li>
            <li><strong>Retest requirements:</strong> The dev team must deliver a fix and the QA team must rerun this <em>exact</em> scenario (same VUs, duration, steps, thresholds). Partial retests or smoke tests do not satisfy the retest criteria for a P1 performance defect.</li>
            <li><strong>Root cause evidence collection:</strong> Before any fix is applied, capture: (1) server CPU and memory graphs for the test window; (2) MongoDB slow-query logs; (3) application error logs. This evidence is required for the defect report and prevents the team from guessing the root cause.</li>
            <li><strong>Do not release</strong> under any circumstance until this defect is closed with a verified PASS retest result. Document the blocking decision in the release sign-off form.</li>
          </ul>`;
        qaRec    = 'NO-GO — RELEASE BLOCKED';
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
    const _stripK6 = s => String(s || '')
        .replace(/\bk6 run started\b/gi, 'Load test run started')
        .replace(/\bk6 test completed\b/gi, 'Load test completed')
        .replace(/\bk6 not found\b/gi, 'Load test engine not found')
        .replace(/\bk6\b/gi, '');

    const tlRows = (state.timeline || []).map(e =>
        `<tr><td style="color:#64748b;font-size:11px">${new Date(e.time).toLocaleString('en-IN')}</td><td>${e.phase}</td><td>${_stripK6(e.event)}</td></tr>`
    ).join('');

    // Log rows (last 20)
    const logRows = (state.logs || []).slice(-20).map(l =>
        `<tr><td style="color:#64748b;font-size:11px">${new Date(l.time).toLocaleString('en-IN')}</td><td>${l.phase}</td><td>${_stripK6(l.event)}</td></tr>`
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

                const resLblClass = parseInt(r.status) >= 500 ? 'panel-lbl-res-err' : parseInt(r.status) >= 400 ? 'panel-lbl-res-warn' : 'panel-lbl-res-ok';
                const resIcon = parseInt(r.status) >= 500 ? '🔴' : parseInt(r.status) >= 400 ? '🟡' : '🟢';
                return `
<div style="border:1px solid #e2e8f0;border-radius:8px;margin-bottom:14px;overflow:hidden">
  <div style="background:linear-gradient(90deg,#1e3a5f,#1e40af);padding:10px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
    <span style="background:#3b82f6;color:#fff;padding:3px 12px;border-radius:20px;font-size:11px;font-weight:800;letter-spacing:.3px">Step ${r.step}</span>
    <span style="font-size:11px;font-weight:800;color:#fbbf24;background:rgba(245,158,11,.2);padding:2px 10px;border-radius:4px;letter-spacing:.5px">${_esc(method)}</span>
    <span style="font-size:12px;font-family:monospace;color:#e2e8f0;word-break:break-all;flex:1">${_esc(url)}</span>
    <span style="margin-left:auto">${statusBadge}</span>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:0;border-top:1px solid #e2e8f0">
    <div style="padding:12px 16px;border-right:1px solid #e2e8f0;background:#f0f9ff">
      <div class="panel-lbl panel-lbl-plain">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        REQUEST — PLAIN (DECRYPTED)
      </div>
      <pre style="background:#fff;border:1px solid #bae6fd;border-radius:6px;padding:10px;font-size:11px;margin:0;white-space:pre-wrap;word-break:break-all;color:#0c4a6e;max-height:200px;overflow-y:auto">${_esc(_tryFmt(r.plainReq))}</pre>
    </div>
    <div style="padding:12px 16px;background:#faf5ff">
      <div class="panel-lbl panel-lbl-enc">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        REQUEST — ENCRYPTED (SENT TO API)
      </div>
      <pre style="background:#fff;border:1px solid #ddd6fe;border-radius:6px;padding:10px;font-size:11px;margin:0;white-space:pre-wrap;word-break:break-all;color:#5b21b6;max-height:200px;overflow-y:auto">${_esc(_tryFmt(r.encReq))}</pre>
    </div>
  </div>
  <div style="padding:12px 16px;border-top:2px solid #e2e8f0;background:#f8fafc">
    <div class="panel-lbl ${resLblClass}">
      ${resIcon}
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-left:2px"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      RESPONSE FROM API ${r.status ? `— HTTP ${r.status}` : ''}
    </div>
    <pre style="background:#fff;border:1px solid ${parseInt(r.status)>=500?'#fca5a5':parseInt(r.status)>=400?'#fde68a':'#a7f3d0'};border-radius:6px;padding:10px;font-size:11px;margin:0;white-space:pre-wrap;word-break:break-all;color:${statusColor};max-height:200px;overflow-y:auto">${_esc(_tryFmt(r.encRes))}</pre>
  </div>
</div>`;
            }).join('');

            return `
<div style="border:2px solid #3b82f6;border-radius:12px;margin-bottom:20px;overflow:hidden;box-shadow:0 2px 8px rgba(59,130,246,.15)">
  <div style="background:linear-gradient(90deg,#0f172a,#1e3a5f);color:#fff;padding:14px 20px;font-size:14px;font-weight:700;display:flex;align-items:center;gap:12px">
    <span style="background:#3b82f6;padding:4px 14px;border-radius:20px;font-size:13px;font-weight:800">VU ${vuNum}</span>
    <span style="font-size:12px;font-weight:400;color:#93c5fd">${steps.length} step(s) recorded</span>
    <span style="margin-left:auto;font-size:11px;color:#64748b">${steps.filter(s=>s.status&&s.status>=200&&s.status<400).length}/${steps.length} passed</span>
  </div>
  <div style="padding:16px;background:#f8fafc">${stepsHtml}</div>
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
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
*{box-sizing:border-box;margin:0;padding:0;-webkit-font-smoothing:antialiased}
body{font-family:'Inter','Segoe UI',system-ui,sans-serif;background:#F0F2F8;color:#0D1224;line-height:1.55}
.page{max-width:1100px;margin:0 auto;padding:28px 24px}

/* ── REPORT HEADER ── */
.rpt-header{
  background:linear-gradient(135deg,#0F172A 0%,#1E293B 60%,#1E3A5F 100%);
  color:#fff;border-radius:18px;padding:36px 44px;margin-bottom:24px;
  display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:20px;
  position:relative;overflow:hidden;
  box-shadow:0 8px 32px rgba(15,23,42,0.35);
}
.rpt-header::before{
  content:'';position:absolute;top:-60px;right:-40px;
  width:260px;height:260px;border-radius:50%;
  background:radial-gradient(circle,rgba(99,102,241,0.20),transparent 70%);
  pointer-events:none;
}
.rpt-brand{font-size:26px;font-weight:900;letter-spacing:-.6px;display:flex;align-items:center;gap:10px}
.rpt-brand-icon{
  width:40px;height:40px;border-radius:10px;
  background:linear-gradient(135deg,#EF4444,#DC2626);
  display:flex;align-items:center;justify-content:center;flex-shrink:0;
  box-shadow:0 2px 10px rgba(220,38,38,0.45);
}
.rpt-brand em{font-style:normal;background:linear-gradient(90deg,#818CF8,#A78BFA);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.rpt-meta{text-align:right}
.rpt-meta .title{font-size:17px;font-weight:800;margin-bottom:6px;letter-spacing:-.1px}
.rpt-meta .sub{font-size:12px;color:rgba(255,255,255,0.65);margin-top:3px;line-height:1.6}

/* ── BADGES ── */
.badge{display:inline-flex;align-items:center;padding:4px 12px;border-radius:6px;font-size:11px;font-weight:700;letter-spacing:.02em}
.badge-env{background:rgba(59,130,246,.20);color:#93c5fd;border:1px solid rgba(59,130,246,.30)}
.badge-type{background:rgba(139,92,246,.20);color:#c4b5fd;border:1px solid rgba(139,92,246,.30)}
.verdict-badge{font-size:18px;font-weight:900;padding:9px 26px;border-radius:10px;background:${vdBg};color:${vdTxt};border:2px solid ${vdColor};letter-spacing:.04em;display:inline-flex;align-items:center;gap:8px}

/* ── SECTIONS ── */
.section{
  background:#fff;border-radius:16px;padding:28px;margin-bottom:20px;
  box-shadow:0 1px 3px rgba(15,23,42,0.06),0 4px 16px rgba(15,23,42,0.04);
  border:1px solid rgba(79,70,229,0.07);
  position:relative;overflow:hidden;
  transition:box-shadow .2s;
}
.section:hover{box-shadow:0 4px 20px rgba(15,23,42,0.10)}
.section h2{
  font-size:11px;font-weight:800;color:#6B7280;text-transform:uppercase;letter-spacing:.09em;
  margin-bottom:20px;padding-bottom:12px;
  border-bottom:1px solid rgba(79,70,229,0.09);
  display:flex;align-items:center;gap:10px;
}
.section-icon{
  width:28px;height:28px;border-radius:7px;
  display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;
  background:rgba(79,70,229,0.08);border:1px solid rgba(79,70,229,0.15);
}

/* ── SECTION HEADER BAR (dark navy) — used for "Test Configuration" ── */
.section-hdr-bar{
  background:linear-gradient(90deg,#0F172A 0%,#1E293B 70%,#1e3a5f 100%);
  border-radius:14px;margin-bottom:20px;overflow:hidden;
  box-shadow:0 4px 20px rgba(15,23,42,0.28);
}
.section-hdr-bar-inner{
  padding:18px 26px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;
}
.section-hdr-bar-icon{
  width:40px;height:40px;border-radius:10px;
  background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.15);
  display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px;
}
.section-hdr-bar-title{font-size:15px;font-weight:800;color:#fff;letter-spacing:-.1px}
.section-hdr-bar-sub{font-size:11px;color:rgba(255,255,255,0.55);margin-top:3px}
.section-hdr-bar-right{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.badge-hdr{display:inline-flex;align-items:center;padding:5px 14px;border-radius:8px;font-size:11px;font-weight:700;letter-spacing:.02em;border:1px solid}
.badge-scenario{background:rgba(255,255,255,0.10);color:#e2e8f0;border-color:rgba(255,255,255,0.20)}
.badge-engine{background:rgba(129,140,248,0.15);color:#a5b4fc;border-color:rgba(129,140,248,0.30)}
.badge-verdict-pass{background:rgba(16,185,129,0.20);color:#6ee7b7;border-color:rgba(16,185,129,0.40)}
.badge-verdict-risk{background:rgba(245,158,11,0.20);color:#fcd34d;border-color:rgba(245,158,11,0.40)}
.badge-verdict-fail{background:rgba(239,68,68,0.20);color:#fca5a5;border-color:rgba(239,68,68,0.40)}
.section-hdr-bar-body{background:#fff;border-radius:0 0 14px 14px;padding:24px 26px;border-top:1px solid rgba(79,70,229,0.07)}

/* ── KPI TILES ── */
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:12px}
.kpi{
  border-radius:14px;padding:20px 16px;text-align:center;
  position:relative;overflow:hidden;border:1px solid transparent;
  transition:transform .2s,box-shadow .2s;
}
.kpi:hover{transform:translateY(-3px);box-shadow:0 8px 24px rgba(0,0,0,0.10)}
.kpi-blue{background:linear-gradient(135deg,#EFF6FF,#DBEAFE);border-color:#BFDBFE}
.kpi-green{background:linear-gradient(135deg,#ECFDF5,#D1FAE5);border-color:#A7F3D0}
.kpi-amber{background:linear-gradient(135deg,#FFFBEB,#FEF3C7);border-color:#FDE68A}
.kpi-purple{background:linear-gradient(135deg,#F5F3FF,#EDE9FE);border-color:#DDD6FE}
.kpi-red{background:linear-gradient(135deg,#FFF1F2,#FFE4E6);border-color:#FECDD3}
.kpi-teal{background:linear-gradient(135deg,#F0FDFA,#CCFBF1);border-color:#99F6E4}
.kpi-val{font-size:28px;font-weight:900;line-height:1;letter-spacing:-.8px}
.kpi-unit{font-size:14px;font-weight:700;margin-left:1px}
.kpi-lbl{font-size:10px;font-weight:700;margin-top:6px;text-transform:uppercase;letter-spacing:.07em;opacity:.75}
.kpi-sub{font-size:10px;margin-top:3px;opacity:.6}
.kpi-val.green{color:#059669}.kpi-val.red{color:#DC2626}.kpi-val.blue{color:#2563EB}.kpi-val.amber{color:#D97706}.kpi-val.purple{color:#7C3AED}.kpi-val.teal{color:#0D9488}

/* ── LOAD PARAM TILES (large colored number tiles) ── */
.lparam-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:4px}
.lparam{border-radius:14px;padding:22px 16px;text-align:center;border:1px solid transparent}
.lparam-blue{background:linear-gradient(135deg,#EFF6FF,#DBEAFE);border-color:#BFDBFE}
.lparam-green{background:linear-gradient(135deg,#ECFDF5,#D1FAE5);border-color:#A7F3D0}
.lparam-amber{background:linear-gradient(135deg,#FFFBEB,#FEF3C7);border-color:#FDE68A}
.lparam-purple{background:linear-gradient(135deg,#F5F3FF,#EDE9FE);border-color:#DDD6FE}
.lparam-val{font-size:36px;font-weight:900;line-height:1;letter-spacing:-1px;display:flex;align-items:baseline;justify-content:center;gap:3px}
.lparam-val-unit{font-size:16px;font-weight:700}
.lparam-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;margin-top:8px;opacity:.7}
.lparam-sub{font-size:11px;margin-top:3px;opacity:.6}
.lparam-blue .lparam-val{color:#2563EB}
.lparam-green .lparam-val{color:#059669}
.lparam-amber .lparam-val{color:#D97706}
.lparam-purple .lparam-val{color:#7C3AED}

/* ── THRESHOLD TILES ── */
.thresh-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.thresh{background:#fff;border:1px solid #E5E7EB;border-radius:14px;padding:18px 20px;position:relative;overflow:hidden}
.thresh-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#6B7280;margin-bottom:8px}
.thresh-val{font-size:22px;font-weight:900;letter-spacing:-.5px;line-height:1}
.thresh-limit{font-size:11px;color:#9CA3AF;margin-top:3px;font-weight:500}
.thresh-progress{height:4px;background:#E5E7EB;border-radius:20px;margin-top:10px;overflow:hidden}
.thresh-bar{height:100%;border-radius:20px;transition:width .6s ease}
.thresh-status{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-top:8px}
.thresh-ok{color:#059669}.thresh-warn{color:#D97706}.thresh-bad{color:#DC2626}

/* ── CFG GRID (text info rows) ── */
.cfg-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.cfg-row{display:flex;flex-direction:column;gap:3px;padding:12px 16px;background:#F9FAFB;border-radius:10px;border:1px solid #F3F4F6}
.cfg-lbl{font-size:10px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.07em}
.cfg-val{font-size:13px;font-weight:700;color:#111827}
.env-badge{display:inline-flex;align-items:center;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700;background:#EFF6FF;color:#2563EB;border:1px solid #BFDBFE}
.url-box{background:#F1F5F9;border:1px solid #E2E8F0;border-radius:8px;padding:8px 12px;font-family:ui-monospace,'Consolas',monospace;font-size:12px;color:#334155;word-break:break-all}

/* ── EXEC TIME GRID ── */
.exec-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.exec-cell{display:flex;align-items:center;gap:12px;padding:14px 16px;background:#F9FAFB;border:1px solid #F3F4F6;border-radius:12px}
.exec-cell-icon{width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0}
.exec-cell-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#9CA3AF;margin-bottom:3px}
.exec-cell-val{font-size:13px;font-weight:700;color:#111827}

.exec-box{background:linear-gradient(135deg,#F0F9FF,#E0F2FE);border:1px solid #BAE6FD;border-radius:12px;padding:20px;font-size:14px;color:#0C4A6E;line-height:1.75}

/* ── TABLES ── */
table{width:100%;border-collapse:collapse}
th{padding:11px 14px;background:#F9FAFB;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#6B7280;text-align:left;border-bottom:2px solid #E5E7EB}
td{padding:10px 14px;border-bottom:1px solid #F3F4F6;font-size:13px}
tr:hover td{background:#F9FAFB}

/* ── CHARTS ── */
.chart-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:700px){.chart-grid{grid-template-columns:1fr}.rpt-header{flex-direction:column}.rpt-meta{text-align:left}.kpi-grid{grid-template-columns:repeat(2,1fr)}.lparam-grid{grid-template-columns:repeat(2,1fr)}.thresh-grid{grid-template-columns:1fr}}
.chart-box{background:#F9FAFB;border:1px solid #E5E7EB;border-radius:14px;padding:20px}
.chart-box h4{font-size:10px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:.08em;margin-bottom:14px;display:flex;align-items:center;gap:8px}

/* ── RECOMMENDATION BOX ── */
.rec-box{padding:20px 24px;border-radius:14px;font-size:13px;line-height:1.8;border-left:4px solid ${recColor};background:${vdBg};color:${vdTxt}}
.rec-box p{margin:0 0 8px}
.rec-box ul{margin:4px 0 10px 20px;padding:0}
.rec-box li{margin-bottom:5px}
.rel-row{display:flex;gap:14px;flex-wrap:wrap}
.rel-item{flex:1;min-width:180px;background:#F9FAFB;border-radius:12px;padding:18px;border:1px solid #E5E7EB}
.rel-item .label{font-size:10px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px}
.rel-item .value{font-size:16px;font-weight:900;color:${recColor}}
.custom-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-top:12px}

/* ── FOOTER ── */
footer{text-align:center;padding:28px;color:#9CA3AF;font-size:11px;border-top:1px solid #E5E7EB;margin-top:12px}

/* ── VU LOG ── */
.log-section{background:#fff;border-radius:16px;padding:26px;margin-bottom:20px;box-shadow:0 2px 12px rgba(245,158,11,.15);border:2px solid rgba(245,158,11,.35)}
.log-section h2{font-size:11px;font-weight:800;color:#92400e;margin-bottom:6px;padding-bottom:10px;border-bottom:1px solid #FDE68A;display:flex;align-items:center;gap:8px;text-transform:uppercase;letter-spacing:.08em}
.log-section-banner{background:linear-gradient(135deg,#FFFBEB,#FEF3C7);border:1px solid #FDE68A;border-radius:10px;padding:10px 16px;margin-bottom:16px;font-size:12px;color:#78350F;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
.log-dl-btn{display:inline-flex;align-items:center;gap:5px;padding:6px 14px;border-radius:7px;font-size:11px;font-weight:700;text-decoration:none;border:none;cursor:pointer;transition:.15s}
.log-dl-btn-full{background:#92400e;color:#fff}.log-dl-btn-full:hover{background:#78350f}
.log-dl-btn-clean{background:#fff;color:#92400e;border:1px solid #F59E0B}.log-dl-btn-clean:hover{background:#FEF3C7}

/* ── PANEL LABELS ── */
.panel-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px;display:flex;align-items:center;gap:5px}
.panel-lbl-plain{color:#0369A1}
.panel-lbl-enc{color:#7C3AED}
.panel-lbl-res-ok{color:#065F46}
.panel-lbl-res-err{color:#991B1B}
.panel-lbl-res-warn{color:#92400E}
</style>
</head>
<body>
<div class="page">

<!-- HEADER -->
<div class="rpt-header">
  <div style="flex:1">
    <div class="rpt-brand">
      <div class="rpt-brand-icon">
        <svg width="18" height="18" viewBox="0 0 16 16" fill="none"><polygon points="9 1 3 9 8 9 7 15 13 7 8 7" fill="rgba(255,255,255,0.95)"/></svg>
      </div>
      Ad<em>Hash</em>
    </div>
    <div style="margin-top:4px;font-size:12px;color:rgba(255,255,255,0.50);letter-spacing:.01em">${companyName}</div>
    <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <span class="badge badge-env">${cfg.environment || 'Unknown'}</span>
      <span class="badge badge-type">${cfg.scenarioType || 'Load Test'}</span>
      <span class="badge" style="background:rgba(129,140,248,.18);color:#a5b4fc;border:1px solid rgba(129,140,248,.30)">Server-side Engine</span>
      <span class="badge" style="background:rgba(129,140,248,.18);color:#a5b4fc;border:1px solid rgba(129,140,248,.30)">${cfg.mode === 'single' || !cfg.steps?.length || cfg.steps?.length === 1 ? 'Single API Test' : 'Workflow Scenario'}</span>
    </div>
    <div style="margin-top:18px">
      <span class="verdict-badge">${vd === 'PASS' ? '✓' : vd === 'RISK' ? '⚠' : '✗'} ${vd}</span>
    </div>
  </div>
  <div class="rpt-meta">
    <div class="title">${reportTitle}</div>
    <div class="sub">Project: <strong style="color:#fff">${cfg.projectName || '—'}</strong></div>
    <div class="sub">Generated: ${genTime}</div>
    <div class="sub">Executed by: ${preparedBy}</div>
  </div>
</div>

${show('showExecutiveSummary') ? `
<!-- EXECUTIVE SUMMARY — Enterprise -->
<div style="background:#fff;border-radius:14px;margin-bottom:20px;box-shadow:0 4px 24px rgba(30,41,59,.10);border:2px solid ${vdColor}44;overflow:hidden">

  <!-- Header bar -->
  <div style="background:linear-gradient(90deg,#0f172a 0%,#1e293b 70%,#334155 100%);padding:16px 28px;display:flex;align-items:center;gap:14px">
    <div style="background:rgba(255,255,255,.12);border-radius:8px;padding:8px 10px;flex-shrink:0">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
    </div>
    <div>
      <div style="font-size:15px;font-weight:800;color:#fff;letter-spacing:.2px">Executive Summary</div>
      <div style="font-size:11px;color:#94a3b8;margin-top:2px">Plain-language outcome for all stakeholders — no technical background required</div>
    </div>
    <div style="margin-left:auto">
      <span style="background:${vd==='PASS'?'rgba(16,185,129,.2)':vd==='RISK'?'rgba(245,158,11,.2)':'rgba(239,68,68,.2)'};color:${vdColor};padding:6px 18px;border-radius:20px;font-size:13px;font-weight:900;border:2px solid ${vdColor};letter-spacing:.5px">${vd}</span>
    </div>
  </div>

  <!-- Verdict banner -->
  <div style="background:${vd==='PASS'?'linear-gradient(90deg,#d1fae5,#ecfdf5)':vd==='RISK'?'linear-gradient(90deg,#fef3c7,#fffbeb)':'linear-gradient(90deg,#fee2e2,#fff1f2)'};border-bottom:1px solid ${vdColor}33;padding:14px 28px;display:flex;align-items:center;gap:16px">
    <div style="width:44px;height:44px;background:${vdColor};border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 4px 12px ${vdColor}55">
      <span style="font-size:20px">${vd==='PASS'?'✓':vd==='RISK'?'⚠':'✗'}</span>
    </div>
    <div>
      <div style="font-size:16px;font-weight:900;color:${vdTxt}">${vd==='PASS'?'Performance Test PASSED — Application is Ready':vd==='RISK'?'Performance Test at RISK — Conditional Release Only':'Performance Test FAILED — Release Blocked'}</div>
      <div style="font-size:13px;color:${vdTxt};opacity:.8;margin-top:3px">${vd==='PASS'?'All performance acceptance criteria were met under the defined load conditions.':vd==='RISK'?'One or more metrics are approaching threshold boundaries. Risk acceptance sign-off required.':'Critical performance failures detected. The application must not proceed to production.'}</div>
    </div>
  </div>

  <!-- Result breakdown for DevOps / Developer audience -->
  <div style="padding:20px 28px 0">
    <div style="font-size:10px;font-weight:800;color:#3b82f6;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">📊 Result Breakdown</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">

      <!-- Latency profile -->
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px">
        <div style="font-size:10px;font-weight:800;color:#3b82f6;text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px">⏱ Latency Profile</div>
        <div style="display:flex;flex-direction:column;gap:7px">
          <div style="display:flex;justify-content:space-between">
            <span style="font-size:12px;color:#64748b">P50 (median)</span>
            <span style="font-size:13px;font-weight:800;color:#0f172a">${p50ms}ms</span>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="font-size:12px;color:#64748b">P95</span>
            <span style="font-size:13px;font-weight:800;color:${p95ms<=p95Thr?'#15803d':'#dc2626'}">${p95ms}ms <span style="font-size:10px;font-weight:600;color:#94a3b8">/ ${p95Thr}ms limit</span></span>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="font-size:12px;color:#64748b">P99</span>
            <span style="font-size:13px;font-weight:800;color:#0f172a">${p99ms}ms</span>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="font-size:12px;color:#64748b">Average</span>
            <span style="font-size:13px;font-weight:800;color:#0f172a">${avgLat}ms</span>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="font-size:12px;color:#64748b">Tail spread (P99−P50)</span>
            <span style="font-size:13px;font-weight:800;color:${latSpreadHigh?'#b45309':'#0f172a'}">${latSpread}ms ${latSpreadHigh?'⚠':''}</span>
          </div>
        </div>
      </div>

      <!-- Throughput & reliability -->
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px">
        <div style="font-size:10px;font-weight:800;color:#3b82f6;text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px">🚀 Throughput &amp; Reliability</div>
        <div style="display:flex;flex-direction:column;gap:7px">
          <div style="display:flex;justify-content:space-between">
            <span style="font-size:12px;color:#64748b">Total Requests</span>
            <span style="font-size:13px;font-weight:800;color:#0f172a">${(totalR).toLocaleString()}</span>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="font-size:12px;color:#64748b">Successful</span>
            <span style="font-size:13px;font-weight:800;color:#15803d">${(okR).toLocaleString()} (${successRate}%)</span>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="font-size:12px;color:#64748b">Failed</span>
            <span style="font-size:13px;font-weight:800;color:${failedR>0?'#dc2626':'#15803d'}">${failedR.toLocaleString()} (${errRateDisp}%)</span>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="font-size:12px;color:#64748b">Avg RPS</span>
            <span style="font-size:13px;font-weight:800;color:#0f172a">${rps}</span>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="font-size:12px;color:#64748b">Requests / VU</span>
            <span style="font-size:13px;font-weight:800;color:#0f172a">${throughputPerVU}</span>
          </div>
        </div>
      </div>

      <!-- Test parameters -->
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px">
        <div style="font-size:10px;font-weight:800;color:#3b82f6;text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px">⚙ Test Parameters</div>
        <div style="display:flex;flex-direction:column;gap:7px">
          <div style="display:flex;justify-content:space-between">
            <span style="font-size:12px;color:#64748b">Virtual Users</span>
            <span style="font-size:13px;font-weight:800;color:#0f172a">${vusCount}</span>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="font-size:12px;color:#64748b">Duration</span>
            <span style="font-size:13px;font-weight:800;color:#0f172a">${durSec}s</span>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="font-size:12px;color:#64748b">Ramp-up</span>
            <span style="font-size:13px;font-weight:800;color:#0f172a">${cfg.rampup||0}s</span>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="font-size:12px;color:#64748b">API Steps / VU</span>
            <span style="font-size:13px;font-weight:800;color:#0f172a">${cfg.steps?.filter(s=>s.enabled!==false).length||1}</span>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="font-size:12px;color:#64748b">Environment</span>
            <span style="font-size:13px;font-weight:800;color:#1d4ed8">${cfg.environment||'QA'}</span>
          </div>
        </div>
      </div>

    </div>
  </div>

  <!-- Key numbers — layman KPIs -->
  <div style="padding:16px 28px 0">
    <div style="font-size:10px;font-weight:800;color:#3b82f6;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">📊 Key Numbers at a Glance</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px">
      <div style="background:${parseFloat(successRate)>=99?'#f0fdf4':'#fff7ed'};border:1px solid ${parseFloat(successRate)>=99?'#bbf7d0':'#fed7aa'};border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:24px;font-weight:900;color:${parseFloat(successRate)>=99?'#15803d':'#b45309'}">${successRate}%</div>
        <div style="font-size:11px;font-weight:700;color:#64748b;margin-top:3px">Requests Succeeded</div>
        <div style="font-size:10px;color:#94a3b8;margin-top:1px">target ≥ 99%</div>
      </div>
      <div style="background:${p95ms<=p95Thr?'#f0fdf4':'#fff1f2'};border:1px solid ${p95ms<=p95Thr?'#bbf7d0':'#fecdd3'};border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:24px;font-weight:900;color:${p95ms<=p95Thr?'#15803d':'#dc2626'}">${p95ms}<span style="font-size:13px">ms</span></div>
        <div style="font-size:11px;font-weight:700;color:#64748b;margin-top:3px">Response Time (P95)</div>
        <div style="font-size:10px;color:#94a3b8;margin-top:1px">limit: ${p95Thr}ms</div>
      </div>
      <div style="background:${errPct<1?'#f0fdf4':'#fff1f2'};border:1px solid ${errPct<1?'#bbf7d0':'#fecdd3'};border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:24px;font-weight:900;color:${errPct<1?'#15803d':'#dc2626'}">${errRateDisp}%</div>
        <div style="font-size:11px;font-weight:700;color:#64748b;margin-top:3px">Error Rate</div>
        <div style="font-size:10px;color:#94a3b8;margin-top:1px">target &lt; 1%</div>
      </div>
      <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:24px;font-weight:900;color:#0369a1">${(m.totalReqs||0).toLocaleString()}</div>
        <div style="font-size:11px;font-weight:700;color:#64748b;margin-top:3px">Total Requests</div>
        <div style="font-size:10px;color:#94a3b8;margin-top:1px">${rps} req/sec avg</div>
      </div>
      <div style="background:#fdf4ff;border:1px solid #e9d5ff;border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:24px;font-weight:900;color:#7e22ce">${dur}</div>
        <div style="font-size:11px;font-weight:700;color:#64748b;margin-top:3px">Test Duration</div>
        <div style="font-size:10px;color:#94a3b8;margin-top:1px">${cfg.vus} virtual users</div>
      </div>
    </div>
  </div>

  <!-- Plain-language verdict -->
  <div style="padding:16px 28px 20px">
    <div style="font-size:10px;font-weight:800;color:#3b82f6;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">🗣 Plain-Language Verdict</div>
    <div style="font-size:14px;color:#334155;line-height:1.8;border-radius:10px;padding:16px;background:${vdBg};border:1px solid ${vdColor}33">
      ${vd==='PASS'
        ? `<strong style="color:${vdTxt}">${cfg.projectName||'The application'} passed this load test.</strong> Under ${cfg.vus} simultaneous users, every response was fast (P95: ${p95ms}ms, well below the ${p95Thr}ms limit), the error rate was negligible (${errRateDisp}%), and all ${(m.totalReqs||0).toLocaleString()} requests completed successfully. <strong>The system is stable and ready for release under these load conditions.</strong>`
        : vd==='RISK'
        ? `<strong style="color:${vdTxt}">The application is showing warning signs under ${cfg.vus} concurrent users.</strong> Some metrics are near their limits. While the application is still functional, continued load or production traffic could push it into failure. <strong>A release decision requires explicit risk acknowledgement from the release manager.</strong> The development team should investigate the flagged areas before the next test cycle.`
        : `<strong style="color:${vdTxt}">${cfg.projectName||'The application'} failed this load test.</strong> Under ${cfg.vus} concurrent users, the system produced ${errRateDisp}% errors and response times reached ${p95ms}ms — ${p95ms > p95Thr ? `${(p95ms-p95Thr)}ms over the limit` : 'exceeding threshold'}. <strong>This application is not ready for production. Release is blocked until the issues are fixed and a full retest passes.</strong>`}
    </div>
  </div>
</div>` : ''}

<!-- FINAL STATUS -->
<div style="background:#fff;border-radius:14px;margin-bottom:20px;box-shadow:0 4px 24px rgba(30,41,59,.10);border:2px solid ${vdColor};overflow:hidden">
  <div style="background:linear-gradient(90deg,#0f172a,#1e293b,#334155);padding:14px 28px;display:flex;align-items:center;gap:12px">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/></svg>
    <div style="font-size:14px;font-weight:800;color:#fff">Final Status</div>
    <div style="font-size:11px;color:#94a3b8;margin-left:4px">Overall test outcome at a glance</div>
  </div>
  <div style="padding:20px 28px;display:flex;align-items:center;gap:28px;flex-wrap:wrap">
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;background:${vdBg};border:2px solid ${vdColor};border-radius:14px;padding:20px 32px;min-width:130px;flex-shrink:0">
      <div style="font-size:11px;font-weight:700;color:${vdTxt};text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Verdict</div>
      <div style="font-size:36px;font-weight:900;color:${vdColor};letter-spacing:1px">${vd}</div>
      <div style="font-size:20px;margin-top:4px">${vd==='PASS'?'✅':vd==='RISK'?'⚠️':'🚫'}</div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;flex:1">
      <div style="background:linear-gradient(135deg,#f0fdf4,#dcfce7);border:1px solid #bbf7d0;border-radius:12px;padding:16px;text-align:center">
        <div style="font-size:26px;font-weight:900;color:#15803d;line-height:1">${successRate}%</div>
        <div style="font-size:10px;font-weight:700;color:#16a34a;text-transform:uppercase;letter-spacing:.6px;margin-top:5px">Success Rate</div>
        <div style="font-size:10px;color:#64748b;margin-top:2px">target ≥ 99%</div>
      </div>
      <div style="background:linear-gradient(135deg,${errPct<1?'#f0fdf4,#dcfce7':'#fff1f2,#fee2e2'});border:1px solid ${errPct<1?'#bbf7d0':'#fecdd3'};border-radius:12px;padding:16px;text-align:center">
        <div style="font-size:26px;font-weight:900;color:${errPct<1?'#15803d':errPct<5?'#b45309':'#dc2626'};line-height:1">${errRateDisp}%</div>
        <div style="font-size:10px;font-weight:700;color:${errPct<1?'#16a34a':errPct<5?'#d97706':'#ef4444'};text-transform:uppercase;letter-spacing:.6px;margin-top:5px">Error Rate</div>
        <div style="font-size:10px;color:#64748b;margin-top:2px">target &lt; 1%</div>
      </div>
      <div style="background:linear-gradient(135deg,${p95ms<=p95Thr?'#eff6ff,#dbeafe':'#fff1f2,#fee2e2'});border:1px solid ${p95ms<=p95Thr?'#bfdbfe':'#fecdd3'};border-radius:12px;padding:16px;text-align:center">
        <div style="font-size:26px;font-weight:900;color:${p95ms<=p95Thr?'#1d4ed8':'#dc2626'};line-height:1">${m.p95||0}ms</div>
        <div style="font-size:10px;font-weight:700;color:${p95ms<=p95Thr?'#2563eb':'#ef4444'};text-transform:uppercase;letter-spacing:.6px;margin-top:5px">P95 Latency</div>
        <div style="font-size:10px;color:#64748b;margin-top:2px">limit: ${p95Thr}ms</div>
      </div>
      <div style="background:linear-gradient(135deg,#fdf4ff,#fae8ff);border:1px solid #e9d5ff;border-radius:12px;padding:16px;text-align:center">
        <div style="font-size:26px;font-weight:900;color:#7e22ce;line-height:1">${m.rps||0}</div>
        <div style="font-size:10px;font-weight:700;color:#9333ea;text-transform:uppercase;letter-spacing:.6px;margin-top:5px">Avg RPS</div>
        <div style="font-size:10px;color:#64748b;margin-top:2px">req / sec</div>
      </div>
    </div>
  </div>
</div>

${show('showTestConfig') ? `
<!-- TEST CONFIGURATION — Premium dark header -->
<div class="section-hdr-bar" style="margin-bottom:20px">
  <div class="section-hdr-bar-inner">
    <div class="section-hdr-bar-icon">⚙️</div>
    <div>
      <div class="section-hdr-bar-title">Test Configuration</div>
      <div class="section-hdr-bar-sub">Defines the scope, load parameters, and acceptance criteria for this test run</div>
    </div>
    <div class="section-hdr-bar-right">
      <span class="badge-hdr badge-scenario">${cfg.scenarioType || 'Baseline Load Test'}</span>
      <span class="badge-hdr badge-engine">Server-side Engine</span>
      <span class="badge-hdr ${vd === 'PASS' ? 'badge-verdict-pass' : vd === 'RISK' ? 'badge-verdict-risk' : 'badge-verdict-fail'}">${vd}</span>
    </div>
  </div>

  <div class="section-hdr-bar-body">

    <!-- Row 1: Target & Identity -->
    <div style="border-bottom:1px solid #E5E7EB;padding-bottom:18px;margin-bottom:18px">
      <div style="font-size:10px;font-weight:800;color:#2563EB;text-transform:uppercase;letter-spacing:.09em;margin-bottom:14px;display:flex;align-items:center;gap:6px">
        <span style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:5px;padding:2px 7px;font-size:9px">🎯</span>
        TEST TARGET &amp; IDENTITY
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 2fr;gap:16px;align-items:start">
        <div>
          <div style="font-size:10px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.07em;margin-bottom:5px">Project</div>
          <div style="font-size:16px;font-weight:800;color:#0D1224">${cfg.projectName || '—'}</div>
        </div>
        <div>
          <div style="font-size:10px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.07em;margin-bottom:5px">Environment</div>
          <span class="env-badge">${cfg.environment || '—'}</span>
        </div>
        <div>
          <div style="font-size:10px;font-weight:700;color:#9CA3AF;text-transform:uppercase;letter-spacing:.07em;margin-bottom:5px">Target URL</div>
          <div class="url-box">${cfg.url || (cfg.steps?.[0]?.url) || '—'}</div>
        </div>
      </div>
    </div>

    <!-- Row 2: Load Parameters — colored large-number tiles matching screenshot -->
    <div style="border-bottom:1px solid #E5E7EB;padding-bottom:18px;margin-bottom:18px">
      <div style="font-size:10px;font-weight:800;color:#2563EB;text-transform:uppercase;letter-spacing:.09em;margin-bottom:14px;display:flex;align-items:center;gap:6px">
        <span style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:5px;padding:2px 7px;font-size:9px">⚡</span>
        LOAD PARAMETERS
      </div>
      <div class="lparam-grid">
        <div class="lparam lparam-blue">
          <div class="lparam-val">${cfg.vus}</div>
          <div class="lparam-lbl">Virtual Users</div>
          <div class="lparam-sub">concurrent</div>
        </div>
        <div class="lparam lparam-green">
          <div class="lparam-val">${cfg.duration}<span class="lparam-val-unit">s</span></div>
          <div class="lparam-lbl">Duration</div>
          <div class="lparam-sub">test window</div>
        </div>
        <div class="lparam lparam-amber">
          <div class="lparam-val">${cfg.rampup || 0}<span class="lparam-val-unit">s</span></div>
          <div class="lparam-lbl">Ramp-up</div>
          <div class="lparam-sub">warm-up period</div>
        </div>
        <div class="lparam lparam-purple">
          <div class="lparam-val">${cfg.steps && cfg.steps.filter(s=>s.enabled!==false).length > 0 ? cfg.steps.filter(s=>s.enabled!==false).length : 1}</div>
          <div class="lparam-lbl">API Steps</div>
          <div class="lparam-sub">per VU flow</div>
        </div>
      </div>
    </div>

    <!-- Row 3: Acceptance Thresholds -->
    <div style="border-bottom:1px solid #E5E7EB;padding-bottom:18px;margin-bottom:18px">
      <div style="font-size:10px;font-weight:800;color:#2563EB;text-transform:uppercase;letter-spacing:.09em;margin-bottom:14px;display:flex;align-items:center;gap:6px">
        <span style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:5px;padding:2px 7px;font-size:9px">📏</span>
        ACCEPTANCE THRESHOLDS &amp; ACTUALS
      </div>
      <div class="thresh-grid">
        <div class="thresh">
          <div class="thresh-lbl">P95 Latency Threshold</div>
          <div class="thresh-val" style="color:${p95ms <= p95Thr ? '#059669' : '#DC2626'}">${p95ms}<span style="font-size:13px;font-weight:600">ms</span></div>
          <div class="thresh-limit">limit: ${cfg.p95Threshold || 3000}ms</div>
          <div class="thresh-progress"><div class="thresh-bar" style="width:${Math.min(100,(p95ms/(cfg.p95Threshold||3000))*100).toFixed(1)}%;background:${p95ms <= p95Thr ? '#10B981' : '#EF4444'}"></div></div>
          <div class="thresh-status ${p95ms <= p95Thr ? 'thresh-ok' : 'thresh-bad'}">${p95ms <= p95Thr ? '✓ WITHIN THRESHOLD' : '✗ THRESHOLD BREACHED'}</div>
        </div>
        <div class="thresh">
          <div class="thresh-lbl">Error Rate Limit</div>
          <div class="thresh-val" style="color:${errPct < 1 ? '#059669' : errPct < 5 ? '#D97706' : '#DC2626'}">${errRateDisp}<span style="font-size:13px;font-weight:600">%</span></div>
          <div class="thresh-limit">limit: &lt;1%</div>
          <div class="thresh-progress"><div class="thresh-bar" style="width:${Math.min(100,errPct*10).toFixed(1)}%;background:${errPct < 1 ? '#10B981' : errPct < 5 ? '#F59E0B' : '#EF4444'}"></div></div>
          <div class="thresh-status ${errPct < 1 ? 'thresh-ok' : errPct < 5 ? 'thresh-warn' : 'thresh-bad'}">${errPct < 1 ? '✓ WITHIN LIMIT' : errPct < 5 ? '⚠ APPROACHING LIMIT' : '✗ LIMIT BREACHED'}</div>
        </div>
        <div class="thresh">
          <div class="thresh-lbl">Request Timeout</div>
          <div class="thresh-val" style="color:#0D1224">${cfg.timeout || 5000}<span style="font-size:13px;font-weight:600">ms</span></div>
          <div class="thresh-limit">Per-request hard timeout</div>
        </div>
        <div class="thresh">
          <div class="thresh-lbl">Total Requests Executed</div>
          <div class="thresh-val" style="color:#2563EB">${(m.totalReqs || 0).toLocaleString()}</div>
          <div class="thresh-limit">${m.rps || 0} avg RPS</div>
        </div>
      </div>
    </div>

    <!-- Row 4: Timing -->
    <div>
      <div style="font-size:10px;font-weight:800;color:#2563EB;text-transform:uppercase;letter-spacing:.09em;margin-bottom:14px;display:flex;align-items:center;gap:6px">
        <span style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:5px;padding:2px 7px;font-size:9px">🕐</span>
        TEST EXECUTION WINDOW
      </div>
      <div class="exec-grid">
        <div class="exec-cell">
          <div class="exec-cell-icon" style="background:#EFF6FF">🕐</div>
          <div>
            <div class="exec-cell-lbl">Start Time</div>
            <div class="exec-cell-val">${cfg.startTime ? new Date(cfg.startTime).toLocaleString('en-IN') : '—'}</div>
          </div>
        </div>
        <div class="exec-cell">
          <div class="exec-cell-icon" style="background:#ECFDF5">🕐</div>
          <div>
            <div class="exec-cell-lbl">End Time</div>
            <div class="exec-cell-val">${state.endTime ? new Date(state.endTime).toLocaleString('en-IN') : '—'}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:36px;height:36px;background:#fefce8;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
          </div>
          <div>
            <div style="font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.4px">Actual Duration</div>
            <div style="font-size:12px;font-weight:700;color:#1e293b">${dur}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:36px;height:36px;background:#fdf4ff;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9333ea" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          </div>
          <div>
            <div style="font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.4px">Executed By</div>
            <div style="font-size:12px;font-weight:700;color:#1e293b">${preparedBy}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>` : ''}

${show('showServerConfig') ? (() => {
    const envKey = _serverEnvKey;
    const sc = _serverCfgForRun;
    const rec = serverRec; // computed once at the top of _generateHtml — see _serverEnvKey/_serverCfgForRun
    const recColor = rec.level === 'upgrade' ? '#DC2626' : rec.level === 'watch' ? '#D97706' : rec.level === 'ok' ? '#059669' : '#6B7280';
    const recBg    = rec.level === 'upgrade' ? '#FEF2F2' : rec.level === 'watch' ? '#FFFBEB' : rec.level === 'ok' ? '#F0FDF4' : '#F3F4F6';
    const recIcon  = rec.level === 'upgrade' ? '🔺' : rec.level === 'watch' ? '⚠️' : rec.level === 'ok' ? '✅' : 'ℹ️';

    const specTile = (label, val, icon) => `
      <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:10px;padding:12px;text-align:center">
        <div style="font-size:16px">${icon}</div>
        <div style="font-size:15px;font-weight:800;color:#0D1224;margin-top:4px">${val}</div>
        <div style="font-size:9px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:.4px;margin-top:2px">${label}</div>
      </div>`;

    const serverCard = sc ? `
      <div style="border:1px solid #E5E7EB;border-radius:12px;padding:16px;margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
          <span class="env-badge" style="${envKey==='production' ? 'background:#FEF2F2;color:#DC2626;border-color:#FECACA' : ''}">${envKey === 'production' ? 'PRODUCTION' : 'STAGING'}</span>
          <span style="font-size:13px;font-weight:800;color:#0D1224">${sc.serverName || '—'}</span>
          <span style="margin-left:auto;font-size:10px;font-weight:700;color:${sc.status==='Running'?'#059669':'#DC2626'}">● ${sc.status || 'Unknown'}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px">
          ${specTile('Cloud', sc.cloudProvider || '—', '☁️')}
          ${specTile('Instance Type', sc.instanceType || '—', '🖥️')}
          ${specTile('vCPU', sc.vcpu || '—', '⚙️')}
          ${specTile('Memory', sc.memoryGb ? sc.memoryGb + ' GB' : '—', '🧠')}
          ${specTile('Storage', sc.storageGb ? sc.storageGb + ' GB' : '—', '💾')}
          ${specTile('OS', sc.os || '—', '🐧')}
          ${specTile('Region', sc.region || '—', '🌍')}
          ${specTile('Elastic IP', sc.elasticIp ? 'Yes' : 'No', '📌')}
        </div>
        <div style="margin-top:10px;font-size:11px;color:#64748B">Public IP: <strong style="color:#334155">${sc.publicIp || '—'}</strong></div>
      </div>` : `
      <div style="border:1px solid #FCD34D;background:#FFFBEB;border-radius:10px;padding:14px 16px;margin-bottom:14px;display:flex;align-items:flex-start;gap:10px">
        <span style="font-size:16px;line-height:1">⚠️</span>
        <div>
          <div style="font-size:12px;font-weight:800;color:#92400E;text-transform:uppercase;letter-spacing:.4px">WARNING</div>
          <div style="font-size:12.5px;color:#78350F;margin-top:3px;line-height:1.6">No server configuration found for <strong>${cfg.projectName || 'this project'} / ${envKey === 'production' ? 'Production' : 'Staging'}</strong>. Please add a server configuration in Server Config. No CPU, RAM, instance type, region, or capacity/scaling figures are shown below because none are on file for this project + environment — they are never estimated or fabricated.</div>
        </div>
      </div>`;

    // ── "What This Configuration Means" — plain-language capacity explanation ──
    const ce = rec.configExplanation;
    const archLine = (label, present) => `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:3px 9px;border-radius:12px;background:${present ? '#F0FDF4' : '#FEF2F2'};color:${present ? '#166534' : '#991B1B'};border:1px solid ${present ? '#BBF7D0' : '#FECACA'}">${present ? '✓' : '✗'} ${label}</span>`;
    const configExplanationHtml = ce ? `
      <div style="margin-top:14px;border:1px solid #E5E7EB;border-radius:10px;padding:14px 16px">
        <div style="font-size:11px;font-weight:800;color:#0D1224;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">📋 What This Configuration Means</div>
        <div style="font-size:12px;color:#374151;margin-bottom:10px;line-height:1.6">
          Current setup: <strong>${ce.instanceType}</strong>, single instance, ${[
            archLine('Load Balancer', ce.archFlags.loadBalancer),
            archLine('Read Replica', ce.archFlags.readReplica),
            archLine('Cache Layer', ce.archFlags.cacheLayer),
            archLine('Auto-scaling', ce.archFlags.autoScaling),
          ].join(' ')}
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin-bottom:12px">
          <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;padding:10px 12px">
            <div style="font-size:10px;font-weight:800;color:#166534">✅ Comfortably supports</div>
            <div style="font-size:13px;font-weight:800;color:#0D1224;margin-top:3px">up to ~${ce.comfortableMaxVUs.toLocaleString()} concurrent VUs</div>
          </div>
          <div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:10px 12px">
            <div style="font-size:10px;font-weight:800;color:#92400E">⚠️ Tested &amp; at-risk zone</div>
            <div style="font-size:13px;font-weight:800;color:#0D1224;margin-top:3px">${ce.atRiskLow.toLocaleString()}–${ce.atRiskHigh.toLocaleString()} VUs</div>
          </div>
          <div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:10px 12px">
            <div style="font-size:10px;font-weight:800;color:#991B1B">✗ Will fail without changes</div>
            <div style="font-size:13px;font-weight:800;color:#0D1224;margin-top:3px">above ~${ce.failsAt.toLocaleString()} VUs</div>
          </div>
        </div>
        <div style="font-size:11px;font-weight:800;color:#0D1224;text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px">Why it caps out here</div>
        <ul style="margin:0;padding-left:18px;font-size:12px;color:#374151;line-height:1.8">
          ${ce.reasons.map(r => `<li>${r}</li>`).join('')}
        </ul>
      </div>` : '';

    // ── Root cause of failure/degradation (only rendered when something is actually wrong) ──
    const rootCauseSevColor = { critical: '#DC2626', high: '#DC2626', medium: '#D97706', info: '#2563EB' };
    const rootCauseHtml = (rec.rootCauses || []).length ? `
      <div style="margin-top:14px">
        <div style="font-size:11px;font-weight:800;color:#0D1224;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">🔍 Root Cause Analysis</div>
        ${rec.rootCauses.map(c => `
          <div style="border-left:3px solid ${rootCauseSevColor[c.severity] || '#6B7280'};background:#F8FAFC;border-radius:0 8px 8px 0;padding:10px 14px;margin-bottom:8px">
            <div style="font-size:12px;font-weight:800;color:#0D1224">${c.title}</div>
            <div style="font-size:11.5px;color:#475569;margin-top:4px;line-height:1.6">${c.detail}</div>
          </div>`).join('')}
      </div>` : '';

    // ── Capacity table: which VU levels are likely to pass on this server ──
    // Tested rows get a solid border + stronger fill (matches existing report card
    // treatment); projected rows use a dashed border + lighter fill — the visual
    // distinction this feature requires, built from the app's existing design
    // system (same border/radius/color tokens used throughout this report) rather
    // than an unrelated new style.
    const fmtPct = (v) => v === null || v === undefined ? 'N/A' : `${v.toFixed(0)}%`;
    const capacityTableHtml = (rec.capacityTable || []).length ? `
      <div style="margin-top:14px">
        <div style="font-size:11px;font-weight:800;color:#0D1224;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">📐 Estimated Capacity by Virtual Users</div>
        <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:11.5px;min-width:640px">
          <thead>
            <tr style="border-bottom:2px solid #E5E7EB">
              <th style="text-align:left;padding:6px 8px;color:#64748B;font-weight:800;text-transform:uppercase;font-size:9.5px">VU Level</th>
              <th style="text-align:left;padding:6px 8px;color:#64748B;font-weight:800;text-transform:uppercase;font-size:9.5px">Data Type</th>
              <th style="text-align:center;padding:6px 8px;color:#64748B;font-weight:800;text-transform:uppercase;font-size:9.5px">CPU</th>
              <th style="text-align:center;padding:6px 8px;color:#64748B;font-weight:800;text-transform:uppercase;font-size:9.5px">RAM</th>
              <th style="text-align:center;padding:6px 8px;color:#64748B;font-weight:800;text-transform:uppercase;font-size:9.5px">P95 Latency</th>
              <th style="text-align:center;padding:6px 8px;color:#64748B;font-weight:800;text-transform:uppercase;font-size:9.5px">Error Rate</th>
              <th style="text-align:center;padding:6px 8px;color:#64748B;font-weight:800;text-transform:uppercase;font-size:9.5px">Verdict</th>
            </tr>
          </thead>
          <tbody>
            ${rec.capacityTable.map(row => {
              // Beyond the model's sane extrapolation range (>20x the tested VU count),
              // show a qualitative label instead of a numeric CPU%/latency figure — a
              // projection this far past the last validated data point is not a
              // meaningful estimate, and printing a fake-precise number (or worse, a
              // clamped value identical across multiple tiers) misrepresents it as one.
              const cpuCell = row.beyondModelRange
                  ? `<span style="font-weight:800;color:#DC2626">⚠ Beyond model range</span>`
                  : `<span style="color:${row.cpuNA ? '#94A3B8' : row.cpuPercent > 100 ? '#DC2626' : row.cpuPercent >= 70 ? '#D97706' : '#059669'};font-weight:700">${row.cpuNA ? 'N/A' : fmtPct(row.cpuPercent)}</span>`;
              const p95Cell = row.beyondModelRange
                  ? `<span style="color:#94A3B8;font-style:italic">Severe overload expected — not load-tested</span>`
                  : `${row.p95NA ? 'N/A' : row.p95 + 'ms'}${!row.isTested && !row.p95NA ? ' <span style="font-size:8px;color:#94A3B8">(est.)</span>' : ''}`;
              return `
            <tr style="border-bottom:1px solid ${row.isTested ? '#CBD5E1' : '#F1F5F9'};background:${row.isTested ? '#F8FAFC' : row.beyondModelRange ? '#FAFAFA' : '#FFFFFF'};border-left:3px ${row.isTested ? 'solid #334155' : 'dashed #CBD5E1'}">
              <td style="padding:8px;font-weight:800;color:#0D1224">${row.vus.toLocaleString()}</td>
              <td style="padding:8px">
                <span style="font-size:9px;font-weight:800;padding:2px 7px;border-radius:5px;${row.isTested ? 'background:#0D1224;color:#fff' : 'background:#F1F5F9;color:#64748B;border:1px dashed #CBD5E1'}">${row.isTested ? '● TESTED' : '○ PROJECTED'}</span>
              </td>
              <td style="padding:8px;text-align:center;font-size:${row.beyondModelRange ? '9.5px' : '11.5px'}">${cpuCell}</td>
              <td style="padding:8px;text-align:center;color:#94A3B8">${row.ramNA ? 'N/A' : fmtPct(row.ramPercent)}</td>
              <td style="padding:8px;text-align:center;color:#334155;font-size:${row.beyondModelRange ? '9.5px' : '11.5px'}">${p95Cell}</td>
              <td style="padding:8px;text-align:center;color:#334155">${row.errorRateNA ? 'N/A' : row.errorRatePct.toFixed(2) + '%'}</td>
              <td style="padding:8px;text-align:center"><span style="font-size:9.5px;font-weight:800;color:${row.verdictColor}">${row.verdict}</span></td>
            </tr>`;
            }).join('')}
          </tbody>
        </table>
        </div>
        <div style="font-size:9px;color:#94A3B8;margin-top:6px">RAM shown as N/A: no RAM-utilization monitoring is wired into this test runner — RAM is never estimated or fabricated. P95 marked "(est.)" is a projection from a documented linear-with-saturation model, not a measurement. Rows marked "Beyond model range" are more than ${CAPACITY_VERDICT_THRESHOLDS.retestBeyondMultipleOfTestedVus}× the tested VU count — far enough past validated data that a numeric estimate would be misleading; expect severe overload/service collapse, not a specific latency figure.</div>
      </div>` : '';

    // ── Scaling Recommendation Path ──
    const scalingPathHtml = rec.scalingPath ? `
      <div style="margin-top:14px;border:1px solid #E5E7EB;border-radius:10px;padding:14px 16px">
        <div style="font-size:11px;font-weight:800;color:#0D1224;text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">🛣️ Scaling Recommendation Path</div>
        <div style="font-size:12px;color:#374151;margin-bottom:10px">
          Current: <strong>${rec.scalingPath.currentInstanceType}</strong> — comfortable up to ~<strong>${rec.scalingPath.comfortableMaxVUs.toLocaleString()} VUs</strong>. Validated test: <strong>${rec.scalingPath.targetVus.toLocaleString()} VUs</strong>.
        </div>
        ${rec.scalingPath.steps.map(s => `
          <div style="display:flex;gap:10px;align-items:baseline;padding:6px 0;border-top:1px dashed #E5E7EB">
            <div style="font-size:11px;font-weight:800;color:#64748B;white-space:nowrap;min-width:120px">${s.rangeLow.toLocaleString()}–${s.rangeHigh.toLocaleString()} VUs</div>
            <div style="font-size:12px;color:#0D1224">→ <strong>${s.recommendation}</strong> <span style="color:#94A3B8;font-size:10px">(${s.note})</span></div>
          </div>`).join('')}
        ${rec.scalingPath.highScaleWarnings.length ? `
        <div style="margin-top:12px;background:#FFFBEB;border:1px solid #FCD34D;border-radius:8px;padding:10px 12px">
          <div style="font-size:10.5px;font-weight:800;color:#92400E;text-transform:uppercase;letter-spacing:.3px;margin-bottom:6px">⚠️ At this scale, CPU is not necessarily the primary bottleneck</div>
          <ul style="margin:0;padding-left:18px;font-size:11px;color:#78350F;line-height:1.7">
            ${rec.scalingPath.highScaleWarnings.map(w => `<li>${w}</li>`).join('')}
          </ul>
        </div>` : ''}
      </div>` : '';

    // ── Mandatory capacity disclaimer (always shown alongside a capacity table) ──
    const capacityDisclaimerHtml = (rec.capacityTable || []).length ? `
      <div style="margin-top:10px;font-size:10px;color:#94A3B8;line-height:1.6;border-top:1px solid #F1F5F9;padding-top:8px">
        <strong>Disclaimer:</strong> Capacity values above the highest load-tested level are projections, not validated production capacity. Extrapolation is not a guarantee. Actual capacity may be limited by database connections, network throughput, disk I/O, file descriptors, external dependencies, connection pools, or other application/infrastructure bottlenecks before CPU reaches its estimated limit. Re-test at each scaling tier before treating the result as validated capacity.
      </div>` : '';

    return `
<!-- SERVER CONFIGURATION -->
<div class="section-hdr-bar" style="margin-bottom:20px">
  <div class="section-hdr-bar-inner">
    <div class="section-hdr-bar-icon">🖥️</div>
    <div>
      <div class="section-hdr-bar-title">Server Configuration</div>
      <div class="section-hdr-bar-sub">Infrastructure specs for the environment under test, with a sizing recommendation based on observed results</div>
    </div>
  </div>
  <div class="section-hdr-bar-body">
    ${serverCard}
    <div style="background:${recBg};border:1px solid ${recColor}33;border-radius:10px;padding:14px 16px;margin-top:4px">
      <div style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:800;color:${recColor}">${recIcon} ${rec.title}</div>
      <div style="font-size:12px;color:#374151;margin-top:6px;line-height:1.6">${rec.detail}</div>
    </div>
    ${configExplanationHtml}
    ${rootCauseHtml}
    ${capacityTableHtml}
    ${capacityDisclaimerHtml}
    ${scalingPathHtml}
  </div>
</div>`;
})() : ''}

${show('showMetricCards') ? `
<!-- KEY METRICS -->
<div class="section-hdr-bar" style="margin-bottom:20px">
  <div class="section-hdr-bar-inner">
    <div class="section-hdr-bar-icon">📊</div>
    <div>
      <div class="section-hdr-bar-title">Key Metrics</div>
      <div class="section-hdr-bar-sub">Full performance measurement across the entire test run</div>
    </div>
  </div>
  <div class="section-hdr-bar-body">
    <!-- Row 1: Requests & Reliability -->
    <div style="font-size:10px;font-weight:800;color:#3b82f6;text-transform:uppercase;letter-spacing:.8px;margin-bottom:10px">Requests &amp; Reliability</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:20px">
      <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:900;color:#0369a1">${m.totalReqs||0}</div>
        <div style="font-size:10px;font-weight:700;color:#0284c7;text-transform:uppercase;letter-spacing:.4px;margin-top:4px">Total Requests</div>
      </div>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:900;color:#15803d">${m.okReqs||0}</div>
        <div style="font-size:10px;font-weight:700;color:#16a34a;text-transform:uppercase;letter-spacing:.4px;margin-top:4px">Successful</div>
      </div>
      <div style="background:${(m.errReqs||0)>0?'#fff1f2':'#f0fdf4'};border:1px solid ${(m.errReqs||0)>0?'#fecdd3':'#bbf7d0'};border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:900;color:${(m.errReqs||0)>0?'#dc2626':'#15803d'}">${m.errReqs||0}</div>
        <div style="font-size:10px;font-weight:700;color:${(m.errReqs||0)>0?'#ef4444':'#16a34a'};text-transform:uppercase;letter-spacing:.4px;margin-top:4px">Failures</div>
      </div>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:900;color:#15803d">${successRate}%</div>
        <div style="font-size:10px;font-weight:700;color:#16a34a;text-transform:uppercase;letter-spacing:.4px;margin-top:4px">Success Rate</div>
      </div>
      <div style="background:#fdf4ff;border:1px solid #e9d5ff;border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:900;color:#7e22ce">${m.rps||0}</div>
        <div style="font-size:10px;font-weight:700;color:#9333ea;text-transform:uppercase;letter-spacing:.4px;margin-top:4px">Avg RPS</div>
      </div>
    </div>
    <!-- Row 2: Latency Distribution -->
    <div style="font-size:10px;font-weight:800;color:#3b82f6;text-transform:uppercase;letter-spacing:.8px;margin-bottom:10px">Latency Distribution</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(115px,1fr));gap:10px;margin-bottom:20px">
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:900;color:#15803d">${m.minLatency||0}ms</div>
        <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.4px;margin-top:4px">Min</div>
      </div>
      <div style="background:#fefce8;border:1px solid #fde68a;border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:900;color:#b45309">${m.avgLatency||0}ms</div>
        <div style="font-size:10px;font-weight:700;color:#d97706;text-transform:uppercase;letter-spacing:.4px;margin-top:4px">Average</div>
      </div>
      <div style="background:#fefce8;border:1px solid #fde68a;border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:900;color:#b45309">${m.p50||0}ms</div>
        <div style="font-size:10px;font-weight:700;color:#d97706;text-transform:uppercase;letter-spacing:.4px;margin-top:4px">P50</div>
      </div>
      <div style="background:#fefce8;border:1px solid #fde68a;border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:900;color:#b45309">${m.p90||0}ms</div>
        <div style="font-size:10px;font-weight:700;color:#d97706;text-transform:uppercase;letter-spacing:.4px;margin-top:4px">P90</div>
      </div>
      <div style="background:${p95ms<=p95Thr?'#eff6ff':'#fff1f2'};border:1px solid ${p95ms<=p95Thr?'#bfdbfe':'#fecdd3'};border-radius:10px;padding:14px;text-align:center;position:relative">
        <div style="font-size:22px;font-weight:900;color:${p95ms<=p95Thr?'#1d4ed8':'#dc2626'}">${m.p95||0}ms</div>
        <div style="font-size:10px;font-weight:700;color:${p95ms<=p95Thr?'#2563eb':'#ef4444'};text-transform:uppercase;letter-spacing:.4px;margin-top:4px">P95 ★</div>
        <div style="font-size:9px;color:#94a3b8;margin-top:2px">SLA limit</div>
      </div>
      <div style="background:#fdf4ff;border:1px solid #e9d5ff;border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:900;color:#7e22ce">${m.p99||0}ms</div>
        <div style="font-size:10px;font-weight:700;color:#9333ea;text-transform:uppercase;letter-spacing:.4px;margin-top:4px">P99</div>
      </div>
      <div style="background:#fff1f2;border:1px solid #fecdd3;border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:900;color:#dc2626">${m.maxLatency||0}ms</div>
        <div style="font-size:10px;font-weight:700;color:#ef4444;text-transform:uppercase;letter-spacing:.4px;margin-top:4px">Max</div>
      </div>
    </div>
    <!-- Row 3: Network & Duration -->
    <div style="font-size:10px;font-weight:800;color:#3b82f6;text-transform:uppercase;letter-spacing:.8px;margin-bottom:10px">Network &amp; Duration</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px">
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:900;color:#0369a1">${dur}</div>
        <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.4px;margin-top:4px">Duration</div>
      </div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:900;color:#b45309">${fmtBytes(m.dataSent||0)}</div>
        <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.4px;margin-top:4px">Data Sent</div>
      </div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;text-align:center">
        <div style="font-size:22px;font-weight:900;color:#b45309">${fmtBytes(m.dataRecv||0)}</div>
        <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.4px;margin-top:4px">Data Received</div>
      </div>
    </div>
  </div>
</div>` : ''}

${show('showCharts') ? `
<!-- CHARTS -->
<div class="section-hdr-bar" style="margin-bottom:20px">
  <div class="section-hdr-bar-inner">
    <div class="section-hdr-bar-icon">📈</div>
    <div>
      <div class="section-hdr-bar-title">Performance Charts</div>
      <div class="section-hdr-bar-sub">Time-series and distribution data across the test window</div>
    </div>
  </div>
  <div class="section-hdr-bar-body">
    <div class="chart-grid">
      <div class="chart-box"><h4>RPS over Time</h4><canvas id="ch-rps" height="140"></canvas></div>
      <div class="chart-box"><h4>Avg Latency (ms) over Time</h4><canvas id="ch-lat" height="140"></canvas></div>
      <div class="chart-box"><h4>Error Rate (%) over Time</h4><canvas id="ch-err" height="140"></canvas></div>
      <div class="chart-box"><h4>Active Users over Time</h4><canvas id="ch-vus" height="140"></canvas></div>
      <div class="chart-box"><h4>Status Code Distribution</h4><canvas id="ch-sc" height="140"></canvas></div>
      <div class="chart-box"><h4>Success vs Failure</h4><canvas id="ch-sf" height="140"></canvas></div>
    </div>
  </div>
</div>` : ''}

${scRows && show('showErrorSummary') ? `
<!-- STATUS CODE DISTRIBUTION -->
<div style="background:#fff;border-radius:14px;margin-bottom:20px;box-shadow:0 4px 24px rgba(30,41,59,.10);border:1px solid #e2e8f0;overflow:hidden">
  <div style="background:linear-gradient(90deg,#0f172a,#1e293b,#334155);padding:14px 28px;display:flex;align-items:center;gap:12px">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
    <div style="font-size:14px;font-weight:800;color:#fff">Status Code Distribution</div>
    <div style="font-size:11px;color:#94a3b8;margin-left:4px">HTTP response codes returned across all requests</div>
  </div>
  <div style="padding:20px 28px">
    <table style="width:100%;border-collapse:collapse">
      <thead><tr>
        <th style="padding:10px 14px;background:#f8fafc;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#3b82f6;text-align:left;border-bottom:2px solid #e2e8f0">Status Code</th>
        <th style="padding:10px 14px;background:#f8fafc;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#3b82f6;text-align:left;border-bottom:2px solid #e2e8f0">Count</th>
        <th style="padding:10px 14px;background:#f8fafc;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#3b82f6;text-align:left;border-bottom:2px solid #e2e8f0">Percentage</th>
      </tr></thead>
      <tbody>${scRows}</tbody>
    </table>
  </div>
</div>` : ''}

${show('showTimeline') ? `
<!-- TIMELINE -->
<div style="background:#fff;border-radius:14px;margin-bottom:20px;box-shadow:0 4px 24px rgba(30,41,59,.10);border:1px solid #e2e8f0;overflow:hidden">
  <div style="background:linear-gradient(90deg,#0f172a,#1e293b,#334155);padding:14px 28px;display:flex;align-items:center;gap:12px">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
    <div style="font-size:14px;font-weight:800;color:#fff">Test Timeline</div>
    <div style="font-size:11px;color:#94a3b8;margin-left:4px">Key lifecycle events during test execution</div>
  </div>
  <div style="padding:20px 28px">
    <table style="width:100%;border-collapse:collapse">
      <thead><tr>
        <th style="padding:10px 14px;background:#f8fafc;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#3b82f6;text-align:left;border-bottom:2px solid #e2e8f0">Time</th>
        <th style="padding:10px 14px;background:#f8fafc;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#3b82f6;text-align:left;border-bottom:2px solid #e2e8f0">Phase</th>
        <th style="padding:10px 14px;background:#f8fafc;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#3b82f6;text-align:left;border-bottom:2px solid #e2e8f0">Event</th>
      </tr></thead>
      <tbody>${tlRows}</tbody>
    </table>
  </div>
</div>` : ''}

${vuRequestLogHtml ? `
<!-- VU REQUEST/RESPONSE LOG — highlighted sensitive section -->
<div class="log-section" id="vu-log-section">
  <h2>🔬 Load Request &amp; Response Log
    <span style="margin-left:8px;font-size:11px;font-weight:600;background:#fef3c7;color:#92400e;padding:2px 10px;border-radius:20px;border:1px solid #fde68a">⚠ SENSITIVE</span>
  </h2>
  <div class="log-section-banner">
    <span>
      <strong>⚠ Security Notice:</strong> This section contains raw API request &amp; response payloads including encrypted data.
      Share only with authorised personnel. Use <em>Download Without Logs</em> for external distribution.
    </span>
    <span style="display:flex;gap:8px;flex-shrink:0">
      <button class="log-dl-btn log-dl-btn-full" onclick="(function(){var tk=localStorage.getItem('qa_jwt_token')||localStorage.getItem('qa_token')||'';window.open('/api/load-test/report/${state.runId}/download?logs=1&token='+encodeURIComponent(tk),'_blank');})()">
        📥 Download With Logs
      </button>
      <button class="log-dl-btn log-dl-btn-clean" onclick="(function(){var tk=localStorage.getItem('qa_jwt_token')||localStorage.getItem('qa_token')||'';window.open('/api/load-test/report/${state.runId}/download?logs=0&token='+encodeURIComponent(tk),'_blank');})()">
        📄 Download Without Logs
      </button>
    </span>
  </div>
  <p style="font-size:13px;color:#78350f;margin-bottom:16px">
    Full request and response for every step executed by each Virtual User.
    Each step shows: <strong style="color:#0369a1">Plain (decrypted) request</strong> ·
    <strong style="color:#7c3aed">Encrypted request sent to API</strong> ·
    <strong style="color:#065f46">Raw API response</strong>.
  </p>
  ${vuRequestLogHtml}
</div>` : ''}

${show('showTimeline') && logRows ? `
<!-- ACTIVITY LOG -->
<div style="background:#fff;border-radius:14px;margin-bottom:20px;box-shadow:0 4px 24px rgba(30,41,59,.10);border:1px solid #e2e8f0;overflow:hidden">
  <div style="background:linear-gradient(90deg,#0f172a,#1e293b,#334155);padding:14px 28px;display:flex;align-items:center;gap:12px">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
    <div style="font-size:14px;font-weight:800;color:#fff">Activity Log</div>
    <div style="font-size:11px;color:#94a3b8;margin-left:4px">Last 20 entries from the test engine during execution</div>
  </div>
  <div style="padding:20px 28px">
    <table style="width:100%;border-collapse:collapse">
      <thead><tr>
        <th style="padding:10px 14px;background:#f8fafc;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#3b82f6;text-align:left;border-bottom:2px solid #e2e8f0">Time</th>
        <th style="padding:10px 14px;background:#f8fafc;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#3b82f6;text-align:left;border-bottom:2px solid #e2e8f0">Phase</th>
        <th style="padding:10px 14px;background:#f8fafc;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#3b82f6;text-align:left;border-bottom:2px solid #e2e8f0">Message</th>
      </tr></thead>
      <tbody>${logRows}</tbody>
    </table>
  </div>
</div>` : ''}

${show('showRecommendations') ? `
<!-- QA RECOMMENDATION — Enterprise -->
<div style="background:#fff;border-radius:14px;margin-bottom:20px;box-shadow:0 4px 24px rgba(30,41,59,.10);border:2px solid ${recColor}55;overflow:hidden">

  <!-- Header -->
  <div style="background:linear-gradient(90deg,${vd==='PASS'?'#064e3b,#065f46,#047857':vd==='RISK'?'#78350f,#92400e,#b45309':'#7f1d1d,#991b1b,#b91c1c'} 100%);padding:16px 28px;display:flex;align-items:center;gap:14px">
    <div style="background:rgba(255,255,255,.15);border-radius:8px;padding:8px 10px;flex-shrink:0">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 0 2-2h11"/></svg>
    </div>
    <div>
      <div style="font-size:15px;font-weight:800;color:#fff">Recommendation</div>
      <div style="font-size:11px;color:rgba(255,255,255,.65);margin-top:2px">ISTQB / CPTPA certified performance tester analysis</div>
    </div>
    <div style="margin-left:auto">
      <span style="background:rgba(255,255,255,.15);color:#fff;padding:6px 16px;border-radius:20px;font-size:12px;font-weight:800;border:1.5px solid rgba(255,255,255,.4);letter-spacing:.3px">${qaRec}</span>
    </div>
  </div>

  <!-- Content -->
  <div style="padding:24px 28px;font-size:13px;line-height:1.85;color:#1e293b">
    ${recText}
    ${(() => {
        const onb = serverRec.onboardingRecommendation;
        if (!onb) return '';
        const phaseLabel = { immediate: 'Immediate (this week) — before any onboarding', shortTerm: 'Short-term (before 1,000 users)', mediumTerm: 'Medium-term (to sustain 1,000-10,000+ users)' };
        const phaseOrder = ['immediate', 'shortTerm', 'mediumTerm'];
        return `
    <div style="margin-top:24px;border:2px solid #4338CA33;border-radius:12px;overflow:hidden">
      <div style="background:linear-gradient(90deg,#312e81,#4338ca,#4f46e5);padding:14px 20px">
        <div style="font-size:14px;font-weight:800;color:#fff">🚀 If Onboarding 1,000-10,000+ Concurrent Users</div>
        <div style="font-size:11px;color:rgba(255,255,255,.7);margin-top:2px">Capacity/architecture planning — distinct from this run's bug triage above</div>
      </div>
      <div style="padding:18px 20px;background:#fff">
        <div style="font-size:12.5px;color:#1e293b;margin-bottom:16px;padding:10px 14px;background:#FEF2F2;border:1px solid #FECACA;border-radius:8px">
          <strong>Bottom line:</strong> current infrastructure (single ${onb.currentInstanceType}, comfortable to ~${onb.comfortableMaxVUs.toLocaleString()} VUs) is undersized by roughly ${onb.gapMultiple}× for the 1,000+ range. This is a capacity/architecture gap, not a bug to patch — treat it as a scaling project, not a hotfix.
        </div>
        ${phaseOrder.filter(p => onb.actionsByPhase[p].length).map((p, idx) => `
        <div style="margin-bottom:14px">
          <div style="font-size:11px;font-weight:800;color:#4338CA;text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px">${phaseLabel[p]}</div>
          <ol style="margin:0;padding-left:20px;font-size:12.5px;color:#374151;line-height:1.9">
            ${onb.actionsByPhase[p].map(a => `<li>${a.text} <span style="font-size:10px;color:#94A3B8">— ${a.owner}, ${a.timeline}</span></li>`).join('')}
          </ol>
        </div>`).join('')}
        ${onb.highScaleWarnings.length ? `
        <div style="margin-top:14px;background:#FFFBEB;border:1px solid #FCD34D;border-radius:8px;padding:10px 14px">
          <div style="font-size:10.5px;font-weight:800;color:#92400E;text-transform:uppercase;letter-spacing:.3px;margin-bottom:6px">⚠️ At this scale, CPU is not necessarily the primary bottleneck</div>
          <ul style="margin:0;padding-left:18px;font-size:11.5px;color:#78350F;line-height:1.8">
            ${onb.highScaleWarnings.map(w => `<li>${w}</li>`).join('')}
          </ul>
        </div>` : ''}
        <div style="margin-top:14px;font-size:12px;color:#78350F;background:#FFFBEB;border:1px solid #FCD34D;border-radius:8px;padding:10px 14px">⚠️ ${onb.fallbackAdvice}</div>
      </div>
    </div>`;
    })()}
  </div>
</div>

<!-- RELEASE DECISION — Enterprise -->
<div style="background:#fff;border-radius:14px;margin-bottom:20px;box-shadow:0 4px 24px rgba(30,41,59,.10);border:2px solid ${recColor}44;overflow:hidden">

  <!-- Header -->
  <div style="background:linear-gradient(90deg,#0f172a,#1e293b,#334155);padding:16px 28px;display:flex;align-items:center;gap:14px">
    <div style="background:rgba(255,255,255,.12);border-radius:8px;padding:8px 10px;flex-shrink:0">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
    </div>
    <div>
      <div style="font-size:15px;font-weight:800;color:#fff">Release Decision</div>
      <div style="font-size:11px;color:#94a3b8;margin-top:2px">Final go/no-go based on observed metrics vs. acceptance criteria</div>
    </div>
  </div>

  <!-- Decision cards -->
  <div style="padding:20px 28px;display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px">

    <!-- Verdict card -->
    <div style="background:${vd==='PASS'?'linear-gradient(135deg,#d1fae5,#a7f3d0)':vd==='RISK'?'linear-gradient(135deg,#fef3c7,#fde68a)':'linear-gradient(135deg,#fee2e2,#fecaca)'};border:2px solid ${recColor};border-radius:12px;padding:18px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px">
      <div style="font-size:32px">${vd==='PASS'?'✅':vd==='RISK'?'⚠️':'🚫'}</div>
      <div style="font-size:11px;font-weight:700;color:${vdTxt};text-transform:uppercase;letter-spacing:.5px">QA Verdict</div>
      <div style="font-size:16px;font-weight:900;color:${vdTxt}">${qaRec}</div>
    </div>

    <!-- Evidence card -->
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:18px">
      <div style="font-size:10px;font-weight:800;color:#3b82f6;text-transform:uppercase;letter-spacing:.8px;margin-bottom:12px">Evidence</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:12px;color:#64748b">Success Rate</span>
          <span style="font-size:13px;font-weight:800;color:${parseFloat(successRate)>=99?'#15803d':'#dc2626'}">${successRate}%</span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:12px;color:#64748b">Error Rate</span>
          <span style="font-size:13px;font-weight:800;color:${errPct<1?'#15803d':errPct<10?'#b45309':'#dc2626'}">${errRateDisp}%</span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:12px;color:#64748b">P95 Latency</span>
          <span style="font-size:13px;font-weight:800;color:${p95ms<=p95Thr?'#15803d':'#dc2626'}">${p95ms}ms / ${p95Thr}ms</span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:12px;color:#64748b">Total Requests</span>
          <span style="font-size:13px;font-weight:800;color:#1d4ed8">${(m.totalReqs||0).toLocaleString()}</span>
        </div>
      </div>
    </div>

    <!-- Next action card -->
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:18px">
      <div style="font-size:10px;font-weight:800;color:#3b82f6;text-transform:uppercase;letter-spacing:.8px;margin-bottom:12px">Next Action</div>
      <div style="font-size:13px;font-weight:700;color:${recColor};margin-bottom:10px">${vd==='PASS'?'Proceed to release pipeline':'Fix issues and retest'}</div>
      <ul style="margin:0 0 0 16px;padding:0;font-size:12px;color:#475569;line-height:2">
        ${vd==='PASS'
          ? `<li>Archive this report as performance baseline</li>
             <li>Schedule stress test at ${cfg.vus*2}–${cfg.vus*3} VUs before next release</li>
             <li>Monitor production P95 after deployment</li>`
          : vd==='RISK'
          ? `<li>Obtain release manager risk sign-off</li>
             <li>Raise P2 performance defect with this report</li>
             <li>Retest at same VU count after dev fixes</li>`
          : `<li>Raise P1 blocker defect immediately</li>
             <li>Dev team: run 1-VU smoke test first</li>
             <li>Full retest required — no partial retests</li>`}
      </ul>
    </div>
  </div>

  <!-- Footer strip -->
  <div style="background:#f1f5f9;border-top:1px solid #e2e8f0;padding:12px 28px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
    <div style="font-size:11px;color:#64748b">Prepared by: <strong>${preparedBy}</strong> · ${new Date(state.endTime||Date.now()).toLocaleString('en-IN')}</div>
    <div style="font-size:11px;color:#64748b">Standard: <strong>ISTQB Performance Testing · CPTPA Guidelines</strong></div>
  </div>
</div>` : ''}

<!-- REPORT DETAILS (always shown) -->
<div style="background:#fff;border-radius:14px;margin-bottom:20px;box-shadow:0 4px 24px rgba(30,41,59,.10);border:1px solid #e2e8f0;overflow:hidden">
  <div style="background:linear-gradient(90deg,#0f172a,#1e293b,#334155);padding:14px 28px;display:flex;align-items:center;gap:12px">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
    <div style="font-size:14px;font-weight:800;color:#fff">Report Details</div>
    <div style="font-size:11px;color:#94a3b8;margin-left:4px">Sign-off chain and release metadata</div>
  </div>
  <div style="padding:20px 28px">
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px">
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px">
        <div style="font-size:10px;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Prepared By</div>
        <div style="font-size:14px;font-weight:700;color:#0f172a">${preparedBy}</div>
      </div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px">
        <div style="font-size:10px;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Reviewed By</div>
        <div style="font-size:14px;font-weight:700;color:#0f172a">${reviewedBy}</div>
      </div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px">
        <div style="font-size:10px;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Approved By</div>
        <div style="font-size:14px;font-weight:700;color:#0f172a">${approvedBy}</div>
      </div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px">
        <div style="font-size:10px;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Client Name</div>
        <div style="font-size:14px;font-weight:700;color:#0f172a">${clientName}</div>
      </div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px">
        <div style="font-size:10px;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Release Version</div>
        <div style="font-size:14px;font-weight:700;color:#0f172a">${releaseVer}</div>
      </div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px">
        <div style="font-size:10px;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Sprint</div>
        <div style="font-size:14px;font-weight:700;color:#0f172a">${sprintName}</div>
      </div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px">
        <div style="font-size:10px;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Build Number</div>
        <div style="font-size:14px;font-weight:700;color:#0f172a">${buildNumber}</div>
      </div>
      ${remarks ? `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;grid-column:1/-1"><div style="font-size:10px;font-weight:700;color:#3b82f6;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Remarks</div><div style="font-size:13px;font-weight:600;color:#334155">${remarks}</div></div>` : ''}
    </div>
  </div>
</div>

<div style="background:linear-gradient(90deg,#0f172a,#1e293b,#334155);border-radius:14px;margin-top:8px;padding:24px 28px;text-align:center">
  <div style="font-size:22px;font-weight:900;color:#fff;letter-spacing:-.5px;margin-bottom:6px"><span style="color:#60a5fa">Ad</span>Hash Technology</div>
  <div style="font-size:12px;color:#94a3b8;margin-bottom:10px">${footerText}</div>
  <div style="display:inline-block;background:rgba(239,68,68,.15);color:#fca5a5;font-size:11px;font-weight:700;padding:4px 16px;border-radius:20px;border:1px solid rgba(239,68,68,.3);margin-bottom:12px">${confidText}</div>
  <div style="height:1px;background:rgba(255,255,255,.1);margin:12px 0"></div>
  <div style="font-size:11px;color:#64748b">Report ID: <span style="color:#94a3b8;font-family:monospace">${state.runId}</span> &nbsp;·&nbsp; Generated: ${genTime}</div>
</div>

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

// Tests for:
// 1. The capacity-table flat-lining bug fix — CPU%/P95 must stay distinguishable
//    at every VU tier instead of collapsing to an identical clamped value once
//    saturation exceeds the old hard cap.
// 2. "What This Configuration Means" (buildConfigExplanation) — plain-language
//    capacity explanation tied to real server config + architecture flags.
// 3. "If Onboarding 1,000-10,000+ Concurrent Users" (buildOnboardingRecommendation)
//    — config-driven gap detection + action library, not a hardcoded paragraph.
//
// Loads the REAL, unmodified routes/load-tests.js module (via Node's Module API
// — the file on disk is never edited).
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { Module } from 'module';

const ROOT = path.join(__dirname, '..', '..');
const LOAD_TESTS_PATH = path.join(ROOT, 'routes', 'load-tests.js');

function loadModule(): any {
  const src = fs.readFileSync(LOAD_TESTS_PATH, 'utf8');
  const wrapped = src +
    '\n;module.exports.__test_computeServerRecommendation = computeServerRecommendation;' +
    '\n;module.exports.__test_buildConfigExplanation = buildConfigExplanation;' +
    '\n;module.exports.__test_buildOnboardingRecommendation = buildOnboardingRecommendation;' +
    '\n;module.exports.__test_buildCapacityTable = buildCapacityTable;' +
    '\n;module.exports.__test_generateHtml = _generateHtml;' +
    '\n;module.exports.__test_cache = _serverConfigCache;' +
    '\n;module.exports.__test_setCacheWarmed = (v) => { _serverConfigCacheWarmed = v; };\n';
  const mod = new Module(LOAD_TESTS_PATH, undefined as any);
  mod.filename = LOAD_TESTS_PATH;
  // @ts-ignore - private Node API, matches existing require resolution
  mod.paths = Module._nodeModulePaths(path.dirname(LOAD_TESTS_PATH));
  // @ts-ignore - private Node API used purely for testing
  mod._compile(wrapped, LOAD_TESTS_PATH);
  return mod.exports;
}

const T3_MEDIUM = { vcpu: 2, memoryGb: 4, instanceType: 't3.medium' };
const BASE_METRICS = { totalReqs: 5000, okReqs: 4800, errReqs: 200, statusCodes: { '200': 4800, '500': 200 }, p95: 3500, avgLatency: 1200, rps: 45 };
const BASE_TEST_CFG = { vus: 50, p95Threshold: 3000 };

test.describe('Regression: capacity table flat-lining bug', () => {
  const mod = loadModule();
  const { __test_computeServerRecommendation: computeServerRecommendation } = mod;

  test('no two VU tiers show identical CPU% — the reported bug (500-10,000 VUs all showing 999%) is fixed', () => {
    const rec = computeServerRecommendation(T3_MEDIUM, BASE_METRICS, BASE_TEST_CFG);
    const cpuValues = rec.capacityTable.map((r: any) => r.cpuPercent.toFixed(2));
    expect(new Set(cpuValues).size).toBe(cpuValues.length); // every value unique
  });

  test('no two VU tiers show identical P95 projection', () => {
    const rec = computeServerRecommendation(T3_MEDIUM, BASE_METRICS, BASE_TEST_CFG);
    const p95Values = rec.capacityTable.map((r: any) => r.p95Raw);
    expect(new Set(p95Values).size).toBe(p95Values.length);
  });

  test('CPU% and P95 continue to scale upward (monotonically increasing) across all 8 tiers', () => {
    const rec = computeServerRecommendation(T3_MEDIUM, BASE_METRICS, BASE_TEST_CFG);
    for (let i = 1; i < rec.capacityTable.length; i++) {
      expect(rec.capacityTable[i].cpuPercent).toBeGreaterThan(rec.capacityTable[i - 1].cpuPercent);
      expect(rec.capacityTable[i].p95Raw).toBeGreaterThan(rec.capacityTable[i - 1].p95Raw);
    }
  });

  test('tiers far beyond the tested baseline are flagged beyondModelRange and hide the numeric estimate in the report, but retain the real number internally', () => {
    const rec = computeServerRecommendation(T3_MEDIUM, BASE_METRICS, BASE_TEST_CFG); // tested at 50 VUs, retest boundary = 50*20 = 1000
    const row10000 = rec.capacityTable.find((r: any) => r.vus === 10000);
    expect(row10000.beyondModelRange).toBe(true);
    expect(row10000.p95).toBeNull(); // display value hidden
    expect(row10000.p95Raw).toBeGreaterThan(0); // real value retained internally, not discarded
    expect(row10000.cpuPercent).toBeGreaterThan(0);
  });

  test('report HTML shows a qualitative label instead of a numeric estimate for beyond-model-range tiers', () => {
    mod.__test_cache.clear();
    mod.__test_setCacheWarmed(true);
    mod.__test_cache.set('SyncTag::staging', { projectName: 'SyncTag', envType: 'staging', ...T3_MEDIUM, cloudProvider: 'AWS' });
    const state = {
      runId: 'lt_test', status: 'completed',
      startTime: new Date(Date.now() - 60000).toISOString(), endTime: new Date().toISOString(),
      verdict: 'RISK',
      config: { projectName: 'SyncTag', environment: 'QA', vus: 50, duration: 30, p95Threshold: 3000, scenarioType: 'Baseline Load Test', url: 'https://x.test' },
      metrics: { ...BASE_METRICS, p50: 630, p99: 4416, dataSent: 0, dataRecv: 0, rpsHistory: [], latHistory: [], errHistory: [], activeUsersHistory: [], tickTimes: [] },
      logs: [], timeline: [], perRequestResults: [],
    };
    const html = mod.__test_generateHtml(state, {});
    expect(html).toContain('Beyond model range');
    expect(html).toContain('Severe overload expected');
  });
});

test.describe('"What This Configuration Means" (buildConfigExplanation)', () => {
  const mod = loadModule();
  const { __test_buildConfigExplanation: buildConfigExplanation, __test_buildCapacityTable: buildCapacityTable } = mod;

  test('returns null when there is no server config or no vCPU (never fabricated)', () => {
    expect(buildConfigExplanation(null, [], 50, BASE_METRICS, BASE_TEST_CFG)).toBeNull();
    expect(buildConfigExplanation({ memoryGb: 4 }, [], 50, BASE_METRICS, BASE_TEST_CFG)).toBeNull();
  });

  test('computes comfortable/at-risk/fail bands grounded in the real capacity table (not a second disconnected heuristic)', () => {
    const capacityTable = buildCapacityTable(T3_MEDIUM, BASE_METRICS, BASE_TEST_CFG);
    const ce = buildConfigExplanation(T3_MEDIUM, capacityTable, 50, BASE_METRICS, BASE_TEST_CFG);
    expect(ce.comfortableMaxVUs).toBe(35); // t3.medium tier table value
    expect(ce.atRiskLow).toBe(35);
    expect(ce.testedVus).toBe(50);
  });

  test('reasons reference the actual architecture gaps present on the server config, not a fixed list', () => {
    const capacityTable = buildCapacityTable(T3_MEDIUM, BASE_METRICS, BASE_TEST_CFG);
    const cfgNoGaps = { ...T3_MEDIUM, hasLoadBalancer: true, hasReadReplica: true, hasCacheLayer: true, hasAutoScaling: true };
    const ceNoGaps = buildConfigExplanation(cfgNoGaps, capacityTable, 50, BASE_METRICS, BASE_TEST_CFG);
    expect(ceNoGaps.reasons.some((r: string) => r.includes('load balancer'))).toBe(false);
    expect(ceNoGaps.reasons.some((r: string) => r.includes('cache layer'))).toBe(false);

    const cfgAllGaps = { ...T3_MEDIUM, hasLoadBalancer: false, hasReadReplica: false, hasCacheLayer: false, hasAutoScaling: false };
    const ceAllGaps = buildConfigExplanation(cfgAllGaps, capacityTable, 50, BASE_METRICS, BASE_TEST_CFG);
    expect(ceAllGaps.reasons.some((r: string) => r.includes('load balancer'))).toBe(true);
    expect(ceAllGaps.reasons.some((r: string) => r.includes('cache layer'))).toBe(true);
  });

  test('archFlags in the returned object exactly reflect the input server config (never guessed from instance size alone)', () => {
    const capacityTable = buildCapacityTable(T3_MEDIUM, BASE_METRICS, BASE_TEST_CFG);
    const ce = buildConfigExplanation({ ...T3_MEDIUM, hasLoadBalancer: true, hasCacheLayer: false }, capacityTable, 50, BASE_METRICS, BASE_TEST_CFG);
    expect(ce.archFlags.loadBalancer).toBe(true);
    expect(ce.archFlags.cacheLayer).toBe(false);
    expect(ce.archFlags.readReplica).toBe(false); // undefined in input -> treated as false, never assumed true
  });
});

test.describe('"If Onboarding 1,000-10,000+ Concurrent Users" (buildOnboardingRecommendation)', () => {
  const mod = loadModule();
  const {
    __test_computeServerRecommendation: computeServerRecommendation,
    __test_buildOnboardingRecommendation: buildOnboardingRecommendation,
    __test_buildConfigExplanation: buildConfigExplanation,
    __test_buildCapacityTable: buildCapacityTable,
  } = mod;

  test('returns null when the current config already comfortably covers 1,000+ VUs', () => {
    const bigServer = { vcpu: 32, memoryGb: 64, instanceType: 'c6i.8xlarge' };
    const capacityTable = buildCapacityTable(bigServer, BASE_METRICS, { vus: 1500, p95Threshold: 3000 });
    const ce = buildConfigExplanation(bigServer, capacityTable, 1500, BASE_METRICS, { vus: 1500, p95Threshold: 3000 });
    const onb = buildOnboardingRecommendation(ce, capacityTable, null);
    expect(onb).toBeNull();
  });

  test('a t3.medium server produces a full onboarding recommendation with immediate/short-term/medium-term phases', () => {
    const rec = computeServerRecommendation(T3_MEDIUM, BASE_METRICS, BASE_TEST_CFG);
    const onb = rec.onboardingRecommendation;
    expect(onb).toBeTruthy();
    expect(onb.actionsByPhase.immediate.length).toBeGreaterThan(0);
    expect(onb.actionsByPhase.shortTerm.length).toBeGreaterThan(0);
    expect(onb.actionsByPhase.mediumTerm.length).toBeGreaterThan(0);
    expect(onb.gapMultiple).toBeGreaterThan(1);
  });

  test('gap-specific actions (load balancer, cache, replica, auto-scaling) are OMITTED when that infra is already present', () => {
    const serverWithInfra = { ...T3_MEDIUM, hasLoadBalancer: true, hasReadReplica: true, hasCacheLayer: true, hasAutoScaling: true };
    const rec = computeServerRecommendation(serverWithInfra, BASE_METRICS, BASE_TEST_CFG);
    const allActions = Object.values(rec.onboardingRecommendation.actionsByPhase).flat() as any[];
    expect(allActions.some(a => a.text.includes('Move off single-instance'))).toBe(false);
    expect(allActions.some(a => a.text.includes('caching layer'))).toBe(false);
    expect(allActions.some(a => a.text.includes('read replica'))).toBe(false);
    expect(allActions.some(a => a.text.includes('Auto-scaling group'))).toBe(false);
    // Universal actions (not gap-gated) still appear regardless of infra flags.
    expect(allActions.some(a => a.text.includes('Re-test at 100, 250, and 500 VUs'))).toBe(true);
  });

  test('gap-specific actions ARE included when that infra is missing', () => {
    const serverNoInfra = { ...T3_MEDIUM, hasLoadBalancer: false, hasReadReplica: false, hasCacheLayer: false, hasAutoScaling: false };
    const rec = computeServerRecommendation(serverNoInfra, BASE_METRICS, BASE_TEST_CFG);
    const allActions = Object.values(rec.onboardingRecommendation.actionsByPhase).flat() as any[];
    expect(allActions.some(a => a.text.includes('Move off single-instance'))).toBe(true);
    expect(allActions.some(a => a.text.includes('caching layer'))).toBe(true);
    expect(allActions.some(a => a.text.includes('read replica'))).toBe(true);
    expect(allActions.some(a => a.text.includes('Auto-scaling group'))).toBe(true);
  });

  test('every action has an owner and timeline (ownership & timeline requirement)', () => {
    const rec = computeServerRecommendation(T3_MEDIUM, BASE_METRICS, BASE_TEST_CFG);
    const allActions = Object.values(rec.onboardingRecommendation.actionsByPhase).flat() as any[];
    expect(allActions.length).toBeGreaterThan(0);
    for (const a of allActions) {
      expect(a.owner).toBeTruthy();
      expect(a.timeline).toBeTruthy();
    }
  });

  test('fallback advice (throttle/waitlist) is always present as an explicit escape hatch', () => {
    const rec = computeServerRecommendation(T3_MEDIUM, BASE_METRICS, BASE_TEST_CFG);
    expect(rec.onboardingRecommendation.fallbackAdvice).toContain('cap registration/onboarding');
  });

  test('high-scale warnings reuse the same threshold-gated list as the Scaling Recommendation Path (never disagree)', () => {
    const rec = computeServerRecommendation(T3_MEDIUM, BASE_METRICS, BASE_TEST_CFG);
    expect(rec.onboardingRecommendation.highScaleWarnings).toEqual(rec.scalingPath.highScaleWarnings);
  });

  test('report HTML includes the onboarding section with phase headings when architecture gaps exist', () => {
    mod.__test_cache.clear();
    mod.__test_setCacheWarmed(true);
    mod.__test_cache.set('SyncTag::staging', { projectName: 'SyncTag', envType: 'staging', ...T3_MEDIUM, cloudProvider: 'AWS', hasLoadBalancer: false, hasCacheLayer: false, hasReadReplica: false, hasAutoScaling: false });
    const state = {
      runId: 'lt_test', status: 'completed',
      startTime: new Date(Date.now() - 60000).toISOString(), endTime: new Date().toISOString(),
      verdict: 'RISK',
      config: { projectName: 'SyncTag', environment: 'QA', vus: 50, duration: 30, p95Threshold: 3000, scenarioType: 'Baseline Load Test', url: 'https://x.test' },
      metrics: { ...BASE_METRICS, p50: 630, p99: 4416, dataSent: 0, dataRecv: 0, rpsHistory: [], latHistory: [], errHistory: [], activeUsersHistory: [], tickTimes: [] },
      logs: [], timeline: [], perRequestResults: [],
    };
    const html = mod.__test_generateHtml(state, {});
    expect(html).toContain('If Onboarding 1,000-10,000+ Concurrent Users');
    expect(html).toContain('Immediate (this week)');
    expect(html).toContain('Short-term (before 1,000 users)');
    expect(html).toContain('Medium-term (to sustain 1,000-10,000+ users)');
  });
});

// Tests for the enhanced capacity analysis + scaling recommendation path in the
// load test report: extended VU-level capacity table (50..10,000), tested-vs-
// projected data, config-driven instance tier lookups, and the Scaling
// Recommendation Path section. Loads the REAL, unmodified routes/load-tests.js
// module (via Node's Module API — the file on disk is never edited).
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
    '\n;module.exports.__test_buildCapacityTable = buildCapacityTable;' +
    '\n;module.exports.__test_buildScalingRecommendationPath = buildScalingRecommendationPath;' +
    '\n;module.exports.__test_INSTANCE_TIER_TABLE = INSTANCE_TIER_TABLE;' +
    '\n;module.exports.__test_CAPACITY_VERDICT_THRESHOLDS = CAPACITY_VERDICT_THRESHOLDS;' +
    '\n;module.exports.__test_lookupTierForSpec = _lookupTierForSpec;' +
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

const REQUIRED_LEVELS = [50, 100, 250, 500, 1000, 2500, 5000, 10000];

test.describe('Capacity table — extended VU levels + tested/projected distinction', () => {
  const mod = loadModule();
  const { __test_computeServerRecommendation: computeServerRecommendation } = mod;

  test('required VU levels (50..10,000) are always present, plus the actual tested VU count even when it is not one of them', () => {
    const serverCfg = { vcpu: 2, memoryGb: 4, instanceType: 't3.medium' };
    const metrics = { totalReqs: 1000, okReqs: 970, errReqs: 30, statusCodes: { '200': 970, '500': 30 }, p95: 2000, rps: 20 };
    // Actual tested VU count is 30 — NOT one of the fixed reference levels, per the
    // spec's explicit instruction not to assume 50 is always the tested count.
    const rec = computeServerRecommendation(serverCfg, metrics, { vus: 30, p95Threshold: 3000 });

    for (const lvl of REQUIRED_LEVELS) {
      expect(rec.capacityTable.some((r: any) => r.vus === lvl)).toBe(true);
    }
    expect(rec.capacityTable.some((r: any) => r.vus === 30 && r.isTested)).toBe(true);
  });

  test('exactly one row is marked TESTED (the real tested VU count) and every other row is PROJECTED', () => {
    const serverCfg = { vcpu: 2, memoryGb: 4, instanceType: 't3.medium' };
    const metrics = { totalReqs: 1000, okReqs: 990, errReqs: 10, statusCodes: { '200': 990, '500': 10 }, p95: 1000, rps: 20 };
    const rec = computeServerRecommendation(serverCfg, metrics, { vus: 50, p95Threshold: 3000 });

    const testedRows = rec.capacityTable.filter((r: any) => r.isTested);
    expect(testedRows.length).toBe(1);
    expect(testedRows[0].vus).toBe(50);
    expect(testedRows[0].dataType).toBe('TESTED');
    expect(rec.capacityTable.filter((r: any) => !r.isTested).every((r: any) => r.dataType === 'PROJECTED')).toBe(true);
  });

  test('the tested row uses ACTUAL measured P95 and error rate, not the projection model', () => {
    const serverCfg = { vcpu: 4, memoryGb: 8, instanceType: 'c6i.xlarge' };
    const metrics = { totalReqs: 2000, okReqs: 1900, errReqs: 100, statusCodes: { '200': 1900, '500': 100 }, p95: 4200, rps: 60 };
    const rec = computeServerRecommendation(serverCfg, metrics, { vus: 100, p95Threshold: 3000 });
    const tested = rec.capacityTable.find((r: any) => r.isTested);

    expect(tested.p95).toBe(4200); // exact measured value, not a model output
    expect(tested.errorRatePct).toBeCloseTo(5, 1); // 100/2000 = 5%
  });

  test('projected rows never claim a measured error rate (errorRateNA is true for every non-tested row)', () => {
    const serverCfg = { vcpu: 2, memoryGb: 4, instanceType: 't3.medium' };
    const metrics = { totalReqs: 1000, okReqs: 990, errReqs: 10, statusCodes: { '200': 990, '500': 10 }, p95: 1000, rps: 20 };
    const rec = computeServerRecommendation(serverCfg, metrics, { vus: 50, p95Threshold: 3000 });

    for (const row of rec.capacityTable.filter((r: any) => !r.isTested)) {
      expect(row.errorRateNA).toBe(true);
      expect(row.errorRatePct).toBeNull();
    }
  });

  test('RAM is always N/A — never fabricated — since no RAM-monitoring data is wired into the runner', () => {
    const serverCfg = { vcpu: 2, memoryGb: 4, instanceType: 't3.medium' };
    const metrics = { totalReqs: 1000, okReqs: 990, errReqs: 10, statusCodes: { '200': 990, '500': 10 }, p95: 1000, rps: 20 };
    const rec = computeServerRecommendation(serverCfg, metrics, { vus: 50, p95Threshold: 3000 });

    expect(rec.capacityTable.every((r: any) => r.ramNA === true && r.ramPercent === null)).toBe(true);
  });

  test('CPU verdict bands follow the configurable thresholds: <70% PASS, 70-100% RISK, >100% FAIL', () => {
    const { __test_CAPACITY_VERDICT_THRESHOLDS: thresholds } = mod;
    expect(thresholds.cpuComfortableMaxPct).toBe(70);
    expect(thresholds.cpuRiskMaxPct).toBe(85);

    const serverCfg = { vcpu: 2, memoryGb: 4, instanceType: 't3.medium' }; // comfortable ~35 VUs per tier table
    const metrics = { totalReqs: 1000, okReqs: 1000, errReqs: 0, statusCodes: { '200': 1000 }, p95: 500, rps: 20 };
    const rec = computeServerRecommendation(serverCfg, metrics, { vus: 20, p95Threshold: 3000 });

    const row20 = rec.capacityTable.find((r: any) => r.vus === 20);
    expect(row20.verdict).toBe('PASS'); // well within comfortable capacity
    const row10000 = rec.capacityTable.find((r: any) => r.vus === 10000);
    expect(['FAIL', 'REQUIRES RE-TEST']).toContain(row10000.verdict); // far beyond a t3.medium
  });

  test('a VU level far beyond BOTH the tested-VU-multiple ceiling AND the saturation-based ceiling is labeled "Requires Re-test"', () => {
    // The "beyond model range" boundary is the MORE PERMISSIVE of two independent
    // ceilings (see CAPACITY_VERDICT_THRESHOLDS): testedVus * 20, and
    // comfortable-capacity-implied-100%-VUs * 50. A small server tested at a VU
    // count that's already a meaningful fraction of ITS OWN comfortable capacity
    // triggers both ceilings at a reachable VU level, unlike a big server tested
    // at a tiny fraction of its own capacity (see the low-VU-on-capable-server
    // test below, which must stay numeric all the way to 10,000).
    const serverCfg = { vcpu: 2, memoryGb: 4, instanceType: 't3.medium' }; // comfortable ~35 VUs
    const metrics = { totalReqs: 1000, okReqs: 1000, errReqs: 0, statusCodes: { '200': 1000 }, p95: 500, rps: 40 };
    const rec = computeServerRecommendation(serverCfg, metrics, { vus: 50, p95Threshold: 3000 });

    const row10000 = rec.capacityTable.find((r: any) => r.vus === 10000);
    expect(row10000.verdict).toBe('REQUIRES RE-TEST');
  });

  test('a low-VU test on a CAPABLE server still gets numeric projections across the full required range (does not collapse to "beyond range" just because the tested VU count was small)', () => {
    const serverCfg = { vcpu: 8, memoryGb: 16, instanceType: 'c6i.2xlarge' }; // comfortable ~320 VUs
    const metrics = { totalReqs: 500, okReqs: 498, errReqs: 2, statusCodes: { '200': 498, '404': 2 }, p95: 300, rps: 8 };
    const rec = computeServerRecommendation(serverCfg, metrics, { vus: 10, p95Threshold: 3000 });

    const beyondRangeRows = rec.capacityTable.filter((r: any) => r.beyondModelRange);
    expect(beyondRangeRows.length).toBe(0); // every required tier stays numeric for this capable server
    const cpuValues = rec.capacityTable.map((r: any) => r.cpuPercent.toFixed(2));
    expect(new Set(cpuValues).size).toBe(cpuValues.length); // still all distinguishable
  });

  test('missing vCPU/server config produces an empty capacity table and null scaling path (never fabricated)', () => {
    const metrics = { totalReqs: 100, okReqs: 100, errReqs: 0, statusCodes: { '200': 100 }, p95: 200, rps: 10 };
    const recNull = computeServerRecommendation(null, metrics, { vus: 10 });
    expect(recNull.capacityTable).toEqual([]);
    expect(recNull.scalingPath).toBeNull();

    const recNoCpu = computeServerRecommendation({ memoryGb: 4 }, metrics, { vus: 10 });
    expect(recNoCpu.capacityTable).toEqual([]);
    expect(recNoCpu.scalingPath).toBeNull();
  });

  // Regression: a tested run with zero total requests (e.g. stopped immediately)
  // used to throw when the report tried to call .toFixed() on a null error rate,
  // because errorRateNA was derived from `!isTested` instead of the actual
  // nullability of errorRatePct — silently aborting report generation.
  test('regression: a tested run with zero total requests does not crash capacity-table generation', () => {
    const serverCfg = { vcpu: 2, memoryGb: 4, instanceType: 't3.medium' };
    const metrics = { totalReqs: 0, okReqs: 0, errReqs: 0, statusCodes: {}, p95: 0, rps: 0 };
    expect(() => computeServerRecommendation(serverCfg, metrics, { vus: 50, p95Threshold: 3000 })).not.toThrow();

    const rec = computeServerRecommendation(serverCfg, metrics, { vus: 50, p95Threshold: 3000 });
    const tested = rec.capacityTable.find((r: any) => r.isTested);
    expect(tested.errorRateNA).toBe(true);
    expect(tested.errorRatePct).toBeNull();
  });
});

test.describe('Instance tier lookup — RAM tie-break regression', () => {
  const mod = loadModule();
  const { __test_lookupTierForSpec: lookupTierForSpec } = mod;

  // Regression: t3.medium (2 vCPU/4GB) and t3.large (2 vCPU/8GB) tie on vCPU.
  // A naive "closest at or below vCPU" lookup with a stable sort always picked
  // whichever tier was declared first in the table, regardless of the server's
  // actual RAM — so a real t3.large server could be silently misidentified as
  // t3.medium, producing a self-contradictory Scaling Recommendation ("current:
  // t3.large" immediately followed by a step recommending upgrading TO t3.large).
  test('a server with 2 vCPU / 8GB RAM resolves to t3.large, not t3.medium', () => {
    const tier = lookupTierForSpec(2, 8);
    expect(tier.instanceType).toBe('t3.large');
  });

  test('a server with 2 vCPU / 4GB RAM resolves to t3.medium', () => {
    const tier = lookupTierForSpec(2, 4);
    expect(tier.instanceType).toBe('t3.medium');
  });

  test('a server with fewer vCPU than any table entry returns null rather than throwing', () => {
    const tier = lookupTierForSpec(1, 2);
    expect(tier).toBeNull();
  });
});

test.describe('Scaling Recommendation Path — config-driven, not hardcoded per report', () => {
  const mod = loadModule();
  const { __test_computeServerRecommendation: computeServerRecommendation, __test_buildScalingRecommendationPath: buildScalingRecommendationPath, __test_INSTANCE_TIER_TABLE: tiers } = mod;

  test('instance tier reference table is a real, inspectable, reusable data structure — not implicit/hardcoded per call', () => {
    expect(Array.isArray(tiers)).toBe(true);
    expect(tiers.length).toBeGreaterThan(3);
    for (const t of tiers) {
      expect(t).toHaveProperty('instanceType');
      expect(t).toHaveProperty('vcpu');
      expect(t).toHaveProperty('ramGb');
      expect(t).toHaveProperty('comfortableMaxVUs');
      expect(t).toHaveProperty('recommendedMaxVUs');
      expect(t).toHaveProperty('tier');
    }
  });

  test('no scaling path is generated when the target VU count is within comfortable capacity', () => {
    const path1 = buildScalingRecommendationPath({ vcpu: 8, memoryGb: 16, instanceType: 'c6i.2xlarge' }, 50);
    expect(path1).toBeNull();
  });

  test('a target beyond comfortable capacity produces a step-by-step upgrade path ending at or beyond the target', () => {
    const path1 = buildScalingRecommendationPath({ vcpu: 2, memoryGb: 4, instanceType: 't3.medium' }, 1000);
    expect(path1).toBeTruthy();
    expect(path1.steps.length).toBeGreaterThan(0);
    const lastStep = path1.steps[path1.steps.length - 1];
    expect(lastStep.rangeHigh).toBeGreaterThanOrEqual(1000);
  });

  test('high-scale warnings only appear once the target VU count reaches the relevant threshold (1000/2500/5000/10000)', () => {
    const low = buildScalingRecommendationPath({ vcpu: 2, memoryGb: 4, instanceType: 't3.medium' }, 100);
    expect(low.highScaleWarnings.length).toBe(0);

    const mid = buildScalingRecommendationPath({ vcpu: 2, memoryGb: 4, instanceType: 't3.medium' }, 1500);
    expect(mid.highScaleWarnings.some((w: string) => w.toLowerCase().includes('database connections'))).toBe(true);

    const high = buildScalingRecommendationPath({ vcpu: 2, memoryGb: 4, instanceType: 't3.medium' }, 6000);
    expect(high.highScaleWarnings.some((w: string) => w.toLowerCase().includes('load balancer'))).toBe(true);
    expect(high.highScaleWarnings.length).toBeGreaterThan(mid.highScaleWarnings.length);
  });

  test('report HTML includes the Scaling Recommendation Path section and disclaimer when a run exceeds comfortable capacity', () => {
    mod.__test_cache.clear();
    mod.__test_setCacheWarmed(true);
    mod.__test_cache.set('SyncTag::staging', { projectName: 'SyncTag', envType: 'staging', vcpu: 2, memoryGb: 4, instanceType: 't3.medium', cloudProvider: 'AWS' });

    const state = {
      runId: 'lt_test', status: 'completed',
      startTime: new Date(Date.now() - 60000).toISOString(), endTime: new Date().toISOString(),
      verdict: 'RISK',
      config: { projectName: 'SyncTag', environment: 'QA', vus: 50, duration: 30, p95Threshold: 3000, scenarioType: 'Baseline Load Test', url: 'https://api.synctag.com/ping' },
      metrics: { totalReqs: 5000, okReqs: 4800, errReqs: 200, statusCodes: { '200': 4800, '500': 200 }, p95: 3500, avgLatency: 1200, rps: 45, dataSent: 0, dataRecv: 0, rpsHistory: [], latHistory: [], errHistory: [], activeUsersHistory: [], tickTimes: [] },
      logs: [], timeline: [], perRequestResults: [],
    };

    const html = mod.__test_generateHtml(state, {});
    expect(html).toContain('Scaling Recommendation Path');
    expect(html).toContain('t3.large');
    expect(html).toContain('Estimated Capacity by Virtual Users');
    expect(html).toContain('Capacity values above the highest load-tested level are projections');
    expect(html).toContain('TESTED');
    expect(html).toContain('PROJECTED');
  });
});

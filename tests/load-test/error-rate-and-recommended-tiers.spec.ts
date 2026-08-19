// Tests for:
// 1. The Error Rate column bug — projected rows previously always showed N/A
//    instead of an estimated error rate. Now every non-"beyond model range" row
//    gets a real projected error rate derived from the tested run's baseline.
// 2. "Recommended Server Configuration by Scale" — new per-tier (1000/5000/
//    10000/10000+) recommended instance cards, shown only when the current
//    server config is insufficient at that tier, using the same reference
//    table as the Scaling Recommendation Path.
//
// Loads the REAL, unmodified routes/load-tests.js module (via Node's Module
// API — the file on disk is never edited).
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
    '\n;module.exports.__test_buildRecommendedConfigsByTier = buildRecommendedConfigsByTier;' +
    '\n;module.exports.__test_INSTANCE_TIER_TABLE = INSTANCE_TIER_TABLE;' +
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

test.describe('Regression: Error Rate column showing N/A for all projected rows', () => {
  const mod = loadModule();
  const { __test_computeServerRecommendation: computeServerRecommendation } = mod;

  test('projected (non-tested) rows get a real estimated error rate, not N/A', () => {
    const metrics = { totalReqs: 5000, okReqs: 4987, errReqs: 13, statusCodes: { '200': 4987, '500': 13 }, p95: 3895, rps: 45 };
    const rec = computeServerRecommendation(T3_MEDIUM, metrics, { vus: 50, p95Threshold: 3000 });

    const projectedRows = rec.capacityTable.filter((r: any) => !r.isTested && !r.beyondModelRange);
    expect(projectedRows.length).toBeGreaterThan(0);
    for (const row of projectedRows) {
      expect(row.errorRateNA).toBe(false);
      expect(row.errorRatePct).not.toBeNull();
      expect(typeof row.errorRatePct).toBe('number');
    }
  });

  test('projected error rate increases with VU count (distinguishable, not flat)', () => {
    const metrics = { totalReqs: 5000, okReqs: 4987, errReqs: 13, statusCodes: { '200': 4987, '500': 13 }, p95: 3895, rps: 45 };
    const rec = computeServerRecommendation(T3_MEDIUM, metrics, { vus: 50, p95Threshold: 3000 });

    const numericRows = rec.capacityTable.filter((r: any) => !r.beyondModelRange);
    for (let i = 1; i < numericRows.length; i++) {
      expect(numericRows[i].errorRatePct).toBeGreaterThanOrEqual(numericRows[i - 1].errorRatePct);
    }
  });

  test('a 0%-error tested run still projects a rising error rate at higher VUs (does not stay 0% forever)', () => {
    const metrics = { totalReqs: 1000, okReqs: 1000, errReqs: 0, statusCodes: { '200': 1000 }, p95: 400, rps: 20 };
    const rec = computeServerRecommendation(T3_MEDIUM, metrics, { vus: 50, p95Threshold: 3000 });

    const tested = rec.capacityTable.find((r: any) => r.isTested);
    expect(tested.errorRatePct).toBe(0);
    const highVuRow = rec.capacityTable.find((r: any) => r.vus === 2500);
    expect(highVuRow.errorRatePct).toBeGreaterThan(0);
  });

  test('beyond-model-range rows still show N/A for error rate (no fake precision that far out)', () => {
    const metrics = { totalReqs: 5000, okReqs: 4987, errReqs: 13, statusCodes: { '200': 4987, '500': 13 }, p95: 3895, rps: 45 };
    const rec = computeServerRecommendation(T3_MEDIUM, metrics, { vus: 50, p95Threshold: 3000 });

    const beyondRows = rec.capacityTable.filter((r: any) => r.beyondModelRange);
    expect(beyondRows.length).toBeGreaterThan(0);
    for (const row of beyondRows) {
      expect(row.errorRateNA).toBe(true);
      expect(row.errorRatePct).toBeNull();
    }
  });

  test('report HTML shows a real percentage (not N/A) for a projected row within the model range', () => {
    mod.__test_cache.clear();
    mod.__test_setCacheWarmed(true);
    mod.__test_cache.set('SyncTag::staging', { projectName: 'SyncTag', envType: 'staging', ...T3_MEDIUM, cloudProvider: 'AWS' });
    const state = {
      runId: 'lt_test', status: 'completed',
      startTime: new Date(Date.now() - 60000).toISOString(), endTime: new Date().toISOString(),
      verdict: 'RISK',
      config: { projectName: 'SyncTag', environment: 'QA', vus: 50, duration: 30, p95Threshold: 3000, scenarioType: 'Baseline Load Test', url: 'https://x.test' },
      metrics: { totalReqs: 5000, okReqs: 4987, errReqs: 13, statusCodes: { '200': 4987, '500': 13 }, p95: 3895, p50: 630, p99: 4416, avgLatency: 1200, rps: 45, dataSent: 0, dataRecv: 0, rpsHistory: [], latHistory: [], errHistory: [], activeUsersHistory: [], tickTimes: [] },
      logs: [], timeline: [], perRequestResults: [],
    };
    const html = mod.__test_generateHtml(state, {});
    // 100 VUs row should show a real, non-N/A percentage with an (est.) marker.
    expect(html).toMatch(/4\.9\d%.*\(est\.\)/s);
  });
});

test.describe('"Recommended Server Configuration by Scale"', () => {
  const mod = loadModule();
  const {
    __test_computeServerRecommendation: computeServerRecommendation,
    __test_buildRecommendedConfigsByTier: buildRecommendedConfigsByTier,
  } = mod;

  test('produces a card for 1000/5000/10000 tiers plus a 10,000+ card when the current server is insufficient', () => {
    const metrics = { totalReqs: 5000, okReqs: 4987, errReqs: 13, statusCodes: { '200': 4987, '500': 13 }, p95: 3895, rps: 45 };
    const rec = computeServerRecommendation(T3_MEDIUM, metrics, { vus: 50, p95Threshold: 3000 });

    expect(rec.recommendedConfigsByTier.length).toBe(4);
    expect(rec.recommendedConfigsByTier.map((t: any) => t.label)).toEqual(['1,000 VUs', '5,000 VUs', '10,000 VUs', '10,000+ VUs']);
  });

  test('recommended instance for each tier can comfortably handle at least that many VUs', () => {
    const { __test_INSTANCE_TIER_TABLE: tiers } = mod;
    const metrics = { totalReqs: 5000, okReqs: 4987, errReqs: 13, statusCodes: { '200': 4987, '500': 13 }, p95: 3895, rps: 45 };
    const rec = computeServerRecommendation(T3_MEDIUM, metrics, { vus: 50, p95Threshold: 3000 });

    for (const t of rec.recommendedConfigsByTier) {
      if (t.targetVus === null) continue; // the open-ended "10,000+" card has no single fixed target
      const matchingTier = tiers.find((x: any) => x.instanceType === t.instanceType);
      expect(matchingTier.comfortableMaxVUs * t.nodes).toBeGreaterThanOrEqual(t.targetVus);
    }
  });

  test('node count scales up for higher tiers once past the largest single-node instance', () => {
    const metrics = { totalReqs: 5000, okReqs: 4987, errReqs: 13, statusCodes: { '200': 4987, '500': 13 }, p95: 3895, rps: 45 };
    const rec = computeServerRecommendation(T3_MEDIUM, metrics, { vus: 50, p95Threshold: 3000 });

    const t1000 = rec.recommendedConfigsByTier.find((t: any) => t.targetVus === 1000);
    const t10000 = rec.recommendedConfigsByTier.find((t: any) => t.targetVus === 10000);
    expect(t10000.nodes).toBeGreaterThanOrEqual(t1000.nodes);
  });

  test('no card is produced for a tier the current config already comfortably PASSes', () => {
    const bigServer = { vcpu: 32, memoryGb: 64, instanceType: 'c6i.8xlarge' };
    const metrics = { totalReqs: 5000, okReqs: 4999, errReqs: 1, statusCodes: { '200': 4999, '500': 1 }, p95: 400, rps: 300 };
    const result = buildRecommendedConfigsByTier(bigServer, [
      { vus: 1000, verdict: 'PASS' },
    ]);
    expect(result.find((t: any) => t.targetVus === 1000)).toBeUndefined();
  });

  test('returns empty array when there is no server config (never fabricated)', () => {
    expect(buildRecommendedConfigsByTier(null, [])).toEqual([]);
    expect(buildRecommendedConfigsByTier({ memoryGb: 4 }, [])).toEqual([]);
  });

  test('report HTML includes the new section with per-tier cards and matches the existing card visual style', () => {
    mod.__test_cache.clear();
    mod.__test_setCacheWarmed(true);
    mod.__test_cache.set('SyncTag::staging', { projectName: 'SyncTag', envType: 'staging', ...T3_MEDIUM, cloudProvider: 'AWS' });
    const state = {
      runId: 'lt_test', status: 'completed',
      startTime: new Date(Date.now() - 60000).toISOString(), endTime: new Date().toISOString(),
      verdict: 'RISK',
      config: { projectName: 'SyncTag', environment: 'QA', vus: 50, duration: 30, p95Threshold: 3000, scenarioType: 'Baseline Load Test', url: 'https://x.test' },
      metrics: { totalReqs: 5000, okReqs: 4987, errReqs: 13, statusCodes: { '200': 4987, '500': 13 }, p95: 3895, p50: 630, p99: 4416, avgLatency: 1200, rps: 45, dataSent: 0, dataRecv: 0, rpsHistory: [], latHistory: [], errHistory: [], activeUsersHistory: [], tickTimes: [] },
      logs: [], timeline: [], perRequestResults: [],
    };
    const html = mod.__test_generateHtml(state, {});
    expect(html).toContain('Recommended Server Configuration by Scale');
    expect(html).toContain('For 1,000 VUs');
    expect(html).toContain('For 5,000 VUs');
    expect(html).toContain('For 10,000 VUs');
    expect(html).toContain('For 10,000+ VUs');
    // Same tile pattern as the current-config card (Instance Type / vCPU / Memory tiles).
    expect(html).toContain('Instance Type');
  });
});

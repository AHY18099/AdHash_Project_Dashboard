// Tests for the load test report's root-cause classification and capacity
// estimate, shown in the Server Configuration section when a run fails or
// degrades at high VUs. Loads the real, unmodified routes/load-tests.js module
// (via Node's Module API — the file on disk is never edited) and exercises the
// real computeServerRecommendation()/classifyFailureRootCause()/
// buildCapacityTable() functions with realistic metric shapes.
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { Module } from 'module';

const ROOT = path.join(__dirname, '..', '..');
const LOAD_TESTS_PATH = path.join(ROOT, 'routes', 'load-tests.js');

function loadComputeServerRecommendation(): (serverCfg: any, metrics: any, testCfg: any) => any {
  const src = fs.readFileSync(LOAD_TESTS_PATH, 'utf8');
  const wrapped = src + '\n;module.exports.__test_computeServerRecommendation = computeServerRecommendation;\n';
  const mod = new Module(LOAD_TESTS_PATH, undefined as any);
  mod.filename = LOAD_TESTS_PATH;
  // @ts-ignore - private Node API, matches existing require resolution
  mod.paths = Module._nodeModulePaths(path.dirname(LOAD_TESTS_PATH));
  // @ts-ignore - private Node API used purely for testing
  mod._compile(wrapped, LOAD_TESTS_PATH);
  return (mod.exports as any).__test_computeServerRecommendation;
}

const SERVER_CFG = { vcpu: 2, memoryGb: 4, instanceType: 't3.medium', cloudProvider: 'AWS' };

test.describe('Server capacity analysis (root cause + capacity table)', () => {
  const computeServerRecommendation = loadComputeServerRecommendation();

  test('high-VU run with connection-level failures is classified as critical resource exhaustion', () => {
    const metrics = {
      totalReqs: 5000, okReqs: 3200, errReqs: 1800,
      statusCodes: { '200': 3200, '0': 1500, '502': 300 },
      p95: 9000, avgLatency: 4000, rps: 40,
    };
    const rec = computeServerRecommendation(SERVER_CFG, metrics, { vus: 200, p95Threshold: 3000 });

    expect(rec.level).toBe('upgrade');
    const connCause = rec.rootCauses.find((c: any) => c.title.includes('Connection-level failures'));
    expect(connCause).toBeTruthy();
    expect(connCause.severity).toBe('critical');
    expect(connCause.detail).toContain('resource-exhaustion');
  });

  test('5xx-dominant failures are classified as application-level, not connection exhaustion', () => {
    const metrics = {
      totalReqs: 1000, okReqs: 850, errReqs: 150,
      statusCodes: { '200': 850, '500': 150 },
      p95: 2500, avgLatency: 900, rps: 30,
    };
    const rec = computeServerRecommendation(SERVER_CFG, metrics, { vus: 50, p95Threshold: 3000 });

    const connCause = rec.rootCauses.find((c: any) => c.title.includes('Connection-level'));
    const serverCause = rec.rootCauses.find((c: any) => c.title.includes('HTTP 5xx'));
    expect(connCause).toBeFalsy();
    expect(serverCause).toBeTruthy();
  });

  test('a clean passing run produces zero root causes', () => {
    const metrics = {
      totalReqs: 1000, okReqs: 998, errReqs: 2,
      statusCodes: { '200': 998, '404': 2 },
      p95: 400, avgLatency: 150, rps: 25,
    };
    const rec = computeServerRecommendation(SERVER_CFG, metrics, { vus: 20, p95Threshold: 3000 });

    expect(rec.level).toBe('ok');
    expect(rec.rootCauses).toEqual([]);
  });

  test('capacity table marks the tested VU level and orders PASS < RISK < FAIL by increasing VUs', () => {
    const metrics = {
      totalReqs: 5000, okReqs: 3200, errReqs: 1800,
      statusCodes: { '200': 3200, '0': 1500, '502': 300 },
      p95: 9000, avgLatency: 4000, rps: 40,
    };
    const rec = computeServerRecommendation(SERVER_CFG, metrics, { vus: 200, p95Threshold: 3000 });

    const tested = rec.capacityTable.find((r: any) => r.isTested);
    expect(tested).toBeTruthy();
    expect(tested.vus).toBe(200);

    // Sorted ascending by VUs, and saturation must be monotonically non-decreasing.
    const vusSorted = rec.capacityTable.map((r: any) => r.vus);
    expect(vusSorted).toEqual([...vusSorted].sort((a, b) => a - b));
    for (let i = 1; i < rec.capacityTable.length; i++) {
      expect(rec.capacityTable[i].projectedSaturation).toBeGreaterThanOrEqual(rec.capacityTable[i - 1].projectedSaturation);
    }
  });

  test('missing server config or missing vCPU degrades gracefully with empty root causes and capacity table', () => {
    const metrics = { totalReqs: 100, okReqs: 100, errReqs: 0, statusCodes: { '200': 100 }, p95: 200, rps: 10 };
    const noCfg = computeServerRecommendation(null, metrics, { vus: 10 });
    expect(noCfg.level).toBe('unknown');
    expect(noCfg.rootCauses).toEqual([]);
    expect(noCfg.capacityTable).toEqual([]);

    const noCpu = computeServerRecommendation({ memoryGb: 4 }, metrics, { vus: 10 });
    expect(noCpu.level).toBe('unknown');
    expect(noCpu.rootCauses).toEqual([]);
    expect(noCpu.capacityTable).toEqual([]);
  });

  test('4xx-heavy failures are flagged as informational (test data/auth), not a capacity problem', () => {
    const metrics = {
      totalReqs: 1000, okReqs: 800, errReqs: 200,
      statusCodes: { '200': 800, '401': 200 },
      p95: 300, avgLatency: 100, rps: 20,
    };
    const rec = computeServerRecommendation(SERVER_CFG, metrics, { vus: 30, p95Threshold: 3000 });

    const clientCause = rec.rootCauses.find((c: any) => c.title.includes('HTTP 4xx'));
    expect(clientCause).toBeTruthy();
    expect(clientCause.severity).toBe('info');
    expect(clientCause.detail).toContain('test-data or auth-token');
  });
});

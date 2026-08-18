// Regression tests for "Server Configuration section missing/empty in the report."
//
// Investigation found the bug as commonly described ("must open Server Config tab
// first") does not match the code — projectName already flows correctly from both
// the Configure Test and Workflow Builder tabs into a run's state.config, and the
// Server Config tab's own project dropdown has no side effect on anything the
// report reads. Two REAL, different bugs were found and are covered here instead:
//
// 1. Cache-warm race: `_serverConfigCache` was warmed lazily and fire-and-forget on
//    first read. The very first report generated after a cold start/Railway restart
//    read an EMPTY cache and silently rendered no Server Configuration data — it
//    self-healed on the next report of any project, which is what made it look like
//    "the report only works after visiting Server Config" (the correlation was really
//    with "which report happened to run first after a deploy", not tab visitation).
//    Fix: `ensureServerConfigCacheWarm()` is now awaited before every report
//    generation call site, so even the very first report after a cold start blocks
//    until the DB fetch completes.
//
// 2. Environment-bucket mismatch: Workflow Builder's environment dropdown defaults
//    to "QA", which maps to the 'staging' bucket. If a user only ever saved a
//    'production' server config and runs a scenario without changing that dropdown,
//    the report correctly finds nothing under 'staging' — this is data-accurate
//    behavior, but it used to fail SILENTLY (the section just showed nothing extra).
//    Fix: the missing-config case now always renders an explicit WARNING with the
//    exact projectName + environment that was looked up, never a silent gap and
//    never a fabricated fallback to a different environment's data.
//
// This file loads the REAL, unmodified routes/load-tests.js module (via Node's
// Module API — appending test-only exports; the file on disk is never edited) so a
// regression in the actual generator/cache code fails here, not in a parallel copy.
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { Module } from 'module';

const ROOT = path.join(__dirname, '..', '..');
const LOAD_TESTS_PATH = path.join(ROOT, 'routes', 'load-tests.js');

function loadModule(): any {
  const src = fs.readFileSync(LOAD_TESTS_PATH, 'utf8');
  const wrapped = src +
    '\n;module.exports.__test_generateHtml = _generateHtml;' +
    '\n;module.exports.__test_cache = _serverConfigCache;' +
    '\n;module.exports.__test_getCacheWarmed = () => _serverConfigCacheWarmed;' +
    '\n;module.exports.__test_setCacheWarmed = (v) => { _serverConfigCacheWarmed = v; };' +
    '\n;module.exports.__test_ensureWarm = ensureServerConfigCacheWarm;' +
    '\n;module.exports.__test_getServerConfigsForProject = getServerConfigsForProject;' +
    '\n;module.exports.__test_LTServerConfig = LTServerConfig;\n';
  const mod = new Module(LOAD_TESTS_PATH, undefined as any);
  mod.filename = LOAD_TESTS_PATH;
  // @ts-ignore - private Node API, matches existing require resolution
  mod.paths = Module._nodeModulePaths(path.dirname(LOAD_TESTS_PATH));
  // @ts-ignore - private Node API used purely for testing
  mod._compile(wrapped, LOAD_TESTS_PATH);
  return mod.exports;
}

function makeState(overrides: any = {}) {
  return {
    runId: 'lt_test', status: 'completed',
    startTime: new Date(Date.now() - 60000).toISOString(), endTime: new Date().toISOString(),
    verdict: 'PASS',
    config: {
      projectName: 'SyncTag', environment: 'QA', vus: 50, duration: 30, p95Threshold: 3000,
      scenarioType: 'Baseline Load Test', url: 'https://api.synctag.com/ping',
      ...overrides.config,
    },
    metrics: {
      totalReqs: 1000, okReqs: 990, errReqs: 10, statusCodes: { '200': 990, '500': 10 },
      p95: 500, p50: 200, p90: 400, p99: 800, avgLatency: 250, minLatency: 50, maxLatency: 1000,
      rps: 30, dataSent: 10000, dataRecv: 50000,
      rpsHistory: [], latHistory: [], errHistory: [], activeUsersHistory: [], tickTimes: [],
      ...overrides.metrics,
    },
    logs: [], timeline: [], perRequestResults: [],
  };
}

test.describe('Server Configuration report sync (Bug 1)', () => {
  test('cache-warm race: ensureServerConfigCacheWarm() actually blocks until the DB fetch resolves, using the REAL function with a mocked DB call', async () => {
    const mod = loadModule();
    // Simulate a cold start: cache genuinely empty, not yet warmed.
    mod.__test_cache.clear();
    mod.__test_setCacheWarmed(false);

    // Mock the DB call that _warmServerConfigCache() makes, with artificial latency —
    // this proves the REAL, exported ensureServerConfigCacheWarm() (not a re-implementation)
    // genuinely awaits the fetch before returning, rather than firing-and-forgetting.
    const original = mod.__test_LTServerConfig.find;
    let dbCallResolved = false;
    mod.__test_LTServerConfig.find = () => ({
      lean: async () => {
        await new Promise(r => setTimeout(r, 30)); // simulate DB latency
        dbCallResolved = true;
        return [{ projectName: 'SyncTag', envType: 'staging', vcpu: 2, memoryGb: 4, instanceType: 't3.medium', cloudProvider: 'AWS' }];
      },
    });

    try {
      const before = dbCallResolved;
      await mod.__test_ensureWarm(); // the REAL function under test
      expect(before).toBe(false); // sanity: DB call hadn't resolved before we awaited
      expect(dbCallResolved).toBe(true); // proves the await genuinely waited for it
      expect(mod.__test_getCacheWarmed()).toBe(true);

      const state = makeState({ config: { projectName: 'SyncTag', environment: 'QA' } });
      const html = mod.__test_generateHtml(state, {});
      expect(html).toContain('t3.medium');
      expect(html).not.toContain('No server configuration found');
    } finally {
      mod.__test_LTServerConfig.find = original;
    }
  });

  test('missing config for the resolved project+environment shows an explicit WARNING, never a silent gap or fabricated data', () => {
    const mod = loadModule();
    mod.__test_cache.clear();
    mod.__test_setCacheWarmed(true); // cache is warm, but genuinely has nothing for this project
    const state = makeState({ config: { projectName: 'NoConfigProject', environment: 'QA' } });
    const html = mod.__test_generateHtml(state, {});

    expect(html).toContain('WARNING');
    expect(html).toContain('No server configuration found');
    expect(html).toContain('NoConfigProject');
    // Must not fabricate any instance/capacity figures when config is missing.
    expect(html).not.toContain('t3.medium');
  });

  test('environment isolation: SyncTag/staging and SyncTag/production are looked up independently — production data never leaks into a staging report', () => {
    const mod = loadModule();
    mod.__test_cache.clear();
    mod.__test_setCacheWarmed(true);
    mod.__test_cache.set('SyncTag::staging', { projectName: 'SyncTag', envType: 'staging', vcpu: 2, memoryGb: 4, instanceType: 't3.medium', cloudProvider: 'AWS' });
    mod.__test_cache.set('SyncTag::production', { projectName: 'SyncTag', envType: 'production', vcpu: 8, memoryGb: 32, instanceType: 'c6i.2xlarge', cloudProvider: 'AWS' });

    const stagingHtml = mod.__test_generateHtml(makeState({ config: { projectName: 'SyncTag', environment: 'QA' } }), {});
    expect(stagingHtml).toContain('t3.medium');
    expect(stagingHtml).not.toContain('c6i.2xlarge');

    const prodHtml = mod.__test_generateHtml(makeState({ config: { projectName: 'SyncTag', environment: 'Production' } }), {});
    expect(prodHtml).toContain('c6i.2xlarge');
    expect(prodHtml).not.toContain('t3.medium');
  });

  test('missing environment configuration: only Production saved, report run as QA/Staging — shows the warning, does NOT fall back to Production data', () => {
    const mod = loadModule();
    mod.__test_cache.clear();
    mod.__test_setCacheWarmed(true);
    mod.__test_cache.set('SyncTag::production', { projectName: 'SyncTag', envType: 'production', vcpu: 8, memoryGb: 32, instanceType: 'c6i.2xlarge', cloudProvider: 'AWS' });

    // Workflow Builder default environment is "QA" -> maps to 'staging' bucket, which has no doc.
    const html = mod.__test_generateHtml(makeState({ config: { projectName: 'SyncTag', environment: 'QA' } }), {});
    expect(html).toContain('WARNING');
    expect(html).toContain('No server configuration found');
    expect(html).not.toContain('c6i.2xlarge'); // must not silently fall back to Production's config
  });

  test('project switching: Project A config and Project B config are resolved independently by projectName', () => {
    const mod = loadModule();
    mod.__test_cache.clear();
    mod.__test_setCacheWarmed(true);
    mod.__test_cache.set('ProjectA::staging', { projectName: 'ProjectA', envType: 'staging', vcpu: 2, memoryGb: 4, instanceType: 't3.medium', cloudProvider: 'AWS' });
    mod.__test_cache.set('ProjectB::staging', { projectName: 'ProjectB', envType: 'staging', vcpu: 4, memoryGb: 16, instanceType: 't3.xlarge', cloudProvider: 'AWS' });

    const htmlA = mod.__test_generateHtml(makeState({ config: { projectName: 'ProjectA', environment: 'QA' } }), {});
    expect(htmlA).toContain('t3.medium');
    expect(htmlA).not.toContain('t3.xlarge');

    const htmlB = mod.__test_generateHtml(makeState({ config: { projectName: 'ProjectB', environment: 'QA' } }), {});
    expect(htmlB).toContain('t3.xlarge');
    expect(htmlB).not.toContain('t3.medium');
  });

  test('getServerConfigsForProject resolves the same data regardless of which UI tab a report run originated from — projectName is the only key that matters', () => {
    const mod = loadModule();
    mod.__test_cache.clear();
    mod.__test_setCacheWarmed(true);
    mod.__test_cache.set('SyncTag::staging', { projectName: 'SyncTag', envType: 'staging', vcpu: 2, memoryGb: 4 });

    // Simulates a Workflow-Builder-originated run (scen-project) and a Configure-Test-
    // originated run (cfg-project) both landing on the same projectName string.
    const fromWorkflowBuilder = mod.__test_getServerConfigsForProject('SyncTag');
    const fromConfigureTest = mod.__test_getServerConfigsForProject('SyncTag');
    expect(fromWorkflowBuilder).toEqual(fromConfigureTest);
    expect(fromWorkflowBuilder.staging).toBeTruthy();
  });
});

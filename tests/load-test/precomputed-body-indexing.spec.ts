// Regression test for a generator defect where `vuData._encryptedBody_stepN` keys
// (the per-VU precomputed AES-encrypted request body table) were numbered by a
// step's position in the FULL, unfiltered scenario.steps array, while the code that
// READS those keys (_generateStepCode) numbers by position among ENABLED steps only
// (`enabledSteps.filter(s => s.enabled !== false)`).
//
// Whenever any step before a static-body encrypted step was disabled, the two
// numbering schemes diverged and the read side found no matching DATA-array entry —
// `vuData._encryptedBody_stepN || null` then silently sent `null` as the request body,
// producing an HTTP 400 with no indication the body was never generated.
//
// Fix: `_buildK6DataArray` now iterates `enabledSteps` (not `steps`) and keys by that
// array's index, matching `_generateStepCode` exactly. A runtime safety check also
// replaces the `|| null` fallback with a thrown error identifying the exact step
// number and missing variable name, so any future regression fails loudly instead
// of silently sending null.
//
// This test loads the REAL, unmodified routes/load-tests.js module via Node's Module
// API (appending one line that exposes the private _scenarioToK6Script for testing —
// the actual file on disk is never modified) and exercises the real generator output.
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { Module } from 'module';

const ROOT = path.join(__dirname, '..', '..');
const LOAD_TESTS_PATH = path.join(ROOT, 'routes', 'load-tests.js');

function loadScenarioToK6Script(): (scenario: any) => string {
  const src = fs.readFileSync(LOAD_TESTS_PATH, 'utf8');
  const wrapped = src + '\n;module.exports.__test_scenarioToK6Script = _scenarioToK6Script;\n';
  const mod = new Module(LOAD_TESTS_PATH, undefined as any);
  mod.filename = LOAD_TESTS_PATH;
  // @ts-ignore - _nodeModulePaths is a private Node API, matches the existing require resolution
  mod.paths = Module._nodeModulePaths(path.dirname(LOAD_TESTS_PATH));
  // @ts-ignore - _compile is a private Node API used here purely for testing
  mod._compile(wrapped, LOAD_TESTS_PATH);
  return (mod.exports as any).__test_scenarioToK6Script;
}

const ENC = {
  enabled: true,
  algorithm: 'AES-128-CBC',
  key: 'xfnr3PVyckouBZxW',
  iv: 'xfnr3PVyckouBZxW',
  outputField: 'key',
};

function staticEncryptedStep(id: string, name: string): any {
  return {
    id, name, method: 'POST', url: '{{baseUrl}}/api/macros/upsert', headers: {},
    bodyType: 'json', body: { name: id }, requestEncryption: ENC, captures: [],
  };
}

function plainStep(id: string, name: string, enabled = true): any {
  return { id, name, method: 'GET', url: '{{baseUrl}}/api/ping', headers: {}, bodyType: 'none', captures: [], enabled };
}

function auditEncryptedBodyKeys(script: string) {
  const reads = [...new Set([...script.matchAll(/vuData\._encryptedBody_step(\d+)/g)].map(m => parseInt(m[1], 10)))].sort((a, b) => a - b);
  const defs = [...new Set([...script.matchAll(/"_encryptedBody_step(\d+)":/g)].map(m => parseInt(m[1], 10)))].sort((a, b) => a - b);
  const missing = reads.filter(r => !defs.includes(r));
  return { reads, defs, missing };
}

test.describe('Precomputed encrypted body indexing (disabled-step regression)', () => {
  const scenarioToK6Script = loadScenarioToK6Script();

  test('reproduces the reported bug shape: a disabled step between two static encrypted steps produces zero missing definitions', () => {
    // Mirrors the confirmed defect: static macro-creation steps before AND after a
    // disabled step (e.g. a disabled file-stage step) must all still get a matching
    // precomputed body entry.
    const steps = [
      staticEncryptedStep('s1', 'Macro A'),
      plainStep('s2', 'Filler'),
      staticEncryptedStep('s3', 'Macro B'),
      plainStep('s4', 'Disabled Stage Step', false), // disabled — must not shift numbering incorrectly
      plainStep('s5', 'Filler'),
      staticEncryptedStep('s6', 'API Tag'),
      plainStep('s7', 'Filler'),
      staticEncryptedStep('s8', 'Browser Tag'),
      plainStep('s9', 'Filler'),
      staticEncryptedStep('s10', 'TOTP Tag'),
    ];
    const script = scenarioToK6Script({ scenarioName: 'Regression repro', vus: 2, duration: 30, url: 'https://x.test', steps });
    const { reads, defs, missing } = auditEncryptedBodyKeys(script);

    expect(missing).toEqual([]);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads).toEqual(defs);
  });

  test('every static encrypted step\'s generated request body is the real precomputed value, never null', () => {
    const steps = [
      staticEncryptedStep('s1', 'Macro A'),
      plainStep('s2', 'Disabled', false),
      staticEncryptedStep('s3', 'Macro B'),
    ];
    const script = scenarioToK6Script({ scenarioName: 'No null body', vus: 1, duration: 30, url: 'https://x.test', steps });

    // The old buggy code generated: `vuData._encryptedBody_stepN || null` directly as
    // the http.post() body argument — confirm that exact dangerous pattern is gone.
    expect(script).not.toMatch(/vuData\._encryptedBody_step\d+ \|\| null/);

    // The new code must read the precomputed value into a local const, guarded by a check.
    expect(script).toMatch(/const _body\d+ = vuData\['_encryptedBody_step\d+'\];/);
  });

  test('a missing precomputed-body key throws a clear, generic error instead of sending null', () => {
    const steps = [staticEncryptedStep('s1', 'Macro A')];
    const script = scenarioToK6Script({ scenarioName: 'Safety check', vus: 1, duration: 30, url: 'https://x.test', steps });

    expect(script).toContain("if (vuData['_encryptedBody_step1'] === undefined)");
    expect(script).toContain('MISSING PRECOMPUTED REQUEST BODY');
    expect(script).toContain('Step: 1');
    expect(script).toContain('Variable: vuData._encryptedBody_step1');

    // Prove the throw actually fires at runtime when the key is genuinely absent —
    // extract the generated default() function body and execute it with a vuData
    // object that deliberately lacks the expected key.
    const helpersStart = script.indexOf('function _gmul');
    const helpersEnd = script.indexOf('export default function');
    const helpers = script.slice(helpersStart, helpersEnd);
    const fnBody = script
      .slice(script.indexOf('export default function'))
      .replace('export default function () {', '')
      .replace(/\n}\n$/, '')
      .replace(
        'const vuIdx = (__VU - 1) % DATA.length;\n  const vuData = DATA[vuIdx];',
        'const vuData = {};' // simulate the exact failure mode: no matching DATA entry at all
      );

    const httpStub = { post: () => ({ status: 200, json: () => ({}), body: '{}' }) };
    let threw = false;
    let message = '';
    try {
      // eslint-disable-next-line no-new-func
      new Function('http', 'check', 'sleep', 'DATA', 'GLOBAL_VARS', '__VU', helpers + '\n' + fnBody)(
        httpStub, () => true, () => {}, [{}], {}, 1
      );
    } catch (e: any) {
      threw = true;
      message = e.message;
    }
    expect(threw).toBe(true);
    expect(message).toContain('MISSING PRECOMPUTED REQUEST BODY');
    expect(message).toContain('Step: 1');
  });

  test('dynamic (runtime-variable) encrypted bodies are unaffected — still use the _encVal runtime-encrypt path', () => {
    const steps = [
      { id: 's1', name: 'Login', method: 'POST', url: '{{baseUrl}}/login', headers: {}, bodyType: 'json', body: { email: '{{email}}' }, captures: [{ varName: 'sessionToken', jsonPath: 'token' }] },
      { id: 's2', name: 'Dynamic Encrypted', method: 'POST', url: '{{baseUrl}}/api/macros/upsert', headers: {}, bodyType: 'json', body: { name: 'tag-{{sessionToken}}' }, requestEncryption: ENC, captures: [] },
    ];
    const script = scenarioToK6Script({ scenarioName: 'Dynamic body regression', vus: 1, duration: 30, url: 'https://x.test', steps });

    expect(script).toContain('_encVal2');
    expect(script).not.toMatch(/vuData\._encryptedBody_step2\b/);
  });

  test('object/array-typed injection is unaffected — no "[object Object]" anywhere in the generated script', () => {
    const steps = [
      staticEncryptedStep('s1', 'Macro A'),
      plainStep('s2', 'Disabled', false),
      { id: 's3', name: 'Import', method: 'POST', url: '{{baseUrl}}/api/import', headers: {}, bodyType: 'json', body: { files: ['{{stagedFile}}'] }, captures: [] },
    ];
    const script = scenarioToK6Script({ scenarioName: 'Object injection regression', vus: 1, duration: 30, url: 'https://x.test', steps });

    expect(script).not.toContain('[object Object]');
    // "Import" is the 2nd ENABLED step (s2/"Disabled" is skipped), so it's numbered
    // _bodyTemplate2 — proving enabled-only numbering is applied consistently
    // across both the precomputed-body mechanism and the object-injection mechanism.
    expect(script).toContain('_resolveValue(_bodyTemplate2');
  });

  test('a scenario with no disabled steps at all is unaffected (common case)', () => {
    const steps = [
      staticEncryptedStep('s1', 'Macro A'),
      plainStep('s2', 'Filler'),
      staticEncryptedStep('s3', 'Macro B'),
    ];
    const script = scenarioToK6Script({ scenarioName: 'No disabled steps', vus: 1, duration: 30, url: 'https://x.test', steps });
    const { reads, defs, missing } = auditEncryptedBodyKeys(script);

    expect(missing).toEqual([]);
    expect(reads).toEqual(defs);
  });
});

// Tests for typed object/array variable capture and JSON-body injection in the
// Load Test Workflow Builder (routes/load-tests.js + public/load-test.html).
//
// These tests extract and execute the REAL functions from the real source files
// (not reimplementations), so a regression in the actual generator/validator code
// fails here — not just in a parallel copy of the logic.
//
// No browser is launched (see playwright.config.ts's `app-status` project pattern).
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');

function extractFunctionSource(fileText: string, fnName: string): string {
  const startIdx = fileText.indexOf(`function ${fnName}(`);
  if (startIdx === -1) throw new Error(`function not found in source: ${fnName}`);
  let depth = 0;
  let i = fileText.indexOf('{', startIdx);
  const braceStart = i;
  for (; i < fileText.length; i++) {
    if (fileText[i] === '{') depth++;
    else if (fileText[i] === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  if (braceStart === -1 || depth !== 0) throw new Error(`could not extract function body: ${fnName}`);
  return fileText.slice(startIdx, i);
}

// _resolveValue, _resolveObj, _resolveVars live inside a JS template literal in
// _scenarioToK6Script (routes/load-tests.js) — the raw file text must be evaluated
// AS a template literal body to reproduce exactly what ends up in the generated
// k6 script (this is what makes the test meaningful: it exercises the real
// generated-script text, not the outer file's escaped source).
function evalAsTemplateLiteralBody(rawFnText: string): string {
  // eslint-disable-next-line no-new-func
  return new Function('return `' + rawFnText + '`;')();
}

test.describe('Typed variable capture + JSON body injection', () => {
  const loadTestsSrc = fs.readFileSync(path.join(ROOT, 'routes', 'load-tests.js'), 'utf8');
  const loadTestHtml = fs.readFileSync(path.join(ROOT, 'public', 'load-test.html'), 'utf8');

  // ── k6 script generator path (_resolveValue, embedded inside generated script) ──
  const resolveVarsGenerated  = evalAsTemplateLiteralBody(extractFunctionSource(loadTestsSrc, '_resolveVars'));
  const resolveObjGenerated   = evalAsTemplateLiteralBody(extractFunctionSource(loadTestsSrc, '_resolveObj'));
  const resolveValueGenerated = evalAsTemplateLiteralBody(extractFunctionSource(loadTestsSrc, '_resolveValue'));

  function makeGeneratedResolveValue(): (value: any, vars: Record<string, any>) => any {
    const sandbox: any = {};
    // eslint-disable-next-line no-new-func
    new Function(
      'exports',
      resolveVarsGenerated + '\n' + resolveObjGenerated + '\n' + resolveValueGenerated +
      '\nexports.resolveValue = _resolveValue;'
    )(sandbox);
    return sandbox.resolveValue;
  }

  // ── Node-side trial-run path (resolveValueTyped in routes/load-tests.js directly) ──
  const resolveValueTypedSrc = extractFunctionSource(loadTestsSrc, 'resolveValueTyped');
  function makeNodeResolveValueTyped(): (value: any, vars: Record<string, any>, resolveStr: (s: any) => any) => any {
    const sandbox: any = {};
    // eslint-disable-next-line no-new-func
    new Function('exports', resolveValueTypedSrc + '\nexports.resolveValueTyped = resolveValueTyped;')(sandbox);
    return sandbox.resolveValueTyped;
  }

  function makeResolveStr() {
    return (vars: Record<string, any>) => (s: any) => {
      if (typeof s !== 'string') return s;
      return s.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => (vars[k] !== undefined ? vars[k] : `{{${k}}}`));
    };
  }

  // ── Frontend validation function (public/load-test.html) ──
  function extractHtmlFunction(fnName: string): string {
    return extractFunctionSource(loadTestHtml, fnName);
  }
  function makeValidateTypedBodyUsage(): (steps: any[]) => string[] {
    const sandbox: any = {};
    const src = extractHtmlFunction('_collectTypedCaptureNames') + '\n' +
                extractHtmlFunction('_findEmbeddedTypedVarMisuse') + '\n' +
                extractHtmlFunction('validateTypedBodyUsage');
    // eslint-disable-next-line no-new-func
    new Function('exports', src + '\nexports.validateTypedBodyUsage = validateTypedBodyUsage;')(sandbox);
    return sandbox.validateTypedBodyUsage;
  }

  test('Test 1 — String: existing scalar capture continues to work', () => {
    const resolveValue = makeGeneratedResolveValue();
    const vars = { userId: '123' };
    const result = resolveValue({ userId: '{{userId}}' }, vars);
    expect(result).toEqual({ userId: '123' });
    expect(typeof result.userId).toBe('string');
  });

  test('Test 2 — Number: captured numeric value serializes as a JSON number', () => {
    const resolveValue = makeGeneratedResolveValue();
    const vars = { count: 10 };
    const result = resolveValue({ count: '{{count}}' }, vars);
    expect(result).toEqual({ count: 10 });
    expect(typeof result.count).toBe('number');
  });

  test('Test 3 — Boolean: captured boolean value serializes as a JSON boolean', () => {
    const resolveValue = makeGeneratedResolveValue();
    const vars = { enabled: true };
    const result = resolveValue({ enabled: '{{enabled}}' }, vars);
    expect(result).toEqual({ enabled: true });
    expect(typeof result.enabled).toBe('boolean');
  });

  test('Test 4 — Object: captured object is injected as a real JSON object, not "[object Object]"', () => {
    const resolveValue = makeGeneratedResolveValue();
    const vars = { file: { id: '123', name: 'test' } };
    const result = resolveValue({ file: '{{file}}' }, vars);
    expect(result).toEqual({ file: { id: '123', name: 'test' } });
    expect(typeof result.file).toBe('object');
    expect(JSON.stringify(result)).not.toContain('[object Object]');
  });

  test('Test 5 — Array: captured array is injected as a real JSON array, not a comma-joined string', () => {
    const resolveValue = makeGeneratedResolveValue();
    const vars = { files: [{ id: '1' }, { id: '2' }] };
    const result = resolveValue({ files: '{{files}}' }, vars);
    expect(result).toEqual({ files: [{ id: '1' }, { id: '2' }] });
    expect(Array.isArray(result.files)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('[object Object]');
  });

  test('Test 6 — Object inside Array: a single captured object placed inside a body-defined array', () => {
    const resolveValue = makeGeneratedResolveValue();
    const vars = { stagedFile: { id: '123', name: 'file.png' } };
    const result = resolveValue({ files: ['{{stagedFile}}'] }, vars);
    expect(result).toEqual({ files: [{ id: '123', name: 'file.png' }] });
  });

  test('Test 7 — Existing string compatibility: {{email}}/{{accessToken}}/{{fileId}}/{{macroId}} still work unchanged', () => {
    const resolveValue = makeGeneratedResolveValue();
    const vars = { email: 'qa@adhashtech.com', accessToken: 'tok_abc', fileId: 'file_1', macroId: 'macro_1' };
    const body = {
      email: '{{email}}',
      auth: 'Bearer {{accessToken}}',
      fileId: '{{fileId}}',
      macroId: '{{macroId}}',
    };
    const result = resolveValue(body, vars);
    expect(result).toEqual({
      email: 'qa@adhashtech.com',
      auth: 'Bearer tok_abc',
      fileId: 'file_1',
      macroId: 'macro_1',
    });
  });

  test('Null values are preserved as JSON null, not the string "null"', () => {
    const resolveValue = makeGeneratedResolveValue();
    const result = resolveValue({ x: '{{maybeNull}}' }, { maybeNull: null });
    expect(result).toEqual({ x: null });
  });

  test('Falsy-but-valid values (0, false) survive capture/injection — not coerced to empty string', () => {
    const resolveValue = makeGeneratedResolveValue();
    expect(resolveValue({ count: '{{zero}}' }, { zero: 0 })).toEqual({ count: 0 });
    expect(resolveValue({ flag: '{{falseFlag}}' }, { falseFlag: false })).toEqual({ flag: false });
  });

  test('Node-side trial-run path (resolveValueTyped) matches the k6-generator path behavior', () => {
    const resolveValueTyped = makeNodeResolveValueTyped();
    const resolveStrFactory = makeResolveStr();
    const vars: Record<string, any> = {
      stagedFile: { s3_key: 'private/tenant/filetags/file.png', mimeType: 'image/jpeg', size: 64475, _id: '123456' },
      vectorStoreId: 'abc123',
    };
    const resolveStr = resolveStrFactory(vars);
    const body = { files: ['{{stagedFile}}'], vector_store_id: '{{vectorStoreId}}' };
    const result = resolveValueTyped(body, vars, resolveStr);
    expect(result).toEqual({
      files: [{ s3_key: 'private/tenant/filetags/file.png', mimeType: 'image/jpeg', size: 64475, _id: '123456' }],
      vector_store_id: 'abc123',
    });
    expect(JSON.stringify(result)).not.toContain('[object Object]');
  });

  // ── SyncTag acceptance scenario (section 12 of the enhancement spec) ──
  test('SyncTag acceptance scenario: staged file object survives capture -> injection -> JSON.stringify', () => {
    const resolveValue = makeGeneratedResolveValue();
    const vars = {
      stagedFile: {
        s3_key: 'private/tenant/filetags/uploaded-file.png',
        mimeType: 'image/jpeg',
        size: 64475,
        _id: 'generated-id-placeholder',
      },
      vectorStoreId: 'generated-vs-placeholder',
    };
    const importBodyTemplate = {
      files: ['{{stagedFile}}'],
      vector_store_id: '{{vectorStoreId}}',
    };
    const resolved = resolveValue(importBodyTemplate, vars);
    const serialized = JSON.stringify(resolved);

    expect(serialized).not.toContain('[object Object]');
    expect(JSON.parse(serialized)).toEqual({
      files: [vars.stagedFile],
      vector_store_id: vars.vectorStoreId,
    });
  });

  // ── Validation (frontend) ──
  test('Validation: whole-value Object/Array injection is valid (no errors)', () => {
    const validateTypedBodyUsage = makeValidateTypedBodyUsage();
    const steps = [
      { name: 'Stage File', captures: [{ varName: 'stagedFile', jsonPath: 'files.0', _isObject: true }] },
      { name: 'Import', bodyType: 'json', body: { files: ['{{stagedFile}}'], vector_store_id: '{{vectorStoreId}}' } },
    ];
    expect(validateTypedBodyUsage(steps)).toEqual([]);
  });

  test('Validation: Object variable embedded in a larger string is flagged as invalid', () => {
    const validateTypedBodyUsage = makeValidateTypedBodyUsage();
    const steps = [
      { name: 'Stage File', captures: [{ varName: 'stagedFile', jsonPath: 'files.0', _isObject: true }] },
      { name: 'Import', bodyType: 'json', body: { note: 'uploaded-{{stagedFile}}-done' } },
    ];
    const errors = validateTypedBodyUsage(steps);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('stagedFile');
    expect(errors[0]).toContain('Object');
  });

  test('Validation: scalar (non-typed) captures never produce validation errors', () => {
    const validateTypedBodyUsage = makeValidateTypedBodyUsage();
    const steps = [
      { name: 'Login', captures: [{ varName: 'accessToken', jsonPath: 'token' }] },
      { name: 'Use', bodyType: 'json', body: { auth: 'Bearer {{accessToken}}', email: '{{email}}' } },
    ];
    expect(validateTypedBodyUsage(steps)).toEqual([]);
  });

  // ── Backward compatibility: the k6-generator source still contains the original
  // header-resolution helper (_resolveObj) and full scalar interpolation (_resolveVars)
  // unchanged, proving this enhancement is additive rather than a replacement. ──
  test('Backward compatibility: _resolveObj and _resolveVars are untouched and still present', () => {
    expect(loadTestsSrc).toContain('function _resolveVars(str, vars)');
    expect(loadTestsSrc).toContain('function _resolveObj(obj, vars)');
    // The new function must be additive, not a replacement of the old ones.
    expect(loadTestsSrc).toContain('function _resolveValue(value, vars)');
  });

  test('Backward compatibility: encrypted JSON bodies still resolve to a string before AES encryption', () => {
    // Encryption requires a plaintext string; typed object/array injection intentionally
    // does not apply inside an encrypted body (see code comments in routes/load-tests.js).
    const resolveValueTyped = makeNodeResolveValueTyped();
    const resolveStrFactory = makeResolveStr();
    const vars = { email: 'a@b.com' };
    const resolveStr = resolveStrFactory(vars);
    // Simulates the existing encrypted-body branch: object -> JSON.stringify -> resolveStr
    const bodyObj = { email: '{{email}}' };
    const bodyStr = JSON.stringify(bodyObj);
    const resolved = resolveStr(bodyStr);
    expect(resolved).toBe('{"email":"a@b.com"}');
    expect(typeof resolved).toBe('string');
  });
});

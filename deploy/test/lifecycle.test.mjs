import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertQuiescent, assertSameSnapshot } from '../lifecycle.mjs';
import { validateStrictEnvironment } from '../../apps/manager-web/e2e/strict-policy.mjs';
import { assertStrictResults } from '../../apps/manager-web/e2e/strict-results.mjs';
import { buildStrictDiagnostic, writeStrictDiagnostic } from '../../apps/manager-web/e2e/strict-reporter.mjs';

test('rollback refuses active runs and every pending queue state', () => {
  assert.doesNotThrow(() => assertQuiescent(0, [{ paused: true, counts: { completed: 5, failed: 2, active: 0 } }]));
  assert.throws(() => assertQuiescent(1, []));
  for (const key of ['active', 'wait', 'waiting', 'paused', 'delayed', 'prioritized', 'waiting-children']) {
    assert.throws(() => assertQuiescent(0, [{ paused: true, counts: { [key]: 1 } }]));
  }
  assert.throws(() => assertQuiescent(0, [{ paused: false, counts: {} }]));
});

test('rollback rejects changed publication evidence even when counts match', () => {
  assert.doesNotThrow(() => assertSameSnapshot({ outbox: 'a', assignments: 3 }, { outbox: 'a', assignments: 3 }));
  assert.throws(() => assertSameSnapshot({ outbox: 'a', assignments: 3 }, { outbox: 'b', assignments: 3 }));
});

test('strict acceptance fails missing, skipped, failed and unexpectedly passing tests', () => {
  const passed = Array.from({ length: 48 }, () => ({ expectedStatus: 'passed', results: [{ status: 'passed' }] }));
  assert.doesNotThrow(() => assertStrictResults(passed));
  assert.throws(() => assertStrictResults([]));
  for (const status of ['skipped', 'failed', 'timedOut', 'interrupted']) {
    assert.throws(() => assertStrictResults([...passed, { expectedStatus: 'passed', results: [{ status }] }]));
  }
  assert.throws(() => assertStrictResults([...passed, { expectedStatus: 'failed', results: [{ status: 'passed' }] }]));
});

test('strict acceptance only targets its explicitly isolated rehearsal', () => {
  const env = { E2E_REHEARSAL_ID: 'abcdef012345', E2E_DATABASE_NAME: 'ultrakil_rehearsal_abcdef012345_test',
    E2E_BULLMQ_PREFIX: 'ultrakil-rehearsal-abcdef012345', E2E_BASE_URL: 'http://127.0.0.1:13000',
    E2E_API_URL: 'http://127.0.0.1:13001/api', E2E_DATE: '2026-09-07' };
  assert.doesNotThrow(() => validateStrictEnvironment(env));
  for (const patch of [{ E2E_DATABASE_NAME: 'ultrakil_staging' }, { E2E_REHEARSAL_ID: '' },
    { E2E_BASE_URL: 'https://pilot.example.com' }, { E2E_BULLMQ_PREFIX: 'ultrakil-staging' }]) {
    assert.throws(() => validateStrictEnvironment({ ...env, ...patch }));
  }
});

test('strict browser diagnostics expose only normalized allowlisted test evidence', () => {
  const privateText = 'secret-token https://example.invalid/private trace.zip';
  const diagnostic = buildStrictDiagnostic([{
    title: privateText,
    expectedStatus: 'passed',
    location: { file: `${process.cwd()}/apps/manager-web/e2e/02-generation.spec.ts`, line: 73 },
    annotations: [{ type: privateText }],
    results: [{ status: 'failed', error: {
      message: privateText,
      location: { file: `${process.cwd()}/apps/manager-web/e2e/02-generation.spec.ts`, line: 47 },
    }, attachments: [{ path: privateText }] }],
  }], 'failed');

  assert.deepEqual(diagnostic, {
    status: 'failed',
    counts: { total: 1, passed: 0, failed: 1, skipped: 0, timedOut: 0, interrupted: 0, notRun: 0, unexpected: 0 },
    failures: [{ file: '02-generation.spec.ts', line: 47, status: 'failed' }],
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret-token|example\.invalid|trace\.zip/);
});

test('strict browser diagnostics ignore non-source-controlled error locations', () => {
  const diagnostic = buildStrictDiagnostic([{
    expectedStatus: 'passed',
    location: { file: `${process.cwd()}/apps/manager-web/e2e/03-dispatch-and-lock.spec.ts`, line: 10 },
    results: [{ status: 'failed', error: { location: { file: '/tmp/private.spec.ts', line: 99 } } }],
  }], 'failed');
  assert.deepEqual(diagnostic.failures, [
    { file: '03-dispatch-and-lock.spec.ts', line: 10, status: 'failed' },
  ]);
});

test('strict browser diagnostics publish only allowlisted accessibility identifiers', () => {
  const diagnostic = buildStrictDiagnostic([{
    expectedStatus: 'passed',
    location: { file: `${process.cwd()}/apps/manager-web/e2e/05-accessibility.spec.ts`, line: 55 },
    annotations: [
      { type: 'strict-case', description: '/calendar' },
      { type: 'strict-axe-rule', description: 'color-contrast' },
      { type: 'strict-axe-rule', description: 'scrollable-region-focusable' },
      { type: 'strict-axe-rule', description: 'PRIVATE_TOKEN' },
      { type: 'private', description: 'https://example.invalid' },
    ],
    results: [{ status: 'failed' }],
  }], 'failed');
  assert.deepEqual(diagnostic.failures, [{
    file: '05-accessibility.spec.ts', line: 55, status: 'failed', case: '/calendar',
    axeRules: ['color-contrast', 'scrollable-region-focusable'],
  }]);
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_TOKEN|example\.invalid/);
});

test('strict browser diagnostics fail closed for non-source-controlled locations', () => {
  const diagnostic = buildStrictDiagnostic([
    { expectedStatus: 'passed', location: { file: '/tmp/private.spec.ts', line: 1 }, results: [{ status: 'timedOut' }] },
    { expectedStatus: 'failed', location: { file: `${process.cwd()}/apps/manager-web/e2e/01-customer-and-agreement.spec.ts`, line: 5 }, results: [{ status: 'passed' }] },
    { expectedStatus: 'passed', location: { file: `${process.cwd()}/apps/manager-web/e2e/03-dispatch-and-lock.spec.ts`, line: 8 }, results: [] },
  ], 'passed');

  assert.deepEqual(diagnostic, {
    status: 'failed',
    counts: { total: 3, passed: 0, failed: 0, skipped: 0, timedOut: 1, interrupted: 0, notRun: 1, unexpected: 1 },
    failures: [
      { file: '01-customer-and-agreement.spec.ts', line: 5, status: 'unexpected' },
      { file: '03-dispatch-and-lock.spec.ts', line: 8, status: 'notRun' },
    ],
  });
});

test('strict browser diagnostics normalize Playwright global timeout status', () => {
  const passed = Array.from({ length: 48 }, () => ({ expectedStatus: 'passed', results: [{ status: 'passed' }] }));
  assert.equal(buildStrictDiagnostic(passed, 'timedout').status, 'timedOut');
});

test('strict browser diagnostic writes replace the fallback atomically', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ulk-strict-diagnostic-'));
  const path = join(directory, 'strict-browser.json');
  const diagnostic = { status: 'failed', counts: { total: 1, passed: 0, failed: 1, skipped: 0, timedOut: 0, interrupted: 0, notRun: 0, unexpected: 0 },
    failures: [{ file: '02-generation.spec.ts', line: 73, status: 'failed' }] };
  try {
    writeStrictDiagnostic(path, diagnostic);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), diagnostic);
    assert.deepEqual(readdirSync(directory), ['strict-browser.json']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

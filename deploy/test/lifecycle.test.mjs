import test from 'node:test';
import assert from 'node:assert/strict';
import { assertQuiescent, assertSameSnapshot } from '../lifecycle.mjs';
import { assertStrictResults, validateStrictEnvironment } from '../../apps/manager-web/e2e/strict-policy.mjs';

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

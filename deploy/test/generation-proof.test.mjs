import test from 'node:test';
import assert from 'node:assert/strict';
import { assertGenerationPreview, assertGenerationPersisted } from '../../apps/manager-web/e2e/generation-proof.mjs';

const addition = { serviceAgreementId: 'synthetic-agreement', customerName: 'Synthetic Mixed',
  siteName: 'Synthetic Open Colombo', visitDate: '2026-09-07', windowStartMinute: 480,
  windowEndMinute: 1020, durationMinutes: 60, requiredCrewSize: 1, branchCode: 'COLOMBO' };
const preview = { isPreview: true, scheduleRunId: null, additions: [addition] };
const confirmation = { ...preview, isPreview: false, scheduleRunId: 'synthetic-new-run' };
const before = { items: [], total: 0 };
const after = { items: [{ ...addition, id: 'synthetic-new-visit' }], total: 1 };

test('strict preview requires positive additions including the deterministic imported fixture', () => {
  assert.doesNotThrow(() => assertGenerationPreview(preview));
  for (const candidate of [{ ...preview, additions: [], updates: [{}] }, { ...preview, additions: [], removals: [{}] },
    { ...preview, additions: [{ ...addition, customerName: 'Unexpected customer' }] }, { ...preview, isPreview: false }]) {
    assert.throws(() => assertGenerationPreview(candidate));
  }
});

test('a successful no-op or unpersisted confirm cannot satisfy strict generation', () => {
  assert.doesNotThrow(() => assertGenerationPersisted(preview, confirmation, before, after));
  for (const result of [{ ...confirmation, additions: [] }, { ...confirmation, scheduleRunId: null },
    { ...confirmation, isPreview: true }, { ...confirmation, additions: [{ ...addition, durationMinutes: 120 }] }]) {
    assert.throws(() => assertGenerationPersisted(preview, result, before, after));
  }
  assert.throws(() => assertGenerationPersisted(preview, confirmation, before, { items: [], total: 0 }));
  assert.throws(() => assertGenerationPersisted(preview, confirmation, after, after));
  assert.throws(() => assertGenerationPersisted(preview, confirmation, before, { ...after, total: 2 }));
  assert.throws(() => assertGenerationPersisted(preview, confirmation, before,
    { items: [{ ...addition, id: 'synthetic-new-visit', windowEndMinute: 500 }], total: 1 }));
});

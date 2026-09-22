import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const servicePath = new URL(
  '../../apps/api/src/scheduling/visit-generation/visit-generation.service.ts',
  import.meta.url,
);

test('bunching repair audit events identify the UUID batch row', async () => {
  const source = await readFile(servicePath, 'utf8');

  for (const action of [
    'visit_generation.repair_bunching_failed',
    'visit_generation.repair_bunching_applied',
  ]) {
    const actionIndex = source.indexOf(`action: '${action}'`);
    assert.notEqual(actionIndex, -1, `${action} audit event must exist`);

    const auditBlock = source.slice(Math.max(0, actionIndex - 180), actionIndex + 80);
    assert.match(auditBlock, /entityId: batchId/);
    assert.doesNotMatch(auditBlock, /entityId: input\.idempotencyKey/);
  }
});

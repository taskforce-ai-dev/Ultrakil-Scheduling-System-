import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationPath = new URL(
  '../../apps/api/prisma/migrations/20260920121729_repair_bunching_batches/migration.sql',
  import.meta.url,
);

test('legacy index renames tolerate independently normalized index names', async () => {
  const sql = await readFile(migrationPath, 'utf8');

  for (const [legacyName, normalizedName] of [
    [
      'assignment_notification_outbox_assignmentId_employeeId_eventTyp',
      'assignment_notification_outbox_assignmentId_employeeId_even_key',
    ],
    [
      'published_assignment_repair_items_repairId_sourceAssignmentId_k',
      'published_assignment_repair_items_repairId_sourceAssignment_key',
    ],
  ]) {
    assert.match(
      sql,
      new RegExp(
        `to_regclass\\('"${legacyName}"'\\) IS NOT NULL[\\s\\S]+?` +
          `to_regclass\\('"${normalizedName}"'\\) IS NULL`,
      ),
      `${legacyName} must only be renamed when it still exists and its normalized name does not`,
    );
  }
});

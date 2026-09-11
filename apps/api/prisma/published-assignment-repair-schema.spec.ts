import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('published assignment repair migration', () => {
  const sql = readFileSync(
    resolve(
      __dirname,
      'migrations/20260910143000_published_assignment_repair/migration.sql',
    ),
    'utf8',
  );

  it('prevents one source assignment from being repaired twice', () => {
    expect(sql).toContain(
      'published_assignment_repair_items_sourceAssignmentId_key',
    );
  });

  it('makes processed and cancelled notification states mutually exclusive', () => {
    expect(sql).toMatch(
      /CHECK \(NOT \("processedAt" IS NOT NULL AND "cancelledAt" IS NOT NULL\)\)/,
    );
  });
});

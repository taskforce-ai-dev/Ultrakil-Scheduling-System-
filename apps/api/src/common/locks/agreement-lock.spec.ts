import { Prisma } from '@prisma/client';

import { lockAgreementRows } from './agreement-lock';

/**
 * The order itself, pinned.
 *
 * Three writers depend on this being ascending id and nothing else: the
 * optimizer's persistence, generation's apply, and the workbook importer. Two
 * of them arrived here by deadlocking against the third, so the property is
 * worth a test of its own rather than being left as something the SQL happens
 * to do.
 */
describe('lockAgreementRows', () => {
  it('locks each row once, in ascending id order, FOR UPDATE', async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);

    await lockAgreementRows(
      { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient,
      ['c', 'a', 'b', 'a'],
    );

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const [statement] = queryRaw.mock.calls[0] as [Prisma.Sql];
    expect(statement.sql).toContain('service_agreements');
    expect(statement.sql).toContain('FOR UPDATE');
    // Sorted in the parameters and ordered again in the statement: the first
    // decides which rows the writer asks for, the second the sequence
    // Postgres takes them in. A writer that gets either wrong is the one that
    // deadlocks.
    expect(statement.sql).toContain('ORDER BY id');
    expect(statement.values).toEqual(['a', 'b', 'c']);
  });

  it('asks for nothing when there is nothing to lock', async () => {
    const queryRaw = jest.fn();
    await lockAgreementRows(
      { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient,
      [],
    );
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('refuses the change when one of the rows is no longer there', async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ id: 'a' }]);

    await expect(
      lockAgreementRows(
        { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient,
        ['a', 'gone'],
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
  });
});

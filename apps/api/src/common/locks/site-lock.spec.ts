import { Prisma } from '@prisma/client';

import { lockSiteRows } from './site-lock';

describe('lockSiteRows', () => {
  it('takes each site once in ascending id order before hours can change', async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ id: 'a' }, { id: 'b' }]);

    await lockSiteRows(
      { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient,
      ['b', 'a', 'b'],
    );

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const [statement] = queryRaw.mock.calls[0] as [Prisma.Sql];
    expect(statement.sql).toContain('service_sites');
    expect(statement.sql).toContain('ORDER BY id');
    expect(statement.sql).toContain('FOR UPDATE');
    expect(statement.values).toEqual(['a', 'b']);
  });

  it('rejects a missing site instead of reading unprotected hours', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    await expect(lockSiteRows(
      { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient,
      ['missing'],
    )).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
  });
});

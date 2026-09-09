import { BranchCode } from '@prisma/client';

import { importSchedule } from './importer';

describe('importSchedule transaction boundary', () => {
  it('allows each remote customer reconciliation up to two minutes', async () => {
    const stopped = new Error('stop before executing the transaction body');
    const prisma = {
      branch: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'colombo-branch', code: BranchCode.COLOMBO },
        ]),
      },
      $transaction: jest.fn().mockRejectedValue(stopped),
    };
    const parsed = {
      customers: [
        {
          name: 'Customer',
          isServiced: true,
          sourceSheet: 'Schedule',
          sites: [],
          agreements: [],
        },
      ],
      issues: [],
    };

    await expect(
      importSchedule(prisma as never, parsed as never),
    ).rejects.toBe(stopped);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 120_000,
    });
  });
});

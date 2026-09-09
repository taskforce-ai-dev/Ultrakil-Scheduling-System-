import { importMatrix } from './importer';

describe('importMatrix transaction boundary', () => {
  it('allows the supported remote operator import up to ten minutes', async () => {
    const stopped = new Error('stop before executing the transaction body');
    const prisma = {
      $transaction: jest.fn().mockRejectedValue(stopped),
    };

    await expect(importMatrix(prisma as never, {} as never)).rejects.toBe(
      stopped,
    );
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 600_000,
    });
  });
});

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

  it('refuses reserved synthetic vehicle identities before opening a transaction', async () => {
    const prisma = { $transaction: jest.fn() };
    const parsed = {
      vehicles: [{
        code: 'SYN-TEST-COLOMBO-01',
        label: 'SYNTHETIC/TEST collision',
        seatCapacity: 2,
        ownershipGroup: '__syntheticCapacity__',
      }],
      employees: [],
      skillColumns: [],
      vehicleColumns: [],
      publicTransportColumn: null,
      issues: [],
      unrecognisedGrades: [],
      headerRowNumber: 1,
    };

    await expect(importMatrix(prisma as never, parsed as never)).rejects.toThrow(
      'MATRIX_RESERVED_SYNTHETIC_VEHICLE_IDENTITY',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

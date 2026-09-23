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

  it.each([
    ['code case variant', 'syn-test-colombo-01', 'Ordinary vehicle', 'COMPANY'],
    ['code punctuation variant', 'SYN_TEST_COLOMBO_01', 'Ordinary vehicle', 'COMPANY'],
    ['label case variant', 'ABC-1234', 'synthetic/test collision', 'COMPANY'],
    ['ownership marker variant', 'ABC-1234', 'Ordinary vehicle', '__SYNTHETIC_CAPACITY__'],
  ])('refuses reserved synthetic vehicle identities before opening a transaction: %s', async (
    _case,
    code,
    label,
    ownershipGroup,
  ) => {
    const prisma = { $transaction: jest.fn() };
    const parsed = {
      vehicles: [{
        code,
        label,
        seatCapacity: 2,
        ownershipGroup,
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

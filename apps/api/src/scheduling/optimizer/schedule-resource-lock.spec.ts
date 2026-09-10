import { Prisma } from '@prisma/client';

import * as scheduleVisitLock from './schedule-visit-lock';

describe('lockScheduleResources', () => {
  it('locks unique employees then vehicles in deterministic id order', async () => {
    const lockScheduleResources = (
      scheduleVisitLock as unknown as {
        lockScheduleResources?: (
          tx: Prisma.TransactionClient,
          employeeIds: string[],
          vehicleIds: string[],
        ) => Promise<void>;
      }
    ).lockScheduleResources;
    expect(lockScheduleResources).toBeDefined();
    if (!lockScheduleResources) return;

    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'employee-a' }, { id: 'employee-b' }])
      .mockResolvedValueOnce([{ id: 'vehicle-a' }, { id: 'vehicle-b' }]);

    await lockScheduleResources(
      { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient,
      ['employee-b', 'employee-a', 'employee-b'],
      ['vehicle-b', 'vehicle-a', 'vehicle-b'],
    );

    expect(queryRaw).toHaveBeenCalledTimes(2);
    const [employeeQuery] = queryRaw.mock.calls[0] as [Prisma.Sql];
    const [vehicleQuery] = queryRaw.mock.calls[1] as [Prisma.Sql];
    expect(employeeQuery.sql).toContain('employees');
    expect(employeeQuery.sql).toContain('FOR UPDATE');
    expect(employeeQuery.values).toEqual(['employee-a', 'employee-b']);
    expect(vehicleQuery.sql).toContain('vehicles');
    expect(vehicleQuery.sql).toContain('FOR UPDATE');
    expect(vehicleQuery.values).toEqual(['vehicle-a', 'vehicle-b']);
  });

  it('rejects a resource set when a requested row disappeared', async () => {
    const lockScheduleResources = scheduleVisitLock.lockScheduleResources;
    const queryRaw = jest.fn().mockResolvedValue([]);

    await expect(
      lockScheduleResources(
        { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient,
        ['employee-missing'],
        [],
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
  });
});

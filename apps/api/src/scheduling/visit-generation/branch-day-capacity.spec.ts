import { BranchCode } from '@prisma/client';

import {
  BranchDayResourceFacts,
  BranchResourcePool,
  computeBranchDayCapacity,
  factsForDate,
} from './branch-day-capacity';

function facts(overrides: Partial<BranchDayResourceFacts> = {}): BranchDayResourceFacts {
  return {
    branchCode: BranchCode.COLOMBO,
    date: '2026-09-23',
    availableEmployeeCount: 10,
    totalEmployeeCount: 10,
    hasAvailablePmsSupervisor: true,
    activeVehicleCount: 3,
    driverCapableVehicleCount: 3,
    ...overrides,
  };
}

describe('computeBranchDayCapacity', () => {
  it("does not make a valid 4-hour, 4-person job impossible on a branch that has enough people — the Technical Director's own counterexample", () => {
    // The old flat 720-minute constant made 240 * 4 = 960 crew-minutes
    // impossible everywhere. Ten available people at 480 minutes each is
    // 4800 crew-minutes — comfortably enough for a single 960-minute job.
    const result = computeBranchDayCapacity(facts({ availableEmployeeCount: 10 }));
    expect(result.capacityMinutes).toBeGreaterThanOrEqual(960);
  });

  it('scales with real headcount, not a company-wide constant', () => {
    // Vehicles held generously so employee headcount is the only thing
    // varying between the two branch-days under test.
    const small = computeBranchDayCapacity(
      facts({ availableEmployeeCount: 2, activeVehicleCount: 20, driverCapableVehicleCount: 20 }),
    );
    const large = computeBranchDayCapacity(
      facts({ availableEmployeeCount: 20, activeVehicleCount: 20, driverCapableVehicleCount: 20 }),
    );
    expect(small.capacityMinutes).toBe(2 * 480);
    expect(large.capacityMinutes).toBe(20 * 480);
    expect(large.capacityMinutes).toBeGreaterThan(small.capacityMinutes);
  });

  it('is zero when the branch has nobody PMS-grade available that day — the Kandy case', () => {
    const result = computeBranchDayCapacity(
      facts({ availableEmployeeCount: 50, hasAvailablePmsSupervisor: false }),
    );
    expect(result.capacityMinutes).toBe(0);
    expect(result.reason).toBe('NO_PMS_SUPERVISOR');
  });

  it('is zero when the branch owns vehicles but none has an available authorized driver today', () => {
    const result = computeBranchDayCapacity(
      facts({ activeVehicleCount: 5, driverCapableVehicleCount: 0 }),
    );
    expect(result.capacityMinutes).toBe(0);
    expect(result.reason).toBe('NO_AVAILABLE_DRIVER');
  });

  it('does not vehicle-gate a branch that owns no vehicles at all', () => {
    // An all-public-transport branch is not penalised for owning none.
    const result = computeBranchDayCapacity(
      facts({ availableEmployeeCount: 8, activeVehicleCount: 0, driverCapableVehicleCount: 0 }),
    );
    expect(result.capacityMinutes).toBe(8 * 480);
    expect(result.reason).toBeNull();
  });

  it('bounds capacity by whichever real resource runs out first', () => {
    // Plenty of people, but only one vehicle with a driver today.
    const result = computeBranchDayCapacity(
      facts({ availableEmployeeCount: 20, activeVehicleCount: 4, driverCapableVehicleCount: 1 }),
    );
    expect(result.capacityMinutes).toBe(1 * 480);
  });

  it('respects a configured employee-workday length', () => {
    const result = computeBranchDayCapacity(facts({ availableEmployeeCount: 3 }), 360);
    expect(result.capacityMinutes).toBe(3 * 360);
  });

  it('falls back to the configured constant for a branch with no workforce imported at all', () => {
    const result = computeBranchDayCapacity(
      facts({ totalEmployeeCount: 0, availableEmployeeCount: 0, hasAvailablePmsSupervisor: false }),
      480,
      720,
    );
    expect(result.capacityMinutes).toBe(720);
    expect(result.reason).toBe('NO_WORKFORCE_RECORDED');
  });

  it('does not fall back once the branch has any workforce on record, even if none is available today', () => {
    const result = computeBranchDayCapacity(
      facts({ totalEmployeeCount: 5, availableEmployeeCount: 0, hasAvailablePmsSupervisor: false }),
      480,
      720,
    );
    expect(result.capacityMinutes).toBe(0);
    expect(result.reason).toBe('NO_PMS_SUPERVISOR');
  });
});

describe('factsForDate', () => {
  function pool(overrides: Partial<BranchResourcePool> = {}): BranchResourcePool {
    return {
      employees: [
        { id: 'e1', isPmsGrade: true },
        { id: 'e2', isPmsGrade: false },
        { id: 'e3', isPmsGrade: false },
      ],
      unavailability: [],
      vehicles: [{ id: 'v1', authorizedEmployeeIds: ['e2'] }],
      ...overrides,
    };
  }

  it('counts every employee available when nobody is on leave that date', () => {
    const result = factsForDate(pool(), BranchCode.COLOMBO, '2026-09-23');
    expect(result.availableEmployeeCount).toBe(3);
    expect(result.hasAvailablePmsSupervisor).toBe(true);
  });

  it('excludes an employee on leave that specific date, and includes them outside it', () => {
    const withLeave = pool({
      unavailability: [{ employeeId: 'e1', startDate: '2026-09-23', endDate: '2026-09-23' }],
    });
    const onLeave = factsForDate(withLeave, BranchCode.COLOMBO, '2026-09-23');
    expect(onLeave.availableEmployeeCount).toBe(2);
    // e1 was the only PMS-grade employee.
    expect(onLeave.hasAvailablePmsSupervisor).toBe(false);

    const dayAfter = factsForDate(withLeave, BranchCode.COLOMBO, '2026-09-24');
    expect(dayAfter.availableEmployeeCount).toBe(3);
    expect(dayAfter.hasAvailablePmsSupervisor).toBe(true);
  });

  it("a vehicle whose only authorized driver is on leave that day is not driver-capable", () => {
    const withLeave = pool({
      unavailability: [{ employeeId: 'e2', startDate: '2026-09-23', endDate: '2026-09-23' }],
    });
    const result = factsForDate(withLeave, BranchCode.COLOMBO, '2026-09-23');
    expect(result.activeVehicleCount).toBe(1);
    expect(result.driverCapableVehicleCount).toBe(0);
  });

  it('a vehicle authorized to several employees stays driver-capable if any one of them is available', () => {
    const shared = pool({
      vehicles: [{ id: 'v1', authorizedEmployeeIds: ['e2', 'e3'] }],
      unavailability: [{ employeeId: 'e2', startDate: '2026-09-23', endDate: '2026-09-23' }],
    });
    const result = factsForDate(shared, BranchCode.COLOMBO, '2026-09-23');
    expect(result.driverCapableVehicleCount).toBe(1);
  });
});

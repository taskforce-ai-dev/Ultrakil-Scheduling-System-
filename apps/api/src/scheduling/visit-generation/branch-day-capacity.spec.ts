import { BranchCode } from '@prisma/client';

import {
  BranchDayResourceFacts,
  BranchResourcePool,
  computeBranchDayCapacity,
  factsForDate,
  workforceForDate,
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
    transportCapableConcurrentCrews: 3,
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
      facts({
        availableEmployeeCount: 2,
        activeVehicleCount: 20,
        driverCapableVehicleCount: 20,
        transportCapableConcurrentCrews: 20,
      }),
    );
    const large = computeBranchDayCapacity(
      facts({
        availableEmployeeCount: 20,
        activeVehicleCount: 20,
        driverCapableVehicleCount: 20,
        transportCapableConcurrentCrews: 20,
      }),
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
      facts({ activeVehicleCount: 5, driverCapableVehicleCount: 0, transportCapableConcurrentCrews: 0 }),
    );
    expect(result.capacityMinutes).toBe(0);
    expect(result.reason).toBe('NO_AVAILABLE_DRIVER');
  });

  it('is not zero-capacity when nobody can drive but staff can still travel by public transport', () => {
    const result = computeBranchDayCapacity(
      facts({
        availableEmployeeCount: 4,
        activeVehicleCount: 5,
        driverCapableVehicleCount: 0,
        transportCapableConcurrentCrews: 2,
      }),
    );
    expect(result.capacityMinutes).toBe(2 * 480);
    expect(result.reason).toBeNull();
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
      facts({
        availableEmployeeCount: 20,
        activeVehicleCount: 4,
        driverCapableVehicleCount: 1,
        transportCapableConcurrentCrews: 1,
      }),
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
        { id: 'e1', isPmsGrade: true, skillCodes: [], canUsePublicTransport: true },
        { id: 'e2', isPmsGrade: false, skillCodes: [], canUsePublicTransport: true },
        { id: 'e3', isPmsGrade: false, skillCodes: [], canUsePublicTransport: true },
      ],
      unavailability: [],
      vehicles: [{ id: 'v1', seatCapacity: null, authorizedEmployeeIds: ['e2'] }],
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
      vehicles: [{ id: 'v1', seatCapacity: null, authorizedEmployeeIds: ['e2', 'e3'] }],
      unavailability: [{ employeeId: 'e2', startDate: '2026-09-23', endDate: '2026-09-23' }],
    });
    const result = factsForDate(shared, BranchCode.COLOMBO, '2026-09-23');
    expect(result.driverCapableVehicleCount).toBe(1);
  });

  // The Technical Director's review, item 1: authorization rows are never
  // pruned to match branch or active status, so `pool.vehicles` can carry an
  // id for someone who is not in `pool.employees` at all — the same shape a
  // Kandy employee or a deactivated Colombo employee's authorization has,
  // since `BranchDayCapacityService.loadPool` only ever populates
  // `pool.employees` with this branch's own active roster.
  it("a vehicle authorized only to someone outside this branch's active roster is not driver-capable", () => {
    const withOutsider = pool({
      // No walkers in this branch's own roster, so the only way
      // transportCapableConcurrentCrews could read nonzero is the outsider's
      // authorization wrongly counting.
      employees: [{ id: 'e1', isPmsGrade: true, skillCodes: [], canUsePublicTransport: false }],
      vehicles: [{ id: 'v1', seatCapacity: null, authorizedEmployeeIds: ['kandy-employee-not-in-pool'] }],
    });
    const result = factsForDate(withOutsider, BranchCode.COLOMBO, '2026-09-23');
    expect(result.activeVehicleCount).toBe(1);
    expect(result.driverCapableVehicleCount).toBe(0);
    expect(result.transportCapableConcurrentCrews).toBe(0);
  });

  it("counts a vehicle authorized to a mix of this branch's employees and an outsider by the branch employee alone", () => {
    const mixed = pool({
      vehicles: [{ id: 'v1', seatCapacity: null, authorizedEmployeeIds: ['kandy-employee-not-in-pool', 'e2'] }],
    });
    const result = factsForDate(mixed, BranchCode.COLOMBO, '2026-09-23');
    expect(result.driverCapableVehicleCount).toBe(1);
  });

  // Item 2: one employee authorized for two vehicles does not make both
  // vehicles usable at the same time — only one of them can actually be
  // driven right now.
  it('one employee authorized for two vehicles is driver-capable for only one of them at once', () => {
    const oneDriverTwoVehicles = pool({
      vehicles: [
        { id: 'v1', seatCapacity: null, authorizedEmployeeIds: ['e2'] },
        { id: 'v2', seatCapacity: null, authorizedEmployeeIds: ['e2'] },
      ],
    });
    const result = factsForDate(oneDriverTwoVehicles, BranchCode.COLOMBO, '2026-09-23');
    expect(result.activeVehicleCount).toBe(2);
    expect(result.driverCapableVehicleCount).toBe(1);
  });

  // The valid multi-driver case this fix must not break: DAC-2485/DAG-3284
  // style, several vehicles each with their own distinct available driver
  // really are all drivable at once.
  it('several vehicles each with a distinct available driver are all driver-capable at once', () => {
    const distinctDrivers = pool({
      employees: [
        { id: 'e1', isPmsGrade: true, skillCodes: [], canUsePublicTransport: false },
        { id: 'e2', isPmsGrade: false, skillCodes: [], canUsePublicTransport: false },
        { id: 'e3', isPmsGrade: false, skillCodes: [], canUsePublicTransport: false },
      ],
      // DAG-3284/DAC-2485-style: several drivers checked for more than one
      // vehicle, but there are still enough distinct people to cover all three.
      vehicles: [
        { id: 'v1', seatCapacity: null, authorizedEmployeeIds: ['e1', 'e2'] },
        { id: 'v2', seatCapacity: null, authorizedEmployeeIds: ['e2', 'e3'] },
        { id: 'v3', seatCapacity: null, authorizedEmployeeIds: ['e3', 'e1'] },
      ],
    });
    const result = factsForDate(distinctDrivers, BranchCode.COLOMBO, '2026-09-23');
    expect(result.activeVehicleCount).toBe(3);
    expect(result.driverCapableVehicleCount).toBe(3);
  });

  // Item 3, at the source: the same person eligible as both a vehicle's only
  // driver and the branch's only walker is one real transport unit, not two.
  it('does not count the same employee as both a vehicle driver and a separate public-transport unit', () => {
    const oneDriverWhoCanAlsoWalk = pool({
      employees: [
        { id: 'e1', isPmsGrade: true, skillCodes: [], canUsePublicTransport: false },
        { id: 'e2', isPmsGrade: false, skillCodes: [], canUsePublicTransport: true },
      ],
      vehicles: [{ id: 'v1', seatCapacity: null, authorizedEmployeeIds: ['e2'] }],
    });
    const result = factsForDate(oneDriverWhoCanAlsoWalk, BranchCode.COLOMBO, '2026-09-23');
    expect(result.driverCapableVehicleCount).toBe(1);
    // Naively adding driverCapableVehicleCount (1) and a public-transport
    // count (1) would read as 2; there is one real person behind both.
    expect(result.transportCapableConcurrentCrews).toBe(1);
  });

  it('a distinct walker on top of a distinct driver really does add a second transportable crew', () => {
    const driverPlusWalker = pool({
      employees: [
        { id: 'e1', isPmsGrade: true, skillCodes: [], canUsePublicTransport: false },
        { id: 'e2', isPmsGrade: false, skillCodes: [], canUsePublicTransport: false },
        { id: 'e3', isPmsGrade: false, skillCodes: [], canUsePublicTransport: true },
      ],
      vehicles: [{ id: 'v1', seatCapacity: null, authorizedEmployeeIds: ['e2'] }],
    });
    const result = factsForDate(driverPlusWalker, BranchCode.COLOMBO, '2026-09-23');
    expect(result.transportCapableConcurrentCrews).toBe(2);
  });
});

describe('workforceForDate', () => {
  function pool(overrides: Partial<BranchResourcePool> = {}): BranchResourcePool {
    return {
      employees: [
        { id: 'e1', isPmsGrade: true, skillCodes: [], canUsePublicTransport: true },
        { id: 'e2', isPmsGrade: false, skillCodes: [], canUsePublicTransport: true },
      ],
      unavailability: [],
      vehicles: [{ id: 'v1', seatCapacity: null, authorizedEmployeeIds: ['e2'] }],
      ...overrides,
    };
  }

  it('mirrors factsForDate: an outside authorization does not make a vehicle driver-capable', () => {
    const result = workforceForDate(
      pool({
        employees: [{ id: 'e1', isPmsGrade: true, skillCodes: [], canUsePublicTransport: false }],
        vehicles: [{ id: 'v1', seatCapacity: null, authorizedEmployeeIds: ['not-in-this-branch'] }],
      }),
      '2026-09-23',
    );
    expect(result.driverCapableVehicleCount).toBe(0);
    // The raw resource list day-feasibility matches against carries an
    // empty driver list for this vehicle too, not just the summary count —
    // the outsider id never survives the branch/active filter into either.
    expect(result.vehicleResources).toEqual([{ id: 'v1', seatCapacity: null, eligibleDriverIds: [] }]);
  });

  it('mirrors factsForDate: one employee does not cover two vehicles at once', () => {
    const result = workforceForDate(
      pool({
        vehicles: [
          { id: 'v1', seatCapacity: null, authorizedEmployeeIds: ['e2'] },
          { id: 'v2', seatCapacity: null, authorizedEmployeeIds: ['e2'] },
        ],
      }),
      '2026-09-23',
    );
    expect(result.driverCapableVehicleCount).toBe(1);
  });

  it('exposes the raw driver list and walker set for day-feasibility to match per demand, unresolved here', () => {
    const result = workforceForDate(
      pool({ vehicles: [{ id: 'v1', seatCapacity: null, authorizedEmployeeIds: ['e2'] }] }),
      '2026-09-23',
    );
    // e1 and e2 can both use public transport; e2 is also v1's only driver.
    // workforceForDate does not resolve that overlap — it hands both raw
    // facts to day-feasibility, which is the one that knows the actual
    // demand and can decide who drives versus who walks.
    expect(result.vehicleResources).toEqual([{ id: 'v1', seatCapacity: null, eligibleDriverIds: ['e2'] }]);
    expect(result.availablePublicTransportEmployeeIds.slice().sort()).toEqual(['e1', 'e2']);
  });

  it('carries each vehicle its imported seat capacity, for day-feasibility to match crew size against', () => {
    const result = workforceForDate(
      pool({ vehicles: [{ id: 'v1', seatCapacity: 4, authorizedEmployeeIds: ['e2'] }] }),
      '2026-09-23',
    );
    expect(result.vehicleResources).toEqual([{ id: 'v1', seatCapacity: 4, eligibleDriverIds: ['e2'] }]);
  });
});

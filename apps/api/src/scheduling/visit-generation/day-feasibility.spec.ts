import { BranchCode } from '@prisma/client';

import {
  BranchDayWorkforce,
  DayVisitDemand,
  checkDayFeasibility,
} from './day-feasibility';

/**
 * The gap the Technical Director's review named: a branch-day can hold plenty
 * of crew-minutes in aggregate and still be impossible, because minutes do not
 * notice *when* the work has to happen or *who* is allowed to do it.
 *
 * Every case below is one where the aggregate cap is satisfied. What is being
 * checked is that placement refuses anyway when no assignment can exist — and,
 * just as importantly, that it does not refuse when one still might.
 */

const DATE = '2026-09-09';

/** Builds `vehicleResources`, unlimited-seat by default, from driver lists alone. */
function vehicles(...eligibleDriverIds: string[][]): BranchDayWorkforce['vehicleResources'] {
  return eligibleDriverIds.map((drivers, index) => ({
    id: `vehicle-${index + 1}`,
    seatCapacity: null,
    eligibleDriverIds: drivers,
  }));
}

function workforce(overrides: Partial<BranchDayWorkforce> = {}): BranchDayWorkforce {
  return {
    totalEmployeeCount: 6,
    availableEmployeeCount: 6,
    availablePmsCount: 3,
    skillHolderCounts: new Map(),
    activeVehicleCount: 3,
    driverCapableVehicleCount: 3,
    // Distinct driver per vehicle and distinct walkers by default, so the
    // baseline fixture never exercises the driver/walker overlap the
    // dedicated tests below are about.
    vehicleResources: vehicles(['driver-1'], ['driver-2'], ['driver-3']),
    availablePublicTransportEmployeeIds: [
      'walker-1', 'walker-2', 'walker-3', 'walker-4', 'walker-5', 'walker-6',
    ],
    ...overrides,
  };
}

/** A visit pinned tightly enough that it must be running across `[start, end)`. */
function tight(overrides: Partial<DayVisitDemand> = {}): DayVisitDemand {
  return {
    serviceAgreementId: 'agreement-1',
    windowStartMinute: 10 * 60,
    windowEndMinute: 11 * 60,
    durationMinutes: 60,
    requiredCrewSize: 1,
    requiredSkillCodes: [],
    ...overrides,
  };
}

/** A visit with a whole day to move around in — forced to overlap nothing. */
function loose(overrides: Partial<DayVisitDemand> = {}): DayVisitDemand {
  return {
    serviceAgreementId: 'agreement-loose',
    windowStartMinute: 8 * 60,
    windowEndMinute: 17 * 60,
    durationMinutes: 60,
    requiredCrewSize: 1,
    requiredSkillCodes: [],
    ...overrides,
  };
}

const check = (visits: DayVisitDemand[], facts = workforce()) =>
  checkDayFeasibility(BranchCode.COLOMBO, DATE, visits, facts);

describe('checkDayFeasibility', () => {
  it('passes a day nothing is planned on, whatever the branch has', () => {
    expect(check([], workforce({ availableEmployeeCount: 0, availablePmsCount: 0 }))).toBeNull();
  });

  it('accepts work the branch can plainly do', () => {
    expect(check([loose(), loose({ serviceAgreementId: 'b' })])).toBeNull();
  });

  describe('supervision', () => {
    it('refuses a day with no PMS-grade supervisor available', () => {
      const verdict = check([loose()], workforce({ availablePmsCount: 0 }));
      expect(verdict?.code).toBe('NO_PMS_SUPERVISOR');
    });

    // The headline case: two hours of one-person work against six people and a
    // 2880-crew-minute day — nowhere near the cap — but both visits are pinned
    // to the same hour and there is one supervisor to go round.
    it('refuses visits forced to run together when supervisors would have to be in two places', () => {
      const verdict = check(
        [tight({ serviceAgreementId: 'a' }), tight({ serviceAgreementId: 'b' })],
        workforce({ availablePmsCount: 1 }),
      );
      expect(verdict?.code).toBe('NOT_ENOUGH_SUPERVISORS_AT_ONCE');
      expect(verdict?.message).toContain('2 visit(s) to run at the same time');
    });

    it('allows the same two visits when their windows leave room to run one after the other', () => {
      expect(
        check(
          [loose({ serviceAgreementId: 'a' }), loose({ serviceAgreementId: 'b' })],
          workforce({ availablePmsCount: 1 }),
        ),
      ).toBeNull();
    });
  });

  describe('crew', () => {
    it('refuses more people on site at one moment than the branch has available', () => {
      const verdict = check(
        [
          tight({ serviceAgreementId: 'a', requiredCrewSize: 3 }),
          tight({ serviceAgreementId: 'b', requiredCrewSize: 3 }),
        ],
        workforce({ availableEmployeeCount: 4, availablePmsCount: 4 }),
      );
      expect(verdict?.code).toBe('NOT_ENOUGH_CREW_AT_ONCE');
      expect(verdict?.message).toContain('6 people onto site at the same time');
    });

    it('counts availability, not headcount — leave takes people off the day', () => {
      const verdict = check(
        [tight({ requiredCrewSize: 4 })],
        workforce({ totalEmployeeCount: 6, availableEmployeeCount: 2, availablePmsCount: 1 }),
      );
      expect(verdict?.code).toBe('NOT_ENOUGH_CREW_AT_ONCE');
    });
  });

  describe('skills', () => {
    it('refuses work needing a skill nobody available holds', () => {
      const verdict = check([loose({ requiredSkillCodes: ['FUMIGATION'] })]);
      expect(verdict?.code).toBe('SKILL_NOT_HELD');
      expect(verdict?.message).toContain('FUMIGATION');
    });

    it('refuses two concurrent visits needing a skill only one person holds', () => {
      const verdict = check(
        [
          tight({ serviceAgreementId: 'a', requiredSkillCodes: ['FUMIGATION'] }),
          tight({ serviceAgreementId: 'b', requiredSkillCodes: ['FUMIGATION'] }),
        ],
        workforce({ skillHolderCounts: new Map([['FUMIGATION', 1]]) }),
      );
      expect(verdict?.code).toBe('NOT_ENOUGH_SKILLED_AT_ONCE');
    });

    // Per skill, not in aggregate: one holder of each is enough for one visit
    // of each, and a count of "two skilled people" would wrongly allow two
    // visits needing the same one.
    it('allows two concurrent visits needing different skills, one holder each', () => {
      expect(
        check(
          [
            tight({ serviceAgreementId: 'a', requiredSkillCodes: ['FUMIGATION'] }),
            tight({ serviceAgreementId: 'b', requiredSkillCodes: ['RODENT'] }),
          ],
          workforce({
            skillHolderCounts: new Map([
              ['FUMIGATION', 1],
              ['RODENT', 1],
            ]),
          }),
        ),
      ).toBeNull();
    });
  });

  describe('getting there', () => {
    it('refuses a day with no drivable vehicle and nobody able to travel otherwise', () => {
      const verdict = check(
        [loose()],
        workforce({ activeVehicleCount: 0, vehicleResources: [], availablePublicTransportEmployeeIds: [] }),
      );
      expect(verdict?.code).toBe('NO_WAY_TO_REACH_SITE');
    });

    it('refuses more crews out at once than transport can cover', () => {
      const verdict = check(
        [tight({ serviceAgreementId: 'a' }), tight({ serviceAgreementId: 'b' })],
        workforce({
          activeVehicleCount: 1,
          vehicleResources: vehicles(['driver-1']),
          availablePublicTransportEmployeeIds: [],
        }),
      );
      expect(verdict?.code).toBe('NOT_ENOUGH_TRANSPORT_AT_ONCE');
    });

    it('accepts crews out at once when transport can actually cover all of them', () => {
      expect(
        check(
          [tight({ serviceAgreementId: 'a' }), tight({ serviceAgreementId: 'b' })],
          workforce({
            activeVehicleCount: 2,
            vehicleResources: vehicles(['driver-1'], ['driver-2']),
          }),
        ),
      ).toBeNull();
    });

    // The Technical Director's second review: a public-transport employee is
    // one person, not an entire crew — walking two one-person crews still
    // needs two distinct walkers, however many public-transport employees
    // the branch has when that number is only one.
    it('one public-transport-capable employee does not cover two forced-concurrent crews', () => {
      const verdict = check(
        [tight({ serviceAgreementId: 'a' }), tight({ serviceAgreementId: 'b' })],
        workforce({
          activeVehicleCount: 0,
          vehicleResources: [],
          availablePublicTransportEmployeeIds: ['walker-1'],
        }),
      );
      expect(verdict?.code).toBe('NOT_ENOUGH_TRANSPORT_AT_ONCE');
    });

    // The exact driver/walker double-counting bug: one vehicle whose only
    // authorized driver is also the branch's only public-transport-capable
    // employee. Naively adding driverCapableVehicleCount (1) and a walker
    // count (1) reads as transport for two crews; the one real person
    // behind both can only cover one.
    it('does not count the same employee as both a vehicle driver and a separate walker', () => {
      const verdict = check(
        [tight({ serviceAgreementId: 'a' }), tight({ serviceAgreementId: 'b' })],
        workforce({
          activeVehicleCount: 1,
          vehicleResources: vehicles(['shared-person']),
          availablePublicTransportEmployeeIds: ['shared-person'],
        }),
      );
      expect(verdict?.code).toBe('NOT_ENOUGH_TRANSPORT_AT_ONCE');
    });

    describe('crew size, not just crew count', () => {
      // Thiva's exact reproduction on 5cd3a03: a walking resource used to
      // read as "covers one crew," any size. A three-person crew with no
      // vehicle needs three distinct walkers, not one.
      it('refuses a three-person crew with no vehicle when only one employee can travel by public transport', () => {
        const verdict = check(
          [tight({ requiredCrewSize: 3 })],
          workforce({
            availableEmployeeCount: 3,
            availablePmsCount: 3,
            activeVehicleCount: 0,
            vehicleResources: [],
            availablePublicTransportEmployeeIds: ['walker-1'],
          }),
        );
        expect(verdict?.code).toBe('NOT_ENOUGH_TRANSPORT_AT_ONCE');
      });

      it('accepts the same three-person crew when three distinct employees can travel by public transport', () => {
        expect(
          check(
            [tight({ requiredCrewSize: 3 })],
            workforce({
              availableEmployeeCount: 3,
              availablePmsCount: 3,
              activeVehicleCount: 0,
              vehicleResources: [],
              availablePublicTransportEmployeeIds: ['walker-1', 'walker-2', 'walker-3'],
            }),
          ),
        ).toBeNull();
      });

      // Two forced-concurrent crews of different sizes: proves resources are
      // not reused across them, and that a vehicle is spent on the crew that
      // actually needs it most (the larger one) rather than leaving it to
      // chance which visit "gets" the vehicle.
      it('does not reuse an employee or a vehicle across two forced-concurrent crews of different sizes', () => {
        const verdict = check(
          [
            tight({ serviceAgreementId: 'big', requiredCrewSize: 3 }),
            tight({ serviceAgreementId: 'small', requiredCrewSize: 1 }),
          ],
          workforce({
            availableEmployeeCount: 5,
            availablePmsCount: 2,
            activeVehicleCount: 1,
            vehicleResources: vehicles(['driver-1']),
            // One walker beyond the driver: exactly enough for the vehicle
            // to take the 3-person crew and the one walker to take the
            // 1-person crew — but not enough for either crew alone without
            // the vehicle, so the split has to be found, not assumed.
            availablePublicTransportEmployeeIds: ['walker-1'],
          }),
        );
        expect(verdict).toBeNull();
      });

      it('refuses the same two crews when there is one fewer transport resource than the split needs', () => {
        const verdict = check(
          [
            tight({ serviceAgreementId: 'big', requiredCrewSize: 3 }),
            tight({ serviceAgreementId: 'small', requiredCrewSize: 1 }),
          ],
          workforce({
            availableEmployeeCount: 5,
            availablePmsCount: 2,
            activeVehicleCount: 1,
            vehicleResources: vehicles(['driver-1']),
            availablePublicTransportEmployeeIds: [],
          }),
        );
        expect(verdict?.code).toBe('NOT_ENOUGH_TRANSPORT_AT_ONCE');
      });
    });

    // The Technical Director's fourth review, item 1: a loose-window visit
    // never appears in any `forcedConcurrentSets` grouping, since nothing
    // forces it to overlap another visit — but it still has to reach the
    // site at some point, so it must be checked on its own too.
    describe('loose-window visits are still checked', () => {
      it('refuses a loose one-person visit when the only vehicle has no available driver and nobody can walk', () => {
        const verdict = check(
          [loose()],
          workforce({
            activeVehicleCount: 1,
            vehicleResources: vehicles([]),
            availablePublicTransportEmployeeIds: [],
          }),
        );
        expect(verdict?.code).toBe('NO_WAY_TO_REACH_SITE');
      });

      it('refuses a loose three-person visit when there is no vehicle and only one walker', () => {
        const verdict = check(
          [loose({ requiredCrewSize: 3 })],
          workforce({
            availableEmployeeCount: 3,
            availablePmsCount: 3,
            activeVehicleCount: 0,
            vehicleResources: [],
            availablePublicTransportEmployeeIds: ['walker-1'],
          }),
        );
        expect(verdict?.code).toBe('NOT_ENOUGH_TRANSPORT_AT_ONCE');
      });

      it('accepts the same loose visit once a second walker is available', () => {
        expect(
          check(
            [loose({ requiredCrewSize: 3 })],
            workforce({
              availableEmployeeCount: 3,
              availablePmsCount: 3,
              activeVehicleCount: 0,
              vehicleResources: [],
              availablePublicTransportEmployeeIds: ['walker-1', 'walker-2', 'walker-3'],
            }),
          ),
        ).toBeNull();
      });
    });

    // The Technical Director's fourth review, item 2: a vehicle only ever
    // covers a crew its own seats can hold. The production eligibility
    // engine already enforces this (`VEHICLE_CAPACITY_EXCEEDED`); this check
    // has to agree, or it accepts a day the eligibility engine will later
    // reject.
    describe('vehicle seat capacity', () => {
      it('refuses a three-person crew when the only drivable vehicle seats one and walkers are short', () => {
        const verdict = check(
          [tight({ requiredCrewSize: 3 })],
          workforce({
            availableEmployeeCount: 4,
            availablePmsCount: 3,
            activeVehicleCount: 1,
            vehicleResources: [{ id: 'v1', seatCapacity: 1, eligibleDriverIds: ['driver-1'] }],
            // One walker beyond the driver — not enough for the remaining
            // two seats a properly-sized vehicle would have freed up.
            availablePublicTransportEmployeeIds: ['walker-1'],
          }),
        );
        expect(verdict?.code).toBe('NOT_ENOUGH_TRANSPORT_AT_ONCE');
      });

      it('accepts the same crew once the drivable vehicle can actually seat it', () => {
        expect(
          check(
            [tight({ requiredCrewSize: 3 })],
            workforce({
              availableEmployeeCount: 4,
              availablePmsCount: 3,
              activeVehicleCount: 1,
              vehicleResources: [{ id: 'v1', seatCapacity: 4, eligibleDriverIds: ['driver-1'] }],
              availablePublicTransportEmployeeIds: ['walker-1'],
            }),
          ),
        ).toBeNull();
      });

      it('a vehicle with unknown (null) seat capacity still covers a crew of any size, as before', () => {
        expect(
          check(
            [tight({ requiredCrewSize: 3 })],
            workforce({
              availableEmployeeCount: 4,
              availablePmsCount: 3,
              activeVehicleCount: 1,
              vehicleResources: [{ id: 'v1', seatCapacity: null, eligibleDriverIds: ['driver-1'] }],
              availablePublicTransportEmployeeIds: [],
            }),
          ),
        ).toBeNull();
      });

      it('a too-small vehicle still frees its driver to count as a walker for a different crew', () => {
        // A 3-person crew and a 1-person crew forced concurrent; the
        // 1-seat vehicle cannot help the 3-person crew, but its driver is a
        // real person who could instead walk the 1-person crew, leaving the
        // 3-person crew to be covered entirely by walkers.
        const verdict = check(
          [
            tight({ serviceAgreementId: 'big', requiredCrewSize: 3 }),
            tight({ serviceAgreementId: 'small', requiredCrewSize: 1 }),
          ],
          workforce({
            availableEmployeeCount: 5,
            availablePmsCount: 2,
            activeVehicleCount: 1,
            vehicleResources: [{ id: 'v1', seatCapacity: 1, eligibleDriverIds: ['driver-1'] }],
            availablePublicTransportEmployeeIds: ['walker-1', 'walker-2', 'walker-3'],
          }),
        );
        expect(verdict).toBeNull();
      });
    });
  });

  describe('a branch this database has never been told about', () => {
    // Reported rather than silently read as "no capacity": inferring a claim
    // about a branch's staffing from the absence of an import would be making
    // one up.
    it('says so, instead of pretending to know', () => {
      const verdict = check([loose()], workforce({ totalEmployeeCount: 0 }));
      expect(verdict?.code).toBe('NO_WORKFORCE_RECORDED');
    });
  });

  describe('forced concurrency', () => {
    // The rule: a visit of duration d in a window [s, e] must be running
    // across [e - d, s + d), which is empty unless e - s < 2d. Anything looser
    // can be scheduled around, and refusing it would be wrong.
    it('treats a window exactly twice the duration as schedulable around', () => {
      const exactly = { windowStartMinute: 600, windowEndMinute: 720, durationMinutes: 60 };
      expect(
        check(
          [
            tight({ serviceAgreementId: 'a', ...exactly }),
            tight({ serviceAgreementId: 'b', ...exactly }),
          ],
          workforce({ availablePmsCount: 1 }),
        ),
      ).toBeNull();
    });

    it('catches a window one minute tighter than that', () => {
      const tighter = { windowStartMinute: 600, windowEndMinute: 719, durationMinutes: 60 };
      const verdict = check(
        [
          tight({ serviceAgreementId: 'a', ...tighter }),
          tight({ serviceAgreementId: 'b', ...tighter }),
        ],
        workforce({ availablePmsCount: 1 }),
      );
      expect(verdict?.code).toBe('NOT_ENOUGH_SUPERVISORS_AT_ONCE');
    });
  });
});

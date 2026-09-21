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

function workforce(overrides: Partial<BranchDayWorkforce> = {}): BranchDayWorkforce {
  return {
    totalEmployeeCount: 6,
    availableEmployeeCount: 6,
    availablePmsCount: 3,
    skillHolderCounts: new Map(),
    activeVehicleCount: 3,
    driverCapableVehicleCount: 3,
    publicTransportCapableCount: 6,
    maxTransportableConcurrentCrews: 3,
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
      const verdict = check([loose()], workforce({ maxTransportableConcurrentCrews: 0 }));
      expect(verdict?.code).toBe('NO_WAY_TO_REACH_SITE');
    });

    it('refuses more crews out at once than transport can cover', () => {
      const verdict = check(
        [tight({ serviceAgreementId: 'a' }), tight({ serviceAgreementId: 'b' })],
        workforce({ maxTransportableConcurrentCrews: 1 }),
      );
      expect(verdict?.code).toBe('NOT_ENOUGH_TRANSPORT_AT_ONCE');
    });

    it('accepts crews out at once when transport can actually cover all of them', () => {
      expect(
        check(
          [tight({ serviceAgreementId: 'a' }), tight({ serviceAgreementId: 'b' })],
          workforce({ maxTransportableConcurrentCrews: 2 }),
        ),
      ).toBeNull();
    });

    // The Technical Director's review: publicTransportCapableCount used to be
    // read as a boolean that waived the transport check entirely, so one
    // public-transport employee silently covered any number of concurrent
    // crews. maxTransportableConcurrentCrews is a real headcount, not a flag,
    // so one such employee against two forced-concurrent crews still refuses.
    it('one public-transport-capable employee does not cover two forced-concurrent crews', () => {
      const verdict = check(
        [tight({ serviceAgreementId: 'a' }), tight({ serviceAgreementId: 'b' })],
        workforce({ driverCapableVehicleCount: 0, publicTransportCapableCount: 1, maxTransportableConcurrentCrews: 1 }),
      );
      expect(verdict?.code).toBe('NOT_ENOUGH_TRANSPORT_AT_ONCE');
    });

    // The matching itself — same person eligible as both a vehicle's driver
    // and a walker — is branch-day-capacity.spec.ts's job to prove; this only
    // checks that checkDayFeasibility trusts the combined figure it is given
    // rather than re-deriving (or re-breaking) it from the two raw counts.
    it('does not add driverCapableVehicleCount and publicTransportCapableCount back together itself', () => {
      const verdict = check(
        [tight({ serviceAgreementId: 'a' }), tight({ serviceAgreementId: 'b' })],
        // A naive sum would read this as 1 + 1 = 2 and pass; the one real
        // person behind both numbers can only cover one crew at once.
        workforce({ driverCapableVehicleCount: 1, publicTransportCapableCount: 1, maxTransportableConcurrentCrews: 1 }),
      );
      expect(verdict?.code).toBe('NOT_ENOUGH_TRANSPORT_AT_ONCE');
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

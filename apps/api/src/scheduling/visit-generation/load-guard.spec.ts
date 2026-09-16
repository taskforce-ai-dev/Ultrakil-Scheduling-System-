import { BranchCode, DataProvenance, VisitPlacement, Weekday } from '@prisma/client';

import { PreviewAlternative } from '../../catalog/schedule-preview';
import { DEFAULT_DAILY_VISIT_CAP } from '../../config/constants';
import { applyDailyLoadGuard } from './load-guard';
import { RequiredVisit } from './plan';

function alternative(date: string, overrides: Partial<PreviewAlternative> = {}): PreviewAlternative {
  return {
    date,
    weekday: Weekday.TUESDAY,
    windowStartMinute: 9 * 60,
    windowEndMinute: 17 * 60,
    isPreferredDay: false,
    windowProvenance: DataProvenance.SOURCE,
    ...overrides,
  };
}

function visit(overrides: Partial<RequiredVisit> = {}): RequiredVisit {
  return {
    serviceAgreementId: 'agreement-1',
    visitDate: '2026-09-07',
    windowStartMinute: 9 * 60,
    windowEndMinute: 17 * 60,
    durationMinutes: 60,
    requiredCrewSize: 2,
    branchCode: BranchCode.COLOMBO,
    agreementVersionId: null,
    windowProvenance: DataProvenance.SOURCE,
    isPreferredDay: false,
    placement: VisitPlacement.EARLIEST,
    periodIndex: 0,
    alternatives: [],
    ...overrides,
  };
}

/** `count` visits on one day, each with somewhere else in the period to go. */
function crowd(count: number, options: { placement?: VisitPlacement; alternatives?: PreviewAlternative[] } = {}) {
  return Array.from({ length: count }, (_unused, index) =>
    visit({
      serviceAgreementId: `agreement-${String(index).padStart(3, '0')}`,
      placement: options.placement ?? VisitPlacement.EARLIEST,
      alternatives: options.alternatives ?? [alternative('2026-09-08')],
    }),
  );
}

const countOn = (visits: RequiredVisit[], date: string) =>
  visits.filter((entry) => entry.visitDate === date).length;

describe('applyDailyLoadGuard', () => {
  it('leaves a day inside the cap exactly as it found it', () => {
    const required = crowd(3);

    const result = applyDailyLoadGuard(required, 12);

    expect(result.required).toEqual(required);
    expect(result.warnings).toEqual([]);
  });

  it('moves visits off an overloaded day until it sits at the cap', () => {
    const result = applyDailyLoadGuard(crowd(15), 12);

    expect(countOn(result.required, '2026-09-07')).toBe(12);
    expect(countOn(result.required, '2026-09-08')).toBe(3);
  });

  it('marks a moved visit as spread, and leaves the rest alone', () => {
    const result = applyDailyLoadGuard(crowd(13), 12);

    const moved = result.required.filter(
      (entry) => entry.placement === VisitPlacement.SPREAD,
    );
    expect(moved).toHaveLength(1);
    expect(moved[0].visitDate).toBe('2026-09-08');
  });

  it('never moves a booked visit', () => {
    const result = applyDailyLoadGuard(
      crowd(15, { placement: VisitPlacement.BOOKED }),
      12,
    );

    expect(countOn(result.required, '2026-09-07')).toBe(15);
    expect(
      result.required.every((entry) => entry.placement === VisitPlacement.BOOKED),
    ).toBe(true);
  });

  it('warns, naming the date and the count, when bookings alone exceed the cap', () => {
    const result = applyDailyLoadGuard(
      crowd(14, { placement: VisitPlacement.BOOKED }),
      12,
    );

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      date: '2026-09-07',
      branchCode: BranchCode.COLOMBO,
      plannedCount: 14,
      bookedCount: 14,
      cap: 12,
    });
    expect(result.warnings[0].message).toContain('2026-09-07');
    expect(result.warnings[0].message).toContain('14');
  });

  it('counts booked visits towards the load, so the unbooked ones move instead', () => {
    const required = [
      ...crowd(10, { placement: VisitPlacement.BOOKED }),
      ...Array.from({ length: 4 }, (_unused, index) =>
        visit({
          serviceAgreementId: `later-${index}`,
          alternatives: [alternative('2026-09-09')],
        }),
      ),
    ];

    const result = applyDailyLoadGuard(required, 12);

    expect(countOn(result.required, '2026-09-07')).toBe(12);
    expect(countOn(result.required, '2026-09-09')).toBe(2);
  });

  it('picks the emptiest alternative day, then the earliest of equals', () => {
    const required = [
      // One visit already sitting on the 9th, so the 8th is emptier.
      visit({ serviceAgreementId: 'a-000', visitDate: '2026-09-09' }),
      ...crowd(3, {
        alternatives: [alternative('2026-09-09'), alternative('2026-09-08')],
      }),
    ];

    const result = applyDailyLoadGuard(required, 2);

    expect(countOn(result.required, '2026-09-08')).toBe(1);
  });

  it('will not move a visit onto a day that is already at the cap', () => {
    const required = [
      ...crowd(4, { alternatives: [alternative('2026-09-08')] }),
      visit({ serviceAgreementId: 'z-000', visitDate: '2026-09-08' }),
      visit({ serviceAgreementId: 'z-001', visitDate: '2026-09-08' }),
    ];

    const result = applyDailyLoadGuard(required, 2);

    expect(countOn(result.required, '2026-09-08')).toBe(2);
    expect(result.warnings.map((warning) => warning.date)).toContain('2026-09-07');
  });

  it('never moves a visit onto a day its own agreement already uses', () => {
    const required = [
      visit({ serviceAgreementId: 'a-000', visitDate: '2026-09-08' }),
      ...Array.from({ length: 3 }, (_unused, index) =>
        visit({
          serviceAgreementId: index === 0 ? 'a-000' : `b-${index}`,
          alternatives: [alternative('2026-09-08')],
        }),
      ),
    ];

    const result = applyDailyLoadGuard(required, 2);

    const onEighth = result.required.filter(
      (entry) => entry.visitDate === '2026-09-08' && entry.serviceAgreementId === 'a-000',
    );
    expect(onEighth).toHaveLength(1);
  });

  it('keeps each branch to its own day count', () => {
    const required = [
      ...crowd(3),
      ...crowd(3).map((entry) => ({
        ...entry,
        serviceAgreementId: `kandy-${entry.serviceAgreementId}`,
        branchCode: BranchCode.KANDY,
      })),
    ];

    const result = applyDailyLoadGuard(required, 4);

    expect(result.required.every((entry) => entry.visitDate === '2026-09-07')).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('produces the same answer twice, whatever order the visits arrive in', () => {
    const required = crowd(20, {
      alternatives: [alternative('2026-09-08'), alternative('2026-09-09')],
    });

    const first = applyDailyLoadGuard(required, 12);
    const second = applyDailyLoadGuard([...required].reverse(), 12);

    const key = (entry: RequiredVisit) =>
      `${entry.serviceAgreementId}|${entry.visitDate}|${entry.placement}`;
    expect(first.required.map(key).sort()).toEqual(second.required.map(key).sort());
  });

  it('does not touch the visits it was handed', () => {
    const required = crowd(15);
    const before = required.map((entry) => entry.visitDate);

    applyDailyLoadGuard(required, 12);

    expect(required.map((entry) => entry.visitDate)).toEqual(before);
  });

  it('leaves a day sitting exactly on the cap alone', () => {
    // The boundary the cap is defined at. One visit either side of it is the
    // difference between a normal day and a day the guard rearranges.
    const required = crowd(12);

    const result = applyDailyLoadGuard(required, 12);

    expect(countOn(result.required, '2026-09-07')).toBe(12);
    expect(result.required).toEqual(required);
    expect(result.warnings).toEqual([]);
  });

  describe('a moved visit takes its new day\'s window, and leaves its old one behind intact', () => {
    const target = alternative('2026-09-08', {
      weekday: Weekday.TUESDAY,
      windowStartMinute: 13 * 60,
      windowEndMinute: 18 * 60,
      isPreferredDay: true,
      windowProvenance: DataProvenance.MANAGER_CONFIRMED,
    });

    const moveOne = () =>
      applyDailyLoadGuard(crowd(13, { alternatives: [target] }), 12).required.find(
        (entry) => entry.placement === VisitPlacement.SPREAD,
      )!;

    it('wears the window, weekday flag and provenance of the day it moved to', () => {
      expect(moveOne()).toMatchObject({
        visitDate: '2026-09-08',
        windowStartMinute: 13 * 60,
        windowEndMinute: 18 * 60,
        isPreferredDay: true,
        windowProvenance: DataProvenance.MANAGER_CONFIRMED,
      });
    });

    it('offers the day it left as an alternative described by that day, not the new one', () => {
      // 2026-09-07 is a Monday and the visit sat on it 09:00-17:00. Reading
      // these fields after the move gave Tuesday 13:00-18:00 — a day that
      // never existed, which the next pass would have moved it back onto.
      expect(moveOne().alternatives).toEqual([
        {
          date: '2026-09-07',
          weekday: Weekday.MONDAY,
          windowStartMinute: 9 * 60,
          windowEndMinute: 17 * 60,
          isPreferredDay: false,
          windowProvenance: DataProvenance.SOURCE,
        },
      ]);
    });
  });

  describe('the rest of the calendar counts too', () => {
    it('sees a day already holding work this run did not plan', () => {
      // Cap 2. The 8th already carries one visit from an agreement outside
      // this run, so it has room for exactly one more.
      const result = applyDailyLoadGuard(
        crowd(3, { alternatives: [alternative('2026-09-08')] }),
        2,
        [
          {
            serviceAgreementId: 'outside-this-run',
            branchCode: BranchCode.COLOMBO,
            visitDate: '2026-09-08',
          },
        ],
      );

      expect(countOn(result.required, '2026-09-08')).toBe(1);
      expect(countOn(result.required, '2026-09-07')).toBe(2);
    });

    it('will not fill a standing day past the cap', () => {
      const result = applyDailyLoadGuard(
        crowd(4, { alternatives: [alternative('2026-09-08')] }),
        2,
        [
          {
            serviceAgreementId: 'outside-1',
            branchCode: BranchCode.COLOMBO,
            visitDate: '2026-09-08',
          },
          {
            serviceAgreementId: 'outside-2',
            branchCode: BranchCode.COLOMBO,
            visitDate: '2026-09-08',
          },
        ],
      );

      // The 8th is full before the run starts, so nothing may move onto it.
      expect(countOn(result.required, '2026-09-08')).toBe(0);
      expect(result.warnings.map((warning) => warning.date)).toContain('2026-09-07');
    });

    it('will not move a visit onto a day its own agreement already stands on', () => {
      const result = applyDailyLoadGuard(
        [
          ...crowd(2, { alternatives: [alternative('2026-09-08')] }),
          visit({
            serviceAgreementId: 'held',
            alternatives: [alternative('2026-09-08')],
          }),
        ],
        2,
        [
          {
            serviceAgreementId: 'held',
            branchCode: BranchCode.COLOMBO,
            visitDate: '2026-09-08',
          },
        ],
      );

      const moved = result.required.filter((entry) => entry.visitDate === '2026-09-08');
      expect(moved.map((entry) => entry.serviceAgreementId)).not.toContain('held');
    });

    it('counts a standing visit this run is re-planning only once', () => {
      // The same visit, seen twice: once as the run's own requirement and once
      // as a protected row already in the calendar.
      const required = crowd(2);
      const result = applyDailyLoadGuard(required, 2, [
        {
          serviceAgreementId: required[0].serviceAgreementId,
          branchCode: BranchCode.COLOMBO,
          visitDate: '2026-09-07',
        },
      ]);

      expect(result.required).toEqual(required);
      expect(result.warnings).toEqual([]);
    });

    it('keeps the branches apart', () => {
      const result = applyDailyLoadGuard(crowd(2), 2, [
        {
          serviceAgreementId: 'kandy-agreement',
          branchCode: BranchCode.KANDY,
          visitDate: '2026-09-07',
        },
      ]);

      expect(result.warnings).toEqual([]);
    });

    it('never counts out a kind of visit the day has none of', () => {
      // "None of them could be moved: 0 are dates already booked with the
      // customer. 3 are already in the calendar" makes a dispatcher stop and
      // work out what a zero means. A clause with nothing behind it is not
      // said at all — and one kind covering the whole day says "all".
      const result = applyDailyLoadGuard(crowd(1, { alternatives: [] }).map((entry) => ({
        ...entry,
        visitDate: '2026-09-09',
      })), 2, ['a', 'b', 'c'].map((id) => ({
        serviceAgreementId: `outside-this-run-${id}`,
        branchCode: BranchCode.COLOMBO,
        visitDate: '2026-09-07',
      })));

      const warning = result.warnings.find((entry) => entry.date === '2026-09-07');
      expect(warning?.bookedCount).toBe(0);
      expect(warning?.message).not.toMatch(/\b0 /);
      expect(warning?.message).toContain(
        "None of them could be moved: all 3 are already in the calendar and not this run's to move.",
      );
    });

    it('counts both kinds out when the day really has both', () => {
      const result = applyDailyLoadGuard(
        crowd(1, { alternatives: [], placement: VisitPlacement.BOOKED }),
        2,
        ['a', 'b'].map((id) => ({
          serviceAgreementId: `outside-this-run-${id}`,
          branchCode: BranchCode.COLOMBO,
          visitDate: '2026-09-07',
        })),
      );

      expect(result.warnings[0].message).toContain(
        "None of them could be moved: 1 is a date already booked with the customer, and 2 are already in the calendar and not this run's to move.",
      );
    });

    it('says in the warning that part of the day is not this run to move', () => {
      const result = applyDailyLoadGuard(crowd(2, { alternatives: [] }), 2, [
        {
          serviceAgreementId: 'outside-this-run',
          branchCode: BranchCode.COLOMBO,
          visitDate: '2026-09-07',
        },
      ]);

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].plannedCount).toBe(3);
      expect(result.warnings[0].message).toContain('already in the calendar');
    });
  });

  it("defaults to the workbook's own busiest day", () => {
    expect(DEFAULT_DAILY_VISIT_CAP).toBe(12);
  });
});

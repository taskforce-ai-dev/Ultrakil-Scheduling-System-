import { BranchCode, DataProvenance, VisitPlacement, Weekday } from '@prisma/client';

import { PreviewAlternative } from '../../catalog/schedule-preview';
import { DEFAULT_DAILY_VISIT_CAP, applyDailyLoadGuard } from './load-guard';
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

  it("defaults to the workbook's own busiest day", () => {
    expect(DEFAULT_DAILY_VISIT_CAP).toBe(12);
  });
});

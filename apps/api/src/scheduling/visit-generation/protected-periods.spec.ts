import { BranchCode, FrequencyUnit, VisitPlacement } from '@prisma/client';

import { ExistingVisit, RequiredVisit, planGeneration } from './plan';
import { AgreementPeriodShape, honourProtectedDates } from './protected-periods';

const AGREEMENT = 'agreement-1';

function required(overrides: Partial<RequiredVisit> = {}): RequiredVisit {
  return {
    serviceAgreementId: AGREEMENT,
    visitDate: '2026-09-16',
    windowStartMinute: 540,
    windowEndMinute: 1020,
    durationMinutes: 90,
    requiredCrewSize: 2,
    branchCode: BranchCode.COLOMBO,
    agreementVersionId: null,
    isPreferredDay: false,
    placement: VisitPlacement.ANCHORED,
    periodIndex: 0,
    alternatives: [
      {
        date: '2026-09-17',
        weekday: 'THURSDAY',
        windowStartMinute: 540,
        windowEndMinute: 1020,
        isPreferredDay: false,
        windowProvenance: 'SOURCE',
      },
    ],
    ...overrides,
  };
}

function existing(overrides: Partial<ExistingVisit> = {}): ExistingVisit {
  return {
    id: 'visit-1',
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    serviceAgreementId: AGREEMENT,
    visitDate: '2026-09-09',
    windowStartMinute: 540,
    windowEndMinute: 1020,
    durationMinutes: 90,
    requiredCrewSize: 2,
    status: 'PENDING',
    placement: VisitPlacement.EARLIEST,
    isManuallyAdjusted: false,
    isLocked: false,
    hasAssignments: false,
    ...overrides,
  };
}

const monthly = (): Map<string, AgreementPeriodShape> =>
  new Map([
    [
      AGREEMENT,
      {
        serviceAgreementId: AGREEMENT,
        horizonStart: '2026-09-01',
        frequencyUnit: FrequencyUnit.MONTH,
        frequencyInterval: 1,
      },
    ],
  ]);

/** Every way a visit can come to belong to a manager rather than the generator. */
const PROTECTIONS: [string, Partial<ExistingVisit>][] = [
  ['already scheduled', { status: 'SCHEDULED' }],
  ['published, so carrying an assignment', { hasAssignments: true }],
  ['locked', { isLocked: true }],
  ['adjusted by hand', { isManuallyAdjusted: true }],
  ['completed', { status: 'COMPLETED' }],
];

describe('honourProtectedDates', () => {
  describe.each(PROTECTIONS)('a visit that is %s', (_label, protection) => {
    const plan = () =>
      planGeneration(
        honourProtectedDates([required()], [existing(protection)], monthly()),
        [existing(protection)],
      );

    it('is not duplicated when the period is re-planned onto another day', () => {
      // The whole defect: the 16th was added, the 9th was kept because it is
      // protected, and the customer got two visits in one month.
      expect(plan().additions).toEqual([]);
    });

    it('is not proposed for removal either', () => {
      expect(plan().removals).toEqual([]);
    });

    it('leaves the month with exactly one visit', () => {
      const result = plan();
      const total =
        result.additions.length + result.updates.length + result.unchangedCount;
      expect(total).toBe(1);
    });
  });

  it('reads as unchanged when the agreement asks for nothing else', () => {
    const plan = planGeneration(
      honourProtectedDates([required()], [existing({ status: 'SCHEDULED' })], monthly()),
      [existing({ status: 'SCHEDULED' })],
    );

    expect(plan.unchangedCount).toBe(1);
    expect(plan.protectedVisits).toEqual([]);
  });

  it('keeps the protected date but still reports what the agreement now wants', () => {
    // The manager owns the day. The agreement still owns how long the visit is
    // and how many people it needs, so a real change is reported — and, the
    // visit being protected, still not applied.
    const plan = planGeneration(
      honourProtectedDates(
        [required({ durationMinutes: 150 })],
        [existing({ status: 'SCHEDULED' })],
        monthly(),
      ),
      [existing({ status: 'SCHEDULED' })],
    );

    expect(plan.protectedVisits).toEqual([
      expect.objectContaining({
        visitId: 'visit-1',
        visitDate: '2026-09-09',
        protection: 'ALREADY_SCHEDULED',
        wouldHave: 'UPDATE',
        changes: [{ field: 'durationMinutes', from: 90, to: 150 }],
      }),
    ]);
    expect(plan.additions).toEqual([]);
    expect(plan.removals).toEqual([]);
  });

  it('never leaves a pinned visit for the load guard to move', () => {
    const pinned = honourProtectedDates(
      [required()],
      [existing({ isLocked: true })],
      monthly(),
    );

    expect(pinned[0].visitDate).toBe('2026-09-09');
    expect(pinned[0].alternatives).toEqual([]);
  });

  it('keeps the placement that actually explains the date', () => {
    // A manager put the visit on the 9th. Calling that ANCHORED would credit
    // the anchor with a date it had no part in choosing.
    const pinned = honourProtectedDates(
      [required()],
      [existing({ isLocked: true, placement: VisitPlacement.BOOKED })],
      monthly(),
    );

    expect(pinned[0].placement).toBe(VisitPlacement.BOOKED);
  });

  it('leaves an unprotected visit to be moved the ordinary way', () => {
    const plan = planGeneration(
      honourProtectedDates([required()], [existing()], monthly()),
      [existing()],
    );

    expect(plan.additions).toHaveLength(1);
    expect(plan.removals).toHaveLength(1);
  });

  it('changes nothing when the protected visit is already on the required day', () => {
    const untouched = [required({ visitDate: '2026-09-09' })];
    const pinned = honourProtectedDates(
      untouched,
      [existing({ isLocked: true })],
      monthly(),
    );

    expect(pinned).toEqual(untouched);
  });

  it('pins as many days as the agreement asks for, and reports the surplus', () => {
    const twice = [
      required({ visitDate: '2026-09-07', periodIndex: 0 }),
      required({ visitDate: '2026-09-21', periodIndex: 0 }),
    ];
    const held = [
      existing({ id: 'a', visitDate: '2026-09-09', isLocked: true }),
      existing({ id: 'b', visitDate: '2026-09-23', isLocked: true }),
      existing({ id: 'c', visitDate: '2026-09-25', isLocked: true }),
    ];

    const plan = planGeneration(honourProtectedDates(twice, held, monthly()), held);

    expect(plan.additions).toEqual([]);
    expect(plan.unchangedCount).toBe(2);
    // The third is more than the agreement asks for. It is still never
    // removed — it is reported, and left exactly where it is.
    expect(plan.protectedVisits).toEqual([
      expect.objectContaining({ visitId: 'c', wouldHave: 'REMOVE' }),
    ]);
    expect(plan.removals).toEqual([]);
  });

  it('keeps months apart — a protected March visit does not satisfy April', () => {
    const april = [required({ visitDate: '2026-10-14', periodIndex: 1 })];
    const march = [existing({ visitDate: '2026-09-09', isLocked: true })];

    const pinned = honourProtectedDates(april, march, monthly());

    expect(pinned[0].visitDate).toBe('2026-10-14');
  });

  it('ignores an agreement this run was not asked about', () => {
    const other = [existing({ serviceAgreementId: 'agreement-2', isLocked: true })];

    expect(honourProtectedDates([required()], other, monthly())).toEqual([required()]);
  });

  it('does not touch the list it was handed', () => {
    const input = [required()];
    honourProtectedDates(input, [existing({ isLocked: true })], monthly());

    expect(input[0].visitDate).toBe('2026-09-16');
  });
});

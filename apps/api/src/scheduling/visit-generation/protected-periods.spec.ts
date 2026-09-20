import { BranchCode, FrequencyUnit, VisitPlacement, Weekday } from '@prisma/client';

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
    requiredSkillCodes: [],
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
    // A Saturday: a day this agreement does not allow, so pinning to it is
    // something a manager needs telling about.
    visitDate: '2026-09-12',
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

/**
 * A monthly agreement served Monday to Friday.
 *
 * The keepers below sit on Saturdays — days this agreement does not allow —
 * because that is the case the would-have-moved report exists for. A keeper on
 * a weekday the agreement is content with is the other case, and has its own
 * tests.
 */
const monthly = (
  allowedDays: Weekday[] = [
    Weekday.MONDAY,
    Weekday.TUESDAY,
    Weekday.WEDNESDAY,
    Weekday.THURSDAY,
    Weekday.FRIDAY,
  ],
): Map<string, AgreementPeriodShape> =>
  new Map([
    [
      AGREEMENT,
      {
        serviceAgreementId: AGREEMENT,
        anchor: '2026-09-01',
        frequencyUnit: FrequencyUnit.MONTH,
        frequencyInterval: 1,
        allowedDays,
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
        result.additions.length +
        result.updates.length +
        result.unchangedCount +
        result.protectedVisits.length;
      expect(total).toBe(1);
    });
  });

  it('reads as unchanged when the day generation wanted is the day already held', () => {
    const held = existing({
      status: 'SCHEDULED',
      placement: VisitPlacement.ANCHORED,
    });
    const sameDay = [required({ visitDate: '2026-09-12' })];
    const plan = planGeneration(
      honourProtectedDates(sameDay, [held], monthly()),
      [held],
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
        visitDate: '2026-09-12',
        protection: 'ALREADY_SCHEDULED',
        wouldHave: 'UPDATE',
        changes: [
          { field: 'visitDate', from: '2026-09-12', to: '2026-09-16' },
          { field: 'durationMinutes', from: 90, to: 150 },
        ],
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

    expect(pinned[0].visitDate).toBe('2026-09-12');
    expect(pinned[0].alternatives).toEqual([]);
  });

  it('keeps the placement that actually explains the date', () => {
    // A manager put the visit on the 12th. Calling that ANCHORED would credit
    // the anchor with a date it had no part in choosing.
    const pinned = honourProtectedDates(
      [required()],
      [existing({ isLocked: true, placement: VisitPlacement.BOOKED })],
      monthly(),
    );

    expect(pinned[0].placement).toBe(VisitPlacement.BOOKED);
  });

  it('does not let a cancelled visit stand in for the work', () => {
    // A cancelled visit means the work did not happen. The period still wants
    // a visit, so nothing is pinned to it — and the cancelled row is still
    // never removed.
    const cancelled = existing({ status: 'CANCELLED' });
    const pinned = honourProtectedDates([required()], [cancelled], monthly());

    expect(pinned[0].visitDate).toBe('2026-09-16');

    const plan = planGeneration(pinned, [cancelled]);
    expect(plan.additions).toHaveLength(1);
    expect(plan.removals).toEqual([]);
    expect(plan.protectedVisits).toEqual([
      expect.objectContaining({
        visitId: 'visit-1',
        protection: 'CANCELLED',
        wouldHave: 'REMOVE',
      }),
    ]);
  });

  it('leaves an unprotected visit to be moved the ordinary way', () => {
    const plan = planGeneration(
      honourProtectedDates([required()], [existing()], monthly()),
      [existing()],
    );

    expect(plan.additions).toHaveLength(1);
    expect(plan.removals).toHaveLength(1);
  });

  it('moves nothing when the protected visit is already on the required day', () => {
    // The date, the window and the placement all stay exactly as the run
    // planned them — there is nothing to pin, because the run already asked
    // for this very slot. The one thing that does change is that the
    // requirement stops being the load guard's to move: it *is* the protected
    // visit, and moving it would invent a second one.
    const untouched = [required({ visitDate: '2026-09-12' })];
    const pinned = honourProtectedDates(
      untouched,
      [existing({ isLocked: true })],
      monthly(),
    );

    expect(pinned).toEqual([{ ...untouched[0], alternatives: [] }]);
  });

  it('pins as many days as the agreement asks for, and reports the surplus', () => {
    const twice = [
      required({ visitDate: '2026-09-07', periodIndex: 0 }),
      required({ visitDate: '2026-09-21', periodIndex: 0 }),
    ];
    const held = [
      existing({ id: 'a', visitDate: '2026-09-12', isLocked: true }),
      existing({ id: 'b', visitDate: '2026-09-19', isLocked: true }),
      existing({ id: 'c', visitDate: '2026-09-26', isLocked: true }),
    ];

    const plan = planGeneration(honourProtectedDates(twice, held, monthly()), held);

    expect(plan.additions).toEqual([]);
    // Both are pinned, and both are reported as the moves they stand in for.
    expect(plan.protectedVisits).toEqual([
      expect.objectContaining({
        visitId: 'a',
        wouldHave: 'UPDATE',
        changes: [{ field: 'visitDate', from: '2026-09-12', to: '2026-09-07' }],
      }),
      expect.objectContaining({
        visitId: 'b',
        wouldHave: 'UPDATE',
        changes: [{ field: 'visitDate', from: '2026-09-19', to: '2026-09-21' }],
      }),
      // The third is more than the agreement asks for. It is still never
      // removed — it is reported, and left exactly where it is.
      expect.objectContaining({ visitId: 'c', wouldHave: 'REMOVE' }),
    ]);
    expect(plan.removals).toEqual([]);
  });

  it('keeps months apart — a protected March visit does not satisfy April', () => {
    const april = [required({ visitDate: '2026-10-14', periodIndex: 1 })];
    const march = [existing({ visitDate: '2026-09-12', isLocked: true })];

    const pinned = honourProtectedDates(april, march, monthly());

    expect(pinned[0].visitDate).toBe('2026-10-14');
  });

  it('ignores an agreement this run was not asked about', () => {
    const other = [existing({ serviceAgreementId: 'agreement-2', isLocked: true })];

    expect(honourProtectedDates([required()], other, monthly())).toEqual([required()]);
  });

  it('takes the whole window of the day it was pinned to, not half of it', () => {
    // The keeper's day has its own hours. Copying the date and the start but
    // leaving the requirement's end produced a window nobody ever recorded,
    // and every run reported a protected windowEndMinute change that no run
    // could ever apply — the same phantom, for ever.
    const shortDay = existing({ isLocked: true, windowEndMinute: 720 });
    const pinned = honourProtectedDates([required()], [shortDay], monthly());

    expect(pinned[0].windowEndMinute).toBe(720);
  });

  it('says which day generation would have moved a protected visit to', () => {
    // Pinning makes the protected visit satisfy its period, which is right.
    // Reporting it as unchanged is not: the agreement no longer allows that
    // weekday, and a manager who is never told will never move it.
    const plan = planGeneration(
      honourProtectedDates([required()], [existing({ isLocked: true })], monthly()),
      [existing({ isLocked: true })],
    );

    expect(plan.protectedVisits).toEqual([
      expect.objectContaining({
        visitId: 'visit-1',
        visitDate: '2026-09-12',
        wouldHave: 'UPDATE',
        changes: [{ field: 'visitDate', from: '2026-09-12', to: '2026-09-16' }],
      }),
    ]);
    expect(plan.additions).toEqual([]);
    expect(plan.removals).toEqual([]);
  });

  it('reports the move and nothing about the window of the day it was moved to', () => {
    // The phantom: the pinned requirement kept the end of the day the
    // generator had wanted, so a hand-move to a day the site shuts at noon
    // was reported as a windowEndMinute change on every run for ever — and a
    // protected visit is never written, so it never went away.
    const shortDay = existing({ isLocked: true, windowEndMinute: 720 });
    const plan = planGeneration(
      honourProtectedDates([required()], [shortDay], monthly()),
      [shortDay],
    );

    expect(plan.protectedVisits[0].changes).toEqual([
      { field: 'visitDate', from: '2026-09-12', to: '2026-09-16' },
    ]);
  });

  it('reports nothing at all when the hours differ and the day does not', () => {
    const shortDay = existing({
      isLocked: true,
      windowEndMinute: 720,
      placement: VisitPlacement.ANCHORED,
    });
    const plan = planGeneration(
      honourProtectedDates(
        [required({ visitDate: '2026-09-12', windowEndMinute: 720 })],
        [shortDay],
        monthly(),
      ),
      [shortDay],
    );

    expect(plan.protectedVisits).toEqual([]);
    expect(plan.unchangedCount).toBe(1);
  });

  it('keeps both protected visits on a date they share with different starts', () => {
    // Keyed by date alone, the second slot vanished: the morning visit made
    // the date "held" and the afternoon one was filtered out of the pinning,
    // so the requirement for it was planned onto another day and the customer
    // got a third visit.
    const twice = [
      required({ visitDate: '2026-09-07', windowStartMinute: 540 }),
      required({ visitDate: '2026-09-21', windowStartMinute: 540 }),
    ];
    const held = [
      existing({ id: 'a', visitDate: '2026-09-07', windowStartMinute: 540, isLocked: true }),
      existing({ id: 'b', visitDate: '2026-09-07', windowStartMinute: 780, isLocked: true }),
    ];

    const pinned = honourProtectedDates(twice, held, monthly());

    expect(pinned.map((visit) => [visit.visitDate, visit.windowStartMinute])).toEqual([
      ['2026-09-07', 540],
      ['2026-09-07', 780],
    ]);
  });

  describe('a hand-move the agreement is content with', () => {
    // D2 gating. A manager who moves a visit from one allowed day to another
    // has made a choice the agreement agrees with. Reporting "would have moved
    // it back" on every run for ever teaches managers to skip the section —
    // and buries the case that matters, a visit stranded on a weekday the
    // agreement has since dropped.
    const onAWednesday = existing({ visitDate: '2026-09-09', isLocked: true });

    it('is not reported as a move generation would make', () => {
      const plan = planGeneration(
        honourProtectedDates([required()], [onAWednesday], monthly()),
        [onAWednesday],
      );

      expect(plan.protectedVisits).toEqual([]);
      expect(plan.unchangedCount).toBe(1);
      expect(plan.additions).toEqual([]);
      expect(plan.removals).toEqual([]);
    });

    it('is reported again the moment the agreement drops that weekday', () => {
      const plan = planGeneration(
        honourProtectedDates(
          [required()],
          [onAWednesday],
          monthly([Weekday.MONDAY, Weekday.TUESDAY, Weekday.THURSDAY, Weekday.FRIDAY]),
        ),
        [onAWednesday],
      );

      expect(plan.protectedVisits).toEqual([
        expect.objectContaining({
          visitId: 'visit-1',
          visitDate: '2026-09-09',
          wouldHave: 'UPDATE',
          changes: [{ field: 'visitDate', from: '2026-09-09', to: '2026-09-16' }],
        }),
      ]);
    });

    it('still pins the period, so nothing is duplicated', () => {
      const pinned = honourProtectedDates([required()], [onAWednesday], monthly());

      expect(pinned[0].visitDate).toBe('2026-09-09');
      expect(pinned[0].pinnedFrom).toBeUndefined();
    });
  });

  /**
   * A requirement that lands on a protected visit's own slot IS that visit.
   *
   * The load guard may move a requirement to another day in the same period.
   * Do that to one of these and two things go wrong at once: a visit is
   * created on the new day while the protected one stays where it is, and the
   * guard treats the old day as a place freed up — when nothing left it. A day
   * carrying three protected visits against a cap of two then ends the run
   * still carrying three, with nothing said.
   *
   * A requirement pinned *onto* a keeper already has its alternatives cleared
   * ("this date belongs to someone"). One that was already on the keeper's
   * slot is the same situation and needs the same treatment.
   */
  describe('a requirement already standing on a protected slot', () => {
    const onTheRequirementsOwnSlot = existing({
      visitDate: '2026-09-16',
      windowStartMinute: 540,
      isLocked: true,
    });

    it('is left nowhere for the load guard to move it to', () => {
      const pinned = honourProtectedDates(
        [required()],
        [onTheRequirementsOwnSlot],
        monthly(),
      );

      expect(pinned[0].visitDate).toBe('2026-09-16');
      expect(pinned[0].alternatives).toEqual([]);
    });

    it('leaves an ordinary requirement its alternatives', () => {
      // Nothing protected in the period, so the guard is free as before.
      const pinned = honourProtectedDates(
        [required()],
        [existing({ isLocked: true, visitDate: '2026-10-19' })],
        monthly(),
      );

      expect(pinned[0].alternatives).toHaveLength(1);
    });
  });

  /**
   * A booking is a commitment to a DATE, not to a weekday.
   *
   * The would-have-moved report is suppressed when the keeper's own weekday is
   * one the agreement still allows: a manager who moved a visit from Monday to
   * Wednesday made a choice the agreement is content with, and saying so for
   * ever teaches managers to skip the section. That reasoning does not reach a
   * booked date. The customer agreed 2 October, not "some Friday"; a protected
   * visit on the 20th does not serve it, and every part of the report went
   * quiet at once — the date was pinned away, the placement was copied from
   * the keeper so even that diff did not fire, and the plan counted the visit
   * as already correct. "1 visit is already correct and needs nothing", while
   * the agreed date gets nothing and nobody is told.
   */
  describe('a booked date a protected visit displaces', () => {
    const booked = required({
      visitDate: '2026-10-02',
      placement: VisitPlacement.BOOKED,
      periodIndex: 1,
      alternatives: [],
    });
    // A Tuesday — a day this agreement allows, which is exactly what used to
    // buy the silence.
    const keeperOnAnAllowedWeekday = existing({
      visitDate: '2026-10-20',
      status: 'SCHEDULED',
    });

    it('says which date the booking was, so the report can name it', () => {
      const pinned = honourProtectedDates([booked], [keeperOnAnAllowedWeekday], monthly());

      expect(pinned[0].visitDate).toBe('2026-10-20');
      expect(pinned[0].pinnedFrom).toBe('2026-10-02');
    });

    it('reaches the plan as a protected visit, never as one already correct', () => {
      const plan = planGeneration(
        honourProtectedDates([booked], [keeperOnAnAllowedWeekday], monthly()),
        [keeperOnAnAllowedWeekday],
      );

      expect(plan.unchangedCount).toBe(0);
      expect(plan.protectedVisits).toEqual([
        expect.objectContaining({
          visitId: 'visit-1',
          visitDate: '2026-10-20',
          wouldHave: 'UPDATE',
          changes: expect.arrayContaining([
            { field: 'visitDate', from: '2026-10-20', to: '2026-10-02' },
          ]),
        }),
      ]);
    });

    it('still keeps quiet for an unbooked visit the manager simply moved', () => {
      // The case the exemption exists for, unchanged.
      const planned = required({
        visitDate: '2026-10-05',
        placement: VisitPlacement.ANCHORED,
        periodIndex: 1,
        alternatives: [],
      });
      const pinned = honourProtectedDates(
        [planned],
        [keeperOnAnAllowedWeekday],
        monthly(),
      );

      expect(pinned[0].visitDate).toBe('2026-10-20');
      expect(pinned[0].pinnedFrom).toBeUndefined();
    });
  });

  it('does not touch the list it was handed', () => {
    const input = [required()];
    honourProtectedDates(input, [existing({ isLocked: true })], monthly());

    expect(input[0].visitDate).toBe('2026-09-16');
  });
});

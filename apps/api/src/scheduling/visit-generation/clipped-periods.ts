import { FrequencyUnit } from '@prisma/client';

import {
  PreviewSkippedPeriod,
  parseDateOnly,
  startOfIsoWeek,
  toDateOnly,
} from '../../catalog/schedule-preview';

/**
 * Whether clipping one of this cadence's periods risks losing it altogether.
 *
 * A month is safe: consecutive month grids either overlap or abut, and the
 * next run plans the calendar month whole by construction. A week is safe for
 * the same reason — both views send whole ISO weeks. A cadence of *several*
 * weeks is the one that needs watching: its periods are phased from the
 * agreement's own start, so one can begin far enough back that no neighbouring
 * grid reaches it.
 */
export function clippingOneMayLoseIt(unit: FrequencyUnit, interval: number): boolean {
  return unit === FrequencyUnit.WEEK && interval > 1;
}

export interface ClippedPeriodScope {
  /** The run's own range. YYYY-MM-DD. */
  from: string;
  to: string;
  /**
   * The periods of this agreement a visit already stands in, by index.
   *
   * Read over the whole calendar months the range touches, which is wider than
   * the range itself, so a period clipped at either edge can be looked up.
   */
  periodsHoldingAVisit: ReadonlySet<number>;
}

/**
 * Of the periods this range cut in half, the ones actually at risk of never
 * being planned.
 *
 * Two questions, and a period has to fail both to be worth a manager's time.
 *
 * The first is whether any *other* range would hold it whole. Month grids are
 * chosen so that consecutive ones overlap by exactly one ISO week — a grid
 * that ends the day before a month begins reaches a week further — and the
 * next grid therefore begins on the Monday of this range's final week. So a
 * period cut by this range's **end** is picked up by the next grid whenever it
 * began on or after that Monday, and is lost only when it began earlier.
 * Since a fortnight is fourteen days and the overlap is seven, an end-clipped
 * fortnight always begins inside the overlap: **fortnights are always
 * covered**, and it is cadences of three weeks or more this warning is for.
 * A period cut by this range's **start** is a different matter: the run before
 * this one reached at least this one's first day, so ordinarily it planned the
 * period — but "ordinarily" is an assumption about a run that may never have
 * happened, which is the next question.
 *
 * The second is whether the period is in fact empty. An agreement created
 * after the previous month was generated has a first period no run ever saw:
 * its start is before this range's first day, the earlier run predates the
 * agreement, and the customer's first fortnight silently gets nothing. Rather
 * than reason about which runs have been pressed, the rule asks the calendar:
 * a clipped period **a visit of this agreement already stands in** is being
 * handed over as designed and is not reported, and one standing empty is.
 * That holds at either edge and needs no assumption at all.
 */
export function clippedPeriodsAtRisk(
  skipped: readonly PreviewSkippedPeriod[],
  scope: ClippedPeriodScope,
): PreviewSkippedPeriod[] {
  const lastWeekStart = toDateOnly(startOfIsoWeek(parseDateOnly(scope.to)));

  return skipped.filter((period) => {
    // Something of this agreement is already there. Whoever planned it, the
    // customer has the visit, and a warning would send a manager to fix a
    // calendar that is correct.
    if (scope.periodsHoldingAVisit.has(period.periodIndex)) return false;

    // Cut by the end: lost only if it began before the week the next grid
    // starts on.
    if (period.end > scope.to) return period.start < lastWeekStart;

    // Cut by the start, and empty: no run is coming back for it.
    return period.start < scope.from;
  });
}

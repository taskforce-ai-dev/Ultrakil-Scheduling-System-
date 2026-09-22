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
  // The overlap argument holds for the ranges the portal sends, and only for
  // those. `GenerateVisitsDto` validates two dates and nothing more, so a
  // contract client may ask for May's raw grid — 27 April to 31 May — where
  // the next month's grid begins on 1 June, *after* the fortnight from 25 May
  // started, and suppressing the report would lose it in silence. Nothing is
  // suppressed on an assumption the caller has not actually met.
  const overlapsTheNextGrid = looksLikeAMonthGrid(scope.from, scope.to);

  return skipped.filter((period) => {
    // Something of this agreement is already there. Whoever planned it, the
    // customer has the visit, and a warning would send a manager to fix a
    // calendar that is correct.
    if (scope.periodsHoldingAVisit.has(period.periodIndex)) return false;

    // Cut by the end: lost only if it began before the week the next grid
    // starts on — and only a range shaped like a month grid has a next grid
    // that reaches back that far.
    if (period.end > scope.to) {
      return !overlapsTheNextGrid || period.start < lastWeekStart;
    }

    // Cut by the start, and empty: no run is coming back for it.
    return period.start < scope.from;
  });
}

/**
 * Whether this range is one of the month grids the overlap argument is about.
 *
 * A grid runs from the Monday on or before the 1st to the Sunday on or after
 * the last day (reaching one ISO week further where that Sunday is the day
 * before a month begins), so it always starts on a Monday, ends on a Sunday,
 * and contains a whole calendar month. Those three together are what make the
 * next grid begin on the Monday of this one's final week; a range that fails
 * any of them has no such guarantee, and its clipped periods are reported.
 *
 * The week view is deliberately not a grid: it holds no whole month, so it
 * falls through here — which costs it nothing, because a weekly cadence never
 * reaches this code and a longer one it cannot see whole is reported as
 * RANGE_HOLDS_NO_WHOLE_PERIOD instead.
 */
function looksLikeAMonthGrid(from: string, to: string): boolean {
  const start = parseDateOnly(from);
  const end = parseDateOnly(to);
  // getUTCDay: 1 is Monday, 0 is Sunday.
  if (start.getUTCDay() !== 1 || end.getUTCDay() !== 0) return false;

  // A grid whose last day is the day before a month begins is one the portal
  // would have reached a whole ISO week past — that is the single seam
  // `rangeForGeneration` sews shut. Arriving here unextended, it is not a
  // range the portal sent, and the next grid starts after this one's final
  // week rather than on its Monday. May's raw grid, 27 April to 31 May, is
  // exactly that: June's begins on 1 June, after the fortnight from 25 May
  // started, and nobody holds it whole.
  const dayAfter = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  if (dayAfter.getUTCDate() === 1) return false;

  // The first of the month that starts on or after `from`, and its last day.
  const firstOfMonth = new Date(
    Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth() + (start.getUTCDate() === 1 ? 0 : 1),
      1,
    ),
  );
  const lastOfMonth = new Date(
    Date.UTC(firstOfMonth.getUTCFullYear(), firstOfMonth.getUTCMonth() + 1, 0),
  );
  return firstOfMonth >= start && lastOfMonth <= end;
}

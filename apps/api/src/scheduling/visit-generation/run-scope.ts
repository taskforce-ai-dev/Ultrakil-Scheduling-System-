import { parseDateOnly, periodIndexOf } from '../../catalog/schedule-preview';
import { AgreementPeriodShape } from './protected-periods';

/**
 * Which visits already in the calendar a run may speak for.
 *
 * Two questions, and they are not opposites. A run *judges* a visit when it
 * may propose changing or removing it; a run *leaves a visit standing* when it
 * will not touch it, and the day it occupies is therefore already spoken for.
 * Every existing visit in the horizon is one or the other, and the pair has to
 * be exhaustive: a visit in neither is one the comparison ignores and the load
 * guard cannot see — which is exactly how a week view and a month view came to
 * disagree about the same Monday.
 */

/** An agreement's own first and last day, as a run reads them. */
export interface AgreementLifetime {
  /** YYYY-MM-DD. */
  start: string;
  /** YYYY-MM-DD, or null for an open-ended agreement. */
  end: string | null;
}

/** The little a scope decision needs to know about a visit. */
export interface ScopedVisit {
  serviceAgreementId: string;
  /** YYYY-MM-DD. */
  visitDate: string;
}

/**
 * Whether this run may propose anything about a visit already in the calendar.
 *
 * Three things have to hold. The visit is inside the run's own range — a run
 * changes nothing outside what it was asked about. Its agreement is in scope.
 * And the run planned the period the visit sits in: a visit standing in a
 * period this range holds only a slice of belongs to the run that can see that
 * period whole, and offering to delete it was how a month view proposed
 * removing the week a week view had just created.
 *
 * One exception, and it is not a period at all. A visit outside the
 * agreement's own start or end date is not waiting for a better run: no period
 * of that agreement will ever ask for it again, so it is this run's to remove.
 */
export function thisRunsToJudge(
  visit: ScopedVisit,
  range: { from: string; to: string },
  shapes: Map<string, AgreementPeriodShape>,
  plannedPeriods: Map<string, Set<number>>,
  lives: Map<string, AgreementLifetime>,
): boolean {
  if (visit.visitDate < range.from || visit.visitDate > range.to) return false;

  const life = lives.get(visit.serviceAgreementId);
  if (!life) return false;
  if (visit.visitDate < life.start) return true;
  if (life.end !== null && visit.visitDate > life.end) return true;

  const shape = shapes.get(visit.serviceAgreementId);
  if (!shape) return false;

  const period = periodIndexOf(
    parseDateOnly(visit.visitDate),
    parseDateOnly(shape.anchor),
    shape.frequencyUnit,
    shape.frequencyInterval,
  );
  return plannedPeriods.get(visit.serviceAgreementId)?.has(period) ?? false;
}

/**
 * Whether this run will leave a visit exactly where it is.
 *
 * The load guard's question, and the complement of `thisRunsToJudge` — not of
 * "protected". Three kinds of visit stand:
 *
 * - a protected one, which stays whatever the run decides;
 * - one belonging to an agreement the run was not asked about;
 * - and one whose **period this run did not plan**. A monthly visit seen from
 *   a week view is the ordinary case: the week holds no whole month, so the
 *   run skips the period, proposes nothing about the visit — and used to count
 *   it nowhere either. The guard then read the Monday it sits on as emptier
 *   than it is and placed weekly work onto it; the next month run, whose
 *   fuller picture was right, moved that work straight off again. Placement
 *   flapped with whichever view a manager happened to press Generate from.
 *
 * A cancelled visit is the one thing that never stands. It is protected and it
 * is never removed, but the optimizer excludes it from the day's capacity and
 * so must the guard: counting one reserves a crew's worth of room for work
 * nobody will do.
 */
export function leftStandingBy(
  visit: ScopedVisit & { isProtected: boolean; isInScope: boolean },
  range: { from: string; to: string },
  shapes: Map<string, AgreementPeriodShape>,
  plannedPeriods: Map<string, Set<number>>,
  lives: Map<string, AgreementLifetime>,
): boolean {
  if (!visit.isInScope) return true;
  if (visit.isProtected) return true;
  return !thisRunsToJudge(visit, range, shapes, plannedPeriods, lives);
}

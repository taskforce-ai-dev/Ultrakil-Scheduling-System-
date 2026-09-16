import { FrequencyUnit, Weekday } from '@prisma/client';

import { parseDateOnly, periodIndexOf, weekdayOf } from '../../catalog/schedule-preview';
import { ExistingVisit, RequiredVisit, protectionReasonFor } from './plan';

/**
 * Stops a protected visit and its own replacement from both standing.
 *
 * A visit is matched to an existing one by agreement, date and start time. So
 * when an agreement's period is re-planned onto a different day — which this
 * release makes routine, since a month that used to take its earliest allowed
 * day now takes its anchor — the new date reads as an addition and the old one
 * as a removal. That is correct for a visit the generator owns: it is removed
 * and recreated. It is wrong for a visit a manager owns. A published, locked,
 * hand-edited or already-staffed visit is kept, and the addition was created
 * anyway, so the customer ended up with two visits in one period.
 *
 * The rule that resolves it: a protected visit *satisfies* its period. The
 * manager has already decided when that period's work happens, so the period's
 * requirement is pinned to that date rather than planned onto another one.
 * Everything the agreement still owns — how long the visit is, how many people
 * it needs — stays as the agreement says, so a genuine change is still
 * reported as one (and still not applied, because the visit is protected).
 *
 * A period holding more protected visits than the agreement now asks for keeps
 * the surplus and reports it, exactly as before. Nothing here removes work.
 *
 * One visit is deliberately outside the rule. A cancelled visit is protected —
 * it is never removed — but it *satisfies* nothing: the work did not happen,
 * so the period still wants a visit, and pinning it to the cancelled row would
 * leave the customer with a cancellation where a visit was due.
 *
 * Pinning stops a duplicate; it must not also hide a difference. The day the
 * generator had chosen is remembered on the pinned requirement, so the plan
 * can still say which day the visit would have moved to — a protected visit
 * held on a weekday the agreement no longer allows would otherwise read as
 * "unchanged", and nobody would ever move it.
 */

/** How an agreement's work is divided into periods. */
export interface AgreementPeriodShape {
  serviceAgreementId: string;
  /**
   * The agreement's own start date, YYYY-MM-DD — what the ISO weeks or
   * calendar months are counted from. Never the run's range: a fortnight
   * belongs to the agreement, not to whoever pressed Generate.
   */
  anchor: string;
  frequencyUnit: FrequencyUnit;
  frequencyInterval: number;
  /**
   * The weekdays the agreement still allows. A keeper on one of them is a day
   * the agreement is content with, however it got there.
   */
  allowedDays: Weekday[];
}

const keyOf = (serviceAgreementId: string, period: number) =>
  `${serviceAgreementId}|${period}`;

/**
 * True when the day a protected visit is held on is still an allowed weekday.
 *
 * An agreement with no allowed weekdays at all plans nothing, so it has no
 * opinion to report either: treated as content, rather than as objecting to
 * every day there is.
 */
const allowsTheKeepersDay = (
  shape: AgreementPeriodShape,
  visitDate: string,
): boolean =>
  shape.allowedDays.length === 0 ||
  shape.allowedDays.includes(weekdayOf(parseDateOnly(visitDate)));

/**
 * One slot in a period: a date *and* a start time.
 *
 * A date alone is not a slot. A site served morning and afternoon on the same
 * Monday holds two protected visits that day, and keying by date let the
 * morning one speak for both — the afternoon requirement was then planned onto
 * some other day and the customer got a third visit.
 */
const slotOf = (visitDate: string, windowStartMinute: number) =>
  `${visitDate}|${windowStartMinute}`;

/**
 * Pins each period's requirement to the protected visit that already covers
 * it. Returns a new list; the one passed in is left alone.
 */
export function honourProtectedDates(
  required: RequiredVisit[],
  existing: ExistingVisit[],
  shapes: Map<string, AgreementPeriodShape>,
): RequiredVisit[] {
  const protectedByPeriod = new Map<string, ExistingVisit[]>();

  for (const visit of existing) {
    const protection = protectionReasonFor(visit);
    if (!protection) continue;
    // Protected, but not a stand-in for the work: see above.
    if (protection === 'CANCELLED') continue;
    const shape = shapes.get(visit.serviceAgreementId);
    // An agreement outside this run plans nothing here, so there is nothing
    // of its to pin.
    if (!shape) continue;

    const period = periodIndexOf(
      parseDateOnly(visit.visitDate),
      parseDateOnly(shape.anchor),
      shape.frequencyUnit,
      shape.frequencyInterval,
    );
    const key = keyOf(visit.serviceAgreementId, period);
    const list = protectedByPeriod.get(key) ?? [];
    list.push(visit);
    protectedByPeriod.set(key, list);
  }

  if (protectedByPeriod.size === 0) return required.map((visit) => ({ ...visit }));

  const requiredByPeriod = new Map<string, number[]>();
  required.forEach((visit, index) => {
    const key = keyOf(visit.serviceAgreementId, visit.periodIndex);
    const list = requiredByPeriod.get(key) ?? [];
    list.push(index);
    requiredByPeriod.set(key, list);
  });

  const pinned = required.map((visit) => ({ ...visit }));

  for (const [key, group] of protectedByPeriod) {
    // Every visit in the group shares an agreement — the key is built from it.
    const shape = shapes.get(group[0].serviceAgreementId);
    const indices = (requiredByPeriod.get(key) ?? [])
      .slice()
      .sort((a, b) => pinned[a].visitDate.localeCompare(pinned[b].visitDate));
    if (indices.length === 0) continue;

    // Dates the run already asks for need no pinning; they are the same
    // visit, and the ordinary comparison will report them as unchanged.
    const held = new Set(
      indices
        .filter((index) =>
          group.some(
            (visit) =>
              visit.visitDate === pinned[index].visitDate &&
              visit.windowStartMinute === pinned[index].windowStartMinute,
          ),
        )
        .map((index) =>
          slotOf(pinned[index].visitDate, pinned[index].windowStartMinute),
        ),
    );

    // A requirement already standing on a protected visit's own slot *is*
    // that visit, so it is no more the load guard's to move than a pinned one
    // is. Left movable, the guard both invents a visit on the day it moves to
    // — the protected one never goes anywhere — and reads the day it left as
    // one place emptier, which is how a day carrying three protected visits
    // against a cap of two finished a run still carrying three, unwarned.
    for (const index of indices) {
      if (!held.has(slotOf(pinned[index].visitDate, pinned[index].windowStartMinute))) {
        continue;
      }
      pinned[index] = { ...pinned[index], alternatives: [] };
    }

    const movers = indices.filter(
      (index) =>
        !held.has(slotOf(pinned[index].visitDate, pinned[index].windowStartMinute)),
    );
    const seen = new Set<string>();
    const unmatched = group
      .filter((visit) => !held.has(slotOf(visit.visitDate, visit.windowStartMinute)))
      .sort(
        (a, b) =>
          a.visitDate.localeCompare(b.visitDate) ||
          a.windowStartMinute - b.windowStartMinute,
      )
      // One slot per date and start time. Two protected visits sharing both
      // are the same slot, and pinning two requirements onto it would make a
      // pair of requirements that cannot be told apart.
      .filter((visit) => {
        const slot = slotOf(visit.visitDate, visit.windowStartMinute);
        if (seen.has(slot)) return false;
        seen.add(slot);
        return true;
      });

    for (let slot = 0; slot < Math.min(movers.length, unmatched.length); slot += 1) {
      const index = movers[slot];
      const keeper = unmatched[slot];
      pinned[index] = {
        ...pinned[index],
        visitDate: keeper.visitDate,
        windowStartMinute: keeper.windowStartMinute,
        // The whole of the keeper's window, not half of it. Taking the date
        // and the start but keeping the requirement's end invented a window
        // nobody recorded — and, since a protected visit is never written,
        // every run reported the same windowEndMinute change for ever.
        windowEndMinute: keeper.windowEndMinute,
        // The manager chose the day, not the generator, so the placement on
        // record stays the one that explains it. Re-labelling it would put a
        // reason on the visit that had nothing to do with the date.
        placement: keeper.placement,
        // Never a candidate for the load guard: this date belongs to someone.
        alternatives: [],
        // The day this period would have been planned onto — but only when
        // the keeper's own weekday is one the agreement no longer allows.
        //
        // A manager who moves a visit from Monday to Wednesday, both allowed,
        // has made a choice the agreement is content with; reporting "would
        // have moved it to Monday" on that, for ever, teaches managers to
        // ignore the section. A visit stranded on a Saturday the agreement has
        // since dropped is the case the report exists for.
        ...(keeper.visitDate === pinned[index].visitDate ||
        (shape !== undefined && allowsTheKeepersDay(shape, keeper.visitDate))
          ? {}
          : { pinnedFrom: pinned[index].visitDate }),
      };
    }
  }

  return pinned;
}

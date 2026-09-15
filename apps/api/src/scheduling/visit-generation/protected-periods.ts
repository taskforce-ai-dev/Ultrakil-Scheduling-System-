import { FrequencyUnit } from '@prisma/client';

import { parseDateOnly, periodIndexOf } from '../../catalog/schedule-preview';
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
 */

/** How an agreement's horizon is divided into periods. */
export interface AgreementPeriodShape {
  serviceAgreementId: string;
  /** The first day of the agreement's own horizon, YYYY-MM-DD. */
  horizonStart: string;
  frequencyUnit: FrequencyUnit;
  frequencyInterval: number;
}

const keyOf = (serviceAgreementId: string, period: number) =>
  `${serviceAgreementId}|${period}`;

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
    if (!protectionReasonFor(visit)) continue;
    const shape = shapes.get(visit.serviceAgreementId);
    // An agreement outside this run plans nothing here, so there is nothing
    // of its to pin.
    if (!shape) continue;

    const period = periodIndexOf(
      parseDateOnly(visit.visitDate),
      parseDateOnly(shape.horizonStart),
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
        .map((index) => pinned[index].visitDate),
    );

    const movers = indices.filter((index) => !held.has(pinned[index].visitDate));
    const seen = new Set<string>();
    const unmatched = group
      .filter((visit) => !held.has(visit.visitDate))
      .sort(
        (a, b) =>
          a.visitDate.localeCompare(b.visitDate) ||
          a.windowStartMinute - b.windowStartMinute,
      )
      // One slot per date and start time. Two protected visits sharing both
      // are the same slot, and pinning two requirements onto it would make a
      // pair of requirements that cannot be told apart.
      .filter((visit) => {
        const slot = `${visit.visitDate}|${visit.windowStartMinute}`;
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
        // The manager chose the day, not the generator, so the placement on
        // record stays the one that explains it. Re-labelling it would put a
        // reason on the visit that had nothing to do with the date.
        placement: keeper.placement,
        // Never a candidate for the load guard: this date belongs to someone.
        alternatives: [],
      };
    }
  }

  return pinned;
}

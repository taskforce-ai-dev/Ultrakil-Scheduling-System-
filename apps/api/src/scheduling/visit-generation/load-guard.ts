import { BranchCode, VisitPlacement } from '@prisma/client';

import { RequiredVisit } from './plan';

/**
 * Keeps a single day from carrying a month's work.
 *
 * Each agreement is planned on its own, so nothing in per-agreement planning
 * can see that forty of them have all chosen the same Monday. This is the one
 * pass that looks across every agreement at once: for a branch-day carrying
 * more than the cap, it moves unbooked visits to another day inside their own
 * period until the day sits at the cap.
 *
 * Three rules keep it honest. A booked visit is a commitment and is never
 * moved, though it still counts towards the day's load. A visit only ever
 * moves inside its own period, because a month's visit pushed into the next
 * month is a different promise. And nothing is moved onto a day that is
 * already full, which would merely relocate the problem.
 *
 * Every ordering here is total — agreements by id, days by date — so running
 * it twice on the same horizon produces the same calendar, which is what lets
 * regeneration report nothing to do.
 */

/**
 * The busiest day in the workbook's own July plan: 159 visits over 28 days,
 * never more than twelve on one of them. It is UltraKIL's demonstrated
 * capacity rather than a number invented here.
 */
export const DEFAULT_DAILY_VISIT_CAP = 12;

/** A day that still carries more work than the cap allows. */
export interface DailyLoadWarning {
  branchCode: BranchCode;
  /** YYYY-MM-DD. */
  date: string;
  plannedCount: number;
  /** How many of those are booked dates, which cannot be moved. */
  bookedCount: number;
  cap: number;
  message: string;
}

export interface LoadGuardResult {
  required: RequiredVisit[];
  warnings: DailyLoadWarning[];
}

/** Reads the cap from the environment, falling back to the workbook's own. */
export function dailyVisitCapFrom(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_DAILY_VISIT_CAP;
  return parsed;
}

const loadKey = (branchCode: BranchCode, date: string) => `${branchCode}|${date}`;
const periodKey = (visit: RequiredVisit) =>
  `${visit.serviceAgreementId}|${visit.periodIndex}`;

export function applyDailyLoadGuard(
  required: RequiredVisit[],
  cap: number,
): LoadGuardResult {
  // Copies throughout: the caller's list is its own account of what the
  // agreements asked for, and a guard that edited it in place would make the
  // two impossible to compare.
  const visits = required.map((visit) => ({ ...visit }));

  const load = new Map<string, number>();
  const usedDates = new Map<string, Set<string>>();
  for (const visit of visits) {
    const key = loadKey(visit.branchCode, visit.visitDate);
    load.set(key, (load.get(key) ?? 0) + 1);
    const period = periodKey(visit);
    const used = usedDates.get(period) ?? new Set<string>();
    used.add(visit.visitDate);
    usedDates.set(period, used);
  }

  const overloaded = [...load.entries()]
    .filter(([, count]) => count > cap)
    .map(([key]) => key)
    // Earliest day first, then branch: a stable order, so two runs make the
    // same moves in the same sequence.
    .sort((a, b) => {
      const [branchA, dateA] = a.split('|');
      const [branchB, dateB] = b.split('|');
      return dateA.localeCompare(dateB) || branchA.localeCompare(branchB);
    });

  for (const key of overloaded) {
    const movers = visits
      .filter(
        (visit) =>
          loadKey(visit.branchCode, visit.visitDate) === key &&
          visit.placement !== VisitPlacement.BOOKED &&
          visit.alternatives.length > 0,
      )
      .sort(
        (a, b) =>
          a.serviceAgreementId.localeCompare(b.serviceAgreementId) ||
          a.visitDate.localeCompare(b.visitDate) ||
          a.windowStartMinute - b.windowStartMinute,
      );

    for (const visit of movers) {
      if ((load.get(key) ?? 0) <= cap) break;

      const period = periodKey(visit);
      const used = usedDates.get(period) ?? new Set<string>();

      const target = visit.alternatives
        .filter((alternative) => !used.has(alternative.date))
        .map((alternative) => ({
          alternative,
          load: load.get(loadKey(visit.branchCode, alternative.date)) ?? 0,
        }))
        // A day already at the cap is no help: moving there would only make
        // the next pass undo it.
        .filter((entry) => entry.load < cap)
        .sort(
          (a, b) =>
            a.load - b.load || a.alternative.date.localeCompare(b.alternative.date),
        )[0];

      if (!target) continue;

      const from = visit.visitDate;
      const targetKey = loadKey(visit.branchCode, target.alternative.date);
      load.set(key, (load.get(key) ?? 1) - 1);
      load.set(targetKey, (load.get(targetKey) ?? 0) + 1);
      used.delete(from);
      used.add(target.alternative.date);
      usedDates.set(period, used);

      visit.visitDate = target.alternative.date;
      visit.windowStartMinute = target.alternative.windowStartMinute;
      visit.windowEndMinute = target.alternative.windowEndMinute;
      visit.isPreferredDay = target.alternative.isPreferredDay;
      visit.windowProvenance = target.alternative.windowProvenance;
      visit.placement = VisitPlacement.SPREAD;
      // The day it came from is now free for it, and the day it went to is not.
      visit.alternatives = visit.alternatives
        .filter((alternative) => alternative.date !== target.alternative.date)
        .concat(
          from === target.alternative.date
            ? []
            : [
                {
                  date: from,
                  weekday: target.alternative.weekday,
                  windowStartMinute: visit.windowStartMinute,
                  windowEndMinute: visit.windowEndMinute,
                  isPreferredDay: visit.isPreferredDay,
                  windowProvenance: target.alternative.windowProvenance,
                },
              ],
        )
        .sort((a, b) => a.date.localeCompare(b.date));
    }
  }

  const warnings: DailyLoadWarning[] = [];
  for (const [key, count] of [...load.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (count <= cap) continue;
    const [branchCode, date] = key.split('|') as [BranchCode, string];
    const bookedCount = visits.filter(
      (visit) =>
        visit.branchCode === branchCode &&
        visit.visitDate === date &&
        visit.placement === VisitPlacement.BOOKED,
    ).length;

    warnings.push({
      branchCode,
      date,
      plannedCount: count,
      bookedCount,
      cap,
      message:
        bookedCount >= count
          ? `${date} carries ${count} visits in ${branchCode}, over the ${cap} a day this branch plans for. Every one of them is a date already booked with the customer, so none was moved.`
          : `${date} carries ${count} visits in ${branchCode}, over the ${cap} a day this branch plans for. ${bookedCount} are already booked with the customer, and the rest had no other day inside their period to move to.`,
    });
  }

  // Back in the order they arrived, so the plan reads the same way it was built.
  return { required: visits, warnings };
}

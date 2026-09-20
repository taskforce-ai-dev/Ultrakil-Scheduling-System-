import { BranchCode, DataProvenance, VisitPlacement } from '@prisma/client';

import { parseDateOnly, weekdayOf } from '../../catalog/schedule-preview';
import { crewMinutesOf } from '../capacity';
import {
  DayInfeasibility,
  DayInfeasibilityCode,
  DayVisitDemand,
} from './day-feasibility';
import { RequiredVisit } from './plan';

/**
 * Keeps a single day from carrying a month's work.
 *
 * Each agreement is planned on its own, so nothing in per-agreement planning
 * can see that forty of them have all chosen the same Monday. This is the one
 * pass that looks across every agreement at once: for a branch-day carrying
 * more crew-minutes than the cap, it moves unbooked visits to another day
 * inside their own period until the day sits at the cap.
 *
 * Capacity is spent in crew-minutes — a visit's duration times its crew size
 * — not in a raw count of visits. A count could not tell a fifteen-minute
 * one-person check apart from a four-hour four-person job, and the source
 * workbook itself has a fifteen-visit day nothing is wrong with; crew-minutes
 * can tell the two apart, because it is the same quantity a crew's own day is
 * measured in.
 *
 * Three rules keep it honest. A booked visit is a commitment and is never
 * moved, though it still counts towards the day's load. A visit only ever
 * moves inside its own period, because a month's visit pushed into the next
 * month is a different promise. And nothing is moved onto a day that would
 * end up over the cap, which would merely relocate the problem.
 *
 * Every ordering here is total — agreements by id, days by date — so running
 * it twice on the same horizon produces the same calendar, which is what lets
 * regeneration report nothing to do.
 */

/** A day that still carries more crew-minutes than the cap allows. */
export interface DailyLoadWarning {
  branchCode: BranchCode;
  /** YYYY-MM-DD. */
  date: string;
  /** How many visits are on the day — for a dispatcher to recognise it by. */
  plannedCount: number;
  /** How many of those are booked dates, which cannot be moved. */
  bookedCount: number;
  /** The day's total crew-minutes: each visit's duration times its crew size. */
  plannedMinutes: number;
  /** The crew-minutes cap itself. */
  cap: number;
  message: string;
  /**
   * Set when the day is not merely full but provably cannot be performed —
   * no crew, supervisor, skill-holder or transport combination exists for the
   * work left on it. A day can be well under its crew-minutes cap and still
   * carry this: minutes do not notice that four of its visits all have to
   * happen at once. See `day-feasibility.ts`.
   */
  infeasibility?: { code: DayInfeasibilityCode; message: string };
}

export interface LoadGuardResult {
  required: RequiredVisit[];
  warnings: DailyLoadWarning[];
}

/**
 * A visit already in the calendar that this run will not be replacing.
 *
 * Two kinds qualify: a protected visit, which stays whatever the run decides,
 * and any visit of an agreement the run was not asked about — a run scoped to
 * one agreement leaves every other agreement's work exactly where it is.
 * Both occupy the day just as firmly as a visit this run planned, and a guard
 * that cannot see them reads a day holding a full load of crew-minutes as
 * empty.
 */
export interface StandingVisit {
  serviceAgreementId: string;
  branchCode: BranchCode;
  /** YYYY-MM-DD. */
  visitDate: string;
  windowStartMinute: number;
  windowEndMinute: number;
  durationMinutes: number;
  requiredCrewSize: number;
  /** Skills its own agreement requires — it competes for holders like any other visit. */
  requiredSkillCodes: string[];
}

const loadKey = (branchCode: BranchCode, date: string) => `${branchCode}|${date}`;

/** A planned or standing visit, as the feasibility check wants to see it. */
const toDemand = (visit: RequiredVisit | StandingVisit): DayVisitDemand => ({
  serviceAgreementId: visit.serviceAgreementId,
  windowStartMinute: visit.windowStartMinute,
  windowEndMinute: visit.windowEndMinute,
  durationMinutes: visit.durationMinutes,
  requiredCrewSize: visit.requiredCrewSize,
  requiredSkillCodes: visit.requiredSkillCodes,
});
const periodKey = (visit: RequiredVisit) =>
  `${visit.serviceAgreementId}|${visit.periodIndex}`;

/**
 * Most crew-minutes one branch-day may carry. A plain number applies the
 * same cap everywhere — what every existing caller in this file's own unit
 * tests still passes. A map gives each branch-day its own real, resource-derived
 * figure (see `branch-day-capacity.ts`); a day absent from the map is read
 * as zero capacity, the safe default for a day this run never asked about.
 */
export type CapacityByDay = number | Map<string, number>;

function capacityOf(capacity: CapacityByDay, branchCode: BranchCode, date: string): number {
  return typeof capacity === 'number' ? capacity : capacity.get(loadKey(branchCode, date)) ?? 0;
}

/** Same lookup, from an already-built `branchCode|date` key. */
function capacityForKey(capacity: CapacityByDay, key: string): number {
  if (typeof capacity === 'number') return capacity;
  const [branchCode, date] = key.split('|') as [BranchCode, string];
  return capacityOf(capacity, branchCode, date);
}

/**
 * Asks whether a branch-day's actual work can be performed at all by the
 * people and vehicles that branch has that day. Optional: callers with no
 * workforce facts to hand (every unit test in this file, for one) get the
 * crew-minutes behaviour unchanged.
 */
export type DayFeasibilityCheck = (
  branchCode: BranchCode,
  date: string,
  visits: DayVisitDemand[],
) => DayInfeasibility | null;

export function applyDailyLoadGuard(
  required: RequiredVisit[],
  capacity: CapacityByDay,
  standing: StandingVisit[] = [],
  isFeasible?: DayFeasibilityCheck,
): LoadGuardResult {
  // Copies throughout: the caller's list is its own account of what the
  // agreements asked for, and a guard that edited it in place would make the
  // two impossible to compare.
  const visits = required.map((visit) => ({ ...visit }));

  const load = new Map<string, number>();
  // Visit counts, kept only so a warning can tell a dispatcher how many
  // visits a day carries. The cap itself is judged on `load` alone.
  const counts = new Map<string, number>();
  const usedDates = new Map<string, Set<string>>();
  // How many of this run's own visits sit on each agreement-day, so a
  // standing visit this run is re-planning is not counted a second time.
  const planned = new Map<string, number>();
  for (const visit of visits) {
    const key = loadKey(visit.branchCode, visit.visitDate);
    load.set(key, (load.get(key) ?? 0) + crewMinutesOf(visit));
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const period = periodKey(visit);
    const used = usedDates.get(period) ?? new Set<string>();
    used.add(visit.visitDate);
    usedDates.set(period, used);
    const pair = `${visit.serviceAgreementId}|${visit.visitDate}`;
    planned.set(pair, (planned.get(pair) ?? 0) + 1);
  }

  // The rest of the calendar. Counted towards each day, and barred as a
  // destination for the agreement that already holds it, so a scoped run and
  // a full run over the same horizon reach the same answer.
  const standingByAgreement = new Map<string, Set<string>>();
  const standingPerDay = new Map<string, number>();
  for (const visit of standing) {
    const dates = standingByAgreement.get(visit.serviceAgreementId) ?? new Set<string>();
    dates.add(visit.visitDate);
    standingByAgreement.set(visit.serviceAgreementId, dates);

    const pair = `${visit.serviceAgreementId}|${visit.visitDate}`;
    const alreadyPlanned = planned.get(pair) ?? 0;
    if (alreadyPlanned > 0) {
      planned.set(pair, alreadyPlanned - 1);
      continue;
    }

    const key = loadKey(visit.branchCode, visit.visitDate);
    load.set(key, (load.get(key) ?? 0) + crewMinutesOf(visit));
    counts.set(key, (counts.get(key) ?? 0) + 1);
    standingPerDay.set(key, (standingPerDay.get(key) ?? 0) + 1);
  }

  const overloaded = [...load.entries()]
    .filter(([key, minutes]) => minutes > capacityForKey(capacity, key))
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
      if ((load.get(key) ?? 0) <= capacityForKey(capacity, key)) break;

      const visitMinutes = crewMinutesOf(visit);
      const period = periodKey(visit);
      const used = usedDates.get(period) ?? new Set<string>();
      const occupied = standingByAgreement.get(visit.serviceAgreementId);

      const target = visit.alternatives
        .filter(
          (alternative) =>
            !used.has(alternative.date) && !occupied?.has(alternative.date),
        )
        .map((alternative) => ({
          alternative,
          load: load.get(loadKey(visit.branchCode, alternative.date)) ?? 0,
        }))
        // A day this visit would push over the cap is no help: moving there
        // would only make the next pass undo it. Each alternative is its own
        // branch-day, so its own capacity is what governs it — not the
        // overloaded origin day's.
        .filter(
          (entry) =>
            entry.load + visitMinutes <=
            capacityOf(capacity, visit.branchCode, entry.alternative.date),
        )
        .sort(
          (a, b) =>
            a.load - b.load || a.alternative.date.localeCompare(b.alternative.date),
        )[0];

      if (!target) continue;

      // Captured before anything is overwritten. The day being left behind
      // becomes an alternative in its own right, and its window, weekday and
      // provenance are its own — read them after the move and every one of
      // them is the day the visit moved *to*, so a second pass would offer
      // the visit a fictional day back.
      const origin = {
        date: visit.visitDate,
        weekday: weekdayOf(parseDateOnly(visit.visitDate)),
        windowStartMinute: visit.windowStartMinute,
        windowEndMinute: visit.windowEndMinute,
        isPreferredDay: visit.isPreferredDay,
        windowProvenance: visit.windowProvenance ?? DataProvenance.UNKNOWN,
      };

      const targetKey = loadKey(visit.branchCode, target.alternative.date);
      load.set(key, (load.get(key) ?? visitMinutes) - visitMinutes);
      load.set(targetKey, (load.get(targetKey) ?? 0) + visitMinutes);
      counts.set(key, (counts.get(key) ?? 1) - 1);
      counts.set(targetKey, (counts.get(targetKey) ?? 0) + 1);
      used.delete(origin.date);
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
        .concat(origin.date === target.alternative.date ? [] : [origin])
        .sort((a, b) => a.date.localeCompare(b.date));
    }
  }

  // --- Feasibility -------------------------------------------------------
  //
  // Crew-minutes are an aggregate, and an aggregate cannot notice that four of
  // a day's visits all have to happen at eleven o'clock, or that one person on
  // the branch holds the skill three of them need. A day can sit comfortably
  // under its cap and still be impossible.
  //
  // So after spreading by minutes, each day is asked whether its remaining
  // work can be performed at all. An infeasible day sheds one movable visit at
  // a time — least-loaded destination first, same rules as above, and only
  // onto a day that is itself feasible with the visit added — and is re-asked
  // after each move, because feasibility is a property of the set, not of any
  // one visit. What cannot be moved is reported with the proven reason rather
  // than left looking merely busy.
  const infeasible = new Map<string, DayInfeasibility>();
  if (isFeasible) {
    const demandsOn = (branchCode: BranchCode, date: string): DayVisitDemand[] => [
      ...visits
        .filter((visit) => visit.branchCode === branchCode && visit.visitDate === date)
        .map(toDemand),
      ...standing
        .filter((visit) => visit.branchCode === branchCode && visit.visitDate === date)
        .map(toDemand),
    ];

    const dayKeys = [...new Set([...load.keys()])].sort();
    for (const key of dayKeys) {
      const [branchCode, date] = key.split('|') as [BranchCode, string];

      // Bounded by the number of visits on the day: every iteration either
      // moves one off or stops.
      for (let guard = 0; guard <= visits.length; guard += 1) {
        const verdict = isFeasible(branchCode, date, demandsOn(branchCode, date));
        if (!verdict) {
          infeasible.delete(key);
          break;
        }
        infeasible.set(key, verdict);

        const mover = visits
          .filter(
            (visit) =>
              loadKey(visit.branchCode, visit.visitDate) === key &&
              visit.placement !== VisitPlacement.BOOKED &&
              visit.alternatives.length > 0,
          )
          .sort(
            (a, b) =>
              a.serviceAgreementId.localeCompare(b.serviceAgreementId) ||
              a.windowStartMinute - b.windowStartMinute,
          )[0];
        if (!mover) break;

        const moverMinutes = crewMinutesOf(mover);
        const period = periodKey(mover);
        const used = usedDates.get(period) ?? new Set<string>();
        const occupied = standingByAgreement.get(mover.serviceAgreementId);

        const target = mover.alternatives
          .filter(
            (alternative) =>
              !used.has(alternative.date) && !occupied?.has(alternative.date),
          )
          .map((alternative) => ({
            alternative,
            load: load.get(loadKey(mover.branchCode, alternative.date)) ?? 0,
          }))
          .filter(
            (entry) =>
              entry.load + moverMinutes <=
                capacityOf(capacity, mover.branchCode, entry.alternative.date) &&
              // Moving an impossible visit onto another impossible day is not
              // a repair, it is a relocation.
              isFeasible(mover.branchCode, entry.alternative.date, [
                ...demandsOn(mover.branchCode, entry.alternative.date),
                toDemand(mover),
              ]) === null,
          )
          .sort(
            (a, b) =>
              a.load - b.load || a.alternative.date.localeCompare(b.alternative.date),
          )[0];
        if (!target) break;

        const origin = {
          date: mover.visitDate,
          weekday: weekdayOf(parseDateOnly(mover.visitDate)),
          windowStartMinute: mover.windowStartMinute,
          windowEndMinute: mover.windowEndMinute,
          isPreferredDay: mover.isPreferredDay,
          windowProvenance: mover.windowProvenance ?? DataProvenance.UNKNOWN,
        };
        const targetKey = loadKey(mover.branchCode, target.alternative.date);
        load.set(key, (load.get(key) ?? moverMinutes) - moverMinutes);
        load.set(targetKey, (load.get(targetKey) ?? 0) + moverMinutes);
        counts.set(key, (counts.get(key) ?? 1) - 1);
        counts.set(targetKey, (counts.get(targetKey) ?? 0) + 1);
        used.delete(origin.date);
        used.add(target.alternative.date);
        usedDates.set(period, used);

        mover.visitDate = target.alternative.date;
        mover.windowStartMinute = target.alternative.windowStartMinute;
        mover.windowEndMinute = target.alternative.windowEndMinute;
        mover.isPreferredDay = target.alternative.isPreferredDay;
        mover.windowProvenance = target.alternative.windowProvenance;
        mover.placement = VisitPlacement.SPREAD;
        mover.alternatives = mover.alternatives
          .filter((alternative) => alternative.date !== target.alternative.date)
          .concat(origin.date === target.alternative.date ? [] : [origin])
          .sort((a, b) => a.date.localeCompare(b.date));
      }
    }
  }

  const warnings: DailyLoadWarning[] = [];
  for (const [key, minutes] of [...load.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const dayCapMinutes = capacityForKey(capacity, key);
    const verdict = infeasible.get(key);
    // A day can be inside its cap and still impossible, so the two are
    // reported independently — skipping only when neither has anything to say.
    if (minutes <= dayCapMinutes && !verdict) continue;

    if (minutes <= dayCapMinutes && verdict) {
      const [branchCode, date] = key.split('|') as [BranchCode, string];
      warnings.push({
        branchCode,
        date,
        plannedCount: counts.get(key) ?? 0,
        bookedCount: visits.filter(
          (visit) =>
            visit.branchCode === branchCode &&
            visit.visitDate === date &&
            visit.placement === VisitPlacement.BOOKED,
        ).length,
        plannedMinutes: minutes,
        cap: dayCapMinutes,
        message: verdict.message,
        infeasibility: { code: verdict.code, message: verdict.message },
      });
      continue;
    }
    const [branchCode, date] = key.split('|') as [BranchCode, string];
    const count = counts.get(key) ?? 0;
    const bookedCount = visits.filter(
      (visit) =>
        visit.branchCode === branchCode &&
        visit.visitDate === date &&
        visit.placement === VisitPlacement.BOOKED,
    ).length;

    const standingCount = standingPerDay.get(key) ?? 0;
    // Only the kinds the day actually has. "0 are dates already booked with
    // the customer" reads as a fact to be worked out rather than one to act
    // on: a dispatcher has to stop and decide the zero means nothing. And
    // "all" when one kind covers the whole day, because "19 are already in the
    // calendar" out of 19 invites a reader to go looking for the other two.
    const clause = (n: number, kind: 'booked' | 'standing', all = false): string => {
      const head = all ? `all ${n} are` : n === 1 ? '1 is' : `${n} are`;
      return kind === 'booked'
        ? `${head} ${!all && n === 1 ? 'a date' : 'dates'} already booked with the customer`
        : `${head} already in the calendar and not this run's to move`;
    };

    const over = `${date} carries ${count} ${count === 1 ? 'visit' : 'visits'} in ${branchCode}, totalling ${minutes} crew-minutes of work — over the ${dayCapMinutes} crew-minutes a day this branch plans for.`;

    let message: string;
    if (bookedCount + standingCount >= count) {
      // Every visit on the day is one or the other, so name them and stop.
      const accountedFor =
        standingCount === 0
          ? [clause(count, 'booked', true)]
          : bookedCount === 0
            ? [clause(count, 'standing', true)]
            : [clause(bookedCount, 'booked'), clause(standingCount, 'standing')];
      message = `${over} None of them could be moved: ${accountedFor.join(', and ')}.`;
    } else {
      message = [
        over,
        bookedCount > 0
          ? `${clause(bookedCount, 'booked')}, and the rest had no other day inside their period to move to.`
          : 'None of them had another day inside their period to move to.',
        standingCount > 0 ? `${clause(standingCount, 'standing')}.` : null,
      ]
        .filter((sentence): sentence is string => sentence !== null)
        .join(' ');
    }

    warnings.push({
      branchCode,
      date,
      plannedCount: count,
      bookedCount,
      plannedMinutes: minutes,
      cap: dayCapMinutes,
      message: verdict ? `${message} ${verdict.message}` : message,
      ...(verdict ? { infeasibility: { code: verdict.code, message: verdict.message } } : {}),
    });
  }

  // Back in the order they arrived, so the plan reads the same way it was built.
  return { required: visits, warnings };
}

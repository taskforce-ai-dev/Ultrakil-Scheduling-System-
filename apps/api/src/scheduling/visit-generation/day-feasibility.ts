import { BranchCode } from '@prisma/client';

/**
 * Whether a branch-day's actual visits can be performed at all by the actual
 * people and vehicles that branch has that day.
 *
 * `branch-day-capacity.ts` answers a different, weaker question: how many
 * crew-minutes the day could carry in aggregate. The Technical Director's
 * review was right that an aggregate is not a feasibility check — a day with
 * plenty of spare minutes can still be impossible, because minutes do not
 * notice that four of its visits all have to happen at eleven o'clock, or
 * that only one person on the branch holds the skill three of them need.
 *
 * This asks the question minutes cannot: given these visits, is there *any*
 * way to staff and transport them? It is deliberately a set of **necessary**
 * conditions, not a solve. Each one below, if it fails, proves no assignment
 * exists; none of them passing proves one does. That asymmetry is the point —
 * generation must never call a day feasible when it demonstrably is not, and
 * must never refuse a day that might be fine. Whether a particular crew can
 * actually be found remains the optimizer's and the eligibility engine's
 * question, asked against one proposed booking at assignment time.
 *
 * ## What "at the same time" means here
 *
 * A visit is not a fixed appointment: it has a window it may start anywhere
 * inside. Two visits whose windows merely touch may well be schedulable one
 * after the other, and refusing the day for that would be wrong.
 *
 * So concurrency is counted only where it is **forced**. A visit of duration
 * `d` in a window `[start, end]` must be running at every minute of
 * `[end - d, start + d)` — whatever start time is chosen, those minutes are
 * covered. That interval is empty unless `end - start < 2d`, which is exactly
 * the case where the window leaves no room to schedule around it.
 *
 * Overlapping those forced intervals gives a true lower bound on how many
 * visits are simultaneously in progress in *any* feasible schedule. When that
 * bound exceeds the people, the supervisors, the skill-holders or the
 * transport the branch actually has, no schedule exists, and generation is
 * placing work it knows cannot be done.
 */

/** One visit a run wants to put on a branch-day. */
export interface DayVisitDemand {
  serviceAgreementId: string;
  /** Earliest the visit may start, minutes from midnight. */
  windowStartMinute: number;
  /** Latest the visit may finish, minutes from midnight. */
  windowEndMinute: number;
  durationMinutes: number;
  requiredCrewSize: number;
  /** Skill codes the agreement requires. Empty when it requires none. */
  requiredSkillCodes: string[];
}

/** What the branch actually has available on that date. */
export interface BranchDayWorkforce {
  /** Active employees at the branch, whatever their availability. */
  totalEmployeeCount: number;
  /** Of those, the ones not on leave, sick or training that date. */
  availableEmployeeCount: number;
  /** Of the available ones, how many are PMS-grade. Every visit needs one. */
  availablePmsCount: number;
  /** Skill code to how many *available* employees hold it. */
  skillHolderCounts: Map<string, number>;
  /** Active vehicles the branch owns at all. Zero means it is not vehicle-gated. */
  activeVehicleCount: number;
  /** Of those, how many have an available, authorized driver that date. */
  driverCapableVehicleCount: number;
  /** Available employees check-marked as able to travel by public transport. */
  publicTransportCapableCount: number;
}

export type DayInfeasibilityCode =
  | 'NO_WORKFORCE_RECORDED'
  | 'NO_PMS_SUPERVISOR'
  | 'NOT_ENOUGH_SUPERVISORS_AT_ONCE'
  | 'NOT_ENOUGH_CREW_AT_ONCE'
  | 'SKILL_NOT_HELD'
  | 'NOT_ENOUGH_SKILLED_AT_ONCE'
  | 'NO_WAY_TO_REACH_SITE'
  | 'NOT_ENOUGH_TRANSPORT_AT_ONCE';

export interface DayInfeasibility {
  branchCode: BranchCode;
  /** YYYY-MM-DD. */
  date: string;
  code: DayInfeasibilityCode;
  /** Written for a manager: what the day asks for, against what the branch has. */
  message: string;
}

/**
 * The minutes a visit must be in progress for, whatever start time is chosen.
 * Empty when the window is loose enough to schedule around.
 */
function forcedInterval(visit: DayVisitDemand): { start: number; end: number } | null {
  const start = visit.windowEndMinute - visit.durationMinutes;
  const end = visit.windowStartMinute + visit.durationMinutes;
  return start < end ? { start, end } : null;
}

/**
 * The largest total of `weight` over visits that are all forced to be running
 * at one instant — a lower bound on simultaneous demand in any schedule.
 *
 * Only interval starts need testing: overlap can only increase where one
 * begins.
 */
function peakForcedDemand(
  visits: DayVisitDemand[],
  weight: (visit: DayVisitDemand) => number,
): number {
  const intervals = visits
    .map((visit) => ({ visit, span: forcedInterval(visit) }))
    .filter((entry): entry is { visit: DayVisitDemand; span: { start: number; end: number } } =>
      entry.span !== null,
    );
  if (intervals.length === 0) return 0;

  let peak = 0;
  for (const { span } of intervals) {
    const at = span.start;
    let total = 0;
    for (const other of intervals) {
      if (other.span.start <= at && at < other.span.end) total += weight(other.visit);
    }
    if (total > peak) peak = total;
  }
  return peak;
}

/**
 * @returns The first proven reason this day's work cannot be performed, or
 *   `null` when nothing here rules it out.
 */
export function checkDayFeasibility(
  branchCode: BranchCode,
  date: string,
  visits: DayVisitDemand[],
  workforce: BranchDayWorkforce,
): DayInfeasibility | null {
  // A day nothing is planned on is trivially fine, whatever the branch has.
  if (visits.length === 0) return null;

  const fail = (code: DayInfeasibilityCode, message: string): DayInfeasibility => ({
    branchCode,
    date,
    code,
    message,
  });

  // A branch this database has never been told about is a data gap, not a
  // fact about its staffing. Reported so it is visible, and left for the
  // caller to decide — inferring "no capacity" from "no import" would be a
  // claim about the branch nobody has made.
  if (workforce.totalEmployeeCount === 0) {
    return fail(
      'NO_WORKFORCE_RECORDED',
      `${branchCode} has no workforce recorded, so whether it can perform ${visits.length} visit(s) on ${date} is unknown.`,
    );
  }

  if (workforce.availablePmsCount === 0) {
    return fail(
      'NO_PMS_SUPERVISOR',
      `${branchCode} has no PMS-grade supervisor available on ${date}, and every visit needs one.`,
    );
  }

  const concurrentVisits = peakForcedDemand(visits, () => 1);

  if (concurrentVisits > workforce.availablePmsCount) {
    return fail(
      'NOT_ENOUGH_SUPERVISORS_AT_ONCE',
      `${date} forces ${concurrentVisits} visit(s) to run at the same time, each needing its own PMS-grade supervisor, but ${branchCode} has ${workforce.availablePmsCount} available.`,
    );
  }

  const concurrentCrew = peakForcedDemand(visits, (visit) => visit.requiredCrewSize);
  if (concurrentCrew > workforce.availableEmployeeCount) {
    return fail(
      'NOT_ENOUGH_CREW_AT_ONCE',
      `${date} forces ${concurrentCrew} people onto site at the same time, but ${branchCode} has ${workforce.availableEmployeeCount} available.`,
    );
  }

  // Skills, per skill rather than in aggregate: one person holding a skill is
  // enough for one visit needing it, and no help at all to the second.
  const requiredSkills = [...new Set(visits.flatMap((visit) => visit.requiredSkillCodes))].sort();
  for (const skillCode of requiredSkills) {
    const holders = workforce.skillHolderCounts.get(skillCode) ?? 0;
    if (holders === 0) {
      return fail(
        'SKILL_NOT_HELD',
        `No ${branchCode} employee available on ${date} holds ${skillCode}, which work planned for that day requires.`,
      );
    }
    const needing = visits.filter((visit) => visit.requiredSkillCodes.includes(skillCode));
    const concurrentSkilled = peakForcedDemand(needing, () => 1);
    if (concurrentSkilled > holders) {
      return fail(
        'NOT_ENOUGH_SKILLED_AT_ONCE',
        `${date} forces ${concurrentSkilled} visit(s) needing ${skillCode} to run at the same time, but ${branchCode} has ${holders} available employee(s) who hold it.`,
      );
    }
  }

  // Getting there. A crew reaches a site in a vehicle or by public transport;
  // a branch with neither cannot perform the work at all, and one with only
  // vehicles cannot run more crews at once than it has drivable vehicles.
  const canWalk = workforce.publicTransportCapableCount > 0;
  if (workforce.driverCapableVehicleCount === 0 && !canWalk) {
    return fail(
      'NO_WAY_TO_REACH_SITE',
      `${branchCode} has no drivable vehicle and nobody able to travel by public transport on ${date}, so no crew can reach a site.`,
    );
  }
  if (!canWalk && concurrentVisits > workforce.driverCapableVehicleCount) {
    return fail(
      'NOT_ENOUGH_TRANSPORT_AT_ONCE',
      `${date} forces ${concurrentVisits} crew(s) to be out at the same time and nobody at ${branchCode} can travel by public transport, but only ${workforce.driverCapableVehicleCount} vehicle(s) have an available authorized driver.`,
    );
  }

  return null;
}

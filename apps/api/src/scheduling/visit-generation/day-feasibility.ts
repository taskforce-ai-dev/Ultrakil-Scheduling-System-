import { BranchCode } from '@prisma/client';

import { preferredBipartiteMatching } from './transport-matching';

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
  /**
   * Of those, how many can be driven at once by a distinct available,
   * authorized employee of this branch — a maximum matching, so one person
   * authorized for several vehicles only ever counts toward one of them,
   * and a Kandy or inactive employee's authorization never counts at all.
   * Informational only; the transport checks below re-derive this from
   * `vehicleResources` for each specific set of visits, since how many
   * vehicles are usable interacts with how many walkers a concrete demand
   * also needs, and with how many seats each vehicle actually has — a
   * single precomputed count cannot answer that for every possible mix of
   * crew sizes.
   */
  driverCapableVehicleCount: number;
  /**
   * One entry per active vehicle: its seat capacity (null when the workbook
   * did not state one, treated as unlimited) and the ids of employees who
   * could actually drive it right now — this branch's own active roster,
   * available today. This is the raw structure the transport checks match
   * against per demand; a vehicle only covers a crew its seats can hold.
   */
  vehicleResources: readonly { id: string; seatCapacity: number | null; eligibleDriverIds: readonly string[] }[];
  /**
   * Ids of available employees check-marked as able to travel by public
   * transport. Unlike a vehicle, a walker can only carry themselves — a
   * crew of three with no vehicle needs three distinct people from this
   * list, not one.
   */
  availablePublicTransportEmployeeIds: readonly string[];
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
 * Every distinct set of visits that are all forced to be running at the
 * same instant, one set per candidate instant (again, only interval starts
 * need testing). Concurrent demand is not one number across the whole day —
 * different instants can force different visits together — so a check that
 * depends on *which* visits overlap, not just how many, has to look at each
 * candidate set in turn rather than a single day-wide peak.
 */
function forcedConcurrentSets(visits: readonly DayVisitDemand[]): DayVisitDemand[][] {
  const intervals = visits
    .map((visit) => ({ visit, span: forcedInterval(visit) }))
    .filter((entry): entry is { visit: DayVisitDemand; span: { start: number; end: number } } =>
      entry.span !== null,
    );
  return intervals.map(({ span: { start: at } }) =>
    intervals.filter((other) => other.span.start <= at && at < other.span.end).map((entry) => entry.visit),
  );
}

/**
 * Every set of visits transport has to be checked against: every visit on
 * its own — a loose window still has to reach the site *at some point*, and
 * `forcedConcurrentSets` alone never mentions a visit that is never forced
 * to overlap anything — plus every forced-overlap set, for the genuinely
 * concurrent demand. Duplicates (a visit appears both alone and inside a
 * forced set) cost nothing beyond a redundant check.
 */
function transportDemandSets(visits: readonly DayVisitDemand[]): DayVisitDemand[][] {
  return [visits.map((visit) => [visit]), forcedConcurrentSets(visits)].flat();
}

/**
 * Whether this branch's transport can carry every visit in `activeVisits`
 * at once. Each visit is either driven — one vehicle, with a driver from
 * that vehicle's own eligible list, its seats sufficient for the crew — or
 * walked — `requiredCrewSize` distinct available public-transport-capable
 * employees, since a walker can only carry themselves. A vehicle, a driver
 * and a walker are each spent on at most one visit; nobody is ever both a
 * driver and a walker, or a driver for two vehicles, at once.
 *
 * Which vehicle should serve which visit, and which vehicles are worth
 * activating at all, are coupled decisions: activating one only helps if
 * it is actually needed, and the wrong choice among several seat-compatible
 * vehicles for one visit can strand a driver who was needed elsewhere — a
 * different vehicle, or as a walker. There is no way to decompose this into
 * two independent matchings (vehicles-to-drivers, then visits-to-vehicles,
 * in either order) without risking exactly that: a locally reasonable
 * choice made without seeing the rest of the demand can block a feasible
 * outcome one step later. (An earlier version of this function tried
 * vehicles-to-drivers first; see the regression tests below for the
 * concrete cases that broke.)
 *
 * So this searches exhaustively over every way to reserve a distinct,
 * seat-compatible vehicle for a subset of the active visits (the rest
 * walk) — exact by construction, not by a further optimality proof.
 * Branch-sized inputs — a handful of visits genuinely forced together at
 * one instant, and a branch's own vehicle fleet, tens not thousands — keep
 * this fast in practice; only vehicles that could conceivably help (an
 * eligible driver, and enough seats for at least one active visit) are
 * ever tried, which prunes most of the search up front.
 *
 * For a *fixed* reservation (which visits get a vehicle, and which one),
 * whether every reserved vehicle can actually get a distinct driver — and,
 * if so, using as few walker-eligible employees as possible — needs no
 * further search: `preferredBipartiteMatching`'s two-phase technique (fill
 * from non-walkers first) is exact for that, whatever vehicle set it is
 * asked about.
 */
function transportFeasible(
  activeVisits: readonly DayVisitDemand[],
  workforce: BranchDayWorkforce,
): boolean {
  if (activeVisits.length === 0) return true;

  const walkerIds = new Set(workforce.availablePublicTransportEmployeeIds);
  const usableVehicles = workforce.vehicleResources.filter(
    (vehicle) =>
      vehicle.eligibleDriverIds.length > 0 &&
      (vehicle.seatCapacity === null ||
        activeVisits.some((visit) => visit.requiredCrewSize <= vehicle.seatCapacity!)),
  );
  const bySizeDescending = [...activeVisits].sort((a, b) => b.requiredCrewSize - a.requiredCrewSize);
  const reservedVehicleIds = new Set<string>();
  const vehicleCovered: boolean[] = new Array(bySizeDescending.length).fill(false);

  const fits = (): boolean => {
    const reserved = usableVehicles.filter((vehicle) => reservedVehicleIds.has(vehicle.id));
    const matchedDrivers = preferredBipartiteMatching(
      reserved.map((vehicle) => vehicle.eligibleDriverIds),
      walkerIds,
    );
    if (matchedDrivers.size < reserved.length) return false;

    const driversWhoAreAlsoWalkers = [...matchedDrivers.values()].filter((id) => walkerIds.has(id));
    const walkersAvailable = walkerIds.size - driversWhoAreAlsoWalkers.length;
    const walkSeatsNeeded = bySizeDescending.reduce(
      (sum, visit, index) => (vehicleCovered[index] ? sum : sum + visit.requiredCrewSize),
      0,
    );
    return walkersAvailable >= walkSeatsNeeded;
  };

  const search = (visitIndex: number): boolean => {
    if (visitIndex === bySizeDescending.length) return fits();
    const visit = bySizeDescending[visitIndex];
    for (const vehicle of usableVehicles) {
      if (reservedVehicleIds.has(vehicle.id)) continue;
      if (vehicle.seatCapacity !== null && vehicle.seatCapacity < visit.requiredCrewSize) continue;
      reservedVehicleIds.add(vehicle.id);
      vehicleCovered[visitIndex] = true;
      if (search(visitIndex + 1)) return true;
      vehicleCovered[visitIndex] = false;
      reservedVehicleIds.delete(vehicle.id);
    }
    return search(visitIndex + 1);
  };

  return search(0);
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
  // a branch with neither cannot perform the work at all. Checked per
  // instant, not as one day-wide count, because a walker carries only
  // themselves — whether transport suffices depends on which visits are
  // forced together and how big each of their crews is, not just how many
  // there are. Every visit is also checked on its own, not only inside a
  // forced-overlap set, because a loose window still has to reach the site
  // at some point even when nothing forces it to coincide with another visit.
  const hasDrivableVehicle = workforce.vehicleResources.some(
    (vehicle) => vehicle.eligibleDriverIds.length > 0,
  );
  if (!hasDrivableVehicle && workforce.availablePublicTransportEmployeeIds.length === 0) {
    return fail(
      'NO_WAY_TO_REACH_SITE',
      `${branchCode} has no drivable vehicle and nobody able to travel by public transport on ${date}, so no crew can reach a site.`,
    );
  }
  for (const activeVisits of transportDemandSets(visits)) {
    if (transportFeasible(activeVisits, workforce)) continue;
    const crewSizes = activeVisits.map((visit) => visit.requiredCrewSize).join('+');
    return fail(
      'NOT_ENOUGH_TRANSPORT_AT_ONCE',
      `${date} forces ${activeVisits.length} crew(s) (sizes ${crewSizes}) to be out at the same time, but ${branchCode} cannot get all of them there at once — a vehicle carries a crew up to its own seat capacity, but a crew with no vehicle (or too big for any available one) needs one distinct public-transport-capable employee per person, and nobody covers two roles at once.`,
    );
  }

  return null;
}

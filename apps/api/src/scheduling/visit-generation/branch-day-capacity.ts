import { BranchCode } from '@prisma/client';

import { BranchDayWorkforce } from './day-feasibility';
import { maxBipartiteMatching } from './transport-matching';

import {
  DEFAULT_DAILY_CAPACITY_MINUTES,
  DEFAULT_EMPLOYEE_WORKDAY_MINUTES,
} from '../../config/constants';

/**
 * How many crew-minutes a branch-day may actually carry, derived from the
 * real resources that branch has on that date — not a company-wide guess.
 *
 * The Technical Director's review rejected the flat `DEFAULT_DAILY_CAPACITY_MINUTES`
 * constant directly: "a valid 4-hour job with a 4-person crew" (960
 * crew-minutes) "is impossible everywhere" under a 720-minute cap, "even when
 * the branch has enough people." A branch's true capacity is what its own
 * staffing on that specific date can carry, so this is computed per branch,
 * per date, from the same facts the eligibility engine already loads for
 * one assignment — headcount, PMS-grade supervision, and vehicles with an
 * authorized driver — asked here in aggregate instead of one crew at a time.
 *
 * Two things this deliberately does **not** do.
 *
 * It does not check skills or per-visit vehicle need. Which specific person
 * is free for which specific job, holding which specific skill, is what the
 * eligibility engine and the optimizer solve for at assignment time, against
 * one proposed crew — asked here in aggregate, that question has no single
 * answer, since it depends on which particular visits land on the day. This
 * stays a conservative *upper bound* generation must not exceed, not a
 * promise every visit under it can actually be staffed.
 *
 * And it does not schedule concurrent time windows against each other.
 * Two employees available on the same date may both be busy at the same
 * hour on other work — that clash is the eligibility engine's own
 * `EMPLOYEE_DOUBLE_BOOKED`/`VEHICLE_DOUBLE_BOOKED` question, asked against
 * one proposed booking's actual minutes, which generation-time capacity
 * cannot ask in aggregate either. This bounds *how much* work a day can
 * carry; whether the optimizer can actually staff and transport it is still
 * checked afterward, exactly where the review says that question belongs.
 */

export interface BranchDayResourceFacts {
  branchCode: BranchCode;
  /** YYYY-MM-DD. */
  date: string;
  /** Active employees at this branch, not on leave/sickness/training this date. */
  availableEmployeeCount: number;
  /**
   * Every active employee this branch has on record at all, whatever their
   * availability today. Distinct from `availableEmployeeCount` for exactly
   * one reason: telling "this branch genuinely has nobody available today"
   * apart from "this branch's workforce was never imported into this
   * database," which is a data gap, not a fact about the branch's capacity.
   */
  totalEmployeeCount: number;
  /** Whether at least one of those available employees is PMS-grade. */
  hasAvailablePmsSupervisor: boolean;
  /**
   * Active vehicles this branch owns at all, whatever their availability
   * today. Zero means the branch is not vehicle-gated — a branch that works
   * entirely by public transport is not penalised for owning no vehicles.
   */
  activeVehicleCount: number;
  /**
   * Of those, how many can actually be driven at once today by a distinct
   * available authorized employee of this same branch — a maximum matching,
   * not a per-vehicle "does it have anyone at all" filter. One employee
   * authorized for several vehicles can drive only one of them; a vehicle
   * whose only authorization is a Kandy employee or an inactive one does not
   * count, since neither can actually turn up and drive it. Only consulted
   * when `activeVehicleCount > 0`.
   */
  driverCapableVehicleCount: number;
  /**
   * A maximum matching of vehicles-with-a-driver plus walkers, same as
   * `driverCapableVehicleCount` but with public-transport-capable staff
   * folded in — `driverCapableVehicleCount` alone undercounts a branch that
   * also has such staff, and nobody is counted as covering both roles.
   *
   * This function has no visit to ask "how big is this crew" of, so it
   * cannot tell a one-person crew from a five-person one; treating this
   * count as "N *crews*" would credit a walker with covering a crew of any
   * size, which day-feasibility's own transport check (which does see each
   * visit's `requiredCrewSize`) proved wrong — a walker carries only
   * themselves. `computeBranchDayCapacity` therefore reads this as *minutes
   * of transportable labor* (one matched unit is worth one employee's
   * workday, the same as a person already counts toward `crewMinutes`), a
   * fungible quantity like `crewMinutes` itself — never as a count of
   * simultaneous crews. Only consulted when `activeVehicleCount > 0`, for
   * the same reason as `driverCapableVehicleCount`.
   */
  transportCapableConcurrentCrews: number;
}

export interface BranchDayCapacity {
  branchCode: BranchCode;
  date: string;
  /** The crew-minutes cap `load-guard.ts`/`DailyLoadLedger` must enforce. */
  capacityMinutes: number;
  /**
   * `BRANCH_HAS_NO_PMS_SUPERVISOR`, the same code the eligibility engine
   * already uses for one assignment — every job needs a PMS-grade
   * supervisor, so a day with none available cannot be staffed at all, not
   * merely capacity-constrained.
   */
  reason: 'NO_PMS_SUPERVISOR' | 'NO_AVAILABLE_DRIVER' | 'NO_WORKFORCE_RECORDED' | null;
}

/**
 * One branch's whole resource pool, loaded once regardless of how many
 * dates it is asked about — the facts that vary by date (who is on leave
 * that day) are cheap in-memory range checks, not a query per date.
 */
export interface BranchResourcePool {
  employees: {
    id: string;
    isPmsGrade: boolean;
    /** Skill codes this person holds, from the workforce matrix. */
    skillCodes: string[];
    /** Check-marked as able to reach a site without a company vehicle. */
    canUsePublicTransport: boolean;
  }[];
  /** Inclusive leave/sickness/training windows, whichever employee they cover. */
  unavailability: { employeeId: string; startDate: string; endDate: string }[];
  /**
   * Active vehicles only, each with who is authorized to drive it.
   * `authorizedEmployeeIds` is read straight off `VehicleAuthorization` —
   * it can and does contain ids for employees of another branch, or for an
   * employee who is no longer active, since authorization rows are never
   * pruned to match. The functions below are what filter that down to
   * people who could actually turn up and drive for *this* branch; they are
   * not pre-filtered here so that every caller goes through the same filter
   * rather than each doing its own version of it.
   */
  vehicles: {
    id: string;
    /** Null when the workbook did not state a capacity — treated as unlimited. */
    seatCapacity: number | null;
    authorizedEmployeeIds: string[];
  }[];
}

/**
 * Vehicles reduced to the people who could actually drive each one for this
 * branch: on this branch's own active roster, and not on leave that date.
 * A Kandy employee's id or an inactive employee's id on the authorization
 * list is never eligible here, however it got onto that list. Shared by
 * every place that needs "who could drive this vehicle right now" so the
 * filter is applied exactly once, the same way, everywhere.
 */
interface VehicleResource {
  id: string;
  seatCapacity: number | null;
  eligibleDriverIds: string[];
}

function vehicleResourcesFor(
  pool: BranchResourcePool,
  unavailableIds: ReadonlySet<string>,
): VehicleResource[] {
  const branchEmployeeIds = new Set(pool.employees.map((employee) => employee.id));
  return pool.vehicles.map((vehicle) => ({
    id: vehicle.id,
    seatCapacity: vehicle.seatCapacity,
    eligibleDriverIds: vehicle.authorizedEmployeeIds.filter(
      (employeeId) => branchEmployeeIds.has(employeeId) && !unavailableIds.has(employeeId),
    ),
  }));
}

/**
 * The same pool, resolved to one date and shaped for
 * {@link import('./day-feasibility').checkDayFeasibility} — which asks what
 * the branch can actually do that day, rather than how many minutes it has.
 */
export function workforceForDate(
  pool: BranchResourcePool,
  date: string,
): BranchDayWorkforce {
  const unavailableIds = new Set(
    pool.unavailability
      .filter((entry) => entry.startDate <= date && date <= entry.endDate)
      .map((entry) => entry.employeeId),
  );
  const available = pool.employees.filter((employee) => !unavailableIds.has(employee.id));

  const skillHolderCounts = new Map<string, number>();
  for (const employee of available) {
    for (const skillCode of employee.skillCodes) {
      skillHolderCounts.set(skillCode, (skillHolderCounts.get(skillCode) ?? 0) + 1);
    }
  }

  const vehicleResources = vehicleResourcesFor(pool, unavailableIds);

  return {
    totalEmployeeCount: pool.employees.length,
    availableEmployeeCount: available.length,
    availablePmsCount: available.filter((employee) => employee.isPmsGrade).length,
    skillHolderCounts,
    activeVehicleCount: pool.vehicles.length,
    driverCapableVehicleCount: maxBipartiteMatching(
      vehicleResources.map((vehicle) => vehicle.eligibleDriverIds),
    ),
    vehicleResources,
    availablePublicTransportEmployeeIds: available
      .filter((employee) => employee.canUsePublicTransport)
      .map((employee) => employee.id),
  };
}

/** Derives one date's resource facts from a branch's already-loaded pool. */
export function factsForDate(
  pool: BranchResourcePool,
  branchCode: BranchCode,
  date: string,
): BranchDayResourceFacts {
  const unavailableIds = new Set(
    pool.unavailability
      .filter((entry) => entry.startDate <= date && date <= entry.endDate)
      .map((entry) => entry.employeeId),
  );
  const available = pool.employees.filter((employee) => !unavailableIds.has(employee.id));
  const vehicleDriverLists = vehicleResourcesFor(pool, unavailableIds).map(
    (vehicle) => vehicle.eligibleDriverIds,
  );
  const walkSlots = available
    .filter((employee) => employee.canUsePublicTransport)
    .map((employee) => [employee.id]);

  return {
    branchCode,
    date,
    availableEmployeeCount: available.length,
    totalEmployeeCount: pool.employees.length,
    hasAvailablePmsSupervisor: available.some((employee) => employee.isPmsGrade),
    activeVehicleCount: pool.vehicles.length,
    driverCapableVehicleCount: maxBipartiteMatching(vehicleDriverLists),
    transportCapableConcurrentCrews: maxBipartiteMatching([...vehicleDriverLists, ...walkSlots]),
  };
}

export function computeBranchDayCapacity(
  facts: BranchDayResourceFacts,
  employeeWorkdayMinutes: number = DEFAULT_EMPLOYEE_WORKDAY_MINUTES,
  /**
   * What to enforce for a branch with no workforce imported at all —
   * `totalEmployeeCount === 0` — rather than silently reading that as zero
   * capacity, which would be a claim about the branch's staffing this
   * database has no basis for. Defaults to the same interim constant this
   * whole feature replaces, used here only as a last resort for a branch
   * this database does not yet describe.
   */
  fallbackCapacityMinutes: number = DEFAULT_DAILY_CAPACITY_MINUTES,
): BranchDayCapacity {
  if (facts.totalEmployeeCount === 0) {
    return {
      branchCode: facts.branchCode,
      date: facts.date,
      capacityMinutes: fallbackCapacityMinutes,
      reason: 'NO_WORKFORCE_RECORDED',
    };
  }

  if (!facts.hasAvailablePmsSupervisor) {
    return {
      branchCode: facts.branchCode,
      date: facts.date,
      capacityMinutes: 0,
      reason: 'NO_PMS_SUPERVISOR',
    };
  }

  const crewMinutes = facts.availableEmployeeCount * employeeWorkdayMinutes;

  // Bounded by the same combined vehicles-plus-walkers figure the day-
  // feasibility transport checks use, not vehicles alone — a branch with
  // vehicles nobody can drive today but staff who can still reach a site by
  // public transport is not zero-capacity, and a branch whose driver count
  // alone looks fine but whose only driver is also its only walker is not
  // double the transport it actually has.
  if (facts.activeVehicleCount > 0 && facts.transportCapableConcurrentCrews === 0) {
    return {
      branchCode: facts.branchCode,
      date: facts.date,
      capacityMinutes: 0,
      reason: 'NO_AVAILABLE_DRIVER',
    };
  }

  const vehicleMinutes =
    facts.activeVehicleCount > 0
      ? facts.transportCapableConcurrentCrews * employeeWorkdayMinutes
      : Infinity;

  return {
    branchCode: facts.branchCode,
    date: facts.date,
    // Whichever real resource runs out first — people or vehicle-capable
    // transport — bounds what the branch can actually carry that day.
    capacityMinutes: Math.min(crewMinutes, vehicleMinutes),
    reason: null,
  };
}

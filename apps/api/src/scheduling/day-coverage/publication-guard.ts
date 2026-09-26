/**
 * The all-or-nothing gate for one replenished day.
 *
 * ## Why this is not `publishReadiness`
 *
 * `optimizer/publish-readiness.ts` asks whether the assignments *being
 * published* are sound. That is the right question for a manager publishing
 * a run they are looking at, and the wrong one here. ULK-C13 requires that
 * **every due visit** on the new day is satisfiable before any of it is
 * published — so a run that quietly considered one of three due visits and
 * staffed that one passes `publishReadiness` and fails this task.
 *
 * The difference is the population. `publishReadiness` measures the
 * assignments; this measures the *due set*, and reports a visit with no
 * assignment at all as a shortfall rather than as an absence it cannot see.
 *
 * This does not replace the existing gate. Both apply: this decides whether
 * the day may be offered for publication at all, and `publishReadiness` then
 * decides whether it goes automatically or waits for a manager. A day can
 * pass here and still be held, which on today's data is what will always
 * happen, because no provenance is confirmed.
 *
 * ## Pure on purpose
 *
 * No Prisma, no clock, no transaction. The caller reads under the visit,
 * resource and branch-day locks and hands the result in; this only decides.
 * That keeps the rule itself testable without a database and keeps the
 * locking in one place rather than smeared through the decision.
 */

/** Reason codes, reused from `eligibility/rules.ts` so one vocabulary describes a failure wherever a manager meets it. */
export const SHORTFALL_CODES = [
  /** A visit was due and the run produced no live assignment for it. */
  'NOT_STAFFED',
  /** Fewer crew than the agreement requires. */
  'CREW_TOO_SMALL',
  /** ULK-C13 requires exactly one vehicle; this assignment has none. */
  'NO_VEHICLE',
  /** More than one vehicle on a single assignment. */
  'TOO_MANY_VEHICLES',
  /** The crew does not fit the vehicle's recorded seats. */
  'VEHICLE_CAPACITY_EXCEEDED',
  /** No crew member is authorised to drive the assigned vehicle. */
  'NO_AUTHORIZED_DRIVER',
  /** The vehicle has no recorded seat count, so capacity cannot be checked. */
  'VEHICLE_CAPACITY_UNKNOWN',
] as const;

export type ShortfallCode = (typeof SHORTFALL_CODES)[number];

const MESSAGES: Record<ShortfallCode, string> = {
  NOT_STAFFED: 'No crew was assigned to this visit.',
  CREW_TOO_SMALL: 'Fewer people are assigned than this service agreement requires.',
  NO_VEHICLE: 'No vehicle is assigned to this visit.',
  TOO_MANY_VEHICLES: 'More than one vehicle is assigned to this visit.',
  VEHICLE_CAPACITY_EXCEEDED:
    'The assigned crew does not fit in the assigned vehicle.',
  NO_AUTHORIZED_DRIVER:
    'Nobody in the assigned crew is authorised to drive the assigned vehicle.',
  VEHICLE_CAPACITY_UNKNOWN:
    'The assigned vehicle has no recorded seat count, so it cannot be checked against the crew size.',
};

export interface DueVisit {
  id: string;
  requiredCrewSize: number;
}

export interface CandidateAssignment {
  id: string;
  generatedVisitId: string;
  crewEmployeeIds: readonly string[];
  vehicleIds: readonly string[];
}

export interface VehicleFacts {
  /** Null when the fleet row has no seat count recorded. */
  seats: number | null;
}

export interface GuardInput {
  dueVisits: readonly DueVisit[];
  assignments: readonly CandidateAssignment[];
  vehicles: ReadonlyMap<string, VehicleFacts>;
  /** `employeeId` values authorised for each vehicle id. */
  authorizedDrivers: ReadonlyMap<string, ReadonlySet<string>>;
  /** Employees who may travel to a visit without a vehicle. */
  publicTransportEmployeeIds: ReadonlySet<string>;
}

export interface Shortfall {
  generatedVisitId: string;
  code: ShortfallCode;
  message: string;
}

export interface GuardVerdict {
  /**
   * PUBLISHABLE means every due visit is satisfiable. It does not mean
   * "publish" — the provenance gate still decides that, and
   * {@link requiresManagerReview} can veto automation on its own.
   */
  decision: 'PUBLISHABLE' | 'WITHHOLD';
  /**
   * The day is valid but must not publish itself.
   *
   * Set when a crew travels by public transport: allowed under policy (c),
   * and never automatic. Separate from `decision` because "this day is fine"
   * and "a machine may act on it" are different questions, and collapsing
   * them is how a review requirement gets lost.
   */
  requiresManagerReview: boolean;
  shortfalls: Shortfall[];
  visitsDue: number;
  visitsStaffed: number;
}

/**
 * DECIDED by Thivarrakesh, 26 Sep 2026: policy (c).
 *
 * A crew with no vehicle is **valid** when every member is authorised for
 * public transport — it is not a shortfall and does not withhold the day.
 * But it may never auto-publish: the day goes to a manager for review.
 *
 * A crew with no vehicle where any member lacks that authorisation stays a
 * shortfall, exactly as before.
 *
 * This reconciles ULK-C13's "exactly one appropriately sized vehicle" with
 * the existing `canUsePublicTransport` allowance (six active employees; PR
 * #72 recorded six such assignments as correct) without either rule
 * silently overriding the other.
 */
export const NO_VEHICLE_POLICY = {
  decision: 'PUBLIC_TRANSPORT_VALID_MANAGER_REVIEW',
  unauthorizedCode: 'NO_VEHICLE',
} as const satisfies { decision: string; unauthorizedCode: ShortfallCode };

const shortfall = (generatedVisitId: string, code: ShortfallCode): Shortfall => ({
  generatedVisitId,
  code,
  message: MESSAGES[code],
});

/**
 * Decides whether the whole day may be published.
 *
 * Every due visit is checked and every failing rule is reported, rather than
 * stopping at the first. A manager fixing one problem only to meet the next
 * on the following run is how a day takes a week; the shortfall list is the
 * whole job, not the first obstacle.
 *
 * A visit whose assignment fails several rules yields several shortfalls,
 * which is why the storage key is the visit and the code together.
 */
export function evaluateDueSet(input: GuardInput): GuardVerdict {
  const byVisit = new Map<string, CandidateAssignment>();
  for (const assignment of input.assignments) {
    byVisit.set(assignment.generatedVisitId, assignment);
  }

  const shortfalls: Shortfall[] = [];
  let staffed = 0;
  let requiresManagerReview = false;

  for (const visit of input.dueVisits) {
    const assignment = byVisit.get(visit.id);

    // The case the existing readiness gate structurally cannot see: the run
    // never produced anything for this visit, so there is no assignment to
    // find fault with.
    if (!assignment) {
      shortfalls.push(shortfall(visit.id, 'NOT_STAFFED'));
      continue;
    }

    staffed += 1;

    if (assignment.crewEmployeeIds.length < visit.requiredCrewSize) {
      shortfalls.push(shortfall(visit.id, 'CREW_TOO_SMALL'));
    }

    if (assignment.vehicleIds.length === 0) {
      // Policy (c). An empty crew is not a public-transport crew, so `every`
      // on an empty list must not be allowed to wave it through; the crew
      // size rule above has already flagged it, and it stays a shortfall.
      const travelsByPublicTransport =
        assignment.crewEmployeeIds.length > 0 &&
        assignment.crewEmployeeIds.every((employeeId) =>
          input.publicTransportEmployeeIds.has(employeeId),
        );

      if (travelsByPublicTransport) {
        requiresManagerReview = true;
      } else {
        shortfalls.push(shortfall(visit.id, NO_VEHICLE_POLICY.unauthorizedCode));
      }
    } else if (assignment.vehicleIds.length > 1) {
      shortfalls.push(shortfall(visit.id, 'TOO_MANY_VEHICLES'));
    } else {
      const vehicleId = assignment.vehicleIds[0];
      const vehicle = input.vehicles.get(vehicleId);

      // A missing fleet row and a null seat count are the same thing to this
      // rule: capacity cannot be checked, so it is not treated as met. A
      // capacity that cannot be violated is not a capacity that passes.
      if (!vehicle || vehicle.seats === null) {
        shortfalls.push(shortfall(visit.id, 'VEHICLE_CAPACITY_UNKNOWN'));
      } else if (assignment.crewEmployeeIds.length > vehicle.seats) {
        shortfalls.push(shortfall(visit.id, 'VEHICLE_CAPACITY_EXCEEDED'));
      }

      const authorised = input.authorizedDrivers.get(vehicleId) ?? new Set<string>();
      const hasDriver = assignment.crewEmployeeIds.some((employeeId) =>
        authorised.has(employeeId),
      );
      if (!hasDriver) {
        shortfalls.push(shortfall(visit.id, 'NO_AUTHORIZED_DRIVER'));
      }
    }
  }

  return {
    decision: shortfalls.length === 0 ? 'PUBLISHABLE' : 'WITHHOLD',
    requiresManagerReview,
    shortfalls,
    visitsDue: input.dueVisits.length,
    visitsStaffed: staffed,
  };
}

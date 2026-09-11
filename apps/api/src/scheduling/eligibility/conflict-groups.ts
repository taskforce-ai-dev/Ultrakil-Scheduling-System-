import { CONFLICT_CODES, ConflictCode } from './conflict-codes';

/**
 * Manager-facing groupings of the engine's conflict codes.
 *
 * A manager does not think in `SKILL_NOT_HELD`; they think "missing skill".
 * The Unassigned queue's conflict-type filter therefore speaks in groups while
 * the engine keeps speaking in codes. Both vocabularies are real and both are
 * validated — what is not allowed is sending one where the other is expected,
 * which is exactly how the queue's filters came to be rejected outright by the
 * API's whitelist validation.
 *
 * The order is the order the filter offers them in, "Other" last.
 */
export const CONFLICT_GROUPS = [
  'MISSING_PMS',
  'INSUFFICIENT_CREW',
  'MISSING_SKILL',
  'NO_AUTHORIZED_DRIVER',
  'UNAVAILABLE_VEHICLE',
  'BRANCH_RESTRICTION',
  'PERMANENT_STAFF_RESTRICTION',
  'SERVICE_WINDOW_CONFLICT',
  'EMPLOYEE_OVERLAP',
  'VEHICLE_OVERLAP',
  'CREW_CANNOT_TRAVEL',
  'OTHER',
] as const;

export type ConflictGroup = (typeof CONFLICT_GROUPS)[number];

/**
 * Every conflict code's group, exhaustive by construction.
 *
 * `Record<ConflictCode, ConflictGroup>` is the whole safety mechanism: add a
 * code to `CONFLICT_CODES` without placing it here and this file stops
 * compiling. That is deliberately a compile-time failure rather than a
 * runtime one — a module-level `throw` checking the same thing would take the
 * entire API down at boot over a mistake the compiler catches before it can
 * ever be deployed.
 *
 * Five codes (EMPLOYEE_INACTIVE, EMPLOYEE_UNAVAILABLE, VISIT_NOT_SCHEDULABLE,
 * ASSIGNMENT_LOCKED, NO_FEASIBLE_CREW) have no natural home among the eleven
 * named groups, so they sit under OTHER rather than being force-fitted
 * somewhere misleading.
 *
 * This must stay in step with `apps/manager-web/src/lib/conflict-groups.ts`.
 * That agreement is asserted by a test, not entrusted to this sentence.
 */
const CODE_TO_GROUP: Record<ConflictCode, ConflictGroup> = {
  NO_PMS_SUPERVISOR_AVAILABLE: 'MISSING_PMS',
  BRANCH_HAS_NO_PMS_SUPERVISOR: 'MISSING_PMS',
  CREW_TOO_SMALL: 'INSUFFICIENT_CREW',
  SKILL_NOT_HELD: 'MISSING_SKILL',
  NO_AUTHORIZED_DRIVER: 'NO_AUTHORIZED_DRIVER',
  VEHICLE_INACTIVE: 'UNAVAILABLE_VEHICLE',
  VEHICLE_CAPACITY_EXCEEDED: 'UNAVAILABLE_VEHICLE',
  TOO_MANY_VEHICLES: 'UNAVAILABLE_VEHICLE',
  BRANCH_MISMATCH: 'BRANCH_RESTRICTION',
  VEHICLE_BRANCH_MISMATCH: 'BRANCH_RESTRICTION',
  EMPLOYEE_PERMANENTLY_STATIONED: 'PERMANENT_STAFF_RESTRICTION',
  OUTSIDE_SERVICE_HOURS: 'SERVICE_WINDOW_CONFLICT',
  WINDOW_TOO_SHORT: 'SERVICE_WINDOW_CONFLICT',
  EMPLOYEE_DOUBLE_BOOKED: 'EMPLOYEE_OVERLAP',
  DUPLICATE_CREW_MEMBER: 'EMPLOYEE_OVERLAP',
  VEHICLE_DOUBLE_BOOKED: 'VEHICLE_OVERLAP',
  CREW_CANNOT_TRAVEL: 'CREW_CANNOT_TRAVEL',
  EMPLOYEE_INACTIVE: 'OTHER',
  EMPLOYEE_UNAVAILABLE: 'OTHER',
  VISIT_NOT_SCHEDULABLE: 'OTHER',
  ASSIGNMENT_LOCKED: 'OTHER',
  NO_FEASIBLE_CREW: 'OTHER',
};

/** Which group a conflict code belongs to. */
export function conflictGroupOf(code: ConflictCode): ConflictGroup {
  return CODE_TO_GROUP[code];
}

/**
 * The same question asked of a string read back from the database.
 *
 * Stored reason codes are plain strings, so a code written by an older
 * release — or by a producer publishing one this catalogue has never heard
 * of — is possible. Such a code belongs under Other; the alternative is a
 * conflict that appears in no group at all and so can never be filtered for.
 */
export function conflictGroupOfStored(code: string): ConflictGroup {
  return (
    (CODE_TO_GROUP as Record<string, ConflictGroup | undefined>)[code] ?? 'OTHER'
  );
}

/**
 * The inverse of `CODE_TO_GROUP`, derived rather than written out a second
 * time: a hand-maintained second copy is how a filter ends up quietly
 * excluding a code the UI still files under that group.
 */
function buildGroupCodes(): Record<ConflictGroup, ConflictCode[]> {
  const byGroup = Object.fromEntries(
    CONFLICT_GROUPS.map((group) => [group, [] as ConflictCode[]]),
  ) as Record<ConflictGroup, ConflictCode[]>;
  for (const code of CONFLICT_CODES) {
    byGroup[CODE_TO_GROUP[code]].push(code);
  }
  return byGroup;
}

export const CONFLICT_GROUP_CODES: Readonly<
  Record<ConflictGroup, readonly ConflictCode[]>
> = buildGroupCodes();

/**
 * Every code belonging to one of the eleven named groups.
 *
 * OTHER is filtered as the complement of this list rather than as its own five
 * codes, which keeps the filter in step with `conflictGroupOfStored`: a stored
 * code this catalogue does not know is shown under Other, so asking for Other
 * has to find it too.
 */
export const NAMED_CONFLICT_GROUP_CODES: readonly ConflictCode[] =
  CONFLICT_GROUPS.filter((group) => group !== 'OTHER').flatMap(
    (group) => CONFLICT_GROUP_CODES[group],
  );

/**
 * What state a queued visit is in, as the server sees it.
 *
 * UNASSIGNED — no eligibility conflicts are recorded against the visit: nobody
 * has proposed a crew for it yet, so its empty conflict list is silence rather
 * than a clean bill of health.
 * EXCEPTION — a crew was proposed, judged and refused, and the reasons are
 * persisted against the visit.
 *
 * The distinction is the server's to make: it owns the reason rows, so a
 * client should be told the answer rather than re-deriving it from whichever
 * page of rows it happens to be holding.
 */
export const UNASSIGNED_OPERATION_STATES = ['UNASSIGNED', 'EXCEPTION'] as const;

export type UnassignedOperationState =
  (typeof UNASSIGNED_OPERATION_STATES)[number];

import { ErrorCode } from '../../common/errors/error-codes';

/**
 * Every reason a proposed assignment can be refused.
 *
 * This catalogue is the contract between the engine, the Unassigned queue and
 * the dispatch board (ULK-O05). A code is a promise: once published it keeps
 * its meaning, because a manager's saved filter and a support conversation both
 * depend on it. Messages get reworded freely; codes do not.
 *
 * The values come from the shared `ErrorCode` catalogue rather than being
 * spelled out again here. ULK-C01 reserved most of these names for this task,
 * and a second near-identical vocabulary is how a dispatch board ends up
 * filtering on a code the API quietly stopped emitting.
 *
 * Every code here refuses work. There is deliberately no "warning" tier — a
 * rule that can be overridden is not a hard rule, and the one thing this engine
 * must never do is let infeasible work look scheduled.
 */
export const CONFLICT_CODES = [
  ErrorCode.BRANCH_MISMATCH,
  ErrorCode.EMPLOYEE_INACTIVE,
  ErrorCode.EMPLOYEE_UNAVAILABLE,
  ErrorCode.EMPLOYEE_DOUBLE_BOOKED,
  ErrorCode.EMPLOYEE_PERMANENTLY_STATIONED,
  ErrorCode.NO_PMS_SUPERVISOR_AVAILABLE,
  ErrorCode.BRANCH_HAS_NO_PMS_SUPERVISOR,
  ErrorCode.CREW_TOO_SMALL,
  ErrorCode.SKILL_NOT_HELD,
  ErrorCode.DUPLICATE_CREW_MEMBER,
  ErrorCode.VEHICLE_INACTIVE,
  ErrorCode.VEHICLE_BRANCH_MISMATCH,
  ErrorCode.VEHICLE_DOUBLE_BOOKED,
  ErrorCode.NO_AUTHORIZED_DRIVER,
  ErrorCode.VEHICLE_CAPACITY_EXCEEDED,
  ErrorCode.OUTSIDE_SERVICE_HOURS,
  ErrorCode.WINDOW_TOO_SHORT,
  ErrorCode.VISIT_NOT_SCHEDULABLE,
  ErrorCode.ASSIGNMENT_LOCKED,
] as const;

export type ConflictCode = (typeof CONFLICT_CODES)[number];

/** Which resources a conflict is about, so a UI can highlight them. */
export interface ConflictResources {
  visitId?: string;
  employeeIds?: string[];
  vehicleIds?: string[];
  serviceSiteId?: string;
  skillCodes?: string[];
  assignmentIds?: string[];
}

export interface Conflict {
  code: ConflictCode;
  /** Written for a manager, never for a developer. */
  message: string;
  /** What to actually do about it. Every conflict has a way out. */
  remediation: string;
  resources: ConflictResources;
}

/**
 * A stable order, so the same input always produces byte-identical output.
 *
 * Sorting by code alone is not enough: two employees can fail the same rule,
 * and the order Prisma returned them in must not leak into the result.
 */
export function sortConflicts(conflicts: Conflict[]): Conflict[] {
  return [...conflicts].sort((left, right) => {
    if (left.code !== right.code) return left.code < right.code ? -1 : 1;
    const leftKey = conflictKey(left);
    const rightKey = conflictKey(right);
    if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
    return left.message < right.message ? -1 : left.message > right.message ? 1 : 0;
  });
}

function conflictKey(conflict: Conflict): string {
  const { employeeIds = [], vehicleIds = [], skillCodes = [] } = conflict.resources;
  return [...employeeIds, ...vehicleIds, ...skillCodes].sort().join(',');
}

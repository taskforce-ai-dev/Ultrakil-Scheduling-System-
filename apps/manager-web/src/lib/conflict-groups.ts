import type { ConflictCode } from "@/lib/api-client";

/**
 * Every conflict code sorted into the groups ULK-O05 asks for, so the
 * Unassigned queue's "conflict type" filter has something to filter by.
 * This is a display grouping only — the engine (`apps/api/src/scheduling/
 * eligibility/conflict-codes.ts`) has no concept of it, and every individual
 * conflict is still shown in full regardless of which group it falls under.
 *
 * Four codes (EMPLOYEE_INACTIVE, EMPLOYEE_UNAVAILABLE, VISIT_NOT_SCHEDULABLE,
 * ASSIGNMENT_LOCKED) don't fit any of the ten named groups, so they fall
 * under "Other" rather than being force-fit somewhere misleading.
 */
export type ConflictGroup =
  | "MISSING_PMS"
  | "INSUFFICIENT_CREW"
  | "MISSING_SKILL"
  | "NO_AUTHORIZED_DRIVER"
  | "UNAVAILABLE_VEHICLE"
  | "BRANCH_RESTRICTION"
  | "PERMANENT_STAFF_RESTRICTION"
  | "SERVICE_WINDOW_CONFLICT"
  | "EMPLOYEE_OVERLAP"
  | "VEHICLE_OVERLAP"
  | "OTHER";

export const CONFLICT_GROUP_LABEL: Record<ConflictGroup, string> = {
  MISSING_PMS: "Missing PMS supervisor",
  INSUFFICIENT_CREW: "Insufficient crew",
  MISSING_SKILL: "Missing skill",
  NO_AUTHORIZED_DRIVER: "No authorized driver",
  UNAVAILABLE_VEHICLE: "Unavailable vehicle",
  BRANCH_RESTRICTION: "Branch restriction",
  PERMANENT_STAFF_RESTRICTION: "Permanent-staff restriction",
  SERVICE_WINDOW_CONFLICT: "Service-window conflict",
  EMPLOYEE_OVERLAP: "Employee overlap",
  VEHICLE_OVERLAP: "Vehicle overlap",
  OTHER: "Other",
};

const CODE_TO_GROUP: Record<ConflictCode, ConflictGroup> = {
  NO_PMS_SUPERVISOR_AVAILABLE: "MISSING_PMS",
  BRANCH_HAS_NO_PMS_SUPERVISOR: "MISSING_PMS",
  CREW_TOO_SMALL: "INSUFFICIENT_CREW",
  SKILL_NOT_HELD: "MISSING_SKILL",
  NO_AUTHORIZED_DRIVER: "NO_AUTHORIZED_DRIVER",
  VEHICLE_INACTIVE: "UNAVAILABLE_VEHICLE",
  VEHICLE_CAPACITY_EXCEEDED: "UNAVAILABLE_VEHICLE",
  BRANCH_MISMATCH: "BRANCH_RESTRICTION",
  VEHICLE_BRANCH_MISMATCH: "BRANCH_RESTRICTION",
  EMPLOYEE_PERMANENTLY_STATIONED: "PERMANENT_STAFF_RESTRICTION",
  OUTSIDE_SERVICE_HOURS: "SERVICE_WINDOW_CONFLICT",
  WINDOW_TOO_SHORT: "SERVICE_WINDOW_CONFLICT",
  EMPLOYEE_DOUBLE_BOOKED: "EMPLOYEE_OVERLAP",
  DUPLICATE_CREW_MEMBER: "EMPLOYEE_OVERLAP",
  VEHICLE_DOUBLE_BOOKED: "VEHICLE_OVERLAP",
  EMPLOYEE_INACTIVE: "OTHER",
  EMPLOYEE_UNAVAILABLE: "OTHER",
  VISIT_NOT_SCHEDULABLE: "OTHER",
  ASSIGNMENT_LOCKED: "OTHER",
};

export function conflictGroup(code: ConflictCode): ConflictGroup {
  return CODE_TO_GROUP[code] ?? "OTHER";
}

/** In a stable order for the filter dropdown, "Other" last. */
export const CONFLICT_GROUPS: ConflictGroup[] = [
  "MISSING_PMS",
  "INSUFFICIENT_CREW",
  "MISSING_SKILL",
  "NO_AUTHORIZED_DRIVER",
  "UNAVAILABLE_VEHICLE",
  "BRANCH_RESTRICTION",
  "PERMANENT_STAFF_RESTRICTION",
  "SERVICE_WINDOW_CONFLICT",
  "EMPLOYEE_OVERLAP",
  "VEHICLE_OVERLAP",
  "OTHER",
];

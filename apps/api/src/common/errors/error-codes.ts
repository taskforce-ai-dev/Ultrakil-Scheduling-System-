/**
 * Stable, machine-readable error codes.
 *
 * These are part of the API contract: the manager portal branches on `code`,
 * never on the human-readable `message`. Once a code ships it must not change
 * meaning — add a new code instead.
 *
 * Naming: <DOMAIN>_<CONDITION>.
 */
export const ErrorCode = {
  // --- Generic ---------------------------------------------------------------
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  RESOURCE_CONFLICT: 'RESOURCE_CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // --- Infrastructure --------------------------------------------------------
  DATABASE_UNAVAILABLE: 'DATABASE_UNAVAILABLE',
  QUEUE_UNAVAILABLE: 'QUEUE_UNAVAILABLE',
  SCHEDULER_UNAVAILABLE: 'SCHEDULER_UNAVAILABLE',

  // --- Workforce import ------------------------------------------------------
  MATRIX_FILE_NOT_FOUND: 'MATRIX_FILE_NOT_FOUND',
  MATRIX_SHEET_NOT_FOUND: 'MATRIX_SHEET_NOT_FOUND',
  MATRIX_COLUMN_MISSING: 'MATRIX_COLUMN_MISSING',
  MATRIX_ROW_INVALID: 'MATRIX_ROW_INVALID',

  // --- Scheduling hard rules (populated by ULK-C05) --------------------------
  BRANCH_MISMATCH: 'BRANCH_MISMATCH',
  EMPLOYEE_PERMANENTLY_STATIONED: 'EMPLOYEE_PERMANENTLY_STATIONED',
  NO_PMS_SUPERVISOR_AVAILABLE: 'NO_PMS_SUPERVISOR_AVAILABLE',
  NO_AUTHORIZED_DRIVER: 'NO_AUTHORIZED_DRIVER',
  VEHICLE_CAPACITY_EXCEEDED: 'VEHICLE_CAPACITY_EXCEEDED',
  EMPLOYEE_DOUBLE_BOOKED: 'EMPLOYEE_DOUBLE_BOOKED',
  VEHICLE_DOUBLE_BOOKED: 'VEHICLE_DOUBLE_BOOKED',
  OUTSIDE_SERVICE_HOURS: 'OUTSIDE_SERVICE_HOURS',
  DAY_NOT_ALLOWED: 'DAY_NOT_ALLOWED',
  SKILL_NOT_HELD: 'SKILL_NOT_HELD',
  ASSIGNMENT_LOCKED: 'ASSIGNMENT_LOCKED',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

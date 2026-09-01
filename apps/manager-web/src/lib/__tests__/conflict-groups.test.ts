import { describe, expect, it } from "vitest";

import { CONFLICT_GROUP_LABEL, CONFLICT_GROUPS, conflictGroup } from "@/lib/conflict-groups";
import type { ConflictCode } from "@/lib/api-client";

/**
 * Locks in every one of the backend's 19 conflict codes against the 10
 * named groups ULK-O05 asks for (plus "Other" for the 4 that don't fit).
 * A code the backend adds later and this file doesn't know about should
 * fail typecheck (CODE_TO_GROUP is a Record<ConflictCode, ...>), but this
 * still pins the *current* mapping so a miscategorization is caught here
 * rather than only showing up as a visit filed under the wrong filter.
 */
const EXPECTED: Record<ConflictCode, string> = {
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

describe("conflictGroup", () => {
  it.each(Object.entries(EXPECTED))("sorts %s into %s", (code, group) => {
    expect(conflictGroup(code as ConflictCode)).toBe(group);
  });

  it("covers every conflict code the backend defines", () => {
    expect(Object.keys(EXPECTED)).toHaveLength(19);
  });

  it("lists all ten named groups plus Other, in a stable order", () => {
    expect(CONFLICT_GROUPS).toEqual([
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
    ]);
  });

  it("gives every group a human-readable label", () => {
    for (const group of CONFLICT_GROUPS) {
      expect(CONFLICT_GROUP_LABEL[group]).toBeTruthy();
    }
  });
});

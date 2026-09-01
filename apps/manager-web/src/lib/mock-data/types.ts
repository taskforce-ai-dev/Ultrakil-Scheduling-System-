/**
 * The shared contract (`@ultrakil/api-contracts`) currently only publishes
 * `/api/health` and `/api/meta` — it "grows with ULK-C02 and ULK-C03" per
 * PR #1. These types are a temporary stand-in for the domain shapes the
 * portal will eventually need. Delete this file and import from
 * `@ultrakil/api-contracts` once those endpoints exist; do not hand-extend
 * these once the real contract lands.
 */

export type BranchCode = "COLOMBO" | "KANDY";

// Customer / ServiceSite / JobType / ServiceAgreement used to live here as
// temporary mock types (grounded in the Prisma schema before ULK-C03 shipped
// an API for them). ULK-C03 is live now — those types come from the
// generated `@ultrakil/api-contracts` client instead (see api-client.ts).
// Weekday/FrequencyUnit/DayRuleKind moved to lib/weekdays.ts, since they're
// shared UI vocabulary rather than mock stand-ins.

/**
 * Grounded in the real `Employee` model (`apps/api/prisma/schema.prisma`),
 * which exists in the database from ULK-C01 even though no API endpoint
 * exposes it yet. Field names match the schema deliberately, so swapping to
 * a real generated type later is a rename of the import, not a re-shape.
 */
export type DeploymentType = "MOBILE" | "PERMANENTLY_STATIONED";

export interface EmployeeSkill {
  skillCode: string;
  skillLabel: string;
}

export interface Employee {
  id: string;
  employeeCode: string | null;
  fullName: string;
  /** Exactly as spelled in the source workbook, e.g. "Senior PMS", "Junior PMT". */
  gradeLabel: string;
  isPmsGrade: boolean;
  branchCode: BranchCode;
  deploymentType: DeploymentType;
  /**
   * Site name for permanently stationed staff. The schema holds this as a
   * label rather than a real site link until ULK-C03 (service sites exist).
   * Non-null only when deploymentType is PERMANENTLY_STATIONED.
   */
  permanentSiteLabel: string | null;
  isActive: boolean;
  skills: EmployeeSkill[];
  /** IDs of vehicles this employee is authorized to drive — authorization only, no ownership. */
  authorizedVehicleIds: string[];
}

export interface Vehicle {
  id: string;
  code: string;
  label: string;
  branchCode: BranchCode | null;
  seatCapacity: number | null;
  isActive: boolean;
}

// DispatchVisit / UnassignedVisit used to live here as placeholder types for
// the ULK-O01 scaffold. ULK-C05 is live now (the eligibility/conflict
// engine) — the Dispatch Board and Unassigned Visits pages use the real
// Visit/AssignmentDto/ConflictDto types from api-client.ts instead.

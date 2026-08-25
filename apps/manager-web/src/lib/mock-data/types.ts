/**
 * The shared contract (`@ultrakil/api-contracts`) currently only publishes
 * `/api/health` and `/api/meta` — it "grows with ULK-C02 and ULK-C03" per
 * PR #1. These types are a temporary stand-in for the domain shapes the
 * portal will eventually need. Delete this file and import from
 * `@ultrakil/api-contracts` once those endpoints exist; do not hand-extend
 * these once the real contract lands.
 */

export type BranchCode = "COLOMBO" | "KANDY";

export interface Customer {
  id: string;
  name: string;
  branchCode: BranchCode;
  siteCount: number;
}

export interface ServiceAgreement {
  id: string;
  customerId: string;
  customerName: string;
  frequencyValue: number;
  frequencyUnit: "WEEK" | "MONTH";
  allowedWeekdays: string[];
  preferredWeekdays: string[];
}

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

export interface DispatchVisit {
  id: string;
  customerName: string;
  branchCode: BranchCode;
  scheduledDate: string;
  crewEmployeeNames: string[];
  hasPmsSupervisor: boolean;
}

export interface UnassignedVisit {
  id: string;
  customerName: string;
  branchCode: BranchCode;
  reason: string;
}

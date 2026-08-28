/**
 * The shared contract (`@ultrakil/api-contracts`) currently only publishes
 * `/api/health` and `/api/meta` — it "grows with ULK-C02 and ULK-C03" per
 * PR #1. These types are a temporary stand-in for the domain shapes the
 * portal will eventually need. Delete this file and import from
 * `@ultrakil/api-contracts` once those endpoints exist; do not hand-extend
 * these once the real contract lands.
 */

export type BranchCode = "COLOMBO" | "KANDY";

/**
 * Grounded in the real `Customer` / `ServiceSite` / `SiteOperatingHours` /
 * `JobType` / `ServiceAgreement` / `ServiceAgreementDayRule` models
 * (`apps/api/prisma/schema.prisma`) — ULK-C03 hasn't published endpoints for
 * these yet, so field names match the schema deliberately, the same way the
 * workforce types did before ULK-C02 landed.
 */
export type Weekday =
  | "MONDAY"
  | "TUESDAY"
  | "WEDNESDAY"
  | "THURSDAY"
  | "FRIDAY"
  | "SATURDAY"
  | "SUNDAY";

export const WEEKDAYS: Weekday[] = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
];

export type FrequencyUnit = "WEEK" | "MONTH";

/** ALLOWED is a hard constraint; PREFERRED is a soft ranking preference only. */
export type DayRuleKind = "ALLOWED" | "PREFERRED";

/**
 * One weekday's opening window. A weekday with no entry is closed — the
 * schema has no "closed" flag, absence of a row *is* closed. Only one window
 * per weekday: the schema (`SiteOperatingHours`) has no support for a second
 * window on the same day, so the UI does not invent one either.
 */
export interface SiteOperatingHours {
  weekday: Weekday;
  opensAtMinute: number;
  closesAtMinute: number;
}

export interface ServiceSite {
  id: string;
  customerId: string;
  name: string;
  addressLine: string | null;
  city: string | null;
  branchCode: BranchCode;
  isActive: boolean;
  operatingHours: SiteOperatingHours[];
}

export interface Customer {
  id: string;
  name: string;
  customerCode: string | null;
  branchCode: BranchCode;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  isActive: boolean;
  sites: ServiceSite[];
}

export interface JobType {
  id: string;
  code: string;
  name: string;
  defaultDurationMinutes: number;
  defaultCrewSize: number;
  requiresPmsSupervisor: boolean;
  requiredSkillCode: string | null;
  isActive: boolean;
}

export interface ServiceAgreementDayRule {
  weekday: Weekday;
  kind: DayRuleKind;
}

export interface ServiceAgreement {
  id: string;
  customerId: string;
  customerName: string;
  serviceSiteId: string;
  siteName: string;
  jobTypeId: string;
  jobTypeName: string;
  branchCode: BranchCode;
  frequencyCount: number;
  frequencyUnit: FrequencyUnit;
  crewSize: number;
  durationMinutes: number;
  /** Null falls back to the site's operating hours for that weekday. */
  serviceWindowStartMinute: number | null;
  serviceWindowEndMinute: number | null;
  startDate: string;
  endDate: string | null;
  isActive: boolean;
  notes: string | null;
  dayRules: ServiceAgreementDayRule[];
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

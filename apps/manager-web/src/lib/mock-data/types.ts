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

export interface Employee {
  id: string;
  name: string;
  branchCode: BranchCode;
  pmsGradeLabel: string | null;
  isPermanentlyStationed: boolean;
}

export interface Vehicle {
  id: string;
  label: string;
  branchCode: BranchCode;
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

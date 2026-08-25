import type {
  Customer,
  ServiceAgreement,
  Employee,
  Vehicle,
  DispatchVisit,
  UnassignedVisit,
} from "./types";

export const mockCustomers: Customer[] = [
  { id: "cust-1", name: "Cinnamon Grand Colombo", branchCode: "COLOMBO", siteCount: 2 },
  { id: "cust-2", name: "Kandy City Centre", branchCode: "KANDY", siteCount: 1 },
];

export const mockServiceAgreements: ServiceAgreement[] = [
  {
    id: "sa-1",
    customerId: "cust-1",
    customerName: "Cinnamon Grand Colombo",
    frequencyValue: 2,
    frequencyUnit: "WEEK",
    allowedWeekdays: ["MONDAY", "THURSDAY"],
    preferredWeekdays: ["MONDAY"],
  },
];

export const mockEmployees: Employee[] = [
  { id: "emp-1", name: "S. Perera", branchCode: "COLOMBO", pmsGradeLabel: "PMS", isPermanentlyStationed: false },
  { id: "emp-2", name: "N. Fernando", branchCode: "KANDY", pmsGradeLabel: null, isPermanentlyStationed: true },
];

export const mockVehicles: Vehicle[] = [
  { id: "veh-1", label: "Van — COL-4521", branchCode: "COLOMBO" },
];

export const mockDispatchVisits: DispatchVisit[] = [
  {
    id: "visit-1",
    customerName: "Cinnamon Grand Colombo",
    branchCode: "COLOMBO",
    scheduledDate: "2026-08-24",
    crewEmployeeNames: ["S. Perera"],
    hasPmsSupervisor: true,
  },
];

export const mockUnassignedVisits: UnassignedVisit[] = [
  {
    id: "unassigned-1",
    customerName: "Kandy City Centre",
    branchCode: "KANDY",
    reason: "No PMS-grade supervisor available in Kandy for the preferred day.",
  },
];

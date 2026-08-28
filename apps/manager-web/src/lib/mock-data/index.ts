import type { Employee, Vehicle, DispatchVisit, UnassignedVisit } from "./types";

// Customer / JobType / ServiceAgreement mocks used to live here — removed
// now that ULK-C03 is live; the Customers and Service Agreements pages fetch
// from the real API (see api-client.ts) instead.

export const mockVehicles: Vehicle[] = [
  { id: "veh-1", code: "COL-4521", label: "Van — COL-4521", branchCode: "COLOMBO", seatCapacity: 6, isActive: true },
  { id: "veh-2", code: "COL-7788", label: "Pickup — COL-7788", branchCode: "COLOMBO", seatCapacity: 3, isActive: true },
  { id: "veh-3", code: "KAN-1190", label: "Van — KAN-1190", branchCode: "KANDY", seatCapacity: 6, isActive: true },
  { id: "veh-4", code: "KAN-2004", label: "Pickup — KAN-2004", branchCode: "KANDY", seatCapacity: 3, isActive: true },
];

export const mockEmployees: Employee[] = [
  {
    id: "emp-1",
    employeeCode: "E-101",
    fullName: "S. Perera",
    gradeLabel: "PMS",
    isPmsGrade: true,
    branchCode: "COLOMBO",
    deploymentType: "MOBILE",
    permanentSiteLabel: null,
    isActive: true,
    skills: [
      { skillCode: "FUMIGATION", skillLabel: "Fumigation" },
      { skillCode: "TERMITE", skillLabel: "Termite Control" },
    ],
    authorizedVehicleIds: ["veh-1", "veh-2"],
  },
  {
    id: "emp-2",
    employeeCode: "E-102",
    fullName: "N. Fernando",
    gradeLabel: "Junior PMT",
    isPmsGrade: false,
    branchCode: "KANDY",
    deploymentType: "MOBILE",
    permanentSiteLabel: null,
    isActive: true,
    skills: [{ skillCode: "GENERAL_PEST", skillLabel: "General Pest Control" }],
    authorizedVehicleIds: ["veh-3"],
  },
  {
    id: "emp-3",
    employeeCode: "E-103",
    fullName: "A. Silva",
    gradeLabel: "Senior PMS",
    isPmsGrade: true,
    branchCode: "COLOMBO",
    deploymentType: "PERMANENTLY_STATIONED",
    permanentSiteLabel: "Grandview Hotel",
    isActive: true,
    skills: [{ skillCode: "FUMIGATION", skillLabel: "Fumigation" }],
    authorizedVehicleIds: [],
  },
  {
    id: "emp-4",
    employeeCode: "E-104",
    fullName: "R. Bandara",
    gradeLabel: "Assistant PMS",
    isPmsGrade: true,
    branchCode: "COLOMBO",
    deploymentType: "MOBILE",
    permanentSiteLabel: null,
    isActive: true,
    skills: [
      { skillCode: "TERMITE", skillLabel: "Termite Control" },
      { skillCode: "RODENT", skillLabel: "Rodent Control" },
    ],
    authorizedVehicleIds: ["veh-1"],
  },
  {
    id: "emp-5",
    employeeCode: "E-105",
    fullName: "K. Jayasuriya",
    gradeLabel: "PMS",
    isPmsGrade: true,
    branchCode: "KANDY",
    deploymentType: "MOBILE",
    permanentSiteLabel: null,
    isActive: true,
    skills: [{ skillCode: "FUMIGATION", skillLabel: "Fumigation" }],
    authorizedVehicleIds: ["veh-3"],
  },
  {
    id: "emp-6",
    employeeCode: "E-106",
    fullName: "T. Wickrama",
    gradeLabel: "Junior PMT",
    isPmsGrade: false,
    branchCode: "COLOMBO",
    deploymentType: "PERMANENTLY_STATIONED",
    permanentSiteLabel: "Seaside Resort",
    isActive: false,
    skills: [{ skillCode: "GENERAL_PEST", skillLabel: "General Pest Control" }],
    authorizedVehicleIds: [],
  },
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

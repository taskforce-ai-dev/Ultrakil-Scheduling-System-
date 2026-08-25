import type { Employee, Vehicle } from "@/lib/api-client";

/**
 * Test fixtures shaped by the generated contract.
 *
 * Built from `Employee` and `Vehicle` rather than hand-written interfaces, so
 * a backend field change breaks these at compile time instead of letting the
 * tests keep passing against a shape the API no longer returns.
 */

export function buildVehicle(overrides: Partial<Vehicle> = {}): Vehicle {
  return {
    id: "vehicle-1",
    code: "253-4289",
    label: "Van( 04 People) 253-4289",
    seatCapacity: 4,
    branchCode: "COLOMBO",
    isActive: true,
    authorizedDriverCount: 1,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

export function buildEmployee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: "employee-1",
    employeeCode: null,
    fullName: "A Perera",
    gradeLabel: "Junior PMT",
    isPmsGrade: false,
    branchCode: "COLOMBO",
    branch: { id: "branch-colombo", code: "COLOMBO", name: "Colombo Branch" },
    deploymentType: "MOBILE",
    permanentSiteLabel: null,
    canUsePublicTransport: false,
    isActive: true,
    skills: [],
    authorizedVehicles: [],
    authorizedVehicleIds: [],
    availability: [],
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

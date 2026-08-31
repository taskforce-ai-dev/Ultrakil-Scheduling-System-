import type {
  Customer,
  GenerationImpact,
  Visit,
  VisitDetail,
  JobType,
  ServiceAgreement,
  ServiceSite,
  SchedulePreview,
  SkillListItem,
  Employee,
  Vehicle,
} from "@/lib/api-client";

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

export function buildServiceSite(overrides: Partial<ServiceSite> = {}): ServiceSite {
  return {
    id: "site-1",
    customerId: "customer-1",
    name: "Main Kitchen",
    addressLine: "77 Galle Road",
    city: "Colombo 03",
    branchCode: "COLOMBO",
    isActive: true,
    operatingHours: [
      { id: "hours-1", weekday: "MONDAY", opensAtMinute: 6 * 60, closesAtMinute: 22 * 60 },
      { id: "hours-2", weekday: "WEDNESDAY", opensAtMinute: 8 * 60, closesAtMinute: 18 * 60 },
    ],
    serviceAgreementCount: 0,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

export function buildCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: "customer-1",
    name: "Cinnamon Grand Colombo",
    customerCode: "C-001",
    branchCode: "COLOMBO",
    contactName: "R. Gunawardena",
    contactPhone: "011 123 4567",
    contactEmail: "facilities@example.com",
    isActive: true,
    sites: [buildServiceSite()],
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

export function buildJobType(overrides: Partial<JobType> = {}): JobType {
  return {
    id: "job-1",
    code: "TERMITE_CONTROL",
    name: "Termite Control",
    defaultDurationMinutes: 90,
    defaultCrewSize: 2,
    requiresPmsSupervisor: true,
    requiredSkillCode: "TERMITE",
    isActive: true,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

export function buildServiceAgreement(
  overrides: Partial<ServiceAgreement> = {}
): ServiceAgreement {
  return {
    id: "agreement-1",
    customerId: "customer-1",
    customerName: "Cinnamon Grand Colombo",
    serviceSiteId: "site-1",
    siteName: "Main Kitchen",
    jobTypeId: "job-1",
    jobTypeName: "Termite Control",
    branchCode: "COLOMBO",
    frequencyCount: 2,
    frequencyUnit: "WEEK",
    // Units per cycle: 1 is the ordinary case, 2 with WEEK is fortnightly.
    frequencyInterval: 1,
    frequencyLabel: "2 times a week",
    crewSize: 2,
    durationMinutes: 90,
    serviceWindowStartMinute: null,
    serviceWindowEndMinute: null,
    startDate: "2026-09-07",
    endDate: null,
    status: "ACTIVE",
    isActive: true,
    currentVersion: 1,
    dayRules: [
      { weekday: "MONDAY", kind: "ALLOWED" },
      { weekday: "WEDNESDAY", kind: "ALLOWED" },
    ],
    allowedDays: ["MONDAY", "WEDNESDAY"],
    preferredDays: ["MONDAY"],
    requiredSkillCodes: [],
    notes: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

export function buildSkill(overrides: Partial<SkillListItem> = {}): SkillListItem {
  return { skillCode: "TERMITE", skillLabel: "Termite Control", employeeCount: 3, ...overrides };
}

export function buildSchedulePreview(overrides: Partial<SchedulePreview> = {}): SchedulePreview {
  return {
    visits: [
      {
        date: "2026-09-07",
        weekday: "MONDAY",
        windowStartMinute: 6 * 60,
        windowEndMinute: 22 * 60,
        isPreferredDay: true,
      },
    ],
    shortfalls: [],
    horizonStart: "2026-09-07",
    horizonEnd: "2026-10-05",
    ...overrides,
  };
}

export function buildVisit(overrides: Partial<Visit> = {}): Visit {
  return {
    id: "visit-1",
    visitDate: "2026-09-09",
    windowStartMinute: 540,
    windowEndMinute: 1020,
    durationMinutes: 90,
    requiredCrewSize: 2,
    status: "UNASSIGNED",
    branchCode: "COLOMBO",
    serviceAgreementId: "agreement-1",
    customerName: "Cinnamon Grand Colombo",
    siteName: "Main Kitchen",
    jobTypeName: "Termite Control",
    hoursUnconfirmed: false,
    isProtected: false,
    protectionReason: null,
    isManuallyAdjusted: false,
    manuallyAdjustedAt: null,
    isLocked: false,
    lockReason: null,
    assignmentCount: 0,
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    ...overrides,
  };
}

export function buildVisitDetail(overrides: Partial<VisitDetail> = {}): VisitDetail {
  return {
    ...buildVisit(),
    origin: {
      serviceAgreementId: "agreement-1",
      customerName: "Cinnamon Grand Colombo",
      siteName: "Main Kitchen",
      jobTypeName: "Termite Control",
      agreementVersionNumber: 1,
      frequencyLabel: "Fortnightly",
      allowedDaysAtGeneration: ["WEDNESDAY"],
      generatedAt: "2026-08-31T00:00:00.000Z",
      generatedByRunId: "run-1",
    },
    ...overrides,
  };
}

export function buildGenerationImpact(
  overrides: Partial<GenerationImpact> = {}
): GenerationImpact {
  return {
    from: "2026-08-31",
    to: "2026-10-04",
    agreementsConsidered: 1,
    additions: [],
    updates: [],
    removals: [],
    protectedVisits: [],
    unchangedCount: 0,
    shortfalls: [],
    isPreview: true,
    scheduleRunId: null,
    ...overrides,
  };
}

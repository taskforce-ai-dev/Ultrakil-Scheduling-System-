import type { components, paths } from "@ultrakil/api-contracts";

import { clearToken, readToken } from "./session-token";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001/api";

/* -------------------------------------------------------------------------
 * Wire types come from the generated contract. Runtime-normalized view models
 * below deliberately broaden malformed scalar fields to safe empty/null values
 * while preserving the generated response's names and nesting.
 * ---------------------------------------------------------------------- */

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;

export type MetaResponse = Json<paths["/api/meta"]["get"]["responses"]["200"]>;
export type HealthResponse = Json<paths["/api/health/ready"]["get"]["responses"]["200"]>;
export type LoginResponse = Json<paths["/api/auth/login"]["post"]["responses"]["200"]>;
export type CurrentUser = Json<paths["/api/auth/me"]["get"]["responses"]["200"]>;
export type PaginatedEmployees = Json<paths["/api/employees"]["get"]["responses"]["200"]>;
export type Employee = PaginatedEmployees["items"][number];
export type BranchCode = Employee["branchCode"];
export type DeploymentType = Employee["deploymentType"];
export type PaginatedVehicles = Json<paths["/api/vehicles"]["get"]["responses"]["200"]>;
export type Vehicle = PaginatedVehicles["items"][number];
export type AuthorizedDrivers = Json<
  paths["/api/vehicles/{id}/authorized-drivers"]["get"]["responses"]["200"]
>;
export type BranchListItem = Json<paths["/api/branches"]["get"]["responses"]["200"]>[number];
export type SkillListItem = Json<paths["/api/skills"]["get"]["responses"]["200"]>[number];

export type EmployeeQuery = NonNullable<paths["/api/employees"]["get"]["parameters"]["query"]>;
export type VehicleQuery = NonNullable<paths["/api/vehicles"]["get"]["parameters"]["query"]>;

export type PaginatedCustomers = Json<paths["/api/customers"]["get"]["responses"]["200"]>;
export type Customer = PaginatedCustomers["items"][number];
export type ServiceSite = Customer["sites"][number];
export type SiteOperatingHoursEntry = ServiceSite["operatingHours"][number];
export type JobType = Json<paths["/api/job-types"]["get"]["responses"]["200"]>[number];
export type PaginatedServiceAgreements = Json<
  paths["/api/service-agreements"]["get"]["responses"]["200"]
>;
export type ServiceAgreement = PaginatedServiceAgreements["items"][number];
export type SchedulePreview = Json<
  paths["/api/service-agreements/{id}/schedule-preview"]["get"]["responses"]["200"]
>;
export type AgreementStatus = ServiceAgreement["status"];

export type PaginatedVisits = Json<paths["/api/visits"]["get"]["responses"]["200"]>;
export type Visit = PaginatedVisits["items"][number];
export type VisitDetail = Json<paths["/api/visits/{id}"]["get"]["responses"]["200"]>;
export type VisitOrigin = VisitDetail["origin"];
export type VisitStatus = Visit["status"];
export type GenerationImpact = Json<
  paths["/api/visit-generation/preview"]["post"]["responses"]["200"]
>;
export type PlannedVisit = GenerationImpact["additions"][number];
export type PlannedUpdate = GenerationImpact["updates"][number];
export type PlannedRemoval = GenerationImpact["removals"][number];
export type ProtectedVisit = GenerationImpact["protectedVisits"][number];
export type GenerationShortfall = GenerationImpact["shortfalls"][number];

export type VisitQuery = NonNullable<paths["/api/visits"]["get"]["parameters"]["query"]>;

export type CalendarResponse = components["schemas"]["CalendarResponseDto"];
export type CalendarEntry = components["schemas"]["CalendarEntryDto"];
export type CalendarAssignment = NonNullable<CalendarEntry["assignment"]>;
export type CalendarQuery = NonNullable<
  paths["/api/schedule/calendar"]["get"]["parameters"]["query"]
>;

export type Conflict = components["schemas"]["ConflictDto"];
export type ConflictCode = Conflict["code"];
export type Assignment = components["schemas"]["AssignmentDto"];
export type AssignmentStatus = Assignment["status"];
export type UnassignedVisit = components["schemas"]["UnassignedVisitDto"];
export type PaginatedUnassignedVisits = components["schemas"]["PaginatedUnassignedVisitsDto"];
export type EligibilityResult = components["schemas"]["EligibilityResultDto"];
export type CrewRole = Assignment["crew"][number]["role"];

/* -------------------------------------------------------------------------
 * Manager operational read model
 *
 * This endpoint is intentionally parsed at the boundary. The generated types
 * keep its wire shape aligned with the API, while this parser keeps a manager
 * screen readable when a malformed or older response omits a field. In
 * particular, a missing/invalid assignment never becomes a positive dispatch
 * claim.
 * ---------------------------------------------------------------------- */

type OperationsDayContract = components["schemas"]["OperationsDayResponseDto"];
type OperationsDayContractItem = OperationsDayContract["items"][number];
export type OperationState = OperationsDayContractItem["state"];
export type OperationWarningCode = OperationsDayContractItem["warnings"][number]["code"];
export type OperationsDayQuery = NonNullable<
  paths["/api/operations/day"]["get"]["parameters"]["query"]
>;

export interface OperationsVisit {
  id: string;
  visitDate: string;
  customerName: string;
  siteName: string;
  jobTypeName: string;
  requiredCrewSize: number | null;
  durationMinutes: number | null;
  windowStartMinute: number | null;
  windowEndMinute: number | null;
  hoursUnconfirmed: boolean;
  branchCode: BranchCode | "";
}

export interface OperationsCrewMember {
  id?: string;
  employeeId?: string;
  fullName?: string;
  role?: string;
  isPmsSupervisor?: boolean;
}

export interface OperationsVehicle {
  id?: string;
  vehicleId?: string;
  label?: string;
  driverName?: string;
  driverEmployeeId?: string;
}

export interface OperationsAssignment {
  id: string;
  status: AssignmentStatus;
  crew: OperationsCrewMember[];
  vehicles: OperationsVehicle[];
  plannedStartMinute?: number | null;
  plannedEndMinute?: number | null;
}

export interface OperationViolation {
  code: string;
  message: string;
  remediation?: string;
}

export interface OperationsScheduleVersion {
  id: string | null;
  version?: number | null;
  status: AssignmentStatus | "";
  predecessorId?: string | null;
  publishedAt: string | null;
}

export interface OperationWarning {
  code: OperationWarningCode;
  message: string;
}

export interface OperationsDayItem {
  visit: OperationsVisit;
  state: OperationState;
  dispatchAssignment: OperationsAssignment | null;
  proposedAssignment: OperationsAssignment | null;
  violations: OperationViolation[];
  nextAction: string;
  scheduleVersion: OperationsScheduleVersion | null;
  warnings: OperationWarning[];
}

export interface OperationsSummary {
  total: number;
  ready: number;
  proposed: number;
  unassigned: number;
  exceptions: number;
  hoursUnconfirmed: number;
}

export interface OperationsDayResponse {
  date: string;
  branchCode: BranchCode | null;
  summary: OperationsSummary;
  items: OperationsDayItem[];
}

/* -------------------------------------------------------------------------
 * Published assignment repair
 *
 * Every type here is a direct projection of the generated OpenAPI contract.
 * Pages may compose the returned fields for display, but must not invent
 * planner metadata the server never returned: a hand-written duplicate
 * compiles happily and then renders a crash against the real response.
 * ---------------------------------------------------------------------- */

export type PublishedAssignmentRepairFindingsPage = Json<
  paths["/api/operations/published-assignment-repairs/findings"]["get"]["responses"]["200"]
>;
export type PublishedAssignmentRepairFinding =
  PublishedAssignmentRepairFindingsPage["items"][number];
export type PublishedAssignmentRepairTimeScope = PublishedAssignmentRepairFinding["timeScope"];
export type PublishedAssignmentRepairConflict = components["schemas"]["ConflictDto"];
export type PublishedAssignmentRepairOperation =
  components["schemas"]["PublishedAssignmentRepairOperationDto"];
export type PublishedAssignmentRepairAction = PublishedAssignmentRepairOperation["action"];
export type PublishedAssignmentRepairPlan = Json<
  paths["/api/operations/published-assignment-repairs/plans"]["post"]["responses"]["200"]
>;
export type PublishedAssignmentRepairPlanItem = PublishedAssignmentRepairPlan["items"][number];
export type BuildPublishedAssignmentRepairPlanRequest =
  components["schemas"]["PublishedAssignmentRepairPlanDto"];
export type ApplyPublishedAssignmentRepairRequest =
  components["schemas"]["PublishedAssignmentRepairApplyDto"];
export type PublishedAssignmentRepairResult = Json<
  paths["/api/operations/published-assignment-repairs/apply"]["post"]["responses"]["200"]
>;

const OPERATION_STATES = new Set<OperationState>([
  "READY",
  "PROPOSED",
  "UNASSIGNED",
  "EXCEPTION",
  "COMPLETED",
  "CANCELLED",
]);

const ASSIGNMENT_STATUSES = new Set<AssignmentStatus>([
  "DRAFT",
  "PROPOSED",
  "PUBLISHED",
  "ACKNOWLEDGED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
  "SUPERSEDED",
]);

const OPERATION_WARNING_CODES = new Set<OperationWarningCode>([
  "CREW_SIZE_DEFAULTED",
  "DAY_RULE_DERIVED",
  "DAY_RULE_UNCONFIRMED",
  "DURATION_DEFAULTED",
  "HOURS_UNCONFIRMED",
  "SITE_BRANCH_UNCONFIRMED",
  "VEHICLE_BRANCH_UNCONFIRMED",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseAssignment(value: unknown): OperationsAssignment | null {
  if (typeof value !== "object" || value === null) return null;
  const record = asRecord(value);
  const id = asString(record.id);
  const status = asString(record.status);
  if (!id || !ASSIGNMENT_STATUSES.has(status as AssignmentStatus)) return null;
  const crew = Array.isArray(record.crew)
    ? record.crew.filter((member) => typeof member === "object" && member !== null).map((member) => {
        const row = asRecord(member);
        return {
          id: typeof row.id === "string" ? row.id : undefined,
          employeeId: typeof row.employeeId === "string" ? row.employeeId : undefined,
          fullName: typeof row.fullName === "string" ? row.fullName : undefined,
          role: typeof row.role === "string" ? row.role : undefined,
          isPmsSupervisor: typeof row.isPmsSupervisor === "boolean" ? row.isPmsSupervisor : undefined,
        };
      })
    : [];
  const vehicles = Array.isArray(record.vehicles)
    ? record.vehicles.filter((vehicle) => typeof vehicle === "object" && vehicle !== null).map((vehicle) => {
        const row = asRecord(vehicle);
        return {
          id: typeof row.id === "string" ? row.id : undefined,
          vehicleId: typeof row.vehicleId === "string" ? row.vehicleId : undefined,
          label: typeof row.label === "string" ? row.label : undefined,
          driverName: typeof row.driverName === "string" ? row.driverName : undefined,
          driverEmployeeId: typeof row.driverEmployeeId === "string" ? row.driverEmployeeId : undefined,
        };
      })
    : [];
  return {
    id,
    status: status as AssignmentStatus,
    crew,
    vehicles,
    plannedStartMinute: asNullableNumber(record.plannedStartMinute),
    plannedEndMinute: asNullableNumber(record.plannedEndMinute),
  };
}

function parseOperationsItem(value: unknown): OperationsDayItem | null {
  if (typeof value !== "object" || value === null) return null;
  const record = asRecord(value);
  const visitRecord = asRecord(record.visit);
  const stateValue = asString(record.state);
  const hasKnownState = OPERATION_STATES.has(stateValue as OperationState);
  const state = hasKnownState
    ? (stateValue as OperationState)
    : "UNASSIGNED";
  const violations = Array.isArray(record.violations)
    ? record.violations.filter((violation) => typeof violation === "object" && violation !== null).map((violation) => {
        const row = asRecord(violation);
        return {
          code: asString(row.code, "UNKNOWN_VIOLATION"),
          message: asString(row.message, "This visit needs review."),
          remediation: typeof row.remediation === "string" ? row.remediation : undefined,
        };
      })
    : [];
  const version = asRecord(record.scheduleVersion);
  const hasVersion = Object.keys(version).length > 0;
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.flatMap((warning) => {
        if (typeof warning !== "object" || warning === null) return [];
        const warningRecord = asRecord(warning);
        const code = asString(warningRecord.code);
        const message = asString(warningRecord.message);
        return OPERATION_WARNING_CODES.has(code as OperationWarningCode) && message
          ? [{ code: code as OperationWarningCode, message }]
          : [];
      })
    : [];
  return {
    visit: {
      id: asString(visitRecord.id),
      visitDate: asString(visitRecord.visitDate),
      customerName: asString(visitRecord.customerName, "Unknown customer"),
      siteName: asString(visitRecord.siteName, "Unknown site"),
      jobTypeName: asString(visitRecord.jobTypeName, "Visit"),
      requiredCrewSize: asNullableNumber(visitRecord.requiredCrewSize),
      durationMinutes: asNullableNumber(visitRecord.durationMinutes),
      windowStartMinute: asNullableNumber(visitRecord.windowStartMinute),
      windowEndMinute: asNullableNumber(visitRecord.windowEndMinute),
      hoursUnconfirmed: asBoolean(visitRecord.hoursUnconfirmed),
      branchCode: ["COLOMBO", "KANDY"].includes(asString(visitRecord.branchCode))
        ? (visitRecord.branchCode as BranchCode)
        : "",
    },
    state,
    // An unknown state cannot safely be treated as dispatch truth, even when
    // an older server happened to include an assignment-shaped object.
    dispatchAssignment:
      state === "READY" || state === "EXCEPTION" || state === "COMPLETED" || state === "CANCELLED"
        ? parseAssignment(record.dispatchAssignment)
        : null,
    proposedAssignment: parseAssignment(record.proposedAssignment),
    violations,
    nextAction: asString(record.nextAction, state === "READY" ? "No action needed" : "Review visit"),
    scheduleVersion: hasVersion
      ? {
          id: typeof version.id === "string" ? version.id : null,
          version: typeof version.version === "number" ? version.version : null,
          status: ASSIGNMENT_STATUSES.has(asString(version.status) as AssignmentStatus)
            ? (version.status as AssignmentStatus)
            : "",
          predecessorId: typeof version.predecessorId === "string" ? version.predecessorId : null,
          publishedAt: typeof version.publishedAt === "string" ? version.publishedAt : null,
        }
      : null,
    warnings: warnings.filter(
      (warning, index) => warnings.findIndex(
        (candidate) => candidate.code === warning.code && candidate.message === warning.message,
      ) === index,
    ),
  };
}

export function parseOperationsDay(payload: unknown): OperationsDayResponse {
  const record = asRecord(payload);
  const summary = asRecord(record.summary);
  const items = Array.isArray(record.items)
    ? record.items.map(parseOperationsItem).filter((item): item is OperationsDayItem => item !== null)
    : [];
  return {
    date: asString(record.date),
    branchCode: ["COLOMBO", "KANDY"].includes(asString(record.branchCode))
      ? (record.branchCode as BranchCode)
      : null,
    summary: {
      total: asNumber(summary.total),
      ready: asNumber(summary.ready),
      proposed: asNumber(summary.proposed),
      unassigned: asNumber(summary.unassigned),
      exceptions: asNumber(summary.exceptions),
      hoursUnconfirmed: asNumber(summary.hoursUnconfirmed),
    },
    items,
  };
}

export function isDispatchableOperation(item: OperationsDayItem): boolean {
  return item.state === "READY"
    && item.dispatchAssignment !== null
    && ["PUBLISHED", "ACKNOWLEDGED", "IN_PROGRESS", "COMPLETED"].includes(
      item.dispatchAssignment.status,
    )
    && item.violations.length === 0;
}

/**
 * Hand-typed request body — `AssignCrewDto` at
 * `apps/api/src/scheduling/eligibility/dto.ts`. Used for both the dry-run
 * check and the real assign; `reason` is optional server-side but the UI
 * requires it whenever this represents a manual override (ULK-O06).
 */
export interface AssignCrewRequest {
  plannedStartMinute: number;
  plannedEndMinute: number;
  crew: Array<{ employeeId: string; role?: CrewRole }>;
  vehicles?: Array<{ vehicleId: string; driverEmployeeId?: string }>;
  reason?: string;
}

/* -------------------------------------------------------------------------
 * Schedule runs, locks and publishing (ULK-C06)
 * ---------------------------------------------------------------------- */

export type ScheduleRun = components["schemas"]["ScheduleRunDto"];
export type ScheduleRunStatus = ScheduleRun["status"];
export type PaginatedScheduleRuns = components["schemas"]["PaginatedScheduleRunsDto"];

export type LockScope = "FULL" | "CREW" | "SUPERVISOR" | "VEHICLE" | "TIME";

/**
 * Hand-typed: same recurring gap (`apps/api/nest-cli.json` has no NestJS
 * Swagger CLI `plugins` entry, so handlers without an explicit `@ApiBody`
 * publish no request-body schema) plus one more here — `lock`/`unlock` in
 * `apps/api/src/scheduling/optimizer/schedule-runs.controller.ts` return the
 * `AssignmentLock` row directly but carry no `@ApiResponse({ type: ... })`,
 * so the response body types as `never` too. Matches
 * `apps/api/prisma/schema.prisma`'s `AssignmentLock` model.
 */
export interface AssignmentLock {
  id: string;
  assignmentId: string;
  scope: LockScope;
  lockedByUserId: string | null;
  reason: string | null;
  releasedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LockAssignmentRequest {
  scope: LockScope;
  reason?: string;
}

/** `StartScheduleRunDto` — same request-body gap as above. */
export interface StartScheduleRunRequest {
  from: string;
  to: string;
  branchCode?: "COLOMBO" | "KANDY";
  timeLimitSeconds?: number;
}

/** `ScheduleRunQueryDto` — the query gap, same pattern as `UnassignedVisitsQuery`. */
export interface ScheduleRunQuery {
  page?: number;
  pageSize?: number;
  status?: ScheduleRunStatus;
  ids?: string[];
}

/** `PublishScheduleDto` — same request-body gap. */
export interface PublishScheduleRequest {
  reason?: string;
  acknowledgePartial?: boolean;
}
/**
 * Hand-typed: the published contract has no `path`/`query` types for
 * `/api/unassigned-visits` (same gap as elsewhere — see the note above
 * `CreateCustomerRequest`), but the controller
 * (`apps/api/src/scheduling/eligibility/assignments.controller.ts`) does
 * accept these.
 */
export interface UnassignedVisitsQuery {
  page?: number;
  pageSize?: number;
  branchCode?: "COLOMBO" | "KANDY";
  from?: string;
  to?: string;
  status?: "UNASSIGNED" | "EXCEPTION";
  conflictCode?: string;
}

export type CustomerQuery = NonNullable<paths["/api/customers"]["get"]["parameters"]["query"]>;
export type ServiceAgreementQuery = NonNullable<
  paths["/api/service-agreements"]["get"]["parameters"]["query"]
>;

/**
 * The API's Swagger setup doesn't run the NestJS CLI plugin
 * (`apps/api/nest-cli.json` has no `plugins` entry) and none of the
 * customer/site/agreement `create`/`update` handlers carry an explicit
 * `@ApiBody(...)`, so the published OpenAPI document has no request-body
 * schema for these endpoints — `paths[...]["post"]["requestBody"]` types as
 * `never`. Flagged to Chanya (either enables the CLI plugin, or adds
 * `@ApiBody({ type: CreateCustomerDto })` etc.) so these can come from the
 * generated contract like every response type already does. Until then,
 * these interfaces are hand-written to match
 * `apps/api/src/catalog/dto/customer.dto.ts` and `agreement.dto.ts` exactly.
 */
export interface CreateCustomerRequest {
  name: string;
  customerCode?: string | null;
  branchCode: "COLOMBO" | "KANDY";
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
}

export interface SiteOperatingHoursInput {
  weekday: components["schemas"]["SiteOperatingHoursResponseDto"]["weekday"];
  opensAtMinute: number;
  closesAtMinute: number;
}

export interface CreateServiceSiteRequest {
  name: string;
  addressLine?: string | null;
  city?: string | null;
  branchCode?: "COLOMBO" | "KANDY";
  operatingHours?: SiteOperatingHoursInput[];
}

export interface CreateServiceAgreementRequest {
  serviceSiteId: string;
  jobTypeId: string;
  frequencyCount: number;
  frequencyUnit: "WEEK" | "MONTH";
  crewSize?: number;
  durationMinutes?: number;
  allowedDays: SiteOperatingHoursInput["weekday"][];
  preferredDays?: SiteOperatingHoursInput["weekday"][];
  serviceWindowStartMinute?: number | null;
  serviceWindowEndMinute?: number | null;
  startDate: string;
  endDate?: string | null;
  requiredSkillCodes?: string[];
  notes?: string | null;
}

/**
 * Request bodies for the visit endpoints. Hand-written for the same reason as
 * the customer/agreement ones above — the API publishes no request-body schema
 * without the NestJS Swagger CLI plugin. Matches
 * `apps/api/src/scheduling/visits/dto.ts`.
 */
export interface AdjustVisitRequest {
  visitDate?: string;
  windowStartMinute?: number;
  windowEndMinute?: number;
  durationMinutes?: number;
  requiredCrewSize?: number;
  reason?: string;
}

export interface LockVisitRequest {
  reason?: string;
}

export interface GenerateVisitsRequest {
  from: string;
  to: string;
  branchCode?: "COLOMBO" | "KANDY";
  serviceAgreementIds?: string[];
}

export interface ChangeAgreementStatusRequest {
  status: AgreementStatus;
  reason?: string | null;
}

/**
 * Every error response from the API carries this envelope
 * (`apps/api/src/common/errors` — `AllExceptionsFilter`). Branch on `code`,
 * never on `message`: messages are written for managers and will be reworded.
 */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  path?: string;
  timestamp?: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiError";
    this.code = body.code;
    this.details = body.details;
  }
}

/** Codes that mean "this session is over", whatever the endpoint. */
const SESSION_ENDED_CODES = new Set([
  "AUTHENTICATION_REQUIRED",
  "INVALID_TOKEN",
  "ACCOUNT_INACTIVE",
]);

function buildQuery(params?: Record<string, unknown>): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** Skip the Authorization header. Only sign-in needs this. */
  anonymous?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, anonymous = false } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";

  if (!anonymous) {
    const token = readToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError({
      code: "NETWORK_UNAVAILABLE",
      message: `Could not reach the API at ${API_BASE_URL}. Confirm it is running and NEXT_PUBLIC_API_BASE_URL is correct.`,
    });
  }

  if (response.status === 204) return undefined as T;

  if (!response.ok) {
    const parsed = (await response.json().catch(() => null)) as ApiErrorBody | null;

    // A dead session is dropped here rather than in every caller, so a stale
    // token cannot sit in storage making each screen fail on its own.
    if (parsed && SESSION_ENDED_CODES.has(parsed.code)) clearToken();

    if (parsed && typeof parsed.code === "string") throw new ApiError(parsed);
    throw new ApiError({
      code: "UNKNOWN_ERROR",
      message: `Request to ${path} failed with status ${response.status}.`,
    });
  }

  // A 200 with a genuinely empty body (as opposed to 204, already handled
  // above) still needs to resolve to "nothing" rather than throw — Response
  // .json() rejects on empty input, and that raw parse error isn't an
  // ApiError, so it would otherwise surface to the user as an unexplained
  // "Something went wrong" instead of the empty result the endpoint meant.
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/* -------------------------------------------------------------------------
 * Endpoints
 * ---------------------------------------------------------------------- */

/** Signs in. The only call made without a token. */
export function login(email: string, password: string): Promise<LoginResponse> {
  return request<LoginResponse>("/auth/login", {
    method: "POST",
    body: { email, password },
    anonymous: true,
  });
}

/** Confirms a stored token still works, and says who it belongs to. */
export function fetchCurrentUser(): Promise<CurrentUser> {
  return request<CurrentUser>("/auth/me");
}

/** Shared vocabulary (branch codes, PMS grade labels, error codes). Public. */
export function fetchMeta(): Promise<MetaResponse> {
  return request<MetaResponse>("/meta", { anonymous: true });
}

/** Database / queue / scheduler readiness. Public. */
export function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/health/ready", { anonymous: true });
}

export function fetchEmployees(query?: EmployeeQuery): Promise<PaginatedEmployees> {
  return request<PaginatedEmployees>(`/employees${buildQuery(query)}`);
}

export function fetchEmployee(id: string): Promise<Employee> {
  return request<Employee>(`/employees/${id}`);
}

export function fetchVehicles(query?: VehicleQuery): Promise<PaginatedVehicles> {
  return request<PaginatedVehicles>(`/vehicles${buildQuery(query)}`);
}

export function fetchVehicle(id: string): Promise<Vehicle> {
  return request<Vehicle>(`/vehicles/${id}`);
}

/**
 * Everyone authorised to drive this vehicle, straight from the workforce
 * matrix checkmarks. Says nothing about ownership or a usual driver.
 */
export function fetchAuthorizedDrivers(vehicleId: string): Promise<AuthorizedDrivers> {
  return request<AuthorizedDrivers>(`/vehicles/${vehicleId}/authorized-drivers`);
}

/** Authorises one employee to drive one vehicle. Returns the updated employee. */
export function authorizeVehicle(employeeId: string, vehicleId: string): Promise<Employee> {
  return request<Employee>(`/employees/${employeeId}/vehicle-authorizations/${vehicleId}`, {
    method: "POST",
  });
}

/** Withdraws one driving authorization. */
export function revokeVehicleAuthorization(employeeId: string, vehicleId: string): Promise<void> {
  return request<void>(`/employees/${employeeId}/vehicle-authorizations/${vehicleId}`, {
    method: "DELETE",
  });
}

export function fetchBranches(): Promise<BranchListItem[]> {
  return request<BranchListItem[]>("/branches");
}

export function fetchSkills(): Promise<SkillListItem[]> {
  return request<SkillListItem[]>("/skills");
}

export function fetchCustomers(query?: CustomerQuery): Promise<PaginatedCustomers> {
  return request<PaginatedCustomers>(`/customers${buildQuery(query)}`);
}

export function createCustomer(dto: CreateCustomerRequest): Promise<Customer> {
  return request<Customer>("/customers", { method: "POST", body: dto });
}

export function createServiceSite(
  customerId: string,
  dto: CreateServiceSiteRequest,
): Promise<ServiceSite> {
  return request<ServiceSite>(`/customers/${customerId}/sites`, {
    method: "POST",
    body: dto,
  });
}

export function fetchJobTypes(): Promise<JobType[]> {
  return request<JobType[]>("/job-types");
}

export function fetchServiceAgreements(
  query?: ServiceAgreementQuery,
): Promise<PaginatedServiceAgreements> {
  return request<PaginatedServiceAgreements>(`/service-agreements${buildQuery(query)}`);
}

export function createServiceAgreement(
  dto: CreateServiceAgreementRequest,
): Promise<ServiceAgreement> {
  return request<ServiceAgreement>("/service-agreements", {
    method: "POST",
    body: dto,
  });
}

export function changeAgreementStatus(
  agreementId: string,
  dto: ChangeAgreementStatusRequest,
): Promise<ServiceAgreement> {
  return request<ServiceAgreement>(`/service-agreements/${agreementId}/status`, {
    method: "POST",
    body: dto,
  });
}

/**
 * Not a schedule — it assigns nobody and books nothing. Only callable once
 * an agreement exists (it's `GET /service-agreements/{id}/schedule-preview`),
 * so a manager sees this right after creating the agreement, not before —
 * there's no dry-run endpoint. See the Service Agreements page for how that
 * shapes the create flow.
 */
export function fetchSchedulePreview(
  agreementId: string,
  options?: { from?: string; horizonWeeks?: number },
): Promise<SchedulePreview> {
  return request<SchedulePreview>(
    `/service-agreements/${agreementId}/schedule-preview${buildQuery(options)}`,
  );
}

/* -------------------------------------------------------------------------
 * Visits — the generated calendar (ULK-C04)
 * ---------------------------------------------------------------------- */

export function fetchVisits(query?: VisitQuery): Promise<PaginatedVisits> {
  return request<PaginatedVisits>(`/visits${buildQuery(query)}`);
}

/**
 * One visit plus its `origin` — the agreement, the version it was generated
 * from and the allowed days as they stood at that moment. That snapshot is
 * why a visit can still be explained after its agreement has moved on.
 */
export function fetchVisit(id: string): Promise<VisitDetail> {
  return request<VisitDetail>(`/visits/${id}`);
}

/**
 * A manager's hand edit. The API marks the visit manually adjusted, which is
 * what stops the next generation run from putting it back.
 */
export function adjustVisit(id: string, dto: AdjustVisitRequest): Promise<Visit> {
  return request<Visit>(`/visits/${id}`, { method: "PATCH", body: dto });
}

/** Pins a visit so regeneration cannot move it. Admin only. */
export function lockVisit(id: string, dto: LockVisitRequest = {}): Promise<Visit> {
  return request<Visit>(`/visits/${id}/lock`, { method: "POST", body: dto });
}

/** Hands a pinned visit back to generation. Admin only. */
export function unlockVisit(id: string): Promise<Visit> {
  return request<Visit>(`/visits/${id}/unlock`, { method: "POST", body: {} });
}

/**
 * What generating this horizon *would* change. Writes nothing — `isPreview`
 * comes back true and `scheduleRunId` is null. Any signed-in user may call it.
 */
export function previewVisitGeneration(dto: GenerateVisitsRequest): Promise<GenerationImpact> {
  return request<GenerationImpact>("/visit-generation/preview", {
    method: "POST",
    body: dto,
  });
}

/** Applies exactly what preview described, and records a schedule run. Admin only. */
export function confirmVisitGeneration(dto: GenerateVisitsRequest): Promise<GenerationImpact> {
  return request<GenerationImpact>("/visit-generation/confirm", {
    method: "POST",
    body: dto,
  });
}

/* -------------------------------------------------------------------------
 * Assignments and the Unassigned queue (ULK-C05)
 * ---------------------------------------------------------------------- */

/**
 * The crew and vehicles on a visit, or `null` if nobody is assigned yet.
 * Hand-typed as nullable: the published contract claims this always returns
 * an `AssignmentDto`, but the handler
 * (`apps/api/src/scheduling/eligibility/assignments.service.ts#get`) returns
 * `null` with a 200 when there's no live assignment — a real visit's normal
 * state right after generation. Flagged as a contract gap in the PR.
 */
export function fetchVisitAssignment(visitId: string): Promise<Assignment | null> {
  // A visit with no assignment yet gets a 204, which the generic `request`
  // helper resolves to `undefined` — not `null`. Callers compare against
  // `null` (e.g. the crew editor's `assignment !== null` publication-history
  // check), and `undefined !== null` is true in JS, so an unnormalised
  // `undefined` slips past that guard and crashes the next property read.
  return request<Assignment | null>(`/visits/${visitId}/assignment`).then(
    (result) => result ?? null
  );
}

/**
 * Work the eligibility engine refused, and every reason why — never only the
 * first. This is the queue the hard rules protect: nothing is silently
 * dropped, it lands here with an explanation a manager can act on.
 */
export function fetchUnassignedVisits(
  query?: UnassignedVisitsQuery,
): Promise<PaginatedUnassignedVisits> {
  return request<PaginatedUnassignedVisits>(
    `/unassigned-visits${buildQuery(query as Record<string, unknown> | undefined)}`,
  );
}

/**
 * Would this crew be allowed on the visit? Writes nothing. Returns every
 * conflict, not just the first, so a manual replacement can be validated
 * before it's saved.
 */
export function checkAssignment(
  visitId: string,
  dto: AssignCrewRequest,
): Promise<EligibilityResult> {
  return request<EligibilityResult>(`/visits/${visitId}/assignment/check`, {
    method: "POST",
    body: dto,
  });
}

/**
 * Sets the crew and vehicles on a visit — replaces any existing live
 * assignment, which is how a supervisor/crew/vehicle "replacement" is done.
 * Refused (409 ASSIGNMENT_NOT_ELIGIBLE) if any hard rule fails; refused
 * (409 RESOURCE_CONFLICT) if the current assignment is already published.
 */
export function assignCrew(visitId: string, dto: AssignCrewRequest): Promise<Assignment> {
  return request<Assignment>(`/visits/${visitId}/assignment`, {
    method: "PUT",
    body: dto,
  });
}

/** Takes the crew off a visit. Refused while published or locked. */
export function unassignVisit(visitId: string): Promise<void> {
  return request<void>(`/visits/${visitId}/assignment`, { method: "DELETE" });
}

/**
 * Pins part of an assignment (`FULL`, `CREW`, `SUPERVISOR`, `VEHICLE` or
 * `TIME`) so the next schedule run keeps it exactly as it is.
 *
 * Known gap: nothing in the published contract or the response of this call
 * lets a client later ask "which scopes are locked on assignment X" — the
 * only read signal is `Assignment.isLocked`, a single boolean covering any
 * scope. Flagged in the PR; the fix is for `AssignmentDto` to include the
 * live `locks: AssignmentLock[]` for an assignment.
 */
export function lockAssignment(
  assignmentId: string,
  dto: LockAssignmentRequest,
): Promise<AssignmentLock> {
  return request<AssignmentLock>(`/assignments/${assignmentId}/lock`, {
    method: "POST",
    body: dto,
  });
}

export function unlockAssignment(assignmentId: string, scope: LockScope): Promise<AssignmentLock> {
  return request<AssignmentLock>(`/assignments/${assignmentId}/unlock`, {
    method: "POST",
    body: { scope },
  });
}

/**
 * Queues a solve over a date range. Returns immediately with a run to poll —
 * `GET /schedule-runs/:id` — rather than holding the request open.
 */
export function startScheduleRun(dto: StartScheduleRunRequest): Promise<ScheduleRun> {
  return request<ScheduleRun>("/schedule-runs", { method: "POST", body: dto });
}

export function fetchScheduleRuns(query?: ScheduleRunQuery): Promise<PaginatedScheduleRuns> {
  return request<PaginatedScheduleRuns>(
    `/schedule-runs${buildQuery(query as Record<string, unknown> | undefined)}`,
  );
}

/** Poll this while a run is queued or running — `progressPercent` moves as it goes. */
export function fetchScheduleRun(id: string): Promise<ScheduleRun> {
  return request<ScheduleRun>(`/schedule-runs/${id}`);
}

/** Asks a queued or running solve to stop. A run that already finished is left as it is. */
export function cancelScheduleRun(id: string): Promise<ScheduleRun> {
  return request<ScheduleRun>(`/schedule-runs/${id}/cancel`, {
    method: "POST",
    body: {},
  });
}

/**
 * Freezes a finished run: its draft assignments become the published
 * schedule. Anything published earlier for the same visits is superseded,
 * never deleted or edited.
 */
export function publishScheduleRun(
  id: string,
  dto: PublishScheduleRequest = {},
): Promise<ScheduleRun> {
  return request<ScheduleRun>(`/schedule-runs/${id}/publish`, {
    method: "POST",
    body: dto,
  });
}

/* -------------------------------------------------------------------------
 * The unified calendar (ULK-C07) — date, time, crew and vehicle joined
 * server-side into one row per visit, for the manager portal's single
 * calendar screen.
 * ---------------------------------------------------------------------- */

export function fetchCalendar(query: CalendarQuery): Promise<CalendarResponse> {
  return request<CalendarResponse>(
    `/schedule/calendar${buildQuery(query as Record<string, unknown>)}`,
  );
}

/**
 * Authoritative manager read model for one operating day. The response is
 * parsed here rather than in each page so every view agrees that a proposal
 * or an invalid assignment is not dispatch truth.
 */
export function fetchOperationsDay(query: OperationsDayQuery): Promise<OperationsDayResponse> {
  return request<unknown>(`/operations/day${buildQuery(query as unknown as Record<string, unknown>)}`).then(
    parseOperationsDay,
  );
}

/** Lists invalid published assignments. This call is read-only. */
export function fetchPublishedAssignmentRepairFindings(
  query: { page?: number; pageSize?: number } = {},
): Promise<PublishedAssignmentRepairFindingsPage> {
  return request<PublishedAssignmentRepairFindingsPage>(
    `/operations/published-assignment-repairs/findings${buildQuery(query)}`,
  );
}

/** Asks the solver for an exact, zero-write repair manifest. */
export function buildPublishedAssignmentRepairPlan(
  dto: BuildPublishedAssignmentRepairPlanRequest,
): Promise<PublishedAssignmentRepairPlan> {
  return request<PublishedAssignmentRepairPlan>(
    "/operations/published-assignment-repairs/plans",
    { method: "POST", body: dto },
  );
}

/** Applies the exact reviewed manifest. The API revalidates every safety gate. */
export function applyPublishedAssignmentRepair(
  dto: ApplyPublishedAssignmentRepairRequest,
): Promise<PublishedAssignmentRepairResult> {
  return request<PublishedAssignmentRepairResult>(
    "/operations/published-assignment-repairs/apply",
    { method: "POST", body: dto },
  );
}

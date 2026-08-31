import type { components, paths } from "@ultrakil/api-contracts";

import { clearToken, readToken } from "./session-token";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001/api";

/* -------------------------------------------------------------------------
 * Types, all taken from the generated contract. Nothing here is hand-written:
 * if the backend changes a field, this file stops compiling, which is the
 * whole point of publishing the contract.
 * ---------------------------------------------------------------------- */

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;

export type MetaResponse = Json<
  paths["/api/meta"]["get"]["responses"]["200"]
>;
export type HealthResponse = Json<
  paths["/api/health/ready"]["get"]["responses"]["200"]
>;
export type LoginResponse = Json<
  paths["/api/auth/login"]["post"]["responses"]["200"]
>;
export type CurrentUser = Json<
  paths["/api/auth/me"]["get"]["responses"]["200"]
>;
export type PaginatedEmployees = Json<
  paths["/api/employees"]["get"]["responses"]["200"]
>;
export type Employee = PaginatedEmployees["items"][number];
export type PaginatedVehicles = Json<
  paths["/api/vehicles"]["get"]["responses"]["200"]
>;
export type Vehicle = PaginatedVehicles["items"][number];
export type AuthorizedDrivers = Json<
  paths["/api/vehicles/{id}/authorized-drivers"]["get"]["responses"]["200"]
>;
export type BranchListItem = Json<
  paths["/api/branches"]["get"]["responses"]["200"]
>[number];
export type SkillListItem = Json<
  paths["/api/skills"]["get"]["responses"]["200"]
>[number];

export type EmployeeQuery = NonNullable<
  paths["/api/employees"]["get"]["parameters"]["query"]
>;
export type VehicleQuery = NonNullable<
  paths["/api/vehicles"]["get"]["parameters"]["query"]
>;

export type PaginatedCustomers = Json<
  paths["/api/customers"]["get"]["responses"]["200"]
>;
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

export type PaginatedVisits = Json<
  paths["/api/visits"]["get"]["responses"]["200"]
>;
export type Visit = PaginatedVisits["items"][number];
export type VisitDetail = Json<
  paths["/api/visits/{id}"]["get"]["responses"]["200"]
>;
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

export type VisitQuery = NonNullable<
  paths["/api/visits"]["get"]["parameters"]["query"]
>;

export type CustomerQuery = NonNullable<
  paths["/api/customers"]["get"]["parameters"]["query"]
>;
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

  return response.json() as Promise<T>;
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

/**
 * Everyone authorised to drive this vehicle, straight from the workforce
 * matrix checkmarks. Says nothing about ownership or a usual driver.
 */
export function fetchAuthorizedDrivers(vehicleId: string): Promise<AuthorizedDrivers> {
  return request<AuthorizedDrivers>(`/vehicles/${vehicleId}/authorized-drivers`);
}

/** Authorises one employee to drive one vehicle. Returns the updated employee. */
export function authorizeVehicle(
  employeeId: string,
  vehicleId: string
): Promise<Employee> {
  return request<Employee>(
    `/employees/${employeeId}/vehicle-authorizations/${vehicleId}`,
    { method: "POST" }
  );
}

/** Withdraws one driving authorization. */
export function revokeVehicleAuthorization(
  employeeId: string,
  vehicleId: string
): Promise<void> {
  return request<void>(
    `/employees/${employeeId}/vehicle-authorizations/${vehicleId}`,
    { method: "DELETE" }
  );
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
  dto: CreateServiceSiteRequest
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
  query?: ServiceAgreementQuery
): Promise<PaginatedServiceAgreements> {
  return request<PaginatedServiceAgreements>(`/service-agreements${buildQuery(query)}`);
}

export function createServiceAgreement(
  dto: CreateServiceAgreementRequest
): Promise<ServiceAgreement> {
  return request<ServiceAgreement>("/service-agreements", { method: "POST", body: dto });
}

export function changeAgreementStatus(
  agreementId: string,
  dto: ChangeAgreementStatusRequest
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
  options?: { from?: string; horizonWeeks?: number }
): Promise<SchedulePreview> {
  return request<SchedulePreview>(
    `/service-agreements/${agreementId}/schedule-preview${buildQuery(options)}`
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
export function previewVisitGeneration(
  dto: GenerateVisitsRequest
): Promise<GenerationImpact> {
  return request<GenerationImpact>("/visit-generation/preview", {
    method: "POST",
    body: dto,
  });
}

/** Applies exactly what preview described, and records a schedule run. Admin only. */
export function confirmVisitGeneration(
  dto: GenerateVisitsRequest
): Promise<GenerationImpact> {
  return request<GenerationImpact>("/visit-generation/confirm", {
    method: "POST",
    body: dto,
  });
}

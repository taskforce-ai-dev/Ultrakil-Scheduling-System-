import type { paths } from "@ultrakil/api-contracts";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001/api";

export type MetaResponse =
  paths["/api/meta"]["get"]["responses"]["200"]["content"]["application/json"];

export type HealthResponse =
  paths["/api/health/ready"]["get"]["responses"]["200"]["content"]["application/json"];

/**
 * Every error response from Chanya's API carries this envelope
 * (`apps/api/src/common/errors` — `AllExceptionsFilter`). Not published by
 * the generated contract yet (only health/meta are), so mirrored here from
 * the documented shape in `packages/api-contracts/README.md`'s "Error
 * handling" section. Branch on `code`, never on `message`.
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

async function getJson<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`);
  } catch {
    throw new ApiError({
      code: "NETWORK_UNAVAILABLE",
      message: `Could not reach the API at ${API_BASE_URL}. Confirm it is running and NEXT_PUBLIC_API_BASE_URL is correct.`,
    });
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    if (body && typeof body.code === "string") {
      throw new ApiError(body);
    }
    throw new ApiError({
      code: "UNKNOWN_ERROR",
      message: `Request to ${path} failed with status ${response.status}.`,
    });
  }

  return response.json() as Promise<T>;
}

/** Shared vocabulary (branch codes, PMS grade labels, error codes, ...). Never hard-code these in the UI — this is why /api/meta exists. */
export function fetchMeta(): Promise<MetaResponse> {
  return getJson<MetaResponse>("/meta");
}

/** Database / queue / scheduler readiness. Not wired into any screen yet — kept here to prove the generated client works end to end against a real endpoint. */
export function fetchHealth(): Promise<HealthResponse> {
  return getJson<HealthResponse>("/health/ready");
}

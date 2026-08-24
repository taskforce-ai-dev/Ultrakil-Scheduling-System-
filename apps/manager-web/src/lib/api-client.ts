import type { paths } from "@ultrakil/api-contracts";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001/api";

export type MetaResponse =
  paths["/api/meta"]["get"]["responses"]["200"]["content"]["application/json"];

export type HealthResponse =
  paths["/api/health/ready"]["get"]["responses"]["200"]["content"]["application/json"];

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`);
  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}`);
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

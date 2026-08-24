/**
 * UltraKIL shared API contract.
 *
 * Everything here is generated from the API's OpenAPI document. Do not edit
 * `src/generated/` by hand and do not hand-write request or response types in
 * the manager portal — a hand-written copy compiles fine and then breaks in
 * production the day the backend adds a required field.
 *
 * Regenerate after any endpoint change:
 *
 *     pnpm contracts:generate
 *
 * Usage:
 *
 *     import type { components, paths } from '@ultrakil/api-contracts';
 *
 *     type Health = components['schemas']['HealthResponseDto'];
 *     type ReadyResponse =
 *       paths['/api/health/ready']['get']['responses']['200']['content']['application/json'];
 */
export type { components, operations, paths, webhooks } from './generated/api';

/** Version of the contract, matching the API's reported `apiVersion`. */
export const CONTRACT_VERSION = '0.1.0';

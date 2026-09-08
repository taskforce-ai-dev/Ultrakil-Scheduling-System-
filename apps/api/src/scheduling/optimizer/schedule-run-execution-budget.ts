/**
 * Shared timing contract for a QStash/Vercel delivery. The same values drive
 * boot validation, QStash range admission, and the service's solver timeout,
 * so no accepted run can consume the response or persistence budget by drift.
 */
export const VERCEL_FUNCTION_COMPATIBILITY_CAP_SECONDS = 60;
export const QSTASH_RESPONSE_RESERVE_SECONDS = 5;
export const QSTASH_MAX_EXECUTION_SECONDS =
  VERCEL_FUNCTION_COMPATIBILITY_CAP_SECONDS - QSTASH_RESPONSE_RESERVE_SECONDS;

export const SCHEDULE_EXECUTION_PREPARATION_RESERVE_SECONDS = 5;
export const SCHEDULE_SOLVER_TRANSPORT_RESERVE_SECONDS = 10;
export const SCHEDULE_EXECUTION_PERSISTENCE_RESERVE_SECONDS = 30;
export const SCHEDULE_EXECUTION_LEASE_SAFETY_SECONDS = 1;
export const SCHEDULE_MINIMUM_SOLVER_SECONDS_PER_DAY = 1;
export const QSTASH_MINIMUM_EXECUTION_SECONDS =
  SCHEDULE_EXECUTION_PREPARATION_RESERVE_SECONDS +
  SCHEDULE_SOLVER_TRANSPORT_RESERVE_SECONDS +
  SCHEDULE_EXECUTION_PERSISTENCE_RESERVE_SECONDS +
  SCHEDULE_EXECUTION_LEASE_SAFETY_SECONDS +
  SCHEDULE_MINIMUM_SOLVER_SECONDS_PER_DAY;

export function qstashMaximumRangeDays(executionBudgetSeconds: number): number {
  return Math.max(
    0,
    Math.floor(
      (executionBudgetSeconds -
        SCHEDULE_EXECUTION_PREPARATION_RESERVE_SECONDS -
        SCHEDULE_SOLVER_TRANSPORT_RESERVE_SECONDS -
        SCHEDULE_EXECUTION_PERSISTENCE_RESERVE_SECONDS -
        SCHEDULE_EXECUTION_LEASE_SAFETY_SECONDS) /
        SCHEDULE_MINIMUM_SOLVER_SECONDS_PER_DAY,
    ),
  );
}

// Self-hosted BullMQ has no Vercel function ceiling. Six hours safely covers
// the DTO's 62-day range at its 300-seconds-per-day maximum plus fixed
// preparation, transport, persistence, and lease reserves.
export const SELF_HOSTED_EXECUTION_BUDGET_SECONDS = 6 * 60 * 60;

// BullMQ can run long self-hosted solves, but its durable database lease must
// remain short enough that a process crash is reclaimed before retries exhaust.
// The worker renews this fenced lease while it is healthy.
export const BULLMQ_EXECUTION_LEASE_SECONDS = 60;
export const BULLMQ_LEASE_HEARTBEAT_MILLISECONDS = 20_000;
export const BULLMQ_RETRY_BACKOFF_MILLISECONDS = 75_000;

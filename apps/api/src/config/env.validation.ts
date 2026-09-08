import { z } from 'zod';
import {
  QSTASH_MAX_EXECUTION_SECONDS,
  QSTASH_MINIMUM_EXECUTION_SECONDS,
} from '../scheduling/optimizer/schedule-run-execution-budget';

const port = (fallback: number) =>
  z.coerce.number().int().min(1).max(65535).default(fallback);

const optionalSecret = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(32).optional(),
);

const apiGlobalPrefix = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)*$/,
    'must be non-empty path segments without leading or trailing slashes',
  )
  .default('api');

function isPureHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.pathname === '/' || url.pathname === '') &&
      url.search === '' &&
      url.hash === '' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

/**
 * Environment contract for the API. Validated once at boot so a misconfigured
 * deployment fails immediately and loudly instead of at first request.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  /** Set automatically by Vercel; used for public-backend-only checks. */
  VERCEL: z.string().optional(),
  TZ: z.string().default('Asia/Colombo'),

  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required (see .env.example)'),

  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: port(6379),
  REDIS_PASSWORD: z.string().optional(),
  BULLMQ_PREFIX: z.string().default('ultrakil'),

  /** BullMQ remains the self-hosted default; QStash is the serverless path. */
  SCHEDULE_DISPATCHER: z.enum(['bullmq', 'qstash']).default('bullmq'),
  /**
   * A QStash execution stays below the checked-in 60-second compatibility
   * ceiling, leaving time for persistence and a deterministic response.
   */
  SCHEDULE_EXECUTION_BUDGET_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(55),
  // These placeholders are deliberately valid when BullMQ is selected: a
  // copied .env.example commonly leaves them blank. QStash mode checks the
  // complete, non-blank set below.
  API_PUBLIC_URL: z.string().optional(),
  QSTASH_TOKEN: z.string().optional(),
  QSTASH_CURRENT_SIGNING_KEY: z.string().optional(),
  QSTASH_NEXT_SIGNING_KEY: z.string().optional(),

  API_PORT: port(3001),
  API_GLOBAL_PREFIX: apiGlobalPrefix,
  API_CORS_ORIGINS: z.string().default('http://localhost:3000'),

  SCHEDULER_BASE_URL: z.string().url().default('http://localhost:8000'),
  SCHEDULER_HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  SCHEDULER_API_TOKEN: optionalSecret,

  /**
   * Hard ceiling on every health probe. A readiness check must always answer:
   * a dependency that is merely slow, or a client library that retries forever,
   * must surface as "down" rather than hanging the endpoint.
   */
  HEALTH_PROBE_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),

  /**
   * Signing secret for portal access tokens.
   *
   * Required in production and deliberately given no default — a shipped
   * default secret means anyone who has read the source can mint a valid admin
   * token. In development it may be omitted, in which case the API generates a
   * random secret at boot and says so; tokens then stop working on restart,
   * which is a fair trade for not having to configure anything to run locally.
   */
  JWT_SECRET: optionalSecret,
  JWT_EXPIRES_IN: z.string().default('12h'),

  /** Seeds the first admin account. Only used when no user exists yet. */
  SEED_ADMIN_EMAIL: z.string().email().default('admin@taskforceai.tech'),
  SEED_ADMIN_PASSWORD: z.string().min(8).default('ultrakil-change-me'),
  SEED_ADMIN_NAME: z.string().default('UltraKIL Administrator'),

  TECHNICIAN_MATRIX_PATH: z.string().default('./data/technician-matrix.xlsx'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);

  if (parsed.success && parsed.data.NODE_ENV === 'production') {
    if (!parsed.data.JWT_SECRET) {
      throw new Error(
        'Invalid environment configuration:\n  - JWT_SECRET: required in production (at least 32 characters)',
      );
    }
    if (parsed.data.SEED_ADMIN_PASSWORD === 'ultrakil-change-me') {
      throw new Error(
        'Invalid environment configuration:\n  - SEED_ADMIN_PASSWORD: the default password must not be used in production',
      );
    }
  }

  if (
    parsed.success &&
    parsed.data.VERCEL === '1' &&
    parsed.data.SCHEDULE_DISPATCHER !== 'qstash'
  ) {
    throw new Error(
      'Invalid environment configuration:\n  - SCHEDULE_DISPATCHER: Vercel deployments require qstash',
    );
  }

  if (
    parsed.success &&
    (parsed.data.VERCEL === '1' ||
      parsed.data.SCHEDULE_DISPATCHER === 'qstash')
  ) {
    if (!parsed.data.SCHEDULER_API_TOKEN) {
      throw new Error(
        'Invalid environment configuration:\n  - SCHEDULER_API_TOKEN: required for public serverless deployment (at least 32 characters)',
      );
    }
    if (!isPureHttpsOrigin(parsed.data.SCHEDULER_BASE_URL)) {
      throw new Error(
        'Invalid environment configuration:\n  - SCHEDULER_BASE_URL: public scheduler URL must be a pure HTTPS origin',
      );
    }
    const corsOrigins = parsed.data.API_CORS_ORIGINS.split(',').map((origin) =>
      origin.trim(),
    );
    if (
      corsOrigins.length === 0 ||
      corsOrigins.some((origin) => !isPureHttpsOrigin(origin))
    ) {
      throw new Error(
        'Invalid environment configuration:\n  - API_CORS_ORIGINS: public origins must be explicit pure HTTPS origins',
      );
    }
  }

  if (parsed.success && parsed.data.SCHEDULE_DISPATCHER === 'qstash') {
    const missing = [
      'QSTASH_TOKEN',
      'QSTASH_CURRENT_SIGNING_KEY',
      'QSTASH_NEXT_SIGNING_KEY',
      'API_PUBLIC_URL',
    ].filter((key) => {
      const value = parsed.data[key as keyof Env];
      return typeof value !== 'string' || value.trim().length === 0;
    });
    if (missing.length > 0) {
      throw new Error(
        `Invalid environment configuration:\n${missing
          .map((key) => `  - ${key}: required when SCHEDULE_DISPATCHER=qstash`)
          .join('\n')}`,
      );
    }
    if (
      parsed.data.SCHEDULE_EXECUTION_BUDGET_SECONDS <
        QSTASH_MINIMUM_EXECUTION_SECONDS ||
      parsed.data.SCHEDULE_EXECUTION_BUDGET_SECONDS >
        QSTASH_MAX_EXECUTION_SECONDS
    ) {
      throw new Error(
        `Invalid environment configuration:\n  - SCHEDULE_EXECUTION_BUDGET_SECONDS: must be between ${QSTASH_MINIMUM_EXECUTION_SECONDS} and ${QSTASH_MAX_EXECUTION_SECONDS} when SCHEDULE_DISPATCHER=qstash`,
      );
    }
    if (!isPureHttpsOrigin(parsed.data.API_PUBLIC_URL ?? '')) {
      throw new Error(
        'Invalid environment configuration:\n  - API_PUBLIC_URL: must be a pure https origin when SCHEDULE_DISPATCHER=qstash',
      );
    }
  }

  if (!parsed.success) {
    const details = parsed.error.issues
      .map(
        (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      )
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return parsed.data;
}

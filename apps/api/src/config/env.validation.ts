import { z } from 'zod';

const port = (fallback: number) =>
  z.coerce.number().int().min(1).max(65535).default(fallback);

/**
 * Environment contract for the API. Validated once at boot so a misconfigured
 * deployment fails immediately and loudly instead of at first request.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  TZ: z.string().default('Asia/Colombo'),

  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required (see .env.example)'),

  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: port(6379),
  REDIS_PASSWORD: z.string().optional(),
  BULLMQ_PREFIX: z.string().default('ultrakil'),

  API_PORT: port(3001),
  API_GLOBAL_PREFIX: z.string().default('api'),
  API_CORS_ORIGINS: z.string().default('http://localhost:3000'),

  SCHEDULER_BASE_URL: z.string().url().default('http://localhost:8000'),
  SCHEDULER_HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),

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
  JWT_SECRET: z.string().min(32).optional(),
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

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return parsed.data;
}

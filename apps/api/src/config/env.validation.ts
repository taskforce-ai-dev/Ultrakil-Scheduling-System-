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

  TECHNICIAN_MATRIX_PATH: z.string().default('./data/technician-matrix.xlsx'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return parsed.data;
}

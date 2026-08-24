import { registerAs } from '@nestjs/config';
import { Env } from './env.validation';

export const appConfig = registerAs('app', () => {
  const env = process.env as unknown as Env;
  return {
    nodeEnv: env.NODE_ENV,
    port: Number(env.API_PORT),
    globalPrefix: env.API_GLOBAL_PREFIX,
    healthProbeTimeoutMs: Number(env.HEALTH_PROBE_TIMEOUT_MS),
    corsOrigins: String(env.API_CORS_ORIGINS)
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
});

export const redisConfig = registerAs('redis', () => {
  const env = process.env as unknown as Env;
  return {
    host: env.REDIS_HOST,
    port: Number(env.REDIS_PORT),
    password: env.REDIS_PASSWORD || undefined,
    prefix: env.BULLMQ_PREFIX,
  };
});

export const schedulerConfig = registerAs('scheduler', () => {
  const env = process.env as unknown as Env;
  return {
    baseUrl: env.SCHEDULER_BASE_URL,
    healthTimeoutMs: Number(env.SCHEDULER_HEALTH_TIMEOUT_MS),
  };
});

export const importConfig = registerAs('import', () => {
  const env = process.env as unknown as Env;
  return {
    technicianMatrixPath: env.TECHNICIAN_MATRIX_PATH,
  };
});

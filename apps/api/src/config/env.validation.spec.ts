import { scheduleDispatchConfig } from './configuration';
import { validateEnv } from './env.validation';

const baseProductionEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:password@postgres:5432/ultrakil',
  JWT_SECRET: 'j'.repeat(32),
  SEED_ADMIN_PASSWORD: 'a'.repeat(24),
  API_CORS_ORIGINS: 'http://web:3000',
  SCHEDULER_BASE_URL: 'http://scheduler:8000',
};

const baseVercelEnv = {
  ...baseProductionEnv,
  VERCEL: '1',
  SCHEDULE_DISPATCHER: 'qstash',
  API_PUBLIC_URL: 'https://api.vercel.app',
  API_CORS_ORIGINS: 'https://manager.vercel.app',
  SCHEDULER_BASE_URL: 'https://scheduler.vercel.app',
  SCHEDULER_API_TOKEN: 's'.repeat(32),
  QSTASH_TOKEN: 'token',
  QSTASH_CURRENT_SIGNING_KEY: 'current',
  QSTASH_NEXT_SIGNING_KEY: 'next',
};

describe('Vercel-specific production environment validation', () => {
  it('treats blank optional local secrets as unset', () => {
    expect(() =>
      validateEnv({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://user:password@localhost:5432/ultrakil',
        JWT_SECRET: '',
        SCHEDULER_API_TOKEN: '',
      }),
    ).not.toThrow();
  });

  it('keeps the preserved Docker production topology valid', () => {
    expect(() => validateEnv(baseProductionEnv)).not.toThrow();
  });

  it.each([
    ['missing token', { SCHEDULER_API_TOKEN: undefined }],
    ['short token', { SCHEDULER_API_TOKEN: 'too-short' }],
  ])('rejects %s for a Vercel deployment', (_name, override) => {
    expect(() =>
      validateEnv({
        ...baseVercelEnv,
        ...override,
      }),
    ).toThrow('SCHEDULER_API_TOKEN');
  });

  it.each([
    'http://scheduler.internal',
    'https://scheduler.vercel.app/solve',
  ])('rejects a non-origin scheduler URL on Vercel: %s', (SCHEDULER_BASE_URL) => {
    expect(() =>
      validateEnv({ ...baseVercelEnv, SCHEDULER_BASE_URL }),
    ).toThrow('SCHEDULER_BASE_URL');
  });

  it.each(['*', 'http://manager.vercel.app', 'https://manager.vercel.app/app'])(
    'rejects insecure CORS origin %s on Vercel',
    (origin) => {
      expect(() =>
        validateEnv({
          ...baseVercelEnv,
          API_CORS_ORIGINS: origin,
        }),
      ).toThrow('API_CORS_ORIGINS');
    },
  );

  it('rejects the non-durable BullMQ provider on Vercel', () => {
    expect(() =>
      validateEnv({
        ...baseVercelEnv,
        SCHEDULE_DISPATCHER: 'bullmq',
      }),
    ).toThrow('SCHEDULE_DISPATCHER');
  });
});

const baseEnv = {
  DATABASE_URL: 'postgresql://user:password@localhost:5432/ultrakil',
  API_CORS_ORIGINS: 'https://manager.example.com',
  SCHEDULER_BASE_URL: 'https://scheduler.example.com',
  SCHEDULER_API_TOKEN: 's'.repeat(32),
};

describe('schedule dispatcher environment validation', () => {
  it('requires the complete QStash credential set when qstash dispatching is selected', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        SCHEDULE_DISPATCHER: 'qstash',
      }),
    ).toThrow('QSTASH_TOKEN');
  });

  it('requires scheduler authentication in QStash mode without relying on Vercel metadata', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        SCHEDULER_API_TOKEN: undefined,
        SCHEDULE_DISPATCHER: 'qstash',
        QSTASH_TOKEN: 'token',
        QSTASH_CURRENT_SIGNING_KEY: 'current',
        QSTASH_NEXT_SIGNING_KEY: 'next',
        API_PUBLIC_URL: 'https://ultrakil.example.com',
      }),
    ).toThrow('SCHEDULER_API_TOKEN');
  });

  it('does not require Redis settings when qstash dispatching is selected', () => {
    expect(
      validateEnv({
        ...baseEnv,
        SCHEDULE_DISPATCHER: 'qstash',
        QSTASH_TOKEN: 'token',
        QSTASH_CURRENT_SIGNING_KEY: 'current',
        QSTASH_NEXT_SIGNING_KEY: 'next',
        API_PUBLIC_URL: 'https://ultrakil.example.com',
      }),
    ).toMatchObject({
      SCHEDULE_DISPATCHER: 'qstash',
      SCHEDULE_EXECUTION_BUDGET_SECONDS: 55,
    });
  });

  it.each([
    'https://ultrakil.example.com/api',
    'https://ultrakil.example.com/?preview=1',
    'https://user@ultrakil.example.com',
  ])('requires API_PUBLIC_URL to be a pure HTTPS origin: %s', (API_PUBLIC_URL) => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        SCHEDULE_DISPATCHER: 'qstash',
        QSTASH_TOKEN: 'token',
        QSTASH_CURRENT_SIGNING_KEY: 'current',
        QSTASH_NEXT_SIGNING_KEY: 'next',
        API_PUBLIC_URL,
      }),
    ).toThrow('API_PUBLIC_URL');
  });

  it('allows blank QStash placeholders when the default BullMQ provider is selected', () => {
    expect(
      validateEnv({
        ...baseEnv,
        QSTASH_TOKEN: '',
        QSTASH_CURRENT_SIGNING_KEY: '',
        QSTASH_NEXT_SIGNING_KEY: '',
        API_PUBLIC_URL: '',
        SCHEDULE_EXECUTION_BUDGET_SECONDS: '21600',
      }),
    ).toMatchObject({
      SCHEDULE_DISPATCHER: 'bullmq',
      SCHEDULE_EXECUTION_BUDGET_SECONDS: 21600,
    });
  });

  it('allows a blank cron secret and requires a strong value when configured', () => {
    expect(validateEnv({ ...baseEnv, CRON_SECRET: '' })).toMatchObject({
      CRON_SECRET: undefined,
    });
    expect(() =>
      validateEnv({ ...baseEnv, CRON_SECRET: 'too-short' }),
    ).toThrow('CRON_SECRET');
    expect(
      validateEnv({
        ...baseEnv,
        CRON_SECRET: 'a-secure-cron-secret-that-is-32-chars',
      }),
    ).toMatchObject({ CRON_SECRET: 'a-secure-cron-secret-that-is-32-chars' });
  });

  it('allows a QStash budget below the 60-second compatibility ceiling', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        SCHEDULE_DISPATCHER: 'qstash',
        SCHEDULE_EXECUTION_BUDGET_SECONDS: '51',
        QSTASH_TOKEN: 'token',
        QSTASH_CURRENT_SIGNING_KEY: 'current',
        QSTASH_NEXT_SIGNING_KEY: 'next',
        API_PUBLIC_URL: 'https://ultrakil.example.com',
      }),
    ).not.toThrow();
  });

  it('reserves enough execution budget to persist a solver result safely', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        SCHEDULE_DISPATCHER: 'qstash',
        SCHEDULE_EXECUTION_BUDGET_SECONDS: '46',
        QSTASH_TOKEN: 'token',
        QSTASH_CURRENT_SIGNING_KEY: 'current',
        QSTASH_NEXT_SIGNING_KEY: 'next',
        API_PUBLIC_URL: 'https://ultrakil.example.com',
      }),
    ).toThrow('SCHEDULE_EXECUTION_BUDGET_SECONDS');
  });

  it('rejects a QStash budget that exceeds the five-second response reserve', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        SCHEDULE_DISPATCHER: 'qstash',
        SCHEDULE_EXECUTION_BUDGET_SECONDS: '56',
        QSTASH_TOKEN: 'token',
        QSTASH_CURRENT_SIGNING_KEY: 'current',
        QSTASH_NEXT_SIGNING_KEY: 'next',
        API_PUBLIC_URL: 'https://ultrakil.example.com',
      }),
    ).toThrow('SCHEDULE_EXECUTION_BUDGET_SECONDS');
  });

  it('derives signed QStash callback destinations from the configured public API URL', () => {
    const original = { ...process.env };
    process.env.API_PUBLIC_URL = 'https://ultrakil.example.com/';
    process.env.API_GLOBAL_PREFIX = 'api';
    try {
      expect(scheduleDispatchConfig()).toMatchObject({
        executeUrl:
          'https://ultrakil.example.com/api/internal/schedule-runs/execute',
        failureUrl:
          'https://ultrakil.example.com/api/internal/schedule-runs/failure',
      });
    } finally {
      process.env = original;
    }
  });

  it.each(['', '/api', 'api/', 'api//internal'])(
    'rejects an unsafe API_GLOBAL_PREFIX of %p',
    (API_GLOBAL_PREFIX) => {
      expect(() =>
        validateEnv({ ...baseEnv, API_GLOBAL_PREFIX }),
      ).toThrow('API_GLOBAL_PREFIX');
    },
  );
});

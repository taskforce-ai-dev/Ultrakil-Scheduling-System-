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
        ...baseProductionEnv,
        VERCEL: '1',
        API_CORS_ORIGINS: 'https://manager.vercel.app',
        SCHEDULER_BASE_URL: 'https://scheduler.vercel.app',
        ...override,
      }),
    ).toThrow('SCHEDULER_API_TOKEN');
  });

  it('rejects a non-HTTPS scheduler URL on Vercel', () => {
    expect(() =>
      validateEnv({
        ...baseProductionEnv,
        VERCEL: '1',
        SCHEDULER_API_TOKEN: 's'.repeat(32),
        API_CORS_ORIGINS: 'https://manager.vercel.app',
      }),
    ).toThrow('SCHEDULER_BASE_URL');
  });

  it.each(['*', 'http://manager.vercel.app'])(
    'rejects insecure CORS origin %s on Vercel',
    (origin) => {
      expect(() =>
        validateEnv({
          ...baseProductionEnv,
          VERCEL: '1',
          SCHEDULER_API_TOKEN: 's'.repeat(32),
          SCHEDULER_BASE_URL: 'https://scheduler.vercel.app',
          API_CORS_ORIGINS: origin,
        }),
      ).toThrow('API_CORS_ORIGINS');
    },
  );
});

const baseEnv = {
  DATABASE_URL: 'postgresql://user:password@localhost:5432/ultrakil',
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
    ).toMatchObject({ SCHEDULE_DISPATCHER: 'qstash' });
  });

  it('allows blank QStash placeholders when the default BullMQ provider is selected', () => {
    expect(
      validateEnv({
        ...baseEnv,
        QSTASH_TOKEN: '',
        QSTASH_CURRENT_SIGNING_KEY: '',
        QSTASH_NEXT_SIGNING_KEY: '',
        API_PUBLIC_URL: '',
      }),
    ).toMatchObject({ SCHEDULE_DISPATCHER: 'bullmq' });
  });

  it('rejects an execution budget that could reach Vercel Hobby’s 300 second ceiling', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        SCHEDULE_EXECUTION_BUDGET_SECONDS: '300',
      }),
    ).toThrow('SCHEDULE_EXECUTION_BUDGET_SECONDS');
  });

  it('reserves enough execution budget to persist a solver result safely', () => {
    expect(() =>
      validateEnv({
        ...baseEnv,
        SCHEDULE_EXECUTION_BUDGET_SECONDS: '30',
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
});

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

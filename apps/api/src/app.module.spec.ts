import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { buildOpenApiDocument } from './openapi';

describe('AppModule bootstrap contract', () => {
  let app: INestApplication | undefined;
  const environment = {
    DATABASE_URL: 'postgresql://unit:unit@localhost:5432/ultrakil_unit',
    SCHEDULE_DISPATCHER: 'qstash',
    API_PUBLIC_URL: 'https://api.ultrakil.example.com',
    API_CORS_ORIGINS: 'https://ultrakil.example.com',
    SCHEDULER_BASE_URL: 'https://scheduler.ultrakil.example.com',
    SCHEDULER_API_TOKEN: 'unit-scheduler-token-with-32-characters',
    QSTASH_TOKEN: 'unit-qstash-token',
    QSTASH_CURRENT_SIGNING_KEY: 'unit-current-signing-key',
    QSTASH_NEXT_SIGNING_KEY: 'unit-next-signing-key',
  };
  const originals = new Map(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );

  beforeAll(() => {
    Object.assign(process.env, environment);
  });

  afterAll(() => {
    for (const [key, value] of originals) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('compiles the real provider graph used by OpenAPI generation', async () => {
    const { AppModule } = await import('./app.module');
    app = await NestFactory.create(AppModule, {
      abortOnError: false,
      logger: false,
      preview: true,
    });
    app.setGlobalPrefix(process.env.API_GLOBAL_PREFIX ?? 'api');

    const document = buildOpenApiDocument(app);

    expect(Object.keys(document.paths ?? {}).length).toBeGreaterThan(0);
    expect(
      Object.keys(document.paths ?? {}).some((path) =>
        path.includes('/internal/schedule-runs/'),
      ),
    ).toBe(false);
  });
});

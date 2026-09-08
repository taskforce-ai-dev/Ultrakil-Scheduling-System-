/**
 * The Vercel entrypoint.
 *
 * `src/main.ts` starts a long-running listener, which cannot be a serverless
 * function — Vercel refused the deployment outright:
 *
 *     The pattern "src/main.ts" defined in `functions` doesn't match any
 *     Serverless Functions inside the `api` directory.
 *
 * Vercel only treats files under `api/` as functions for a project with no
 * framework preset, so this file is both the right shape and the right place.
 * `src/main.ts` stays exactly as it is: it remains how the API runs locally and
 * in the Docker staging stack, and the two must not drift, so everything the
 * request path depends on is applied here in the same order.
 *
 * The Nest application is built once per warm instance and reused. Building it
 * per request would open a fresh database pool every time and exhaust the
 * connection limit long before traffic did.
 */
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import express, { type Express } from 'express';

import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { buildOpenApiDocument } from '../src/openapi';

const server: Express = express();

/**
 * Kept as the promise rather than a boolean.
 *
 * Two requests can arrive at a cold instance before the first has finished
 * booting; awaiting the same promise makes the second wait for that boot
 * instead of starting a competing one.
 */
let ready: Promise<void> | null = null;

async function bootstrap(): Promise<void> {
  // Mirrors src/main.ts, minus listen(). rawBody is what lets QStash verify its
  // signature over the original bytes.
  const app = await NestFactory.create(AppModule, new ExpressAdapter(server), {
    bufferLogs: false,
    rawBody: true,
  });

  const config = app.get(ConfigService);
  const globalPrefix = config.getOrThrow<string>('app.globalPrefix');
  const corsOrigins = config.getOrThrow<string[]>('app.corsOrigins');

  app.setGlobalPrefix(globalPrefix);
  app.enableCors({ origin: corsOrigins, credentials: true });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  SwaggerModule.setup(`${globalPrefix}/docs`, app, buildOpenApiDocument(app), {
    swaggerOptions: { persistAuthorization: true },
  });

  // No enableShutdownHooks(): the platform freezes and thaws the instance
  // rather than signalling it, so the hooks would never fire and Nest would
  // hold process listeners that leak across invocations.
  await app.init();
}

export default async function handler(
  request: express.Request,
  response: express.Response,
): Promise<void> {
  ready ??= bootstrap();
  await ready;
  server(request, response);
}

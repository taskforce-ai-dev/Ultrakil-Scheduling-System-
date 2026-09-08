import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { buildOpenApiDocument } from './openapi';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  // QStash signs the original bytes. Nest keeps them on the request while
  // retaining normal JSON parsing for every existing API endpoint.
  const app = await NestFactory.create(AppModule, {
    bufferLogs: false,
    rawBody: true,
  });

  const config = app.get(ConfigService);
  // The platform picks the port when it hosts the process; API_PORT is ours.
  // Vercel's Nest runtime injects PORT and connects to whatever binds it, so
  // ignoring it would leave the function listening where nothing is listening
  // for it. Locally and in Docker PORT is unset and API_PORT wins as before.
  const port = Number(process.env.PORT ?? config.getOrThrow<number>('app.port'));
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
  app.enableShutdownHooks();

  SwaggerModule.setup(`${globalPrefix}/docs`, app, buildOpenApiDocument(app), {
    swaggerOptions: { persistAuthorization: true },
  });

  await app.listen(port, '0.0.0.0');

  logger.log(`API listening on http://localhost:${port}/${globalPrefix}`);
  logger.log(`API docs on http://localhost:${port}/${globalPrefix}/docs`);
  logger.log(`Health on http://localhost:${port}/${globalPrefix}/health/ready`);
}

void bootstrap();

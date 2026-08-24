import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { buildOpenApiDocument } from './openapi';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  const config = app.get(ConfigService);
  const port = config.getOrThrow<number>('app.port');
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

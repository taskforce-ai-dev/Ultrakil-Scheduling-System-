import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import {
  appConfig,
  authConfig,
  importConfig,
  redisConfig,
  schedulerConfig,
} from './config/configuration';
import { validateEnv } from './config/env.validation';
import { HealthModule } from './health/health.module';
import { MetaModule } from './meta/meta.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { CatalogModule } from './catalog/catalog.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { WorkforceModule } from './workforce/workforce.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      load: [appConfig, redisConfig, schedulerConfig, importConfig, authConfig],
      envFilePath: ['.env', '../../.env'],
    }),
    PrismaModule,
    QueueModule,
    AuditModule,
    AuthModule,
    HealthModule,
    MetaModule,
    WorkforceModule,
    CatalogModule,
    SchedulingModule,
  ],
})
export class AppModule {}

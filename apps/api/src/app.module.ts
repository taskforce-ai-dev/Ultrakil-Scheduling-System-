import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  appConfig,
  importConfig,
  redisConfig,
  schedulerConfig,
} from './config/configuration';
import { validateEnv } from './config/env.validation';
import { HealthModule } from './health/health.module';
import { MetaModule } from './meta/meta.module';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      load: [appConfig, redisConfig, schedulerConfig, importConfig],
      envFilePath: ['.env', '../../.env'],
    }),
    PrismaModule,
    QueueModule,
    HealthModule,
    MetaModule,
  ],
})
export class AppModule {}

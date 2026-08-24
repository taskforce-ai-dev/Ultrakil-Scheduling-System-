import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ALL_QUEUES } from './queue.constants';
import { QueueHealthService } from './queue-health.service';

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.getOrThrow<string>('redis.host'),
          port: config.getOrThrow<number>('redis.port'),
          password: config.get<string>('redis.password'),
          // Fail fast instead of retrying forever, so health checks report
          // "unavailable" rather than hanging.
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
        },
        prefix: config.getOrThrow<string>('redis.prefix'),
      }),
    }),
    ...ALL_QUEUES.map((name) => BullModule.registerQueue({ name })),
  ],
  providers: [QueueHealthService],
  exports: [BullModule, QueueHealthService],
})
export class QueueModule {}

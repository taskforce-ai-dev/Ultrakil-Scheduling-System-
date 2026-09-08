import { BullModule } from '@nestjs/bullmq';
import { DynamicModule, Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ALL_QUEUES } from './queue.constants';
import {
  BullQueueHealthService,
  QStashQueueHealthService,
  QueueHealthService,
} from './queue-health.service';

@Global()
@Module({})
export class QueueModule {
  static register(): DynamicModule {
    if (process.env.SCHEDULE_DISPATCHER === 'qstash') {
      return {
        module: QueueModule,
        providers: [
          QStashQueueHealthService,
          {
            provide: QueueHealthService,
            useExisting: QStashQueueHealthService,
          },
        ],
        exports: [QueueHealthService],
      };
    }

    return {
      module: QueueModule,
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
      providers: [
        BullQueueHealthService,
        { provide: QueueHealthService, useExisting: BullQueueHealthService },
      ],
      exports: [BullModule, QueueHealthService],
    };
  }
}

import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import {
  QSTASH_CLIENT,
  QStashScheduleRunDispatcher,
} from './schedule-run.dispatcher';
import {
  QSTASH_RECEIVER,
  ScheduleRunQStashController,
} from './schedule-run.qstash.controller';
import { ScheduleRunService } from './schedule-run.service';

describe('QStash Nest DI wiring', () => {
  it('compiles the QStash dispatcher and signed controller without an Object provider', async () => {
    const config = {
      getOrThrow: jest.fn((key: string) => {
        const values: Record<string, string | number> = {
          'scheduleDispatch.qstash.token': 'test-token',
          'scheduleDispatch.executeUrl':
            'https://ultrakil.example.com/api/internal/schedule-runs/execute',
          'scheduleDispatch.failureUrl':
            'https://ultrakil.example.com/api/internal/schedule-runs/failure',
          'scheduleDispatch.executionBudgetSeconds': 55,
        };
        return values[key];
      }),
    };
    const client = {
      publishJSON: jest.fn(),
      messages: { cancel: jest.fn() },
    };
    const receiver = { verify: jest.fn() };

    const module = await Test.createTestingModule({
      controllers: [ScheduleRunQStashController],
      providers: [
        QStashScheduleRunDispatcher,
        { provide: ConfigService, useValue: config },
        { provide: ScheduleRunService, useValue: {} },
        { provide: QSTASH_CLIENT, useValue: client },
        { provide: QSTASH_RECEIVER, useValue: receiver },
      ],
    }).compile();

    expect(module.get(QStashScheduleRunDispatcher)).toBeInstanceOf(
      QStashScheduleRunDispatcher,
    );
    expect(module.get(ScheduleRunQStashController)).toBeInstanceOf(
      ScheduleRunQStashController,
    );
  });
});

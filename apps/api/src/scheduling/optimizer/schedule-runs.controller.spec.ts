import { BranchCode, UserRole } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { ScheduleRunDispatcher } from './schedule-run.dispatcher';
import { ScheduleRunService } from './schedule-run.service';
import { ScheduleRunDispatchService } from './schedule-run-dispatch.service';
import { ScheduleRunsController } from './schedule-runs.controller';
import { PublishingService } from './publishing.service';

describe('ScheduleRunsController QStash bounds', () => {
  it('rejects a QStash range that cannot fit the configured per-day solver budget before creating a run', async () => {
    const runs = { create: jest.fn() };
    const dispatcher = {
      provider: 'qstash',
      maxRangeDays: 9,
      enqueue: jest.fn(),
      cancel: jest.fn(),
    };
    const controller = new ScheduleRunsController(
      runs as unknown as ScheduleRunService,
      dispatcher as ScheduleRunDispatcher,
      {} as PublishingService,
      {} as PrismaService,
      {} as ScheduleRunDispatchService,
    );

    await expect(
      controller.start(
        {
          from: '2027-03-01',
          to: '2027-03-10',
          branchCode: BranchCode.COLOMBO,
        },
        {
          id: 'actor',
          role: UserRole.ADMIN,
          email: 'actor@example.test',
          fullName: 'Actor',
        },
      ),
    ).rejects.toMatchObject({ code: 'SCHEDULE_EXECUTION_BUDGET_EXCEEDED' });
    expect(runs.create).not.toHaveBeenCalled();
  });
});

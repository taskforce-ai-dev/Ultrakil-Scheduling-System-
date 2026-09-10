import { ScheduleRunProcessor } from './optimizer/schedule-run.processor';
import { QStashScheduleRunDispatcher } from './optimizer/schedule-run.dispatcher';
import { PublishedAssignmentRepairController } from './repair/published-assignment-repair.controller';
import { PublishedAssignmentRepairService } from './repair/published-assignment-repair.service';
import { SchedulingModule } from './scheduling.module';

describe('SchedulingModule QStash mode', () => {
  it('registers the QStash dispatcher without a BullMQ worker', () => {
    const previous = process.env.SCHEDULE_DISPATCHER;
    process.env.SCHEDULE_DISPATCHER = 'qstash';
    try {
      const module = SchedulingModule.register();

      expect(module.providers).toEqual(
        expect.arrayContaining([QStashScheduleRunDispatcher]),
      );
      expect(module.providers).not.toEqual(
        expect.arrayContaining([ScheduleRunProcessor]),
      );
    } finally {
      if (previous === undefined) delete process.env.SCHEDULE_DISPATCHER;
      else process.env.SCHEDULE_DISPATCHER = previous;
    }
  });

  it('registers the published-assignment repair API and service', () => {
    const module = SchedulingModule.register();

    expect(module.controllers).toEqual(
      expect.arrayContaining([PublishedAssignmentRepairController]),
    );
    expect(module.providers).toEqual(
      expect.arrayContaining([PublishedAssignmentRepairService]),
    );
  });
});

import { QueueModule } from './queue.module';
import {
  QStashQueueHealthService,
  QueueHealthService,
} from './queue-health.service';

describe('QueueModule QStash mode', () => {
  it('does not register BullMQ or Redis providers when QStash is selected', () => {
    const previous = process.env.SCHEDULE_DISPATCHER;
    process.env.SCHEDULE_DISPATCHER = 'qstash';
    try {
      const module = QueueModule.register();

      expect(module.imports).toBeUndefined();
      expect(module.providers).toEqual(
        expect.arrayContaining([
          QStashQueueHealthService,
          expect.objectContaining({ provide: QueueHealthService }),
        ]),
      );
    } finally {
      if (previous === undefined) delete process.env.SCHEDULE_DISPATCHER;
      else process.env.SCHEDULE_DISPATCHER = previous;
    }
  });
});

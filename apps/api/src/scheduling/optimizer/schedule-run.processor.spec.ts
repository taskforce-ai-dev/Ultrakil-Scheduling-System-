import { Job } from 'bullmq';

import {
  ScheduleRunJobData,
  ScheduleRunProcessor,
} from './schedule-run.processor';
import { ScheduleRunService } from './schedule-run.service';

const runId = 'e53c9feb-f68f-4c6f-8ba5-31939e3a5000';

function job(attemptsMade: number) {
  return {
    data: { runId },
    opts: { attempts: 3 },
    attemptsMade,
    updateProgress: jest.fn(),
  } as unknown as Job<ScheduleRunJobData>;
}

describe('ScheduleRunProcessor BullMQ retry ownership', () => {
  it('releases the first failed lease so BullMQ can retry and a later attempt can succeed', async () => {
    const runs = {
      deliver: jest
        .fn()
        .mockRejectedValueOnce(new Error('temporary solver failure'))
        .mockResolvedValueOnce({
          kind: 'completed',
          scheduled: 2,
          unassigned: 0,
        }),
    };
    const processor = new ScheduleRunProcessor(
      runs as unknown as ScheduleRunService,
    );

    await expect(processor.process(job(0))).rejects.toThrow(
      'temporary solver failure',
    );
    await expect(processor.process(job(1))).resolves.toBeUndefined();

    expect(runs.deliver).toHaveBeenNthCalledWith(
      1,
      runId,
      expect.objectContaining({ retryOnFailure: true }),
    );
    expect(runs.deliver).toHaveBeenNthCalledWith(
      2,
      runId,
      expect.objectContaining({ retryOnFailure: true }),
    );
  });

  it('marks only BullMQ’s final delivery attempt as terminal', async () => {
    const runs = {
      deliver: jest.fn().mockRejectedValue(new Error('final solver failure')),
    };
    const processor = new ScheduleRunProcessor(
      runs as unknown as ScheduleRunService,
    );

    await expect(processor.process(job(2))).rejects.toThrow(
      'final solver failure',
    );

    expect(runs.deliver).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({ retryOnFailure: false }),
    );
  });
});

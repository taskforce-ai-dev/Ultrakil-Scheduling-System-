import { Job, Queue } from 'bullmq';

import {
  ScheduleRunJobData,
  ScheduleRunProcessor,
  ScheduleRunQueue,
} from './schedule-run.processor';
import {
  BULLMQ_EXECUTION_LEASE_SECONDS,
  BULLMQ_RETRY_BACKOFF_MILLISECONDS,
} from './schedule-run-execution-budget';
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
      expect.objectContaining({
        retryOnFailure: true,
        executionLeaseSeconds: BULLMQ_EXECUTION_LEASE_SECONDS,
        renewExecutionLease: true,
      }),
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

  it('treats a legacy job fixture without retry options as a final delivery', async () => {
    const runs = {
      deliver: jest.fn(async () => ({
        kind: 'completed',
        scheduled: 1,
        unassigned: 0,
      })),
    };
    const processor = new ScheduleRunProcessor(
      runs as unknown as ScheduleRunService,
    );
    const legacyJob = {
      data: { runId },
      attemptsMade: 0,
      updateProgress: jest.fn(),
    } as unknown as Job<ScheduleRunJobData>;

    await expect(processor.process(legacyJob)).resolves.toBeUndefined();

    expect(runs.deliver).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({ retryOnFailure: false }),
    );
  });

  it('delays BullMQ retries past the crashed owner lease instead of exhausting them while busy', async () => {
    const queue = { add: jest.fn(async () => ({ id: runId })) };
    const dispatcher = new ScheduleRunQueue(queue as unknown as Queue);

    await dispatcher.enqueue({ runId });

    expect(queue.add).toHaveBeenCalledWith(
      'solve',
      { runId },
      expect.objectContaining({
        attempts: 3,
        backoff: {
          type: 'fixed',
          delay: BULLMQ_RETRY_BACKOFF_MILLISECONDS,
        },
      }),
    );
    expect(BULLMQ_RETRY_BACKOFF_MILLISECONDS).toBeGreaterThan(
      BULLMQ_EXECUTION_LEASE_SECONDS * 1_000,
    );
  });
});

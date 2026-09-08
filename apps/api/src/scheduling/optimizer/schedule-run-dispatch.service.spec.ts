import { ScheduleRunStatus } from '@prisma/client';

import { ScheduleRunDispatcher } from './schedule-run.dispatcher';
import { ScheduleRunDispatchService } from './schedule-run-dispatch.service';

const runId = 'e53c9feb-f68f-4c6f-8ba5-31939e3a5000';
const dispatchId = 'ab839d87-6e0d-4b08-a6d1-f3e352a6f4a4';

function fixture() {
  const run = {
    id: runId,
    status: ScheduleRunStatus.QUEUED,
    cancelRequestedAt: null as Date | null,
    jobId: null as string | null,
  };
  const dispatch = {
    id: dispatchId,
    scheduleRunId: runId,
    provider: 'QSTASH',
    status: 'PENDING',
    messageId: null as string | null,
    attempts: 0,
    lastError: null as string | null,
    run,
  };
  let failRunWrite = false;
  const dispatcher = {
    provider: 'qstash' as const,
    enqueue: jest.fn(async () => 'msg_opaque'),
    cancel: jest.fn(),
  };
  const prisma = {
    scheduleRunDispatchOutbox: {
      findUnique: jest.fn(async () => ({ ...dispatch, run: { ...run } })),
      findMany: jest.fn(async () => [{ ...dispatch, run: { ...run } }]),
      updateMany: jest.fn(
        async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          if (where.id !== dispatchId || where.status !== dispatch.status)
            return { count: 0 };
          const { attempts, ...rest } = data;
          Object.assign(dispatch, rest);
          if (typeof attempts === 'object' && attempts) {
            dispatch.attempts += Number(
              (attempts as { increment: number }).increment,
            );
          }
          return { count: 1 };
        },
      ),
    },
    scheduleRun: {
      update: jest.fn(async ({ data }: { data: { jobId: string } }) => {
        if (failRunWrite) {
          failRunWrite = false;
          throw new Error('database write interrupted');
        }
        run.jobId = data.jobId;
        return { ...run };
      }),
      findUnique: jest.fn(async () => ({ ...run })),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    async (work: (tx: typeof prisma) => Promise<unknown>) => {
      const dispatchBefore = structuredClone(dispatch);
      const runBefore = structuredClone(run);
      try {
        return await work(prisma);
      } catch (error) {
        Object.assign(dispatch, dispatchBefore);
        Object.assign(run, runBefore);
        throw error;
      }
    },
  );
  const service = new ScheduleRunDispatchService(
    prisma as never,
    dispatcher as unknown as ScheduleRunDispatcher,
  );
  return {
    run,
    dispatch,
    prisma,
    dispatcher,
    service,
    failRunWrite: () => {
      failRunWrite = true;
    },
  };
}

describe('ScheduleRunDispatchService durable dispatch outbox', () => {
  it('recovers a QStash publish that succeeded before the job-id database write failed', async () => {
    const f = fixture();
    f.failRunWrite();

    await f.service.dispatch(runId);

    expect(f.run.jobId).toBeNull();
    expect(f.dispatch.status).toBe('PENDING');
    await f.service.reconcilePending();

    expect(f.dispatcher.enqueue).toHaveBeenNthCalledWith(1, {
      runId,
      dispatchId,
    });
    expect(f.dispatcher.enqueue).toHaveBeenNthCalledWith(2, {
      runId,
      dispatchId,
    });
    expect(f.dispatch).toMatchObject({
      status: 'PUBLISHED',
      messageId: 'msg_opaque',
    });
    expect(f.run.jobId).toBe('msg_opaque');
  });

  it('leaves a failed publish pending and retries it through reconciliation', async () => {
    const f = fixture();
    f.dispatcher.enqueue.mockRejectedValueOnce(new Error('QStash unavailable'));

    await f.service.dispatch(runId);

    expect(f.dispatch).toMatchObject({
      status: 'PENDING',
      attempts: 1,
    });
    await f.service.reconcilePending();
    expect(f.run.jobId).toBe('msg_opaque');
  });

  it('limits one polling request to a small concurrent reconciliation batch', async () => {
    const f = fixture();

    await f.service.reconcilePending();

    expect(f.prisma.scheduleRunDispatchOutbox.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 3 }),
    );
  });
});

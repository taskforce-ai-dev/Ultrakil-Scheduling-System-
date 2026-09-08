import { ScheduleRunStatus } from '@prisma/client';

import { ScheduleRunDispatcher } from './schedule-run.dispatcher';
import {
  DISPATCH_CONTROL_PLANE_TIMEOUT_MILLISECONDS,
  ScheduleRunDispatchService,
} from './schedule-run-dispatch.service';
import { failScheduleRunForQStash } from './schedule-run-recovery';

const runId = 'e53c9feb-f68f-4c6f-8ba5-31939e3a5000';
const dispatchId = 'ab839d87-6e0d-4b08-a6d1-f3e352a6f4a4';

function fixture(provider: 'qstash' | 'bullmq' = 'qstash') {
  const run = {
    id: runId,
    status: ScheduleRunStatus.QUEUED as ScheduleRunStatus,
    cancelRequestedAt: null as Date | null,
    jobId: null as string | null,
    executionLeaseId: null as string | null,
    executionLeaseExpiresAt: null as Date | null,
  };
  const dispatch = {
    id: dispatchId,
    scheduleRunId: runId,
    provider: provider === 'qstash' ? 'QSTASH' : 'BULLMQ',
    status: 'PENDING',
    messageId: null as string | null,
    attempts: 0,
    lastAttemptAt: null as Date | null,
    lastError: null as string | null,
    terminalFailureMessageId: null as string | null,
    terminalFailureCode: null as string | null,
    terminalFailureMessage: null as string | null,
    terminalFailureAt: null as Date | null,
    run,
  };
  let failRunWrite = false;
  const dispatcher = {
    provider,
    enqueue: jest.fn(async () => 'msg_opaque'),
    cancel: jest.fn(async () => undefined),
  };
  const prisma = {
    scheduleRunDispatchOutbox: {
      findUnique: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          if (where.id && where.id !== dispatch.id) return null;
          if (where.scheduleRunId && where.scheduleRunId !== runId) return null;
          return { ...dispatch, scheduleRun: { ...run } };
        },
      ),
      findMany: jest.fn(async () => [
        { ...dispatch, scheduleRun: { ...run } },
      ]),
      updateMany: jest.fn(
        async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          if (where.id && where.id !== dispatch.id) return { count: 0 };
          if (where.scheduleRunId && where.scheduleRunId !== runId)
            return { count: 0 };
          if (where.provider && where.provider !== dispatch.provider)
            return { count: 0 };
          const scheduleRun = where.scheduleRun as
            | { status?: { not?: ScheduleRunStatus } }
            | undefined;
          if (
            scheduleRun?.status?.not &&
            scheduleRun.status.not === run.status
          ) {
            return { count: 0 };
          }
          const status = where.status as
            | string
            | { in?: string[] }
            | undefined;
          if (
            (typeof status === 'string' && status !== dispatch.status) ||
            (typeof status === 'object' &&
              status.in &&
              !status.in.includes(dispatch.status))
          ) {
            return { count: 0 };
          }
          if (
            where.terminalFailureAt === null &&
            dispatch.terminalFailureAt !== null
          ) {
            return { count: 0 };
          }
          if (where.messageId !== undefined && where.messageId !== dispatch.messageId)
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
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const matches = (condition: Record<string, unknown>): boolean => {
            if (condition.id && condition.id !== run.id) return false;
            if (condition.status) {
              const status = condition.status as
              | ScheduleRunStatus
              | { in?: ScheduleRunStatus[] };
              if (typeof status === 'string' && status !== run.status)
                return false;
              if (
                typeof status === 'object' &&
                status.in &&
                !status.in.includes(run.status)
              ) {
                return false;
              }
            }
            if (
              condition.cancelRequestedAt === null &&
              run.cancelRequestedAt !== null
            ) {
              return false;
            }
            if (
              typeof condition.cancelRequestedAt === 'object' &&
              condition.cancelRequestedAt &&
              'not' in condition.cancelRequestedAt &&
              run.cancelRequestedAt === null
            ) {
              return false;
            }
            if (condition.jobId !== undefined) {
              const expected = condition.jobId as string | null;
              if (expected !== run.jobId) return false;
            }
            if (condition.executionLeaseId === null && run.executionLeaseId)
              return false;
            if (condition.executionLeaseExpiresAt === null) {
              if (run.executionLeaseExpiresAt !== null) return false;
            }
            const expiry = condition.executionLeaseExpiresAt as
              | { lt?: Date; lte?: Date; gt?: Date }
              | undefined;
            if (
              expiry?.lt &&
              (!run.executionLeaseExpiresAt ||
                run.executionLeaseExpiresAt >= expiry.lt)
            ) {
              return false;
            }
            if (
              expiry?.lte &&
              (!run.executionLeaseExpiresAt ||
                run.executionLeaseExpiresAt > expiry.lte)
            ) {
              return false;
            }
            if (
              expiry?.gt &&
              (!run.executionLeaseExpiresAt ||
                run.executionLeaseExpiresAt <= expiry.gt)
            ) {
              return false;
            }
            const conjunction = condition.AND as
              | Record<string, unknown>[]
              | undefined;
            if (conjunction && !conjunction.every(matches)) return false;
            const alternatives = condition.OR as
              | Record<string, unknown>[]
              | undefined;
            return !alternatives || alternatives.some(matches);
          };
          if (!matches(where)) return { count: 0 };
          for (const [key, value] of Object.entries(data)) {
            if (typeof value === 'object' && value && 'increment' in value) {
              (run as Record<string, unknown>)[key] =
                Number((run as Record<string, unknown>)[key] ?? 0) +
                Number((value as { increment: number }).increment);
            } else {
              (run as Record<string, unknown>)[key] = value;
            }
          }
          return { count: 1 };
        },
      ),
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

  it('time-boxes a never-resolving reconciliation publish', async () => {
    jest.useFakeTimers();
    try {
      const f = fixture();
      f.dispatcher.enqueue.mockImplementation(
        () => new Promise<string>(() => undefined),
      );

      const reconciliation = f.service.reconcilePending();
      await jest.advanceTimersByTimeAsync(
        DISPATCH_CONTROL_PLANE_TIMEOUT_MILLISECONDS,
      );
      await expect(reconciliation).resolves.toBeUndefined();

      expect(f.dispatch).toMatchObject({ status: 'PENDING', attempts: 1 });
      expect(f.run.jobId).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores a publish acknowledgement that arrives after its timeout', async () => {
    jest.useFakeTimers();
    try {
      const f = fixture();
      let acknowledge!: (messageId: string) => void;
      f.dispatcher.enqueue.mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            acknowledge = resolve;
          }),
      );

      const attempt = f.service.dispatch(runId);
      await jest.advanceTimersByTimeAsync(
        DISPATCH_CONTROL_PLANE_TIMEOUT_MILLISECONDS,
      );
      await expect(attempt).resolves.toMatchObject({ id: runId });
      acknowledge('msg_late');
      await Promise.resolve();

      expect(f.dispatch).toMatchObject({ status: 'PENDING', messageId: null });
      expect(f.run.jobId).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('limits one polling request to a small concurrent reconciliation batch', async () => {
    const f = fixture();

    await f.service.reconcilePending();

    expect(f.prisma.scheduleRunDispatchOutbox.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 3 }),
    );
  });

  it('consumes more than one batch of terminal history so newer pending work is not starved', async () => {
    const historical = Array.from({ length: 4 }, (_, index) => ({
      id: `00000000-0000-4000-8000-00000000000${index + 1}`,
      scheduleRunId: `10000000-0000-4000-8000-00000000000${index + 1}`,
      provider: 'QSTASH',
      status: 'PUBLISHED',
      messageId: `msg_historical_${index}`,
      attempts: 1,
      lastAttemptAt: new Date(0),
      lastError: null as string | null,
      terminalFailureMessageId: `msg_historical_${index}` as string | null,
      terminalFailureCode: 'QSTASH_DELIVERY_FAILED' as string | null,
      terminalFailureMessage: 'Already settled.' as string | null,
      terminalFailureAt: new Date(index + 1) as Date | null,
      scheduleRun: {
        id: `10000000-0000-4000-8000-00000000000${index + 1}`,
        status: ScheduleRunStatus.SUCCEEDED,
        cancelRequestedAt: null as Date | null,
        jobId: `msg_historical_${index}` as string | null,
        executionLeaseId: null as string | null,
        executionLeaseExpiresAt: null as Date | null,
      },
    }));
    const pendingRunId = '20000000-0000-4000-8000-000000000005';
    const pendingDispatchId = '30000000-0000-4000-8000-000000000005';
    const newer = {
      id: pendingDispatchId,
      scheduleRunId: pendingRunId,
      provider: 'QSTASH',
      status: 'PENDING',
      messageId: null as string | null,
      attempts: 0,
      lastAttemptAt: null as Date | null,
      lastError: null as string | null,
      terminalFailureMessageId: null as string | null,
      terminalFailureCode: null as string | null,
      terminalFailureMessage: null as string | null,
      terminalFailureAt: null as Date | null,
      scheduleRun: {
        id: pendingRunId,
        status: ScheduleRunStatus.QUEUED,
        cancelRequestedAt: null as Date | null,
        jobId: null as string | null,
        executionLeaseId: null as string | null,
        executionLeaseExpiresAt: null as Date | null,
      },
    };
    const rows = [...historical, newer];
    const findDispatch = (where: Record<string, unknown>) =>
      rows.find(
        (row) =>
          (!where.id || row.id === where.id) &&
          (!where.scheduleRunId || row.scheduleRunId === where.scheduleRunId),
      );
    const outbox = {
      findUnique: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          findDispatch(where) ?? null,
      ),
      findMany: jest.fn(
        async ({ take }: { take: number }) =>
          rows
            .filter(
              (row) =>
                row.terminalFailureAt !== null || row.status === 'PENDING',
            )
            .slice(0, take),
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const row = findDispatch(where);
          if (!row) return { count: 0 };
          if (where.provider && where.provider !== row.provider)
            return { count: 0 };
          const status = where.status as
            | string
            | { in?: string[] }
            | undefined;
          if (
            (typeof status === 'string' && status !== row.status) ||
            (typeof status === 'object' &&
              status.in &&
              !status.in.includes(row.status))
          ) {
            return { count: 0 };
          }
          if (
            where.terminalFailureAt === null &&
            row.terminalFailureAt !== null
          ) {
            return { count: 0 };
          }
          Object.assign(row, data);
          return { count: 1 };
        },
      ),
    };
    const scheduleRun = {
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) =>
          rows.find((row) => row.scheduleRun.id === where.id)?.scheduleRun ??
          null,
      ),
      updateMany: jest.fn(async () => ({ count: 0 })),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { jobId: string };
        }) => {
          const run = rows.find(
            (row) => row.scheduleRun.id === where.id,
          )?.scheduleRun;
          if (!run) throw new Error('missing run');
          run.jobId = data.jobId;
          return run;
        },
      ),
    };
    const prisma = {
      scheduleRunDispatchOutbox: outbox,
      scheduleRun,
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(
      async (work: (tx: typeof prisma) => Promise<unknown>) => work(prisma),
    );
    const dispatcher = {
      provider: 'qstash' as const,
      enqueue: jest.fn(async () => 'msg_new'),
      cancel: jest.fn(),
    };
    const service = new ScheduleRunDispatchService(
      prisma as never,
      dispatcher,
    );

    await service.reconcilePending();
    expect(dispatcher.enqueue).not.toHaveBeenCalled();
    await service.reconcilePending();

    expect(historical.every((row) => row.terminalFailureAt === null)).toBe(
      true,
    );
    expect(dispatcher.enqueue).toHaveBeenCalledWith({
      runId: pendingRunId,
      dispatchId: pendingDispatchId,
    });
    expect(newer.status).toBe('PUBLISHED');
  });

  it('settles a durably recorded QStash terminal failure after the crashed lease expires', async () => {
    const f = fixture();
    f.run.status = ScheduleRunStatus.RUNNING;
    f.run.executionLeaseId = '00000000-0000-4000-8000-000000000001';
    f.run.executionLeaseExpiresAt = new Date(Date.now() + 60_000);
    f.dispatch.status = 'PUBLISHED';
    f.dispatch.messageId = 'msg_opaque';
    f.dispatch.terminalFailureMessageId = 'msg_opaque';
    f.dispatch.terminalFailureCode = 'QSTASH_DELIVERY_FAILED';
    f.dispatch.terminalFailureMessage = 'QStash exhausted delivery retries.';
    f.dispatch.terminalFailureAt = new Date();

    await f.service.reconcilePending();
    expect(f.run.status).toBe(ScheduleRunStatus.RUNNING);

    f.run.executionLeaseExpiresAt = new Date(Date.now() - 1);
    await f.service.reconcilePending();

    expect(f.run.status).toBe(ScheduleRunStatus.FAILED);
    expect(f.dispatch.status).toBe('CANCELLED');
    expect(f.dispatch.terminalFailureAt).toBeNull();
  });

  it('never publishes a pending dispatch after a terminal failure was recorded', async () => {
    const f = fixture();
    f.dispatch.terminalFailureMessageId = 'msg_terminal';
    f.dispatch.terminalFailureCode = 'QSTASH_DELIVERY_FAILED';
    f.dispatch.terminalFailureMessage = 'QStash exhausted delivery retries.';
    f.dispatch.terminalFailureAt = new Date();

    await f.service.dispatch(runId);

    expect(f.dispatcher.enqueue).not.toHaveBeenCalled();
  });

  it('lets a terminal callback win if it arrives while publish is in flight', async () => {
    const f = fixture();
    f.dispatcher.enqueue.mockImplementationOnce(async () => {
      f.dispatch.terminalFailureMessageId = 'msg_opaque';
      f.dispatch.terminalFailureCode = 'QSTASH_DELIVERY_FAILED';
      f.dispatch.terminalFailureMessage = 'QStash exhausted delivery retries.';
      f.dispatch.terminalFailureAt = new Date();
      return 'msg_opaque';
    });

    await f.service.dispatch(runId);

    expect(f.dispatch).toMatchObject({
      status: 'PENDING',
      messageId: null,
      terminalFailureMessageId: 'msg_opaque',
    });
    expect(f.run.jobId).toBeNull();
  });

  it('rotates an abandoned published delivery to a fresh id before republishing', async () => {
    const f = fixture();
    f.run.status = ScheduleRunStatus.RUNNING;
    f.run.jobId = 'msg_old';
    f.run.executionLeaseExpiresAt = new Date(Date.now() - 1_000);
    f.dispatch.status = 'PUBLISHED';
    f.dispatch.messageId = 'msg_old';
    f.dispatch.lastAttemptAt = new Date(Date.now() - 10 * 60_000);

    await f.service.reconcilePending();

    expect(f.dispatch.id).not.toBe(dispatchId);
    expect(f.dispatcher.enqueue).toHaveBeenCalledWith({
      runId,
      dispatchId: f.dispatch.id,
    });
    expect(f.dispatch).toMatchObject({
      status: 'PUBLISHED',
      messageId: 'msg_opaque',
    });
    expect(f.run).toMatchObject({
      status: ScheduleRunStatus.QUEUED,
      jobId: 'msg_opaque',
      executionLeaseExpiresAt: null,
    });

    await expect(
      failScheduleRunForQStash(
        f.prisma as never,
        runId,
        dispatchId,
        'msg_old',
        'QSTASH_DELIVERY_FAILED',
        'Late callback from the superseded generation.',
      ),
    ).resolves.toBe('ignored');
    expect(f.run.status).toBe(ScheduleRunStatus.QUEUED);
    expect(f.dispatch.id).not.toBe(dispatchId);
  });

  it('rotates a lost-ack pending generation after its worker lease expires', async () => {
    const f = fixture();
    f.run.status = ScheduleRunStatus.RUNNING;
    f.run.executionLeaseExpiresAt = new Date(Date.now() - 1_000);
    f.dispatch.lastAttemptAt = new Date(Date.now() - 10 * 60_000);

    await f.service.reconcilePending();

    expect(f.dispatch.id).not.toBe(dispatchId);
    expect(f.dispatcher.enqueue).toHaveBeenCalledWith({
      runId,
      dispatchId: f.dispatch.id,
    });
    expect(f.run).toMatchObject({
      status: ScheduleRunStatus.QUEUED,
      jobId: 'msg_opaque',
    });
  });

  it('does not redrive a published delivery while its lease is still active', async () => {
    const f = fixture();
    f.run.status = ScheduleRunStatus.RUNNING;
    f.run.jobId = 'msg_old';
    f.run.executionLeaseExpiresAt = new Date(Date.now() + 60_000);
    f.dispatch.status = 'PUBLISHED';
    f.dispatch.messageId = 'msg_old';
    f.dispatch.lastAttemptAt = new Date(Date.now() - 10 * 60_000);

    await f.service.reconcilePending();

    expect(f.dispatch.id).toBe(dispatchId);
    expect(f.dispatcher.enqueue).not.toHaveBeenCalled();
  });

  it('gives BullMQ a fresh job id after every permanently stalled generation', async () => {
    const f = fixture('bullmq');
    f.run.status = ScheduleRunStatus.RUNNING;
    f.run.jobId = 'bull_old';
    f.run.executionLeaseExpiresAt = new Date(Date.now() - 1_000);
    f.dispatch.status = 'PUBLISHED';
    f.dispatch.messageId = 'bull_old';
    f.dispatch.lastAttemptAt = new Date(Date.now() - 10 * 60_000);

    await f.service.reconcilePending();
    const firstReplacement = f.dispatch.id;

    f.run.status = ScheduleRunStatus.RUNNING;
    f.run.jobId = 'bull_replacement_1';
    f.run.executionLeaseExpiresAt = new Date(Date.now() - 1_000);
    f.dispatch.messageId = 'bull_replacement_1';
    f.dispatch.lastAttemptAt = new Date(Date.now() - 10 * 60_000);
    f.dispatcher.enqueue.mockResolvedValueOnce('bull_replacement_2');

    await f.service.reconcilePending();

    expect(f.dispatch.id).not.toBe(firstReplacement);
    expect(f.dispatcher.enqueue).toHaveBeenNthCalledWith(1, {
      runId,
      dispatchId: firstReplacement,
    });
    expect(f.dispatcher.enqueue).toHaveBeenNthCalledWith(2, {
      runId,
      dispatchId: f.dispatch.id,
    });
    expect(f.run.jobId).toBe('bull_replacement_2');
  });

  it('settles an expired cancellation instead of redriving it', async () => {
    const f = fixture();
    f.run.status = ScheduleRunStatus.RUNNING;
    f.run.cancelRequestedAt = new Date();
    f.run.executionLeaseExpiresAt = new Date(Date.now() - 1_000);
    f.dispatch.status = 'PUBLISHED';
    f.dispatch.messageId = 'msg_old';
    f.dispatch.lastAttemptAt = new Date(Date.now() - 10 * 60_000);

    await f.service.reconcilePending();

    expect(f.run.status).toBe(ScheduleRunStatus.CANCELLED);
    expect(f.dispatcher.enqueue).not.toHaveBeenCalled();
  });

  it('time-boxes advisory remote cancellation after persisting cancellation', async () => {
    jest.useFakeTimers();
    try {
      const f = fixture();
      f.run.status = ScheduleRunStatus.CANCELLED;
      f.dispatcher.cancel.mockImplementation(
        () => new Promise<undefined>(() => undefined),
      );

      const cancellation = f.service.cancel(runId, 'msg_opaque');
      await jest.advanceTimersByTimeAsync(
        DISPATCH_CONTROL_PLANE_TIMEOUT_MILLISECONDS,
      );
      await expect(cancellation).resolves.toBeUndefined();

      expect(f.dispatch.status).toBe('CANCELLED');
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves a lost-ack running row until an expired cancellation is settled', async () => {
    const f = fixture();
    f.run.status = ScheduleRunStatus.RUNNING;
    f.run.cancelRequestedAt = new Date();
    f.run.executionLeaseExpiresAt = new Date(Date.now() + 60_000);

    await f.service.cancel(runId, null);
    expect(f.dispatch.status).toBe('PENDING');

    f.run.executionLeaseExpiresAt = new Date(Date.now() - 1);
    await f.service.reconcilePending();

    expect(f.run.status).toBe(ScheduleRunStatus.CANCELLED);
    expect(f.dispatch.status).toBe('CANCELLED');
  });

  it('recognizes only the current provider delivery id', async () => {
    const f = fixture();

    await expect(
      f.service.isCurrentDispatch(runId, dispatchId),
    ).resolves.toBe(true);
    await expect(
      f.service.isCurrentDispatch(
        runId,
        '00000000-0000-4000-8000-000000000001',
      ),
    ).resolves.toBe(false);
  });
});

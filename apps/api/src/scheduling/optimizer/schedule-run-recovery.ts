import { Prisma, ScheduleRunStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

type RecoveryClient = PrismaService | Prisma.TransactionClient;

interface RecoveryRunModel {
  findUnique(args: Prisma.ScheduleRunFindUniqueArgs): Promise<{
    status: ScheduleRunStatus;
    cancelRequestedAt: Date | null;
    executionLeaseExpiresAt: Date | null;
  } | null>;
  updateMany(
    args: Prisma.ScheduleRunUpdateManyArgs,
  ): Promise<{ count: number }>;
}

interface RecoveryOutboxModel {
  updateMany(
    args: Prisma.ScheduleRunDispatchOutboxUpdateManyArgs,
  ): Promise<{ count: number }>;
}

function runModel(client: RecoveryClient): RecoveryRunModel {
  return (client as unknown as { scheduleRun: RecoveryRunModel }).scheduleRun;
}

function outboxModel(client: RecoveryClient): RecoveryOutboxModel {
  return (
    client as unknown as {
      scheduleRunDispatchOutbox: RecoveryOutboxModel;
    }
  ).scheduleRunDispatchOutbox;
}

interface TerminalFailure {
  runId: string;
  dispatchId: string;
  messageId: string;
  code: string;
  message: string;
  recordedAt: Date;
}

async function consumeTerminalFailure(
  client: RecoveryClient,
  terminal: TerminalFailure,
): Promise<void> {
  // Fence the clear with every recorded value. A newer callback that arrives
  // between settlement and this update remains durable for its own sweep.
  await outboxModel(client).updateMany({
    where: {
      id: terminal.dispatchId,
      scheduleRunId: terminal.runId,
      provider: 'QSTASH',
      terminalFailureMessageId: terminal.messageId,
      terminalFailureCode: terminal.code,
      terminalFailureMessage: terminal.message,
      terminalFailureAt: terminal.recordedAt,
    },
    data: {
      status: 'CANCELLED',
      terminalFailureMessageId: null,
      terminalFailureCode: null,
      terminalFailureMessage: null,
      terminalFailureAt: null,
    },
  });
}

export async function settleExpiredScheduleRunCancellation(
  prisma: PrismaService,
  runId: string,
): Promise<boolean> {
  const now = new Date();
  const settled = await runModel(prisma).updateMany({
    where: {
      id: runId,
      status: ScheduleRunStatus.RUNNING,
      cancelRequestedAt: { not: null },
      OR: [
        { executionLeaseExpiresAt: { lte: now } },
        { executionLeaseExpiresAt: null },
      ],
    },
    data: {
      status: ScheduleRunStatus.CANCELLED,
      finishedAt: now,
      progressPercent: 100,
      executionLeaseId: null,
      executionLeaseExpiresAt: null,
    },
  });
  return settled.count === 1;
}

/**
 * Records a signed QStash terminal callback, then either settles the run or
 * keeps the callback durable while a live execution lease can still finish.
 * Settled/irrelevant markers are consumed so bounded reconciliation cannot be
 * starved forever by historical rows.
 */
export async function failScheduleRunForQStash(
  prisma: PrismaService,
  runId: string,
  dispatchId: string,
  messageId: string,
  code: string,
  message: string,
): Promise<'failed' | 'deferred' | 'ignored'> {
  const recordedAt = new Date();
  const terminal: TerminalFailure = {
    runId,
    dispatchId,
    messageId,
    code,
    message,
    recordedAt,
  };
  const recorded = await outboxModel(prisma).updateMany({
    where: {
      id: dispatchId,
      scheduleRunId: runId,
      provider: 'QSTASH',
      status: { in: ['PENDING', 'PUBLISHED'] },
      OR: [{ messageId: null }, { messageId }],
    },
    data: {
      terminalFailureMessageId: messageId,
      terminalFailureCode: code,
      terminalFailureMessage: message,
      terminalFailureAt: recordedAt,
    },
  });
  if (recorded.count !== 1) return 'ignored';

  return prisma.$transaction(async (tx) => {
    const failed = await runModel(tx).updateMany({
      where: {
        id: runId,
        cancelRequestedAt: null,
        status: {
          in: [ScheduleRunStatus.QUEUED, ScheduleRunStatus.RUNNING],
        },
        AND: [
          { OR: [{ jobId: null }, { jobId: messageId }] },
          {
            OR: [
              { executionLeaseId: null },
              { executionLeaseExpiresAt: { lte: recordedAt } },
            ],
          },
        ],
      },
      data: {
        status: ScheduleRunStatus.FAILED,
        finishedAt: recordedAt,
        errorCode: code,
        errorMessage: message,
        jobId: messageId,
      },
    });
    if (failed.count === 1) {
      await consumeTerminalFailure(tx, terminal);
      return 'failed';
    }

    const cancelled = await runModel(tx).updateMany({
      where: {
        id: runId,
        status: ScheduleRunStatus.RUNNING,
        cancelRequestedAt: { not: null },
        OR: [
          { executionLeaseExpiresAt: { lte: recordedAt } },
          { executionLeaseExpiresAt: null },
        ],
      },
      data: {
        status: ScheduleRunStatus.CANCELLED,
        finishedAt: recordedAt,
        progressPercent: 100,
        executionLeaseId: null,
        executionLeaseExpiresAt: null,
      },
    });
    if (cancelled.count === 1) {
      await consumeTerminalFailure(tx, terminal);
      return 'ignored';
    }

    const run = await runModel(tx).findUnique({ where: { id: runId } });
    if (
      run?.status === ScheduleRunStatus.RUNNING &&
      run.executionLeaseExpiresAt &&
      run.executionLeaseExpiresAt > recordedAt
    ) {
      return 'deferred';
    }

    await consumeTerminalFailure(tx, terminal);
    return 'ignored';
  });
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  ScheduleRun,
  ScheduleRunDispatchStatus,
  ScheduleRunStatus,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../prisma/prisma.service';
import {
  SCHEDULE_RUN_DISPATCHER,
  ScheduleRunDispatcher,
} from './schedule-run.dispatcher';
import {
  failScheduleRunForQStash,
  settleExpiredScheduleRunCancellation,
} from './schedule-run-recovery';

type DispatchProvider = 'BULLMQ' | 'QSTASH';

type DispatchOutboxRow = Prisma.ScheduleRunDispatchOutboxGetPayload<{
  include: { scheduleRun: true };
}>;

interface DispatchOutboxModel {
  findUnique(
    args: Prisma.ScheduleRunDispatchOutboxFindUniqueArgs,
  ): Promise<DispatchOutboxRow | null>;
  findMany(
    args: Prisma.ScheduleRunDispatchOutboxFindManyArgs,
  ): Promise<DispatchOutboxRow[]>;
  updateMany(
    args: Prisma.ScheduleRunDispatchOutboxUpdateManyArgs,
  ): Promise<{ count: number }>;
}

// Keep each signed recovery invocation bounded; a later sweep continues from
// the oldest durable rows without monopolising a Vercel function invocation.
export const MAX_RECONCILIATION_DISPATCHES = 3;
export const DISPATCH_RECOVERY_STALE_MILLISECONDS = 5 * 60_000;
export const DISPATCH_CONTROL_PLANE_TIMEOUT_MILLISECONDS = 5_000;

class DispatchRecoveryRace extends Error {}

function withControlPlaneTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Schedule-run dispatch control plane timed out.')),
      DISPATCH_CONTROL_PLANE_TIMEOUT_MILLISECONDS,
    );
    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Reconciles durable scheduling dispatch intent with a remote queue.
 *
 * The remote publish is deliberately outside the SQL transaction. If its
 * acknowledgement arrives but the subsequent SQL write fails, the PENDING row
 * remains and can safely publish again: both providers receive the same
 * durable dispatch id until recovery intentionally rotates its generation.
 */
@Injectable()
export class ScheduleRunDispatchService {
  private readonly logger = new Logger(ScheduleRunDispatchService.name);

  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(SCHEDULE_RUN_DISPATCHER)
    private readonly dispatcher: ScheduleRunDispatcher,
  ) {}

  async dispatch(runId: string): Promise<ScheduleRun | null> {
    const dispatch = await this.outbox(this.prisma).findUnique({
      where: { scheduleRunId: runId },
      include: { scheduleRun: true },
    });
    if (!dispatch) return this.findRun(runId);
    if (!this.isDispatchable(dispatch)) return this.findRun(runId);

    let messageId: string;
    try {
      messageId = await withControlPlaneTimeout(
        this.dispatcher.enqueue({
          runId,
          dispatchId: dispatch.id,
        }),
      );
    } catch {
      await this.recordAttemptFailure(dispatch.id);
      return this.findRun(runId);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const recorded = await this.outbox(tx).updateMany({
          where: {
            id: dispatch.id,
            status: 'PENDING',
            terminalFailureAt: null,
          },
          data: {
            status: 'PUBLISHED',
            messageId,
            attempts: { increment: 1 },
            lastAttemptAt: new Date(),
            lastError: null,
          },
        });
        if (recorded.count !== 1) return this.findRun(runId);
        return tx.scheduleRun.update({ where: { id: runId }, data: { jobId: messageId } });
      });
    } catch {
      // QStash deduplicates this exact dispatch id for ten minutes and BullMQ
      // uses it as jobId. Retrying this generation is safe for both.
      await this.recordAttemptFailure(dispatch.id);
      return this.findRun(runId);
    }
  }

  /** Invoked by normal polling endpoints and any future scheduled reconciler. */
  async reconcilePending(): Promise<void> {
    const provider =
      this.dispatcher.provider === 'qstash' ? 'QSTASH' : 'BULLMQ';
    const now = new Date();
    const staleBefore = new Date(
      now.getTime() - DISPATCH_RECOVERY_STALE_MILLISECONDS,
    );
    const pending = await this.outbox(this.prisma).findMany({
      where: {
        provider,
        OR: [
          {
            status: 'PENDING',
            terminalFailureAt: null,
            scheduleRun: {
              status: ScheduleRunStatus.QUEUED,
              cancelRequestedAt: null,
            },
          },
          ...(provider === 'QSTASH'
            ? [
                {
                  status: {
                    in: [
                      ScheduleRunDispatchStatus.PENDING,
                      ScheduleRunDispatchStatus.PUBLISHED,
                    ],
                  },
                  terminalFailureAt: { not: null },
                },
              ]
            : []),
          {
            status: {
              in: [
                ScheduleRunDispatchStatus.PENDING,
                ScheduleRunDispatchStatus.PUBLISHED,
              ],
            },
            terminalFailureAt: null,
            AND: [
              {
                OR: [
                  { lastAttemptAt: null },
                  { lastAttemptAt: { lt: staleBefore } },
                ],
              },
              {
                scheduleRun: {
                  cancelRequestedAt: null,
                  OR: [
                    { status: ScheduleRunStatus.QUEUED },
                    {
                      status: ScheduleRunStatus.RUNNING,
                      OR: [
                        { executionLeaseExpiresAt: { lte: now } },
                        { executionLeaseExpiresAt: null },
                      ],
                    },
                  ],
                },
              },
            ],
          },
          {
            status: {
              in: [
                ScheduleRunDispatchStatus.PENDING,
                ScheduleRunDispatchStatus.PUBLISHED,
              ],
            },
            scheduleRun: {
              status: ScheduleRunStatus.RUNNING,
              cancelRequestedAt: { not: null },
              OR: [
                { executionLeaseExpiresAt: { lte: now } },
                { executionLeaseExpiresAt: null },
              ],
            },
          },
        ],
      },
      include: { scheduleRun: true },
      orderBy: { updatedAt: 'asc' },
      take: MAX_RECONCILIATION_DISPATCHES,
    });
    await Promise.allSettled(
      pending.map((dispatch) => this.reconcileDispatch(dispatch, now)),
    );
  }

  /** Rejects callbacks and jobs from a superseded remote delivery generation. */
  async isCurrentDispatch(runId: string, dispatchId: string): Promise<boolean> {
    const dispatch = await this.outbox(this.prisma).findUnique({
      where: { id: dispatchId },
      include: { scheduleRun: true },
    });
    if (!dispatch || dispatch.scheduleRunId !== runId) return false;
    const expectedProvider: DispatchProvider =
      this.dispatcher.provider === 'qstash' ? 'QSTASH' : 'BULLMQ';
    return (
      dispatch.provider === expectedProvider &&
      (dispatch.status === 'PENDING' || dispatch.status === 'PUBLISHED') &&
      dispatch.terminalFailureAt === null &&
      (dispatch.scheduleRun.status === ScheduleRunStatus.QUEUED ||
        dispatch.scheduleRun.status === ScheduleRunStatus.RUNNING) &&
      dispatch.scheduleRun.cancelRequestedAt === null
    );
  }

  /** The run cancellation is authoritative; remote cancellation is advisory. */
  async cancel(runId: string, jobId: string | null): Promise<void> {
    await this.outbox(this.prisma).updateMany({
      where: {
        scheduleRunId: runId,
        status: 'PENDING',
        // A lost publish acknowledgement can leave a live worker attached to a
        // PENDING row. Preserve that row so reconciliation can settle the
        // cancellation if the worker disappears and its lease expires.
        scheduleRun: { status: { not: ScheduleRunStatus.RUNNING } },
      },
      data: { status: 'CANCELLED' },
    });
    try {
      await withControlPlaneTimeout(this.dispatcher.cancel(jobId));
    } catch {
      // The database cancel flag is authoritative. Never hold an API request
      // open indefinitely for advisory remote cleanup.
      this.logger.warn('Schedule-run remote cancellation did not complete');
    }
  }

  private isDispatchable(dispatch: DispatchOutboxRow): boolean {
    const expectedProvider: DispatchProvider =
      this.dispatcher.provider === 'qstash' ? 'QSTASH' : 'BULLMQ';
    return (
      dispatch.provider === expectedProvider &&
      dispatch.status === 'PENDING' &&
      dispatch.terminalFailureAt === null &&
      dispatch.scheduleRun.status === ScheduleRunStatus.QUEUED &&
      dispatch.scheduleRun.cancelRequestedAt === null
    );
  }

  private async reconcileDispatch(
    dispatch: DispatchOutboxRow,
    now: Date,
  ): Promise<void> {
    // A signed terminal callback is authoritative over every retry/redrive.
    if (this.hasRecordedQStashTerminalFailure(dispatch)) {
      const outcome = await this.settleRecordedQStashTerminalFailure(dispatch);
      if (outcome === 'deferred') return;
      if (dispatch.scheduleRun.cancelRequestedAt) {
        await this.settleExpiredCancellation(dispatch);
      }
      return;
    }
    if (dispatch.scheduleRun.cancelRequestedAt) {
      await this.settleExpiredCancellation(dispatch);
      return;
    }
    if (
      dispatch.status === 'PENDING' &&
      dispatch.scheduleRun.status === ScheduleRunStatus.QUEUED
    ) {
      await this.dispatch(dispatch.scheduleRunId);
      return;
    }
    if (this.isStaleDeliveredDispatch(dispatch, now)) {
      await this.redriveStaleDispatch(dispatch, now);
    }
  }

  private isStaleDeliveredDispatch(
    dispatch: DispatchOutboxRow,
    now: Date,
  ): boolean {
    if (
      (dispatch.status !== 'PENDING' && dispatch.status !== 'PUBLISHED') ||
      dispatch.terminalFailureAt
    ) {
      return false;
    }
    if (
      dispatch.lastAttemptAt &&
      now.getTime() - dispatch.lastAttemptAt.getTime() <
        DISPATCH_RECOVERY_STALE_MILLISECONDS
    ) {
      return false;
    }
    if (dispatch.scheduleRun.status === ScheduleRunStatus.QUEUED) return true;
    return (
      dispatch.scheduleRun.status === ScheduleRunStatus.RUNNING &&
      (!dispatch.scheduleRun.executionLeaseExpiresAt ||
        dispatch.scheduleRun.executionLeaseExpiresAt <= now)
    );
  }

  private async redriveStaleDispatch(
    dispatch: DispatchOutboxRow,
    now: Date,
  ): Promise<void> {
    const replacementId = randomUUID();
    try {
      await this.prisma.$transaction(async (tx) => {
        const reset = await tx.scheduleRun.updateMany({
          where: {
            id: dispatch.scheduleRunId,
            cancelRequestedAt: null,
            OR: [
              { status: ScheduleRunStatus.QUEUED },
              {
                status: ScheduleRunStatus.RUNNING,
                OR: [
                  { executionLeaseExpiresAt: { lte: now } },
                  { executionLeaseExpiresAt: null },
                ],
              },
            ],
          },
          data: {
            status: ScheduleRunStatus.QUEUED,
            progressPercent: 0,
            jobId: null,
            executionLeaseId: null,
            executionLeaseExpiresAt: null,
          },
        });
        if (reset.count !== 1) throw new DispatchRecoveryRace();

        const rotated = await this.outbox(tx).updateMany({
          where: {
            id: dispatch.id,
            scheduleRunId: dispatch.scheduleRunId,
            provider: dispatch.provider,
            status: {
              in: [
                ScheduleRunDispatchStatus.PENDING,
                ScheduleRunDispatchStatus.PUBLISHED,
              ],
            },
            messageId: dispatch.messageId,
            terminalFailureAt: null,
          },
          data: {
            id: replacementId,
            status: 'PENDING',
            messageId: null,
            lastError: null,
          },
        });
        if (rotated.count !== 1) throw new DispatchRecoveryRace();
      });
    } catch (error) {
      if (error instanceof DispatchRecoveryRace) return;
      throw error;
    }

    await this.dispatch(dispatch.scheduleRunId);
  }

  private async settleExpiredCancellation(
    dispatch: DispatchOutboxRow,
  ): Promise<void> {
    const settled = await settleExpiredScheduleRunCancellation(
      this.prisma,
      dispatch.scheduleRunId,
    );
    if (!settled) return;
    await this.outbox(this.prisma).updateMany({
      where: {
        id: dispatch.id,
        scheduleRunId: dispatch.scheduleRunId,
        status: {
          in: [
            ScheduleRunDispatchStatus.PENDING,
            ScheduleRunDispatchStatus.PUBLISHED,
          ],
        },
      },
      data: { status: 'CANCELLED' },
    });
  }

  private async recordAttemptFailure(dispatchId: string): Promise<void> {
    try {
      await this.outbox(this.prisma).updateMany({
        where: { id: dispatchId, status: 'PENDING' },
        data: {
          attempts: { increment: 1 },
          lastAttemptAt: new Date(),
          // Do not persist an upstream message: it can contain transport data.
          lastError: 'Dispatch publish or persistence attempt failed.',
        },
      });
    } catch {
      // A database outage means the durable outbox cannot be touched yet. A
      // later API invocation will reconcile it once PostgreSQL is available.
      this.logger.warn('Schedule-run dispatch reconciliation could not persist');
    }
  }

  private hasRecordedQStashTerminalFailure(
    dispatch: DispatchOutboxRow,
  ): boolean {
    return (
      dispatch.provider === 'QSTASH' &&
      dispatch.terminalFailureAt !== null &&
      dispatch.terminalFailureMessageId !== null &&
      dispatch.terminalFailureCode !== null &&
      dispatch.terminalFailureMessage !== null
    );
  }

  /**
   * A QStash failure callback can exhaust its own retries while another worker
   * still owns the lease. Replaying the signed, durable terminal fact on later
   * polling safely settles only after that owner has expired.
   */
  private async settleRecordedQStashTerminalFailure(
    dispatch: DispatchOutboxRow,
  ): Promise<'failed' | 'deferred' | 'ignored'> {
    return failScheduleRunForQStash(
      this.prisma,
      dispatch.scheduleRunId,
      dispatch.id,
      dispatch.terminalFailureMessageId as string,
      dispatch.terminalFailureCode as string,
      dispatch.terminalFailureMessage as string,
    );
  }

  private outbox(client: unknown): DispatchOutboxModel {
    return (client as { scheduleRunDispatchOutbox: DispatchOutboxModel })
      .scheduleRunDispatchOutbox;
  }

  private async findRun(runId: string): Promise<ScheduleRun | null> {
    return this.prisma.scheduleRun.findUnique({ where: { id: runId } });
  }
}

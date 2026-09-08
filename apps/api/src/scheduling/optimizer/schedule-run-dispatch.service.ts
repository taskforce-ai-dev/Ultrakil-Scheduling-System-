import { Inject, Injectable, Logger } from '@nestjs/common';
import { ScheduleRun, ScheduleRunStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import {
  SCHEDULE_RUN_DISPATCHER,
  ScheduleRunDispatcher,
} from './schedule-run.dispatcher';

type DispatchStatus = 'PENDING' | 'PUBLISHED' | 'CANCELLED';
type DispatchProvider = 'BULLMQ' | 'QSTASH';

interface DispatchOutboxRow {
  id: string;
  scheduleRunId: string;
  provider: DispatchProvider;
  status: DispatchStatus;
  messageId: string | null;
  run: Pick<ScheduleRun, 'id' | 'status' | 'cancelRequestedAt' | 'jobId'>;
}

interface DispatchOutboxModel {
  findUnique(args: Record<string, unknown>): Promise<DispatchOutboxRow | null>;
  findMany(args: Record<string, unknown>): Promise<DispatchOutboxRow[]>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
}

// Polling paths run inside the API function too. Limit reconciliation so an
// unavailable upstream cannot turn an ordinary GET into a long Vercel request.
export const MAX_RECONCILIATION_DISPATCHES = 3;

/**
 * Reconciles durable scheduling dispatch intent with a remote queue.
 *
 * The remote publish is deliberately outside the SQL transaction. If its
 * acknowledgement arrives but the subsequent SQL write fails, the PENDING row
 * remains and can safely publish again: QStash receives the same opaque
 * deduplication id, while BullMQ receives the same run-id job id.
 */
@Injectable()
export class ScheduleRunDispatchService {
  private readonly logger = new Logger(ScheduleRunDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SCHEDULE_RUN_DISPATCHER)
    private readonly dispatcher: ScheduleRunDispatcher,
  ) {}

  async dispatch(runId: string): Promise<ScheduleRun | null> {
    const dispatch = await this.outbox(this.prisma).findUnique({
      where: { scheduleRunId: runId },
      include: { run: true },
    });
    if (!dispatch) return this.findRun(runId);
    if (!this.isDispatchable(dispatch)) return this.findRun(runId);

    let messageId: string;
    try {
      messageId = await this.dispatcher.enqueue({
        runId,
        dispatchId: dispatch.id,
      });
    } catch {
      await this.recordAttemptFailure(dispatch.id);
      return this.findRun(runId);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const recorded = await this.outbox(tx).updateMany({
          where: { id: dispatch.id, status: 'PENDING' },
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
      // QStash deduplicates this exact dispatch id for ten minutes; BullMQ uses
      // the run id as its job id. Retrying later is therefore safe for both.
      await this.recordAttemptFailure(dispatch.id);
      return this.findRun(runId);
    }
  }

  /** Invoked by normal polling endpoints and any future scheduled reconciler. */
  async reconcilePending(): Promise<void> {
    const provider = this.dispatcher.provider === 'qstash' ? 'QSTASH' : 'BULLMQ';
    const pending = await this.outbox(this.prisma).findMany({
      where: { status: 'PENDING', provider },
      orderBy: { updatedAt: 'asc' },
      take: MAX_RECONCILIATION_DISPATCHES,
    });
    await Promise.allSettled(
      pending.map((dispatch) => this.dispatch(dispatch.scheduleRunId)),
    );
  }

  /** The run cancellation is authoritative; remote cancellation is advisory. */
  async cancel(runId: string, jobId: string | null): Promise<void> {
    await this.outbox(this.prisma).updateMany({
      where: { scheduleRunId: runId, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
    await this.dispatcher.cancel(jobId);
  }

  private isDispatchable(dispatch: DispatchOutboxRow): boolean {
    const expectedProvider: DispatchProvider =
      this.dispatcher.provider === 'qstash' ? 'QSTASH' : 'BULLMQ';
    return (
      dispatch.provider === expectedProvider &&
      dispatch.status === 'PENDING' &&
      dispatch.run.status === ScheduleRunStatus.QUEUED &&
      dispatch.run.cancelRequestedAt === null
    );
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

  private outbox(client: unknown): DispatchOutboxModel {
    return (client as { scheduleRunDispatchOutbox: DispatchOutboxModel })
      .scheduleRunDispatchOutbox;
  }

  private async findRun(runId: string): Promise<ScheduleRun | null> {
    return this.prisma.scheduleRun.findUnique({ where: { id: runId } });
  }
}

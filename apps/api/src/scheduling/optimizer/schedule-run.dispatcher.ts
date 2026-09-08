import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { qstashMaximumRangeDays } from './schedule-run-execution-budget';

export { qstashMaximumRangeDays } from './schedule-run-execution-budget';

export interface ScheduleRunDispatch {
  runId: string;
  /** Durable outbox UUID; QStash uses it as its deduplication key. */
  dispatchId?: string;
}

export type ScheduleRunDispatcherProvider = 'bullmq' | 'qstash';

/** The controller dispatches runs without knowing which delivery system is active. */
export interface ScheduleRunDispatcher {
  readonly provider: ScheduleRunDispatcherProvider;
  /** Undefined for self-hosted BullMQ, which has no Vercel function ceiling. */
  readonly maxRangeDays?: number;
  enqueue(dispatch: ScheduleRunDispatch): Promise<string>;
  cancel(jobId: string | null): Promise<void>;
}

export const SCHEDULE_RUN_DISPATCHER = Symbol('SCHEDULE_RUN_DISPATCHER');
export const QSTASH_CLIENT = Symbol('QSTASH_CLIENT');

export interface QStashClient {
  publishJSON(input: {
    url: string;
    body: { runId: string; dispatchId: string };
    failureCallback: string;
    retries: number;
    timeout: string;
    deduplicationId: string;
  }): Promise<{ messageId: string }>;
  messages: {
    cancel(messageId: string): Promise<unknown>;
  };
}

type QStashClientConstructor = new (options: {
  token: string;
  enableTelemetry: boolean;
}) => QStashClient;

export function createQStashClient(token: string): QStashClient {
  // Keep the runtime dependency conditional: BullMQ-only deployments never
  // instantiate or configure QStash, while Vercel resolves the official SDK.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require('@upstash/qstash') as {
    Client: QStashClientConstructor;
  };
  return new Client({ token, enableTelemetry: false });
}

/** Publishes an opaque run ID to QStash; run details remain in PostgreSQL. */
@Injectable()
export class QStashScheduleRunDispatcher implements ScheduleRunDispatcher {
  readonly provider = 'qstash' as const;
  private readonly logger = new Logger(QStashScheduleRunDispatcher.name);

  constructor(
    config: ConfigService,
    @Inject(QSTASH_CLIENT) private readonly client: QStashClient,
  ) {
    this.executeUrl = config.getOrThrow<string>('scheduleDispatch.executeUrl');
    this.failureUrl = config.getOrThrow<string>('scheduleDispatch.failureUrl');
    this.executionBudgetSeconds = config.getOrThrow<number>(
      'scheduleDispatch.executionBudgetSeconds',
    );
    this.maxRangeDays = qstashMaximumRangeDays(this.executionBudgetSeconds);
  }

  private readonly executeUrl: string;
  private readonly failureUrl: string;
  private readonly executionBudgetSeconds: number;
  readonly maxRangeDays: number;

  async enqueue({ runId, dispatchId = runId }: ScheduleRunDispatch): Promise<string> {
    const result = await this.client.publishJSON({
      url: this.executeUrl,
      // Both values are opaque UUIDs. The API loads all scheduling detail from
      // PostgreSQL, never from a QStash message body.
      body: { runId, dispatchId },
      failureCallback: this.failureUrl,
      retries: 3,
      timeout: `${this.executionBudgetSeconds}s`,
      deduplicationId: dispatchId,
    });
    return result.messageId;
  }

  async cancel(jobId: string | null): Promise<void> {
    if (!jobId) return;
    try {
      await this.client.messages.cancel(jobId);
    } catch {
      // PostgreSQL's cancel flag is authoritative. The remote request merely
      // avoids a delivery that has not started yet, so it must never undo it.
      this.logger.warn('Best-effort QStash cancellation did not complete');
    }
  }
}

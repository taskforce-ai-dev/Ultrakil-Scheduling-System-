import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ScheduleRunDispatch {
  runId: string;
}

/** The controller dispatches runs without knowing which delivery system is active. */
export interface ScheduleRunDispatcher {
  enqueue(dispatch: ScheduleRunDispatch): Promise<string>;
  cancel(jobId: string | null): Promise<void>;
}

export const SCHEDULE_RUN_DISPATCHER = Symbol('SCHEDULE_RUN_DISPATCHER');

interface QStashClient {
  publishJSON(input: {
    url: string;
    body: { runId: string };
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

function createQStashClient(token: string): QStashClient {
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
  private readonly logger = new Logger(QStashScheduleRunDispatcher.name);
  private readonly client: QStashClient;

  constructor(config: ConfigService, client?: QStashClient) {
    this.client =
      client ??
      createQStashClient(
        config.getOrThrow<string>('scheduleDispatch.qstash.token'),
      );
    this.executeUrl = config.getOrThrow<string>('scheduleDispatch.executeUrl');
    this.failureUrl = config.getOrThrow<string>('scheduleDispatch.failureUrl');
    this.executionBudgetSeconds = config.getOrThrow<number>(
      'scheduleDispatch.executionBudgetSeconds',
    );
  }

  private readonly executeUrl: string;
  private readonly failureUrl: string;
  private readonly executionBudgetSeconds: number;

  async enqueue({ runId }: ScheduleRunDispatch): Promise<string> {
    const result = await this.client.publishJSON({
      url: this.executeUrl,
      // A UUID is opaque and lets the execute endpoint load authoritative data.
      body: { runId },
      failureCallback: this.failureUrl,
      retries: 3,
      timeout: `${this.executionBudgetSeconds}s`,
      deduplicationId: runId,
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

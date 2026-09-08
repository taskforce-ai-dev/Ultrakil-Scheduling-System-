import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';

import { QUEUE_SCHEDULE_RUN } from '../../queue/queue.constants';
import {
  ScheduleRunDispatch,
  ScheduleRunDispatcher,
} from './schedule-run.dispatcher';
import { ScheduleRunService } from './schedule-run.service';
import {
  BULLMQ_EXECUTION_LEASE_SECONDS,
  BULLMQ_RETRY_BACKOFF_MILLISECONDS,
  SELF_HOSTED_EXECUTION_BUDGET_SECONDS,
} from './schedule-run-execution-budget';

export interface ScheduleRunJobData extends ScheduleRunDispatch {
  timeLimitSeconds?: number;
}

export const SCHEDULE_RUN_JOB = 'solve';

/**
 * Runs the solve off the request thread.
 *
 * A solve takes seconds, so doing it inline would hold an HTTP connection open
 * and time out behind any proxy. The job is keyed on the run id, which is what
 * makes a retry safe: re-running the same job re-solves the same range and
 * replaces that run's own draft assignments rather than adding a second set.
 */
@Injectable()
@Processor(QUEUE_SCHEDULE_RUN)
export class ScheduleRunProcessor extends WorkerHost {
  private readonly logger = new Logger(ScheduleRunProcessor.name);

  constructor(private readonly runs: ScheduleRunService) {
    super();
  }

  async process(job: Job<ScheduleRunJobData>): Promise<void> {
    const { runId, timeLimitSeconds } = job.data;
    this.logger.log(`Solving schedule run ${runId}`);

    // BullMQ increments attemptsMade only after an attempt has failed. Its
    // retry decision is `attemptsMade + 1 < attempts`; use the exact same
    // boundary so the service releases the lease for every retryable failure
    // and writes FAILED only on BullMQ's final delivery.
    const retryOnFailure =
      job.attemptsMade + 1 < Math.max(1, job.opts?.attempts ?? 1);
    const outcome = await this.runs.deliver(runId, {
      timeLimitSeconds,
      executionBudgetSeconds: SELF_HOSTED_EXECUTION_BUDGET_SECONDS,
      executionLeaseSeconds: BULLMQ_EXECUTION_LEASE_SECONDS,
      renewExecutionLease: true,
      retryOnFailure,
      onProgress: async (percent) => {
        await job.updateProgress(percent);
      },
    });

    if (outcome.kind === 'settled' || outcome.kind === 'not_found') return;
    if (outcome.kind === 'busy') {
      throw new Error(`Schedule run ${runId} already has an active lease.`);
    }
    this.logger.log(
      outcome.kind === 'cancelled'
        ? `Schedule run ${runId} cancelled before writing`
        : `Schedule run ${runId}: ${outcome.scheduled} staffed, ${outcome.unassigned} unassigned`,
    );
  }
}

/** Puts a run on the queue. Separated so the controller never touches BullMQ. */
@Injectable()
export class ScheduleRunQueue implements ScheduleRunDispatcher {
  readonly provider = 'bullmq' as const;
  constructor(@InjectQueue(QUEUE_SCHEDULE_RUN) private readonly queue: Queue) {}

  async enqueue(data: ScheduleRunDispatch): Promise<string> {
    const job = await this.queue.add(SCHEDULE_RUN_JOB, data, {
      // The run id is the job id, so submitting the same run twice cannot
      // produce two solves racing each other over the same visits.
      jobId: data.runId,
      attempts: 3,
      // A crashed worker's 60-second DB lease must expire before BullMQ spends
      // another attempt on it. The worker heartbeats the lease while healthy.
      backoff: { type: 'fixed', delay: BULLMQ_RETRY_BACKOFF_MILLISECONDS },
      removeOnComplete: { age: 24 * 3600, count: 200 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
    return job.id ?? data.runId;
  }

  async cancel(jobId: string | null): Promise<void> {
    if (!jobId) return;
    const job = await this.queue.getJob(jobId);
    // Only a job that has not started can simply be removed. A running solve
    // is stopped by the cancel flag the service checks, never by killing it
    // mid-write.
    if (job && (await job.isWaiting())) await job.remove();
  }
}

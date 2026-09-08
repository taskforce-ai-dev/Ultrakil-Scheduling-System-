import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';

import { QUEUE_SCHEDULE_RUN } from '../../queue/queue.constants';
import {
  ScheduleRunDispatch,
  ScheduleRunDispatcher,
} from './schedule-run.dispatcher';
import { ScheduleRunService } from './schedule-run.service';

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

    const result = await this.runs.execute(runId, {
      timeLimitSeconds,
      onProgress: async (percent) => {
        await job.updateProgress(percent);
      },
    });
    this.logger.log(
      result.cancelled
        ? `Schedule run ${runId} cancelled before writing`
        : `Schedule run ${runId}: ${result.scheduled} staffed, ${result.unassigned} unassigned`,
    );
  }
}

/** Puts a run on the queue. Separated so the controller never touches BullMQ. */
@Injectable()
export class ScheduleRunQueue implements ScheduleRunDispatcher {
  constructor(@InjectQueue(QUEUE_SCHEDULE_RUN) private readonly queue: Queue) {}

  async enqueue(data: ScheduleRunDispatch): Promise<string> {
    const job = await this.queue.add(SCHEDULE_RUN_JOB, data, {
      // The run id is the job id, so submitting the same run twice cannot
      // produce two solves racing each other over the same visits.
      jobId: data.runId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
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

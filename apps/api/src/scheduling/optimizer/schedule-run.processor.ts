import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';

import { QUEUE_SCHEDULE_RUN } from '../../queue/queue.constants';
import { ScheduleRunService } from './schedule-run.service';

export interface ScheduleRunJobData {
  runId: string;
  timeLimitSeconds: number;
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

    try {
      const result = await this.runs.execute(runId, {
        timeLimitSeconds,
        onProgress: async (percent) => {
          await job.updateProgress(percent);
          await this.runs.setProgress(runId, percent);
        },
      });
      this.logger.log(
        result.cancelled
          ? `Schedule run ${runId} cancelled before writing`
          : `Schedule run ${runId}: ${result.scheduled} staffed, ${result.unassigned} unassigned`,
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      const code =
        typeof (caught as { code?: unknown }).code === 'string'
          ? (caught as { code: string }).code
          : 'INTERNAL_ERROR';
      // Recorded on the run itself, so a manager sees why rather than a run
      // stuck at "running" forever.
      await this.runs.fail(runId, code, message);
      throw caught;
    }
  }
}

/** Puts a run on the queue. Separated so the controller never touches BullMQ. */
@Injectable()
export class ScheduleRunQueue {
  constructor(@InjectQueue(QUEUE_SCHEDULE_RUN) private readonly queue: Queue) {}

  async enqueue(data: ScheduleRunJobData): Promise<string> {
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

  async cancel(runId: string): Promise<void> {
    const job = await this.queue.getJob(runId);
    // Only a job that has not started can simply be removed. A running solve
    // is stopped by the cancel flag the service checks, never by killing it
    // mid-write.
    if (job && (await job.isWaiting())) await job.remove();
  }
}

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { QUEUE_SCHEDULE_RUN } from './queue.constants';

@Injectable()
export class QueueHealthService {
  constructor(
    @InjectQueue(QUEUE_SCHEDULE_RUN) private readonly scheduleRunQueue: Queue,
  ) {}

  /**
   * Exercises the BullMQ connection to Redis. `waitUntilReady` resolves once the
   * connection is usable and rejects when Redis is unreachable; `getJobCounts`
   * then performs a real round trip. Either failing is what the health indicator
   * turns into a "down" result.
   */
  async ping(): Promise<{ queue: string; jobCounts: Record<string, number> }> {
    await this.scheduleRunQueue.waitUntilReady();
    const jobCounts = await this.scheduleRunQueue.getJobCounts();
    return { queue: this.scheduleRunQueue.name, jobCounts };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { QueueHealthService } from '../queue/queue-health.service';
import { ErrorCode } from '../common/errors/error-codes';
import { DependencyHealthDto, HealthResponseDto } from './health.types';

type Probe = () => Promise<Record<string, unknown> | void>;

class ProbeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Probe did not answer within ${timeoutMs}ms`);
    this.name = 'ProbeTimeoutError';
  }
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueHealth: QueueHealthService,
    private readonly config: ConfigService,
  ) {}

  async check(): Promise<HealthResponseDto> {
    const [database, queue, scheduler] = await Promise.all([
      this.probe(
        () => this.prisma.ping(),
        ErrorCode.DATABASE_UNAVAILABLE,
        'Cannot reach PostgreSQL. Start it with "pnpm dev:infra" and confirm DATABASE_URL in your .env.',
      ),
      this.probe(
        () => this.queueHealth.ping(),
        ErrorCode.QUEUE_UNAVAILABLE,
        'Cannot reach Redis. Start it with "pnpm dev:infra" and confirm REDIS_HOST and REDIS_PORT in your .env.',
      ),
      this.probe(
        () => this.pingScheduler(),
        ErrorCode.SCHEDULER_UNAVAILABLE,
        'Cannot reach the Python scheduling service. Start it with "pnpm dev:scheduler" and confirm SCHEDULER_BASE_URL in your .env.',
      ),
    ]);

    const dependencies = { database, queue, scheduler };
    const status = Object.values(dependencies).every((d) => d.status === 'up')
      ? 'ok'
      : 'degraded';

    return {
      status,
      checkedAt: new Date().toISOString(),
      uptimeSeconds: Number(process.uptime().toFixed(1)),
      dependencies,
    };
  }

  private async probe(
    run: Probe,
    code: string,
    remediation: string,
  ): Promise<DependencyHealthDto> {
    const startedAt = Date.now();
    try {
      const details = await this.withTimeout(run());
      return {
        status: 'up',
        responseTimeMs: Date.now() - startedAt,
        ...(details ? { details } : {}),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Health probe failed (${code}): ${reason}`);
      return {
        status: 'down',
        responseTimeMs: Date.now() - startedAt,
        code,
        message: remediation,
        details: { reason },
      };
    }
  }

  /**
   * Caps a probe so the endpoint always answers.
   *
   * Some clients retry indefinitely by design — BullMQ's Redis connection will
   * wait forever for a server that is down. Without this ceiling,
   * /health/ready would hang at exactly the moment it is most needed.
   */
  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    const timeoutMs = this.config.getOrThrow<number>(
      'app.healthProbeTimeoutMs',
    );

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new ProbeTimeoutError(timeoutMs)),
        timeoutMs,
      );
      // Never hold the event loop open just for this timer.
      timer.unref?.();
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async pingScheduler(): Promise<Record<string, unknown>> {
    const baseUrl = this.config.getOrThrow<string>('scheduler.baseUrl');
    const timeoutMs = this.config.getOrThrow<number>(
      'scheduler.healthTimeoutMs',
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}/health/live`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `Scheduler responded with HTTP ${response.status} ${response.statusText}`,
        );
      }
      return (await response.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
    }
  }
}

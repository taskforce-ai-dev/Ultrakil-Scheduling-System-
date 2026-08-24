import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { QueueHealthService } from '../queue/queue-health.service';
import { HealthService } from './health.service';

/**
 * Health-endpoint tests (ULK-C01) for both the healthy and the unavailable
 * case. The unavailable case matters most: a readiness probe that hangs, or
 * that reports "ok" while the database is down, is worse than none at all.
 */
describe('HealthService', () => {
  const config = {
    getOrThrow: (key: string) => {
      const values: Record<string, unknown> = {
        'app.healthProbeTimeoutMs': 150,
        'scheduler.baseUrl': 'http://scheduler.test',
        'scheduler.healthTimeoutMs': 100,
      };
      return values[key];
    },
  } as unknown as ConfigService;

  const upPrisma = { ping: jest.fn().mockResolvedValue(undefined) };
  const upQueue = {
    ping: jest.fn().mockResolvedValue({ queue: 'schedule-run', jobCounts: {} }),
  };

  const build = (prisma: unknown, queue: unknown) =>
    new HealthService(
      prisma as PrismaService,
      queue as QueueHealthService,
      config,
    );

  const mockSchedulerUp = () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ status: 'ok', service: 'ultrakil-scheduler' }),
    }) as unknown as typeof fetch;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockSchedulerUp();
  });

  it('reports ok when every dependency answers', async () => {
    const result = await build(upPrisma, upQueue).check();

    expect(result.status).toBe('ok');
    expect(result.dependencies.database.status).toBe('up');
    expect(result.dependencies.queue.status).toBe('up');
    expect(result.dependencies.scheduler.status).toBe('up');
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('reports the database down with a stable code and a fix', async () => {
    const downPrisma = {
      ping: jest.fn().mockRejectedValue(new Error('ECONNREFUSED 5432')),
    };

    const result = await build(downPrisma, upQueue).check();

    expect(result.status).toBe('degraded');
    expect(result.dependencies.database.status).toBe('down');
    expect(result.dependencies.database.code).toBe('DATABASE_UNAVAILABLE');
    expect(result.dependencies.database.message).toContain('pnpm dev:infra');
    // One dependency failing must not take the others down with it.
    expect(result.dependencies.queue.status).toBe('up');
    expect(result.dependencies.scheduler.status).toBe('up');
  });

  it('reports the queue down when Redis is unreachable', async () => {
    const downQueue = {
      ping: jest.fn().mockRejectedValue(new Error('Redis connection refused')),
    };

    const result = await build(upPrisma, downQueue).check();

    expect(result.status).toBe('degraded');
    expect(result.dependencies.queue.code).toBe('QUEUE_UNAVAILABLE');
    expect(result.dependencies.queue.message).toContain('REDIS_HOST');
  });

  it('reports the scheduler down on a non-200 response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => ({}),
    }) as unknown as typeof fetch;

    const result = await build(upPrisma, upQueue).check();

    expect(result.dependencies.scheduler.code).toBe('SCHEDULER_UNAVAILABLE');
    expect(result.dependencies.scheduler.details?.reason).toContain('502');
  });

  it('gives up on a probe that never settles, instead of hanging', async () => {
    // BullMQ's Redis client retries forever by design. Without the timeout the
    // readiness endpoint would hang at exactly the moment it is most needed.
    const hangingQueue = { ping: jest.fn(() => new Promise(() => {})) };

    const startedAt = Date.now();
    const result = await build(upPrisma, hangingQueue).check();
    const elapsed = Date.now() - startedAt;

    expect(result.status).toBe('degraded');
    expect(result.dependencies.queue.status).toBe('down');
    expect(result.dependencies.queue.details?.reason).toContain('did not answer');
    expect(elapsed).toBeLessThan(1000);
  });

  it('reports every dependency that is down, not just the first', async () => {
    const downPrisma = { ping: jest.fn().mockRejectedValue(new Error('no db')) };
    const downQueue = { ping: jest.fn().mockRejectedValue(new Error('no redis')) };
    global.fetch = jest.fn().mockRejectedValue(new Error('no scheduler')) as unknown as typeof fetch;

    const result = await build(downPrisma, downQueue).check();

    expect(result.status).toBe('degraded');
    expect(
      Object.values(result.dependencies).every((d) => d.status === 'down'),
    ).toBe(true);
  });
});

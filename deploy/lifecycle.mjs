import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const pending = ['active', 'wait', 'waiting', 'paused', 'delayed', 'prioritized', 'waiting-children'];
export function assertQuiescent(activeRuns, queues) {
  if (activeRuns !== 0 || queues.some(queue => !queue.paused || pending.some(key => (queue.counts[key] ?? 0) !== 0))) {
    throw new Error('Maintenance blocked: active runs or pending queue work remain. Keep ingress closed; investigate or resume draining.');
  }
}
export function assertSameSnapshot(before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Publication state changed during rollback; keep maintenance closed.');
}

export async function runLifecycle(command, env = process.env) {
  if (!['pause', 'check', 'snapshot', 'resume'].includes(command) || env.MAINTENANCE_GATE_CONFIRMED !== 'yes') {
    throw new Error('Require pause/check/snapshot/resume and MAINTENANCE_GATE_CONFIRMED=yes after closing all write ingress.');
  }
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(env.BULLMQ_PREFIX ?? '') || env.REDIS_HOST !== 'redis'
    || !env.REDIS_PASSWORD || new URL(env.DATABASE_URL).hostname !== 'postgres') {
    throw new Error('Maintenance configuration is invalid; values withheld.');
  }
  const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
  const { PrismaClient } = require('@prisma/client');
  const { Queue } = require('bullmq');
  const db = new PrismaClient({ log: [] });
  const queues = ['visit-generation', 'schedule-run'].map(name => new Queue(name, {
    prefix: env.BULLMQ_PREFIX,
    connection: { host: env.REDIS_HOST, port: 6379, password: env.REDIS_PASSWORD, maxRetriesPerRequest: 1,
      retryStrategy: () => null, connectTimeout: 5000 },
  }));
  // Avoid forwarding connection strings or payloads from client error events.
  queues.forEach(queue => queue.on('error', () => {}));
  try {
    if (command === 'resume') {
      for (const queue of queues) await queue.resume();
      return { resumedQueues: queues.length };
    }
    if (command === 'pause') for (const queue of queues) await queue.pause();
    const states = await Promise.all(queues.map(async queue => ({ paused: await queue.isPaused(), counts: await queue.getJobCounts(...pending) })));
    const activeRuns = await db.scheduleRun.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } });
    assertQuiescent(activeRuns, states);
    if (command !== 'snapshot') return { pausedQueues: queues.length, activeRuns, pendingJobs: 0 };
    // A hash detects mutations with unchanged row counts without printing PII.
    // Snapshot all publication-bearing rows in one consistent read transaction.
    return await db.$transaction(async tx => {
      const assignments = await tx.assignment.findMany({ orderBy: { id: 'asc' }, include: {
        crewMembers: { orderBy: { id: 'asc' } }, vehicles: { orderBy: { id: 'asc' } },
      } });
      const outbox = await tx.assignmentNotificationOutbox.findMany({ orderBy: { id: 'asc' } });
      const runs = await tx.scheduleRun.findMany({ orderBy: { id: 'asc' } });
      const keys = outbox.map(row => `${row.assignmentId}:${row.employeeId}:${row.eventType}`);
      if (new Set(keys).size !== keys.length) throw new Error('Duplicate outbox keys');
      return { assignments: assignments.length, outbox: outbox.length, runs: runs.length, duplicateOutbox: 0,
        digest: createHash('sha256').update(JSON.stringify({ assignments, outbox, runs })).digest('hex') };
    }, { isolationLevel: 'RepeatableRead' });
  } finally {
    await Promise.allSettled(queues.map(queue => queue.close()));
    await db.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLifecycle(process.argv[2]).then(result => console.log(JSON.stringify(result))).catch(() => {
    console.error('Maintenance gate failed; raw diagnostics withheld. Keep ingress closed and inspect privately.');
    process.exitCode = 1;
  });
}

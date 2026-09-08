// Fault injection ONLY on the freshly generated synthetic rehearsal namespace.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { PrismaClient } = require('@prisma/client');
const { Queue } = require('bullmq');
const match = new URL(process.env.DATABASE_URL).pathname.match(/^\/ultrakil_rehearsal_([a-f0-9]{12})_test$/);
if (!match || new URL(process.env.DATABASE_URL).hostname !== 'postgres'
  || process.env.BULLMQ_PREFIX !== `ultrakil-rehearsal-${match[1]}`) throw new Error('Synthetic rehearsal only');
const db = new PrismaClient({ log: [] });
const queue = new Queue('schedule-run', { prefix: process.env.BULLMQ_PREFIX,
  connection: { host: 'redis', port: 6379, password: process.env.REDIS_PASSWORD, maxRetriesPerRequest: 1 } });
queue.on('error', () => {});
try {
  const action = process.argv[2];
  if (action === 'active-run') {
    await db.scheduleRun.create({ data: { status: 'RUNNING', requestedByUserId: 'c08-synthetic-maintenance-probe',
      rangeStart: new Date('2026-09-07'), rangeEnd: new Date('2026-09-07') } });
  } else if (action === 'settle-run') {
    const changed = await db.scheduleRun.updateMany({ where: { requestedByUserId: 'c08-synthetic-maintenance-probe', status: 'RUNNING' },
      data: { status: 'CANCELLED' } });
    if (changed.count !== 1) throw new Error('Probe run missing');
  } else if (action === 'queued-job') {
    await queue.add('synthetic-maintenance-probe', { synthetic: true }, { jobId: 'c08-synthetic-maintenance-probe' });
  } else if (action === 'remove-probe-job') {
    const job = await queue.getJob('c08-synthetic-maintenance-probe');
    if (!job || job.data.synthetic !== true) throw new Error('Probe job missing');
    await job.remove();
  } else throw new Error('Unsupported probe');
  console.log(JSON.stringify({ syntheticProbe: 1 }));
} finally { await queue.close(); await db.$disconnect(); }

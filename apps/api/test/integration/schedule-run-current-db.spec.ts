import { BranchCode, PrismaClient } from '@prisma/client';

import { PrismaService } from '../../src/prisma/prisma.service';
import { PublishingService } from '../../src/scheduling/optimizer/publishing.service';
import { ScheduleRunDispatchService } from '../../src/scheduling/optimizer/schedule-run-dispatch.service';
import { ScheduleRunService } from '../../src/scheduling/optimizer/schedule-run.service';
import { ScheduleRunsController } from '../../src/scheduling/optimizer/schedule-runs.controller';
import { ScheduleRunDispatcher } from '../../src/scheduling/optimizer/schedule-run.dispatcher';

const prisma = new PrismaClient();
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
const start = day('2031-03-17');
const end = day('2031-03-23');

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  await prisma.scheduleRun.deleteMany({ where: { rangeStart: start, rangeEnd: end } });
  await prisma.$disconnect();
});

it('reads a published covering run beyond the newest 50 from PostgreSQL', async () => {
  const live = await prisma.scheduleRun.create({
    data: {
      branchCode: BranchCode.COLOMBO, status: 'SUCCEEDED',
      rangeStart: start, rangeEnd: end, visitsScheduled: 6,
      publishedAt: new Date('2031-03-16T09:00:00Z'),
      createdAt: new Date('2031-03-15T09:00:00Z'),
    },
  });
  await prisma.scheduleRun.createMany({
    data: Array.from({ length: 60 }, (_, index) => ({
      branchCode: BranchCode.COLOMBO, status: 'SUCCEEDED' as const,
      rangeStart: start, rangeEnd: end,
      createdAt: new Date(Date.UTC(2031, 2, 18, 0, index)),
    })),
  });
  const controller = new ScheduleRunsController(
    {} as ScheduleRunService,
    { provider: 'qstash' } as ScheduleRunDispatcher,
    {} as PublishingService,
    prisma as unknown as PrismaService,
    {} as ScheduleRunDispatchService,
  );
  const recent = await controller.list({ pageSize: 50 });
  expect(recent.items).toHaveLength(50);
  expect(recent.items.some((run) => run.id === live.id)).toBe(false);

  const current = await controller.list({ currentOn: '2031-03-18', pageSize: 1 });
  expect(current.total).toBe(1);
  expect(current.items.map((run) => run.id)).toEqual([live.id]);
  expect(current.items[0].isPublished).toBe(true);
}, 60_000);

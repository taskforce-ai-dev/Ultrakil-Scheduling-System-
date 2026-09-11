import { BranchCode, ScheduleRunStatus, UserRole } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { ScheduleRunDispatcher } from './schedule-run.dispatcher';
import { ScheduleRunService } from './schedule-run.service';
import { ScheduleRunDispatchService } from './schedule-run-dispatch.service';
import { managerSafeError, ScheduleRunsController } from './schedule-runs.controller';
import { PublishingService } from './publishing.service';

describe('ScheduleRunsController QStash bounds', () => {
  it('forwards the explicit provenance acknowledgement to the publication gate', async () => {
    const publish = jest.fn(async () => ({
      run: {
        id: 'run-1',
        status: ScheduleRunStatus.SUCCEEDED,
        rangeStart: new Date('2027-03-01T00:00:00.000Z'),
        rangeEnd: new Date('2027-03-07T00:00:00.000Z'),
        branchCode: null,
        progressPercent: 100,
        visitsConsidered: 1,
        visitsScheduled: 1,
        visitsUnassigned: 0,
        publishedAt: new Date('2027-03-01T12:00:00.000Z'),
        supersededByRunId: null,
        cancelRequestedAt: null,
        errorCode: null,
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
        createdAt: new Date('2027-03-01T11:00:00.000Z'),
      },
      provenanceWarnings: [],
    }));
    const controller = new ScheduleRunsController(
      {} as ScheduleRunService,
      { provider: 'qstash', enqueue: jest.fn(), cancel: jest.fn() } as ScheduleRunDispatcher,
      { publish } as unknown as PublishingService,
      {} as PrismaService,
      {} as ScheduleRunDispatchService,
    );
    const actor = {
      id: 'actor',
      role: UserRole.ADMIN,
      email: 'actor@example.test',
      fullName: 'Actor',
    };

    await controller.publish(
      '11111111-1111-4111-8111-111111111111',
      {
        reason: 'Manager reviewed restored agreement source data.',
        acknowledgeProvenance: true,
      },
      actor,
    );

    expect(publish).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'Manager reviewed restored agreement source data.',
      actor,
      false,
      true,
    );
  });

  it('never exposes a raw scheduler failure to a manager', () => {
    expect(managerSafeError('fetch https://scheduler.internal/runs failed: Prisma P2025'))
      .toBe('The schedule run could not finish. Retry it, and contact support with the run ID if it persists.');
    expect(managerSafeError(null)).toBeNull();
  });

  it('rejects a QStash range that cannot fit the configured per-day solver budget before creating a run', async () => {
    const runs = { create: jest.fn() };
    const dispatcher = {
      provider: 'qstash',
      maxRangeDays: 9,
      enqueue: jest.fn(),
      cancel: jest.fn(),
    };
    const controller = new ScheduleRunsController(
      runs as unknown as ScheduleRunService,
      dispatcher as ScheduleRunDispatcher,
      {} as PublishingService,
      {} as PrismaService,
      {} as ScheduleRunDispatchService,
    );

    await expect(
      controller.start(
        {
          from: '2027-03-01',
          to: '2027-03-10',
          branchCode: BranchCode.COLOMBO,
        },
        {
          id: 'actor',
          role: UserRole.ADMIN,
          email: 'actor@example.test',
          fullName: 'Actor',
        },
      ),
    ).rejects.toMatchObject({ code: 'SCHEDULE_EXECUTION_BUDGET_EXCEEDED' });
    expect(runs.create).not.toHaveBeenCalled();
  });

  it('keeps polling reads independent from remote reconciliation latency', async () => {
    const dispatches = { reconcilePending: jest.fn() };
    const prisma = {
      scheduleRun: {
        count: jest.fn(async () => 0),
        findMany: jest.fn(async () => []),
      },
    };
    const controller = new ScheduleRunsController(
      {} as ScheduleRunService,
      {
        provider: 'qstash',
        enqueue: jest.fn(),
        cancel: jest.fn(),
      },
      {} as PublishingService,
      prisma as unknown as PrismaService,
      dispatches as unknown as ScheduleRunDispatchService,
    );

    await expect(controller.list({})).resolves.toMatchObject({
      items: [],
      total: 0,
    });
    expect(dispatches.reconcilePending).not.toHaveBeenCalled();
  });

  it('invokes durable BullMQ recovery from a polling read', async () => {
    const dispatches = {
      reconcilePending: jest.fn(async () => undefined),
    };
    const prisma = {
      scheduleRun: {
        count: jest.fn(async () => 0),
        findMany: jest.fn(async () => []),
      },
    };
    const controller = new ScheduleRunsController(
      {} as ScheduleRunService,
      {
        provider: 'bullmq',
        enqueue: jest.fn(),
        cancel: jest.fn(),
      },
      {} as PublishingService,
      prisma as unknown as PrismaService,
      dispatches as unknown as ScheduleRunDispatchService,
    );

    await controller.list({});

    expect(dispatches.reconcilePending).toHaveBeenCalledTimes(1);
  });
});

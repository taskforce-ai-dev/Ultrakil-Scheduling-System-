import {
  AssignmentStatus,
  BranchCode,
  DataProvenance,
  ScheduleRun,
  ScheduleRunStatus,
  SiteBranchConfidence,
  SiteBranchSource,
  UserRole,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { ScheduleRunDispatcher } from './schedule-run.dispatcher';
import { ScheduleRunService } from './schedule-run.service';
import { ScheduleRunDispatchService } from './schedule-run-dispatch.service';
import { managerSafeError, ScheduleRunsController } from './schedule-runs.controller';
import { PublishingService } from './publishing.service';

function run(overrides: Partial<ScheduleRun> = {}): ScheduleRun {
  return {
    id: 'run',
    status: ScheduleRunStatus.SUCCEEDED,
    rangeStart: new Date('2027-03-01T00:00:00Z'),
    rangeEnd: new Date('2027-03-07T00:00:00Z'),
    branchCode: BranchCode.COLOMBO,
    progressPercent: 100,
    visitsConsidered: 4,
    visitsScheduled: 4,
    visitsUnassigned: 0,
    publishedAt: null,
    supersededByRunId: null,
    cancelRequestedAt: null,
    errorCode: null,
    errorMessage: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date('2027-03-01T00:00:00Z'),
    ...overrides,
  } as ScheduleRun;
}

describe('ScheduleRunsController QStash bounds', () => {
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

  it('reads readiness for a page of runs with one scalar-only query, and skips runs with no decision left', async () => {
    const rows = [
      run({ id: 'draft-run' }),
      run({ id: 'published-run', publishedAt: new Date('2027-03-02T10:00:00Z') }),
      run({ id: 'empty-run', visitsScheduled: 0, visitsUnassigned: 4 }),
    ];
    const assignment = {
      findMany: jest.fn(async () => [
        {
          scheduleRunId: 'draft-run',
          generatedVisitId: 'visit',
          generatedVisit: {
            windowProvenance: DataProvenance.DEFAULTED,
            serviceAgreement: {
              crewSizeProvenance: DataProvenance.SOURCE,
              durationProvenance: DataProvenance.SOURCE,
              dayRuleProvenance: DataProvenance.SOURCE,
              serviceSite: {
                branchConfidence: SiteBranchConfidence.CONFIRMED,
                branchSource: SiteBranchSource.MANAGER_CONFIRMED,
              },
            },
          },
          vehicles: [],
        },
      ]),
    };
    const prisma = {
      assignment,
      scheduleRun: {
        count: jest.fn(async () => rows.length),
        findMany: jest.fn(async () => rows),
      },
    };
    const controller = new ScheduleRunsController(
      {} as ScheduleRunService,
      { provider: 'qstash', enqueue: jest.fn(), cancel: jest.fn() },
      {} as PublishingService,
      prisma as unknown as PrismaService,
      { reconcilePending: jest.fn() } as unknown as ScheduleRunDispatchService,
    );

    const page = await controller.list({});

    // One query for the whole page, and only for the run that can still be
    // published — never a per-run assignment object graph.
    expect(assignment.findMany).toHaveBeenCalledTimes(1);
    const [args] = assignment.findMany.mock.calls[0] as unknown as [
      { where: unknown; select: Record<string, unknown>; include?: unknown },
    ];
    expect(args.include).toBeUndefined();
    expect(args.where).toEqual({
      scheduleRunId: { in: ['draft-run'] },
      status: AssignmentStatus.DRAFT,
    });
    expect(Object.keys(args.select).sort()).toEqual([
      'generatedVisit',
      'generatedVisitId',
      'scheduleRunId',
      'vehicles',
    ]);
    expect(page.items[0].publishReadiness).toMatchObject({
      state: 'ACKNOWLEDGEMENT_REQUIRED',
      requiresProvenanceAcknowledgement: true,
      provenanceWarnings: [
        expect.objectContaining({ code: 'HOURS_UNCONFIRMED', affectedVisitCount: 1 }),
      ],
    });
    expect(page.items[1].publishReadiness.provenanceWarnings).toEqual([]);
    expect(page.items[2].publishReadiness).toMatchObject({ state: 'BLOCKED' });
  });

  it('does not read assignments at all when no run on the page can be published', async () => {
    const assignment = { findMany: jest.fn() };
    const prisma = {
      assignment,
      scheduleRun: {
        count: jest.fn(async () => 1),
        findMany: jest.fn(async () => [
          run({ id: 'published-run', publishedAt: new Date('2027-03-02T10:00:00Z') }),
        ]),
      },
    };
    const controller = new ScheduleRunsController(
      {} as ScheduleRunService,
      { provider: 'qstash', enqueue: jest.fn(), cancel: jest.fn() },
      {} as PublishingService,
      prisma as unknown as PrismaService,
      { reconcilePending: jest.fn() } as unknown as ScheduleRunDispatchService,
    );

    await controller.list({});

    expect(assignment.findMany).not.toHaveBeenCalled();
  });
});

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
    jobId: null,
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

  it('rejects a QStash range that cannot fit a locked joint phase before creating a run', async () => {
    const runs = { create: jest.fn() };
    const dispatcher = {
      provider: 'qstash',
      maxRangeDays: 8,
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
          to: '2027-03-09',
          branchCode: BranchCode.COLOMBO,
        },
        {
          id: 'actor',
          role: UserRole.ADMIN,
          email: 'actor@example.test',
          fullName: 'Actor',
        },
      ),
    ).rejects.toMatchObject({
      code: 'SCHEDULE_EXECUTION_BUDGET_EXCEEDED',
      details: { days: 9, maximumDays: 8, provider: 'qstash' },
    });
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

  it('asks PostgreSQL for published runs covering the requested day, ordered by publication', async () => {
    const prisma = {
      scheduleRun: {
        count: jest.fn(async () => 0),
        findMany: jest.fn(async () => []),
      },
    };
    const controller = new ScheduleRunsController(
      {} as ScheduleRunService,
      { provider: 'qstash', enqueue: jest.fn(), cancel: jest.fn() },
      {} as PublishingService,
      prisma as unknown as PrismaService,
      {} as ScheduleRunDispatchService,
    );
    await controller.list({ currentOn: '2029-04-05', pageSize: 1 });
    expect(prisma.scheduleRun.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        publishedAt: { not: null },
        rangeStart: { lte: new Date('2029-04-05T00:00:00Z') },
        rangeEnd: { gte: new Date('2029-04-05T00:00:00Z') },
      }),
    });
    expect(prisma.scheduleRun.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 1,
      orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
    }));
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
    // Solver runs: each was dispatched, which is what makes it one.
    const solved = { dispatchOutbox: { id: 'outbox' } };
    const rows = [
      { ...run({ id: 'draft-run' }), ...solved },
      { ...run({ id: 'published-run', publishedAt: new Date('2027-03-02T10:00:00Z') }), ...solved },
      { ...run({ id: 'empty-run', visitsScheduled: 0, visitsUnassigned: 4 }), ...solved },
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
    expect(page.items[1].publishReadiness).not.toBeNull();
    expect(page.items[1].publishReadiness?.provenanceWarnings).toEqual([]);
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

describe('a visit-generation run is not an optimiser draft', () => {
  /**
   * Confirming "Generate visits" writes a `schedule_runs` row to account for
   * what it did. Schedule History listed it beside the solver's runs, read its
   * visitsScheduled of 0 and badged it "Draft — no dispatchable assignments" —
   * which a manager reads as a schedule that failed.
   *
   * Every optimiser run is created with a dispatch outbox row, in the same
   * transaction; generation creates none. That is what tells the two apart on
   * the read side, without changing a thing about what generation records.
   */
  const controllerFor = (rows: unknown[], assignment = { findMany: jest.fn(async () => []) }) => {
    const prisma = {
      assignment,
      scheduleRun: {
        count: jest.fn(async () => rows.length),
        findMany: jest.fn(async () => rows),
        findUniqueOrThrow: jest.fn(async () => rows[0]),
      },
    };
    return new ScheduleRunsController(
      {} as ScheduleRunService,
      { provider: 'qstash', enqueue: jest.fn(), cancel: jest.fn() },
      {} as PublishingService,
      prisma as unknown as PrismaService,
      { reconcilePending: jest.fn() } as unknown as ScheduleRunDispatchService,
    );
  };

  it('is reported as visit generation, not as a solver run', async () => {
    const page = await controllerFor([
      { ...run({ id: 'generation', visitsConsidered: 105, visitsScheduled: 0 }), dispatchOutbox: null },
    ]).list({});

    expect(page.items[0].kind).toBe('VISIT_GENERATION');
  });

  it('carries no publish readiness at all, rather than a blocked one', async () => {
    // "This run produced no dispatchable assignments and cannot be published"
    // is true of every generation run and useful about none of them.
    const page = await controllerFor([
      { ...run({ id: 'generation', visitsConsidered: 105, visitsScheduled: 0 }), dispatchOutbox: null },
    ]).list({});

    expect(page.items[0].publishReadiness).toBeNull();
  });

  it('leaves a solver run reading exactly as it did', async () => {
    const page = await controllerFor([
      { ...run({ id: 'solved', visitsScheduled: 0, visitsUnassigned: 4 }), dispatchOutbox: { id: 'outbox' } },
    ]).list({});

    expect(page.items[0].kind).toBe('OPTIMIZER');
    expect(page.items[0].publishReadiness).toMatchObject({
      state: 'BLOCKED',
      code: 'ZERO_RESULTS',
    });
  });

  it('reads a solve from before the outbox existed as a solve', async () => {
    // The outbox arrived with migration 20260908093000. Every optimiser run
    // solved before it has no row, and reading those as generation badged a
    // real schedule "Draft — no dispatchable assignments". The queue delivery
    // id is a mark only a solve ever carries.
    const page = await controllerFor([
      {
        ...run({ id: 'legacy-solve', visitsScheduled: 0, jobId: 'qstash-message-1' }),
        dispatchOutbox: null,
      },
    ]).list({});

    expect(page.items[0].kind).toBe('OPTIMIZER');
  });

  it('reads one with no delivery id but real results as a solve too', async () => {
    // A run that scheduled visits scheduled them: generation writes a run to
    // account for what it did and leaves visitsScheduled at zero, always.
    const page = await controllerFor([
      { ...run({ id: 'legacy-solve-2', visitsScheduled: 6 }), dispatchOutbox: null },
    ]).list({});

    expect(page.items[0].kind).toBe('OPTIMIZER');
  });

  it('still reads a generation run — no outbox, no delivery, no results — as generation', async () => {
    const page = await controllerFor([
      {
        ...run({ id: 'generation', visitsScheduled: 0, jobId: null }),
        dispatchOutbox: null,
      },
    ]).list({});

    expect(page.items[0].kind).toBe('VISIT_GENERATION');
  });

  it('never reads assignments to judge a generation run', async () => {
    const assignment = { findMany: jest.fn(async () => []) };
    await controllerFor(
      [
        { ...run({ id: 'generation', visitsScheduled: 0 }), dispatchOutbox: null },
        { ...run({ id: 'publishable', visitsScheduled: 4 }), dispatchOutbox: { id: 'outbox' } },
      ],
      assignment,
    ).list({});

    const [args] = assignment.findMany.mock.calls[0] as unknown as [
      { where: { scheduleRunId: { in: string[] } } },
    ];
    expect(args.where.scheduleRunId.in).toEqual(['publishable']);
  });

  it('says so on a single run too, not only in the list', async () => {
    const dto = await controllerFor([
      { ...run({ id: 'generation', visitsScheduled: 0 }), dispatchOutbox: null },
    ]).get('generation');

    expect(dto.kind).toBe('VISIT_GENERATION');
    expect(dto.publishReadiness).toBeNull();
  });
});

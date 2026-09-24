import { ConfigService } from '@nestjs/config';
import {
  AssignmentStatus,
  BranchCode,
  CrewRole,
  DayRuleKind,
  FrequencyUnit,
  LockScope,
  Prisma,
  ScheduleRunStatus,
  VisitPlacement,
  VisitStatus,
  Weekday,
} from '@prisma/client';
import { Job } from 'bullmq';

import { AuditService } from '../../audit/audit.service';
import { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../prisma/prisma.service';
import { EligibilityService } from '../eligibility/eligibility.service';
import { BranchDayCapacityService } from '../visit-generation/branch-day-capacity.service';
import {
  BRANCH_DAY_LOCK_CLASS,
  branchDayLockKey,
} from './branch-day-lock';
import {
  ScheduleRunJobData,
  ScheduleRunProcessor,
} from './schedule-run.processor';
import { ScheduleRunService, solvedCrewRoles } from './schedule-run.service';
import {
  BULLMQ_EXECUTION_LEASE_SECONDS,
  BULLMQ_LEASE_HEARTBEAT_MILLISECONDS,
  SELF_HOSTED_EXECUTION_BUDGET_SECONDS,
} from './schedule-run-execution-budget';
import { SchedulerClient, SolveRequest, SolveResponse } from './scheduler.client';
import { PublishingService } from './publishing.service';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(
  scheduledDate = '2027-03-03',
  initialStatus: AssignmentStatus = AssignmentStatus.DRAFT,
  /**
   * How many visits each branch-day already carries, for the backstop that
   * refuses a move on to a full one. Days left out are empty, which is what a
   * week nobody has planned yet looks like.
   */
  dayLoad: Record<string, number> = {},
) {
  const started = deferred<void>();
  const answer = deferred<SolveResponse>();
  const visit = {
    id: 'visit',
    updatedAt: new Date('2027-02-01T00:00:00Z'),
    branchId: 'branch',
    branchCode: BranchCode.COLOMBO,
    visitDate: new Date('2027-03-03T00:00:00Z'),
    isManuallyAdjusted: false,
    lockedAt: null as Date | null,
    windowStartMinute: 540,
    windowEndMinute: 720,
    durationMinutes: 90,
    requiredCrewSize: 1,
    status: VisitStatus.SCHEDULED,
    placement: VisitPlacement.ANCHORED as VisitPlacement,
    serviceAgreementId: 'agreement',
    serviceAgreement: {
      startDate: new Date('2027-03-01T00:00:00Z'),
      endDate: null,
      frequencyUnit: FrequencyUnit.WEEK,
      frequencyInterval: 1,
      requiredSkills: [],
      dayRules: [
        { weekday: Weekday.WEDNESDAY, kind: DayRuleKind.ALLOWED },
        { weekday: Weekday.THURSDAY, kind: DayRuleKind.ALLOWED },
      ] as { weekday: Weekday; kind: DayRuleKind }[],
      serviceSiteId: 'site',
      serviceWindowStartMinute: 540,
      serviceWindowEndMinute: 720,
      serviceSite: { operatingHours: [] as { weekday: Weekday; opensAtMinute: number; closesAtMinute: number }[] },
    },
  };
  const oldAssignment = {
    id: 'snapshotted',
    status: initialStatus,
    plannedStart: new Date('2027-03-03T10:00:00Z'),
    plannedEnd: new Date('2027-03-03T11:30:00Z'),
    crewMembers: [{ employeeId: 'employee', role: CrewRole.SUPERVISOR, isPmsSupervisor: true }],
    vehicles: [],
    locks: [] as { scope: LockScope; releasedAt: Date | null }[],
  };
  const assignments = [oldAssignment];
  const outbox: {
    id: string;
    assignmentId: string;
    payload: { visitDate: string };
  }[] = [];
  const run = {
    id: 'run',
    branchCode: BranchCode.COLOMBO,
    status: ScheduleRunStatus.QUEUED as ScheduleRunStatus,
    rangeStart: new Date('2027-03-01T00:00:00Z'),
    rangeEnd: new Date('2027-03-07T00:00:00Z'),
    cancelRequestedAt: null as Date | null,
    startedAt: null as Date | null,
    executionLeaseId: null as string | null,
    executionLeaseExpiresAt: null as Date | null,
    executionAttempt: 0,
    timeLimitSeconds: 1,
    jobId: 'msg_current' as string | null,
    errorCode: null as string | null,
    errorMessage: null as string | null,
  };
  const dispatchOutbox = {
    id: 'ab839d87-6e0d-4b08-a6d1-f3e352a6f4a4',
    scheduleRunId: run.id,
    provider: 'QSTASH',
    status: 'PUBLISHED',
    messageId: run.jobId as string | null,
    terminalFailureMessageId: null as string | null,
    terminalFailureCode: null as string | null,
    terminalFailureMessage: null as string | null,
    terminalFailureAt: null as Date | null,
  };
  // Model deletion and its FK cascade at the database boundary. The service,
  // snapshot, solver barrier and queue failure handler run unchanged.
  const remove = (id: string, statuses?: AssignmentStatus[]) => {
    const index = assignments.findIndex(
      (a) => a.id === id && (!statuses || statuses.includes(a.status)),
    );
    if (index === -1) return 0;
    assignments.splice(index, 1);
    for (let i = outbox.length - 1; i >= 0; i--) {
      if (outbox[i].assignmentId === id) outbox.splice(i, 1);
    }
    return 1;
  };
  const assignment = {
    findMany: jest.fn(
      async ({ where }: { where: { status?: { in: AssignmentStatus[] } } }) =>
        assignments
          .filter(
            (entry) => !where.status || where.status.in.includes(entry.status),
          )
          .map((entry) => ({
            ...entry,
            publishedAt: null,
            _count: {
              notificationOutboxEntries: outbox.filter(
                (notice) => notice.assignmentId === entry.id,
              ).length,
            },
          })),
    ),
    delete: jest.fn(async ({ where }: { where: { id: string } }) =>
      remove(where.id),
    ),
    deleteMany: jest.fn(
      async ({
        where,
      }: {
        where: { id: string; status?: { in: AssignmentStatus[] } };
      }) => ({ count: remove(where.id, where.status?.in) }),
    ),
    updateMany: jest.fn(
      async ({
        where,
        data,
      }: {
        where: { id: string; status: { in: AssignmentStatus[] } };
        data: { status: AssignmentStatus };
      }) => {
        const current = assignments.find(
          (entry) =>
            entry.id === where.id && where.status.in.includes(entry.status),
        );
        if (!current) return { count: 0 };
        current.status = data.status;
        return { count: 1 };
      },
    ),
    create: jest.fn(async () => {
      const replacement = {
        ...oldAssignment,
        id: 'replacement',
        status: AssignmentStatus.DRAFT,
      };
      assignments.push(replacement);
      return replacement;
    }),
  };
  // The day-load read: how many crew-minutes each branch-day the run would
  // move work between already carries. Each unit of `dayLoad` stands for a
  // one-hour, one-crew reference visit, so `{ '2027-03-04': 12 }` reads
  // exactly as it did when the cap was a raw count: twelve of them are
  // seven hundred and twenty crew-minutes, the default cap itself.
  const dayLoadFindMany = jest.fn(
    async ({ where }: { where: { branchCode: { in: BranchCode[] }; visitDate: { in: Date[] } } }) =>
      where.visitDate.in.flatMap((visitDate) => {
        const date = visitDate.toISOString().slice(0, 10);
        return Array.from({ length: dayLoad[date] ?? 0 }, () => ({
          branchCode: where.branchCode.in[0],
          visitDate,
          durationMinutes: 60,
          requiredCrewSize: 1,
        }));
      }),
  );
  const generatedVisit = {
    findMany: jest.fn(
      async (args?: { where?: { branchCode?: { in: BranchCode[] } | BranchCode } }) =>
        args?.where?.branchCode && typeof args.where.branchCode === 'object'
          ? dayLoadFindMany(args as never)
          : [{ ...visit, assignments: assignments.map((a) => ({
            ...a,
            publishedAt: (a as typeof a & { publishedAt?: Date | null }).publishedAt ?? null,
            _count: { notificationOutboxEntries: outbox.filter((notice) => notice.assignmentId === a.id).length },
            locks: a.locks.filter((lock) => lock.releasedAt === null),
          })) }],
    ),
    findUniqueOrThrow: jest.fn(async (args?: {
      select?: { assignments?: { select?: { locks?: { where?: { releasedAt: null } } } } };
    }) => ({
      ...visit,
      assignments: assignments.map((assignment) => ({
        ...assignment,
        locks: args?.select?.assignments?.select?.locks?.where
          ? assignment.locks.filter((lock) => lock.releasedAt === null)
          : assignment.locks,
      })),
    })),
    update: jest.fn(async ({ data }: { data: Partial<typeof visit> }) =>
      Object.assign(visit, data),
    ),
    /** The day-load half of `findMany`, exposed so tests can assert on it alone. */
    dayLoadFindMany,
  };
  const scheduleRun = {
    findUnique: jest.fn(async () => ({ ...run })),
    update: jest.fn(async ({ data }: { data: Partial<typeof run> }) =>
      Object.assign(run, data),
    ),
    updateMany: jest.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const matches = (condition: Record<string, unknown>): boolean => {
          if (condition.id && condition.id !== run.id) return false;
          if (condition.jobId && condition.jobId !== run.jobId) return false;
          if (condition.status) {
            const status = condition.status as
              ScheduleRunStatus | { in?: ScheduleRunStatus[] };
            if (typeof status === 'string' && status !== run.status)
              return false;
            if (
              typeof status === 'object' &&
              status.in &&
              !status.in.includes(run.status)
            )
              return false;
          }
          if (condition.cancelRequestedAt === null && run.cancelRequestedAt)
            return false;
          if (
            typeof condition.cancelRequestedAt === 'object' &&
            condition.cancelRequestedAt &&
            'not' in condition.cancelRequestedAt &&
            !run.cancelRequestedAt
          )
            return false;
          if (
            condition.executionLeaseId !== undefined &&
            condition.executionLeaseId !== run.executionLeaseId
          )
            return false;
          const dispatchRelation = condition.dispatchOutbox as
            | {
                is?: {
                  id?: string;
                  status?: { in?: string[] };
                  terminalFailureAt?: Date | null;
                };
              }
            | undefined;
          if (dispatchRelation?.is) {
            if (
              dispatchRelation.is.id &&
              dispatchRelation.is.id !== dispatchOutbox.id
            ) {
              return false;
            }
            if (
              dispatchRelation.is.status?.in &&
              !dispatchRelation.is.status.in.includes(dispatchOutbox.status)
            ) {
              return false;
            }
            if (
              dispatchRelation.is.terminalFailureAt === null &&
              dispatchOutbox.terminalFailureAt !== null
            ) {
              return false;
            }
          }
          if (
            condition.executionLeaseExpiresAt === null &&
            run.executionLeaseExpiresAt
          )
            return false;
          const expiry = condition.executionLeaseExpiresAt as
            { gt?: Date; lt?: Date; lte?: Date } | undefined;
          if (
            expiry?.gt &&
            (!run.executionLeaseExpiresAt ||
              run.executionLeaseExpiresAt <= expiry.gt)
          )
            return false;
          if (
            expiry?.lt &&
            (!run.executionLeaseExpiresAt ||
              run.executionLeaseExpiresAt >= expiry.lt)
          )
            return false;
          if (
            expiry?.lte &&
            (!run.executionLeaseExpiresAt ||
              run.executionLeaseExpiresAt > expiry.lte)
          )
            return false;
          const conjunction = condition.AND as
            | Record<string, unknown>[]
            | undefined;
          if (conjunction && !conjunction.every(matches)) return false;
          const alternatives = condition.OR as
            Record<string, unknown>[] | undefined;
          return !alternatives || alternatives.some(matches);
        };
        if (!matches(where)) return { count: 0 };
        for (const [key, value] of Object.entries(data)) {
          if (typeof value === 'object' && value && 'increment' in value) {
            (run as Record<string, unknown>)[key] =
              Number((run as Record<string, unknown>)[key] ?? 0) +
              Number((value as { increment: number }).increment);
          } else {
            (run as Record<string, unknown>)[key] = value;
          }
        }
        return { count: 1 };
      },
    ),
  };
  const scheduleRunDispatchOutbox = {
    create: jest.fn(),
    findUnique: jest.fn(async () => ({ ...dispatchOutbox })),
    updateMany: jest.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (where.id && where.id !== dispatchOutbox.id) return { count: 0 };
        if (
          where.scheduleRunId &&
          where.scheduleRunId !== dispatchOutbox.scheduleRunId
        ) {
          return { count: 0 };
        }
        if (where.provider && where.provider !== dispatchOutbox.provider) {
          return { count: 0 };
        }
        const status = where.status as string | { in?: string[] } | undefined;
        if (
          (typeof status === 'string' && status !== dispatchOutbox.status) ||
          (typeof status === 'object' &&
            status.in &&
            !status.in.includes(dispatchOutbox.status))
        ) {
          return { count: 0 };
        }
        const alternatives = where.OR as Record<string, unknown>[] | undefined;
        if (
          alternatives &&
          !alternatives.some((alternative) =>
            alternative.messageId === null
              ? dispatchOutbox.messageId === null
              : alternative.messageId === dispatchOutbox.messageId,
          )
        ) {
          return { count: 0 };
        }
        Object.assign(dispatchOutbox, data);
        return { count: 1 };
      },
    ),
  };
  const tx = {
    scheduleRun,
    scheduleRunDispatchOutbox,
    assignment,
    assignmentLock: { updateMany: jest.fn() },
    serviceAgreement: {
      findMany: jest.fn(async () => [{ serviceSiteId: 'site' }]),
    },
    generatedVisit,
    visitUnassignedReason: { deleteMany: jest.fn(), createMany: jest.fn() },
    // Read by `BranchDayCapacityService` inside the same transaction the
    // daily-cap backstop runs in — one PMS-grade employee and no vehicles,
    // matching the plain `prisma.employee`/`prisma.vehicle` mocks below, so
    // capacity is real and available rather than the branch reading as
    // having no workforce recorded at all.
    employee: {
      findMany: jest.fn(async () => [
        {
          id: 'employee',
          branchCode: BranchCode.COLOMBO,
          isPmsGrade: true,
          permanentAssignments: [],
          skills: [],
          vehicleAuthorizations: [],
          availability: [],
        },
      ]),
    },
    vehicle: { findMany: jest.fn(async () => []) },
    // The branch-day advisory lock. It returns a row count rather than rows,
    // which is why it is `$executeRaw` and not the `$queryRaw` the row locks use.
    $executeRaw: jest.fn(async () => 1),
    $queryRaw: jest.fn(async (query: Prisma.Sql) =>
      query.sql.includes('generated_visits')
        ? [{ id: visit.id }]
        : query.sql.includes('service_agreements')
          ? [{ id: visit.serviceAgreementId }]
          : query.sql.includes('service_sites')
            ? [{ id: 'site' }]
          : query.sql.includes('employees')
            ? query.values.map((id) => ({ id }))
            : query.sql.includes('vehicles')
              ? query.values.map((id) => ({ id }))
        : assignments
            .filter((entry) => entry.id === query.values[0])
            .map((entry) => ({ status: entry.status })),
    ),
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn(
      async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
    ),
  };
  const eligibility = {
    evaluate: jest.fn(async () => ({ isEligible: true, conflicts: [] })),
  };
  const scheduler = {
    solve: jest.fn(() => {
      started.resolve();
      return answer.promise;
    }),
  };
  const service = new ScheduleRunService(
    prisma as unknown as PrismaService,
    scheduler as unknown as SchedulerClient,
    eligibility as unknown as EligibilityService,
    {} as AuditService,
    // A 720-minute workday for the mock's one PMS-grade employee — this
    // fixture's real resource-derived capacity therefore lands on exactly
    // the same 720-crew-minute (twelve reference-hour) figure the daily-cap
    // backstop tests below were written against, so their own numbers stay
    // meaningful rather than being about dispatch/locking mechanics alone.
    new BranchDayCapacityService(
      prisma as unknown as PrismaService,
      {
        get: (key: string) =>
          key === 'visitGeneration.employeeWorkdayMinutes' ? 720 : undefined,
      } as unknown as ConfigService,
    ),
  );
  const processor = new ScheduleRunProcessor(service, {
    isCurrentDispatch: jest.fn(async () => true),
  } as never);
  const job = {
    data: {
      runId: run.id,
      dispatchId: dispatchOutbox.id,
      timeLimitSeconds: 1,
    },
    updateProgress: jest.fn(),
  } as unknown as Job<ScheduleRunJobData>;
  const release = (unassigned = false) =>
    answer.resolve({
      run_id: run.id,
      status: 'OPTIMAL',
      assignments: unassigned
        ? []
        : [
            {
              visit_id: visit.id,
              employee_ids: ['employee'],
              vehicles: [],
              start_minute: 600,
              scheduled_date: scheduledDate,
            },
          ],
      unassigned: unassigned
        ? [
            {
              visit_id: visit.id,
              reason_codes: ['NO_CREW'],
              message: 'No crew available',
            },
          ]
        : [],
      solve_seconds: 0,
      objective_value: 0,
      visits_considered: 1,
    });
  return {
    answer,
    started,
    release,
    processor,
    service,
    scheduler,
    job,
    run,
    visit,
    oldAssignment,
    assignments,
    outbox,
    assignment,
    generatedVisit,
    eligibility,
    reasons: tx.visitUnassignedReason,
    prisma,
    tx,
    dispatchOutbox,
  };
}

describe('solver replacement lifecycle fence', () => {
  it.each([LockScope.TIME, LockScope.FULL])(
    'encodes a %s-locked appointment ending at next-day midnight as minute 1440', async (scope) => {
    const f = fixture();
    f.oldAssignment.plannedStart = new Date('2027-03-03T22:30:00Z');
    f.oldAssignment.plannedEnd = new Date('2027-03-04T00:00:00Z');
    f.oldAssignment.locks.push({ scope, releasedAt: null });
    f.visit.windowStartMinute = 1350;
    f.visit.windowEndMinute = 1440;
    f.visit.serviceAgreement.serviceWindowStartMinute = 1350;
    f.visit.serviceAgreement.serviceWindowEndMinute = 1440;
    f.visit.serviceAgreement.serviceSite.operatingHours = [
      { weekday: Weekday.WEDNESDAY, opensAtMinute: 1350, closesAtMinute: 1440 },
    ];

    const pending = f.service.execute(f.run.id);
    await f.started.promise;
    const request = (f.scheduler.solve.mock.calls as unknown as [SolveRequest][])[0][0];
    expect(request.locks[0]).toMatchObject({ start_minute: 1350, end_minute: 1440 });
    f.answer.resolve({
      run_id: f.run.id, status: 'OPTIMAL',
      assignments: [{ visit_id: f.visit.id, employee_ids: ['employee'], vehicles: [],
        start_minute: 1350, scheduled_date: '2027-03-03' }],
      unassigned: [], solve_seconds: 0, objective_value: 0, visits_considered: 1,
    });
    await expect(pending).resolves.toMatchObject({ scheduled: 1 });
  });

  it('keeps a BOOKED visit on its stored fallback window when that weekday has no site hours', async () => {
    const f = fixture();
    f.visit.placement = VisitPlacement.BOOKED;
    f.visit.windowEndMinute = 1020;
    f.visit.serviceAgreement.serviceWindowEndMinute = 1020;
    f.visit.serviceAgreement.serviceSite.operatingHours = [
      { weekday: Weekday.THURSDAY, opensAtMinute: 480, closesAtMinute: 1020 },
    ];

    const pending = f.service.execute(f.run.id);
    await f.started.promise;
    const request = (f.scheduler.solve.mock.calls as unknown as [SolveRequest][])[0][0];
    expect(request.visits[0].candidate_slots).toEqual([
      expect.objectContaining({ date: '2027-03-03', earliest_start_minute: 540, latest_start_minute: 930 }),
    ]);
    f.release();
    await expect(pending).resolves.toMatchObject({ scheduled: 1 });
    expect(f.visit.visitDate).toEqual(new Date('2027-03-03T00:00:00Z'));
  });

  it('keeps SUPERVISOR distinct from CREW when composing active locks', async () => {
    const f = fixture();
    f.oldAssignment.locks.push(
      { scope: LockScope.SUPERVISOR, releasedAt: null },
      { scope: LockScope.TIME, releasedAt: null },
      { scope: LockScope.CREW, releasedAt: new Date('2027-02-02T00:00:00Z') },
    );
    const pending = f.service.execute(f.run.id);
    await f.started.promise;
    const request = (f.scheduler.solve.mock.calls as unknown as [SolveRequest][])[0][0];
    expect(request.locks.map((lock) => lock.scope)).toEqual(['SUPERVISOR', 'TIME']);
    expect(request.locks[0].employee_ids).toEqual(['employee']);
    f.release();
    await expect(pending).resolves.toMatchObject({ scheduled: 1 });
  });

  it('uses the PMS-qualified crew identity when a supervisor pin has no role marker', async () => {
    const f = fixture();
    Object.assign(f.oldAssignment, {
      crewMembers: [{
        employeeId: 'employee',
        role: CrewRole.TECHNICIAN,
        isPmsSupervisor: true,
      }],
    });
    f.oldAssignment.locks.push({ scope: LockScope.SUPERVISOR, releasedAt: null });

    const pending = f.service.execute(f.run.id);
    await f.started.promise;
    const request = (f.scheduler.solve.mock.calls as unknown as [SolveRequest][])[0][0];

    expect(request.locks).toEqual([
      expect.objectContaining({
        scope: LockScope.SUPERVISOR,
        employee_ids: ['employee'],
      }),
    ]);
    f.release();
    await expect(pending).resolves.toMatchObject({ scheduled: 1 });
  });

  it('rejects a stale response that replaces a pinned supervisor while retaining a PMS-grade crew', async () => {
    const f = fixture();
    f.oldAssignment.locks.push({ scope: LockScope.SUPERVISOR, releasedAt: null });
    const pending = f.service.execute(f.run.id);
    await f.started.promise;
    f.answer.resolve({
      run_id: f.run.id, status: 'OPTIMAL',
      assignments: [{ visit_id: f.visit.id, employee_ids: ['other'], vehicles: [], start_minute: 600, scheduled_date: '2027-03-03' }],
      unassigned: [], solve_seconds: 0, objective_value: 0, visits_considered: 1,
    });
    await expect(pending).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(f.assignment.create).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'crew under combined TIME and CREW locks', scopes: [LockScope.TIME, LockScope.CREW], crew: ['other'], driver: null },
    { name: 'driver under a VEHICLE lock', scopes: [LockScope.VEHICLE], crew: ['employee'], driver: 'other' },
  ])('rejects a stale solver replacement of the $name', async ({ scopes, crew, driver }) => {
    const f = fixture();
    Object.assign(f.oldAssignment, {
      locks: scopes.map((scope) => ({ scope, releasedAt: null })),
      vehicles: driver ? [{ vehicleId: 'van', driverEmployeeId: 'employee' }] : [],
    });
    const pending = f.service.execute(f.run.id);
    await f.started.promise;
    f.answer.resolve({
      run_id: f.run.id,
      status: 'OPTIMAL',
      assignments: [{
        visit_id: f.visit.id,
        employee_ids: crew,
        vehicles: driver ? [{ vehicle_id: 'van', driver_employee_id: driver }] : [],
        start_minute: 600,
        scheduled_date: '2027-03-03',
      }],
      unassigned: [],
      solve_seconds: 0,
      objective_value: 0,
      visits_considered: 1,
    });

    await expect(pending).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(f.assignment.create).not.toHaveBeenCalled();
  });

  it('rejects a solver move of a time-locked visit even when the new date fits its cadence', async () => {
    const f = fixture('2027-03-04');
    f.oldAssignment.locks.push({ scope: LockScope.TIME, releasedAt: null });

    const pending = f.service.execute(f.run.id);
    await f.started.promise;
    const request = (f.scheduler.solve.mock.calls as unknown as [SolveRequest][])[0][0];
    expect(request.visits[0].candidate_slots).toBeNull();
    f.release();

    await expect(pending).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(f.assignment.create).not.toHaveBeenCalled();
    expect(f.visit.visitDate).toEqual(new Date('2027-03-03T00:00:00Z'));
  });

  it.each([LockScope.TIME, LockScope.FULL])(
    'preserves the exact longer interval of a %s-locked assignment',
    async (scope) => {
      const f = fixture();
      f.oldAssignment.plannedEnd = new Date('2027-03-03T12:00:00Z');
      f.oldAssignment.locks.push({ scope, releasedAt: null });

      const pending = f.service.execute(f.run.id);
      await f.started.promise;
      const request = (f.scheduler.solve.mock.calls as unknown as [SolveRequest][])[0][0];
      expect(request.locks).toEqual(expect.arrayContaining([
        expect.objectContaining({ scope, start_minute: 600, end_minute: 720 }),
      ]));
      f.release();

      await expect(pending).resolves.toMatchObject({ scheduled: 1 });
      expect(f.assignment.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          plannedStart: new Date('2027-03-03T10:00:00.000Z'),
          plannedEnd: new Date('2027-03-03T12:00:00.000Z'),
        }),
      }));
    },
  );

  it('allows a legal move after its time lock was released', async () => {
    const f = fixture('2027-03-04');
    f.oldAssignment.locks.push({
      scope: LockScope.TIME,
      releasedAt: new Date('2027-02-02T00:00:00Z'),
    });

    const pending = f.service.execute(f.run.id);
    await f.started.promise;
    const request = (f.scheduler.solve.mock.calls as unknown as [SolveRequest][])[0][0];
    expect(request.visits[0].candidate_slots?.map((slot) => slot.date)).toContain('2027-03-04');
    f.release();

    await expect(pending).resolves.toMatchObject({ scheduled: 1 });
    expect(f.visit.visitDate).toEqual(new Date('2027-03-04T00:00:00Z'));
  });

  it.each([
    {
      name: 'a workbook BOOKED date',
      scheduledDate: '2027-03-04',
      placement: VisitPlacement.BOOKED,
      unit: FrequencyUnit.WEEK,
      endDate: null,
      runEnd: '2027-03-07',
      allowed: Weekday.THURSDAY,
    },
    {
      name: 'a different ISO week',
      scheduledDate: '2027-03-08',
      placement: VisitPlacement.ANCHORED,
      unit: FrequencyUnit.WEEK,
      endDate: null,
      runEnd: '2027-03-14',
      allowed: Weekday.MONDAY,
    },
    {
      name: 'a different calendar month',
      scheduledDate: '2027-04-01',
      placement: VisitPlacement.ANCHORED,
      unit: FrequencyUnit.MONTH,
      endDate: null,
      runEnd: '2027-04-03',
      allowed: Weekday.THURSDAY,
    },
    {
      name: 'past the agreement end date',
      scheduledDate: '2027-03-04',
      placement: VisitPlacement.ANCHORED,
      unit: FrequencyUnit.WEEK,
      endDate: '2027-03-03',
      runEnd: '2027-03-07',
      allowed: Weekday.THURSDAY,
    },
  ])('rejects a stale solver move to $name before persistence', async ({
    scheduledDate, placement, unit, endDate, runEnd, allowed,
  }) => {
    const f = fixture(scheduledDate);
    Object.assign(f.visit, { placement });
    Object.assign(f.visit.serviceAgreement, {
      frequencyUnit: unit,
      endDate: endDate ? new Date(`${endDate}T00:00:00Z`) : null,
      dayRules: [{ weekday: allowed, kind: DayRuleKind.ALLOWED }],
    });
    f.run.rangeEnd = new Date(`${runEnd}T00:00:00Z`);

    const pending = f.service.execute(f.run.id);
    await f.started.promise;
    f.release();

    await expect(pending).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(f.assignment.create).not.toHaveBeenCalled();
    expect(f.visit.visitDate).toEqual(new Date('2027-03-03T00:00:00Z'));
  });

  it('pins a workbook BOOKED visit to its committed date even when other days are allowed', () => {
    const f = fixture();
    const target = {
      ...f.visit,
      placement: VisitPlacement.BOOKED,
      assignments: [],
      serviceAgreement: {
        ...f.visit.serviceAgreement,
        dayRules: [
          { weekday: Weekday.WEDNESDAY, kind: DayRuleKind.ALLOWED },
          { weekday: Weekday.THURSDAY, kind: DayRuleKind.ALLOWED },
        ],
      },
    };
    const request = (
      f.service as unknown as {
        buildSolveRequest: (
          runId: string, visits: unknown[], employees: unknown[], vehicles: unknown[],
          options: { timeLimitSeconds: number; from: Date; to: Date },
        ) => { visits: { id: string; candidate_slots: { date: string }[] }[] };
      }
    ).buildSolveRequest('run', [target], [], [], {
      timeLimitSeconds: 20,
      from: new Date('2027-03-01T00:00:00Z'),
      to: new Date('2027-03-07T00:00:00Z'),
    });

    expect(request.visits[0].candidate_slots?.map((slot) => slot.date)).toEqual(['2027-03-03']);
  });

  it('sends published reservations and sibling keys while retaining the target own date', () => {
    const f = fixture();
    const target = {
      ...f.visit,
      assignments: [],
    };
    const published = {
      ...f.visit,
      id: 'published-visit',
      assignments: [
        {
          ...f.oldAssignment,
          id: 'published-assignment',
          status: AssignmentStatus.PUBLISHED,
          plannedStart: new Date('2027-03-03T09:00:00Z'),
          plannedEnd: new Date('2027-03-03T10:30:00Z'),
          crewMembers: [{ employeeId: 'published-employee', isPmsSupervisor: true }],
          vehicles: [{ vehicleId: 'published-vehicle' }],
        },
      ],
    };
    const request = (
      f.service as unknown as {
        buildSolveRequest: (
          runId: string,
          visits: unknown[],
          employees: unknown[],
          vehicles: unknown[],
          options: {
            timeLimitSeconds: number;
            from: Date;
            to: Date;
            excludeReservationAssignmentIds?: string[];
          },
          siblingKeys: unknown[],
        ) => {
          visits: { id: string; occupied_start_keys: unknown[] }[];
          reservations: unknown[];
          excluded_reservation_assignment_ids: string[];
        };
      }
    ).buildSolveRequest(
      'run',
      [target, published],
      [],
      [],
      {
        timeLimitSeconds: 20,
        from: new Date('2027-03-03T00:00:00Z'),
        to: new Date('2027-03-03T00:00:00Z'),
      },
      [
        {
          id: target.id,
          serviceAgreementId: target.serviceAgreementId,
          visitDate: target.visitDate,
          windowStartMinute: target.windowStartMinute,
        },
        {
          id: published.id,
          serviceAgreementId: published.serviceAgreementId,
          visitDate: published.visitDate,
          windowStartMinute: published.windowStartMinute,
        },
      ],
    );

    expect(request.reservations).toEqual([
      {
        assignment_id: 'published-assignment',
        scheduled_date: '2027-03-03',
        start_minute: 540,
        end_minute: 630,
        employee_ids: ['published-employee'],
        vehicle_ids: ['published-vehicle'],
      },
    ]);
    expect(request.visits).toEqual([
      expect.objectContaining({
        id: target.id,
        occupied_start_keys: [
          { date: '2027-03-03', start_minute: target.windowStartMinute },
        ],
      }),
    ]);
    expect(request.excluded_reservation_assignment_ids).toEqual([]);
  });

  it('sends an existing draft start minute as a soft solver preference', () => {
    const f = fixture();
    const existing = {
      ...f.oldAssignment,
      plannedStart: new Date('2027-03-03T10:00:00Z'),
      plannedEnd: new Date('2027-03-03T11:30:00Z'),
    };
    const target = {
      ...f.visit,
      assignments: [existing],
    };
    const request = (
      f.service as unknown as {
        buildSolveRequest: (
          runId: string,
          visits: unknown[],
          employees: unknown[],
          vehicles: unknown[],
          options: { timeLimitSeconds: number; from: Date; to: Date },
        ) => {
          existing: {
            visit_id: string;
            employee_ids: string[];
            vehicle_ids: string[];
            start_minute?: number;
          }[];
        };
      }
    ).buildSolveRequest('run', [target], [], [], {
      timeLimitSeconds: 20,
      from: new Date('2027-03-03T00:00:00Z'),
      to: new Date('2027-03-03T00:00:00Z'),
    });

    expect(request.existing).toEqual([
      {
        visit_id: target.id,
        employee_ids: ['employee'],
        vehicle_ids: [],
        start_minute: 600,
      },
    ]);
  });

  it.each([LockScope.TIME, LockScope.FULL])(
    'sends the actual assignment minute for an assignment %s lock',
    (scope) => {
      const f = fixture();
      const target = {
        ...f.visit,
        assignments: [
          {
            ...f.oldAssignment,
            locks: [{ scope }],
          },
        ],
      };
      const request = (
        f.service as unknown as {
          buildSolveRequest: (
            runId: string,
            visits: unknown[],
            employees: unknown[],
            vehicles: unknown[],
            options: { timeLimitSeconds: number; from: Date; to: Date },
          ) => {
            locks: { visit_id: string; scope: string; start_minute: number | null }[];
          };
        }
      ).buildSolveRequest('run', [target], [], [], {
        timeLimitSeconds: 20,
        from: new Date('2027-03-03T00:00:00Z'),
        to: new Date('2027-03-03T00:00:00Z'),
      });

      expect(request.locks).toEqual([
        expect.objectContaining({
          visit_id: target.id,
          scope,
          start_minute: 600,
        }),
      ]);
    },
  );

  it.each(['manual', 'visit-lock'] as const)(
    'pins a %s visit date without inventing an assignment time lock',
    (protection) => {
      const f = fixture();
      const target = {
        ...f.visit,
        isManuallyAdjusted: protection === 'manual',
        lockedAt: protection === 'visit-lock' ? new Date('2027-02-02T00:00:00Z') : null,
        assignments: [{ ...f.oldAssignment, locks: [] }],
        serviceAgreement: {
          ...f.visit.serviceAgreement,
          serviceWindowStartMinute: 480,
          serviceWindowEndMinute: 1020,
          serviceSite: {
            operatingHours: [
              { weekday: Weekday.WEDNESDAY, opensAtMinute: 480, closesAtMinute: 1020 },
              { weekday: Weekday.THURSDAY, opensAtMinute: 480, closesAtMinute: 1020 },
            ],
          },
          dayRules: [
            { weekday: Weekday.WEDNESDAY, kind: DayRuleKind.ALLOWED },
            { weekday: Weekday.THURSDAY, kind: DayRuleKind.ALLOWED },
          ],
        },
      };
      const build = (f.service as unknown as {
        buildSolveRequest: (
          runId: string,
          visits: unknown[],
          employees: unknown[],
          vehicles: unknown[],
          options: { timeLimitSeconds: number; from: Date; to: Date },
        ) => {
          visits: {
            candidate_slots: {
              date: string;
              earliest_start_minute: number;
              latest_start_minute: number;
            }[] | null;
          }[];
          locks: unknown[];
          existing: { start_minute: number | null }[];
        };
      }).buildSolveRequest.bind(f.service);
      const options = {
        timeLimitSeconds: 20,
        from: new Date('2027-03-03T00:00:00Z'),
        to: new Date('2027-03-07T00:00:00Z'),
      };

      expect(build('run', [{ ...target, isManuallyAdjusted: false, lockedAt: null }], [], [], options)
        .visits[0].candidate_slots).toEqual([
        expect.objectContaining({
          date: '2027-03-03',
          earliest_start_minute: 540,
          latest_start_minute: 630,
        }),
        expect.objectContaining({
          date: '2027-03-04',
          earliest_start_minute: 480,
          latest_start_minute: 930,
        }),
      ]);
      const request = build('run', [target], [], [], options);
      expect(request.visits[0].candidate_slots).toEqual([
        expect.objectContaining({
          date: '2027-03-03',
          earliest_start_minute: 540,
          latest_start_minute: 630,
        }),
      ]);
      expect(request.locks).toEqual([]);
      expect(request.existing[0].start_minute).toBe(600);
    },
  );

  it.each(['manual', 'visit-lock'] as const)(
    'keeps a %s visit on its protected date while allowing a legal time change',
    async (protection) => {
      const f = fixture();
      f.visit.isManuallyAdjusted = protection === 'manual';
      f.visit.lockedAt = protection === 'visit-lock' ? new Date('2027-02-02T00:00:00Z') : null;
      f.visit.serviceAgreement.dayRules = [
        { weekday: Weekday.THURSDAY, kind: DayRuleKind.ALLOWED },
      ];

      const pending = f.service.execute(f.run.id);
      await f.started.promise;
      const request = (f.scheduler.solve.mock.calls as unknown as [SolveRequest][])[0][0];
      expect(request.visits[0].candidate_slots).toEqual([
        expect.objectContaining({ date: '2027-03-03', earliest_start_minute: 540 }),
      ]);
      f.answer.resolve({
        run_id: f.run.id,
        status: 'OPTIMAL',
        assignments: [{
          visit_id: f.visit.id,
          employee_ids: ['employee'],
          vehicles: [],
          start_minute: 540,
          scheduled_date: '2027-03-03',
        }],
        unassigned: [],
        solve_seconds: 0,
        objective_value: 0,
        visits_considered: 1,
      });

      await expect(pending).resolves.toMatchObject({ scheduled: 1 });
      expect(f.assignment.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          plannedStart: new Date('2027-03-03T09:00:00.000Z'),
        }),
      }));
      expect(f.visit.visitDate).toEqual(new Date('2027-03-03T00:00:00Z'));
    },
  );

  it.each(['manual', 'visit-lock'] as const)(
    'keeps a %s protected date even when it is outside the agreement cadence',
    (protection) => {
      const f = fixture();
      const target = {
        ...f.visit,
        isManuallyAdjusted: protection === 'manual',
        lockedAt: protection === 'visit-lock' ? new Date('2027-02-02T00:00:00Z') : null,
        assignments: [],
        serviceAgreement: {
          ...f.visit.serviceAgreement,
          dayRules: [{ weekday: Weekday.THURSDAY, kind: DayRuleKind.ALLOWED }],
        },
      };
      const request = (
        f.service as unknown as {
          buildSolveRequest: (
            runId: string,
            visits: unknown[],
            employees: unknown[],
            vehicles: unknown[],
            options: { timeLimitSeconds: number; from: Date; to: Date },
          ) => {
            visits: {
              candidate_slots: {
                date: string;
                earliest_start_minute: number;
                latest_start_minute: number;
              }[] | null;
            }[];
          };
        }
      ).buildSolveRequest('run', [target], [], [], {
        timeLimitSeconds: 20,
        from: new Date('2027-03-03T00:00:00Z'),
        to: new Date('2027-03-07T00:00:00Z'),
      });

      expect(request.visits[0].candidate_slots).toEqual([{
        date: '2027-03-03',
        earliest_start_minute: 540,
        latest_start_minute: 630,
        is_preferred: false,
      }]);
    },
  );

  it.each(['manual', 'visit-lock'] as const)(
    'rejects a solver date move for a %s visit without counting or writing it',
    async (protection) => {
      const f = fixture('2027-03-04');
      f.visit.isManuallyAdjusted = protection === 'manual';
      f.visit.lockedAt = protection === 'visit-lock' ? new Date('2027-02-02T00:00:00Z') : null;

      const pending = f.service.execute(f.run.id);
      await f.started.promise;
      f.release();

      await expect(pending).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
      expect(f.run).toMatchObject({
        status: ScheduleRunStatus.FAILED,
        errorCode: 'RESOURCE_CONFLICT',
      });
      expect(f.visit.visitDate).toEqual(new Date('2027-03-03T00:00:00Z'));
      expect(f.assignment.create).not.toHaveBeenCalled();
      expect(f.generatedVisit.update).not.toHaveBeenCalled();
      expect(f.reasons.createMany).not.toHaveBeenCalled();
    },
  );

  it.each(['manual', 'visit-lock'] as const)(
    're-reads a newly %s protected visit inside persistence before accepting a stale date move',
    async (protection) => {
      const f = fixture('2027-03-04');
      const pending = f.service.execute(f.run.id);
      await f.started.promise;
      // Model an older writer whose protection change has the same timestamp
      // precision as the solve snapshot: revision alone cannot prove safety.
      f.visit.isManuallyAdjusted = protection === 'manual';
      f.visit.lockedAt = protection === 'visit-lock' ? new Date('2027-02-02T00:00:00Z') : null;
      f.release();

      await expect(pending).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
      expect(f.visit.visitDate).toEqual(new Date('2027-03-03T00:00:00Z'));
      expect(f.assignment.create).not.toHaveBeenCalled();
      expect(f.generatedVisit.update).not.toHaveBeenCalled();
    },
  );

  it('passes all active lock scopes and exact vehicle drivers to the solver in stable order', () => {
    const f = fixture();
    const target = {
      ...f.visit,
      assignments: [{
        ...f.oldAssignment,
        locks: [
          { scope: LockScope.VEHICLE },
          { scope: LockScope.TIME },
          { scope: LockScope.CREW },
        ],
        vehicles: [{ vehicleId: 'van', driverEmployeeId: 'employee' }],
      }],
    };
    const request = (
      f.service as unknown as {
        buildSolveRequest: (
          runId: string, visits: unknown[], employees: unknown[], vehicles: unknown[],
          options: { timeLimitSeconds: number; from: Date; to: Date },
        ) => SolveRequest;
      }
    ).buildSolveRequest('run', [target], [], [], {
      timeLimitSeconds: 20,
      from: new Date('2027-03-03T00:00:00Z'),
      to: new Date('2027-03-03T00:00:00Z'),
    });

    expect(request.locks).toEqual([
      expect.objectContaining({ scope: 'CREW', employee_ids: ['employee'] }),
      expect.objectContaining({ scope: 'TIME', start_minute: 600, end_minute: 690 }),
      expect.objectContaining({
        scope: 'VEHICLE', vehicle_ids: ['van'],
        vehicle_drivers: [{ vehicle_id: 'van', driver_employee_id: 'employee' }],
      }),
    ]);
    expect(request.visits[0].candidate_slots).toBeNull();
  });

  it('maps a final Prisma unique collision to a safe resource conflict', async () => {
    const f = fixture();
    f.assignment.create.mockRejectedValueOnce({
      code: 'P2002',
      message: 'Unique constraint failed at https://internal.example/prisma',
    });

    const pending = f.service.execute(f.run.id);
    await f.started.promise;
    f.release();

    await expect(pending).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(f.run.errorMessage).not.toContain('https://internal.example');
    expect(f.run.errorMessage).not.toContain('P2002');
  });

  it('locks affected agreements before visit rows while persisting a solve', async () => {
    const f = fixture();

    const pending = f.service.execute(f.run.id);
    await f.started.promise;
    f.release();
    await pending;

    const lockQueries = f.tx.$queryRaw.mock.calls.map(
      ([query]: [Prisma.Sql]) => query.sql,
    );
    expect(lockQueries).toEqual(
      expect.arrayContaining([
        expect.stringContaining('service_agreements'),
        expect.stringContaining('generated_visits'),
      ]),
    );
    expect(lockQueries.findIndex((sql) => sql.includes('service_agreements'))).toBeLessThan(
      lockQueries.findIndex((sql) => sql.includes('generated_visits')),
    );
  });

  it('locks proposed resources before rechecking persisted eligibility', async () => {
    const f = fixture();

    const pending = f.service.execute(f.run.id);
    await f.started.promise;
    f.release();
    await pending;

    const resourceLockCall = f.tx.$queryRaw.mock.calls.findIndex(
      ([query]: [Prisma.Sql]) => query.sql.includes('employees'),
    );
    expect(resourceLockCall).toBeGreaterThanOrEqual(0);
    expect(
      f.tx.$queryRaw.mock.invocationCallOrder[resourceLockCall],
    ).toBeLessThan(f.eligibility.evaluate.mock.invocationCallOrder[0]);
  });

  it.each(['assignment', 'unassigned'])(
    'rejects duplicate %s outcomes for an empty assignment snapshot',
    async (duplicate) => {
      const f = fixture();
      f.assignments.length = 0;
      const pending = f.processor.process(f.job).then(
        () => undefined,
        (error: unknown) => error,
      );
      await f.started.promise;
      const proposal = {
        visit_id: f.visit.id,
        employee_ids: ['employee'],
        vehicles: [],
        start_minute: 600,
        scheduled_date: '2027-03-03',
      };
      f.answer.resolve({
        run_id: f.run.id,
        status: 'OPTIMAL',
        solve_seconds: 0,
        objective_value: 0,
        visits_considered: 1,
        assignments:
          duplicate === 'assignment' ? [proposal, proposal] : [proposal],
        unassigned:
          duplicate === 'unassigned'
            ? [
                {
                  visit_id: f.visit.id,
                  reason_codes: ['NO_CREW'],
                  message: 'No crew',
                },
              ]
            : [],
      });
      expect(await pending).toMatchObject({ code: 'RESOURCE_CONFLICT' });
      expect(f.assignments).toEqual([]);
      expect(f.generatedVisit.update).not.toHaveBeenCalled();
      expect(f.reasons.createMany).not.toHaveBeenCalled();
    },
  );

  it.each(
    ['present', 'absent'].flatMap((snapshot) =>
      ['same-date', 'moved-date', 'rejected', 'unassigned'].flatMap((outcome) =>
        ['after-snapshot', 'before-persistence'].map((barrier) => ({
          snapshot,
          outcome,
          barrier,
        })),
      ),
    ),
  )(
    'rejects a revised visit for $outcome with $snapshot snapshot at $barrier',
    async ({ snapshot, outcome, barrier }) => {
      const f = fixture(outcome === 'same-date' ? '2027-03-03' : '2027-03-04');
      if (snapshot === 'absent') f.assignments.length = 0;
      if (outcome === 'rejected') {
        f.eligibility.evaluate.mockResolvedValue({
          isEligible: false,
          conflicts: [],
        });
      }
      const adjust = () =>
        Object.assign(f.visit, {
          updatedAt: new Date('2027-02-01T00:00:01Z'),
          durationMinutes: 120,
          requiredCrewSize: 2,
          windowEndMinute: 900,
        });
      if (barrier === 'before-persistence') {
        f.prisma.$transaction.mockImplementationOnce(async (work) => {
          expect(f.eligibility.evaluate).not.toHaveBeenCalled();
          adjust();
          return work(f.tx);
        });
      }
      const result = f.processor.process(f.job).then(
        () => undefined,
        (error: unknown) => error,
      );
      await f.started.promise;
      if (barrier === 'after-snapshot') adjust();
      f.release(outcome === 'unassigned');
      expect(await result).toMatchObject({ code: 'RESOURCE_CONFLICT' });
      expect(f.visit).toMatchObject({
        durationMinutes: 120,
        requiredCrewSize: 2,
        windowEndMinute: 900,
      });
      expect(f.assignment.deleteMany).not.toHaveBeenCalled();
      expect(f.assignment.updateMany).not.toHaveBeenCalled();
      expect(f.assignment.create).not.toHaveBeenCalled();
      expect(f.generatedVisit.update).not.toHaveBeenCalled();
      expect(f.reasons.deleteMany).not.toHaveBeenCalled();
      expect(f.reasons.createMany).not.toHaveBeenCalled();
      expect(f.outbox).toEqual([]);
      expect(f.assignments).toHaveLength(snapshot === 'present' ? 1 : 0);
    },
  );

  it.each(['assignment', 'unassigned'])(
    'accepts %s when the snapshot and current visit both have no assignment',
    async (outcome) => {
      const f = fixture('2027-03-04');
      f.assignments.splice(0);
      const pending = f.processor.process(f.job);
      await f.started.promise;
      f.release(outcome === 'unassigned');
      await pending;

      expect(f.run.status).toBe(ScheduleRunStatus.SUCCEEDED);
      expect(f.assignments).toHaveLength(outcome === 'assignment' ? 1 : 0);
      expect(f.visit.status).toBe(
        outcome === 'assignment'
          ? VisitStatus.SCHEDULED
          : VisitStatus.UNASSIGNED,
      );
    },
  );

  it('invalidates a draft before a waiting publisher can promote it after unassignment', async () => {
    const f = fixture();
    const snapshotRead = deferred<void>();
    const returnSnapshot = deferred<void>();
    const atUnassignedWrite = deferred<void>();
    const commitUnassigned = deferred<void>();
    const publisherWaiting = deferred<void>();
    const unassignedFinished = deferred<void>();
    const publishable = {
      ...f.oldAssignment,
      generatedVisitId: f.visit.id,
      plannedStart: new Date('2027-03-03T09:00:00Z'),
      plannedEnd: new Date('2027-03-03T10:30:00Z'),
      generatedVisit: {
        ...f.visit,
        serviceAgreement: {
          customer: { name: 'Customer' },
          serviceSite: { name: 'Site' },
        },
      },
      crewMembers: [
        {
          employeeId: 'employee',
          employee: { fullName: 'Employee' },
          role: 'SUPERVISOR',
          isPmsSupervisor: true,
        },
      ],
    };
    const notices = { createMany: jest.fn() };
    const publishedRun = {
      id: 'original-run',
      status: ScheduleRunStatus.SUCCEEDED,
      publishedAt: null,
      assignments: [publishable],
    };
    const publishTx = {
      $queryRaw: jest.fn(async () => [{ id: f.visit.id }]),
      scheduleRun: {
        updateMany: jest.fn(async () => ({ count: 1 })),
        findUniqueOrThrow: jest.fn(async () => publishedRun),
      },
      assignment: {
        findMany: jest.fn(async () => []),
        updateMany: jest.fn(async () => {
          if (f.oldAssignment.status !== AssignmentStatus.DRAFT)
            return { count: 0 };
          f.oldAssignment.status = AssignmentStatus.PUBLISHED;
          return { count: 1 };
        }),
      },
      assignmentNotificationOutbox: notices,
    };
    const publishingPrisma = {
      scheduleRun: {
        findUnique: jest.fn(async () => {
          snapshotRead.resolve();
          // The read occurred before invalidation; deliver its response while
          // the unassigned transaction holds the write fence.
          await returnSnapshot.promise;
          return publishedRun;
        }),
      },
      assignment: { findMany: jest.fn(async () => []) },
      $transaction: jest.fn(
        async (work: (tx: typeof publishTx) => Promise<unknown>) => {
          publisherWaiting.resolve();
          await unassignedFinished.promise;
          return work(publishTx);
        },
      ),
    };
    const publishing = new PublishingService(
      publishingPrisma as unknown as PrismaService,
      { record: jest.fn() } as unknown as AuditService,
      {
        evaluate: jest.fn(async () => ({ isEligible: true, conflicts: [] })),
      } as unknown as EligibilityService,
    );
    f.reasons.createMany.mockImplementation(async () => {
      atUnassignedWrite.resolve();
      await commitUnassigned.promise;
    });
    const publication = publishing
      .publish('original-run', null, { id: 'actor' } as AuthenticatedUser)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await snapshotRead.promise;
    const running = f.processor.process(f.job);
    await f.started.promise;
    f.release(true);
    await atUnassignedWrite.promise;
    returnSnapshot.resolve();
    await publisherWaiting.promise;
    commitUnassigned.resolve();
    await running;
    unassignedFinished.resolve();
    const failure = await publication;

    expect(failure).toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(f.oldAssignment.status).toBe(AssignmentStatus.CANCELLED);
    expect(f.visit.status).toBe(VisitStatus.UNASSIGNED);
    expect(notices.createMany).not.toHaveBeenCalled();
  });

  it.each([
    { date: '2027-03-03', outcome: 'assignment' },
    { date: '2027-03-04', outcome: 'assignment' },
    { date: '2027-03-04', outcome: 'rejected' },
    { date: '2027-03-04', outcome: 'unassigned' },
  ])(
    'protects a publication absent from the empty snapshot: $outcome on $date',
    async ({ date, outcome }) => {
      const f = fixture(date);
      f.assignments.splice(0);
      if (outcome === 'rejected')
        f.eligibility.evaluate.mockResolvedValue({
          isEligible: false,
          conflicts: [],
        });
      const pending = f.processor.process(f.job).then(
        () => undefined,
        (error: unknown) => error,
      );
      await f.started.promise;
      f.oldAssignment.status = AssignmentStatus.PUBLISHED;
      f.assignments.push(f.oldAssignment);
      f.outbox.push({
        id: 'notice',
        assignmentId: f.oldAssignment.id,
        payload: { visitDate: '2027-03-03' },
      });
      const visitBefore = { ...f.visit };
      const outboxBefore = structuredClone(f.outbox);
      f.release(outcome === 'unassigned');
      const failure = await pending;

      expect(f.assignments).toEqual([f.oldAssignment]);
      expect(f.visit).toEqual(visitBefore);
      expect(f.outbox).toEqual(outboxBefore);
      expect(f.reasons.deleteMany).not.toHaveBeenCalled();
      expect(f.reasons.createMany).not.toHaveBeenCalled();
      expect(failure).toMatchObject({ code: 'RESOURCE_CONFLICT' });
    },
  );

  it.each(['assignment', 'unassigned'])(
    'rejects an extra published assignment alongside the snapshot for %s',
    async (outcome) => {
      const f = fixture('2027-03-04');
      const pending = f.processor.process(f.job).then(
        () => undefined,
        (error: unknown) => error,
      );
      await f.started.promise;
      f.assignments.push({
        ...f.oldAssignment,
        id: 'another-publication',
        status: AssignmentStatus.PUBLISHED,
      });
      const assignmentsBefore = structuredClone(f.assignments);
      const visitBefore = { ...f.visit };
      f.release(outcome === 'unassigned');
      const failure = await pending;

      expect(f.assignments).toEqual(assignmentsBefore);
      expect(f.visit).toEqual(visitBefore);
      expect(failure).toMatchObject({ code: 'RESOURCE_CONFLICT' });
    },
  );

  it.each(['rejected', 'unassigned'])(
    'preserves a publication when the stale result is %s',
    async (result) => {
      const f = fixture('2027-03-04');
      if (result === 'rejected')
        f.eligibility.evaluate.mockResolvedValue({
          isEligible: false,
          conflicts: [],
        });
      const pending = f.processor.process(f.job).then(
        () => undefined,
        (error: unknown) => error,
      );
      await f.started.promise;
      f.oldAssignment.status = AssignmentStatus.PUBLISHED;
      f.outbox.push({
        id: 'notice',
        assignmentId: f.oldAssignment.id,
        payload: { visitDate: '2027-03-03' },
      });
      const visitBefore = { ...f.visit };
      const outboxBefore = structuredClone(f.outbox);
      f.release(result === 'unassigned');
      const failure = await pending;

      expect(f.visit).toEqual(visitBefore);
      expect(f.assignments).toEqual([f.oldAssignment]);
      expect(f.outbox).toEqual(outboxBefore);
      expect(f.reasons.deleteMany).not.toHaveBeenCalled();
      expect(f.reasons.createMany).not.toHaveBeenCalled();
      expect(failure).toMatchObject({ code: 'RESOURCE_CONFLICT' });
      expect(f.run.status).toBe(ScheduleRunStatus.FAILED);
    },
  );

  it('still records an unassigned result while the snapshot remains replaceable', async () => {
    const f = fixture();
    const pending = f.processor.process(f.job);
    await f.started.promise;
    f.release(true);
    await pending;

    expect(f.visit.status).toBe(VisitStatus.UNASSIGNED);
    expect(f.oldAssignment.status).toBe(AssignmentStatus.CANCELLED);
    expect(f.reasons.createMany).toHaveBeenCalledWith({
      data: [
        {
          generatedVisitId: 'visit',
          scheduleRunId: 'run',
          code: 'NO_CREW',
          message: 'No crew available',
          // Each reason carries its own remedy, matching what the manual path
          // records, so the queue reads the same either way. Null here because
          // the solver sent no remediation for this code.
          details: { remediation: null, resources: null },
        },
      ],
    });
  });

  it.each(['2027-03-03', '2027-03-04'])(
    'preserves a publication made during a solve for %s',
    async (date) => {
      const f = fixture(date);
      const pending = f.processor.process(f.job).then(
        () => undefined,
        (error: unknown) => error,
      );
      await f.started.promise;
      f.oldAssignment.status = AssignmentStatus.PUBLISHED;
      f.outbox.push({
        id: 'notice',
        assignmentId: f.oldAssignment.id,
        payload: { visitDate: '2027-03-03' },
      });
      const publishedVisit = { ...f.visit };
      const publishedOutbox = structuredClone(f.outbox);
      f.release();
      const error = await pending;

      expect(f.assignments).toEqual([f.oldAssignment]);
      expect(f.outbox).toEqual(publishedOutbox);
      expect(f.visit).toEqual(publishedVisit);
      expect(error).toMatchObject({ code: 'RESOURCE_CONFLICT' });
      expect(f.run).toMatchObject({
        status: ScheduleRunStatus.FAILED,
        errorCode: 'RESOURCE_CONFLICT',
      });
      expect(f.assignment.create).not.toHaveBeenCalled();
    },
  );

  it('fails instead of replacing a different draft when the snapshotted assignment disappeared', async () => {
    const f = fixture();
    const pending = f.processor.process(f.job).then(
      () => undefined,
      (error: unknown) => error,
    );
    await f.started.promise;
    f.assignments.splice(0, 1, { ...f.oldAssignment, id: 'another-draft' });
    f.release();

    expect(await pending).toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(f.assignments.map((a) => a.id)).toEqual(['another-draft']);
    expect(f.assignment.create).not.toHaveBeenCalled();
    expect(f.generatedVisit.update).not.toHaveBeenCalled();
  });

  it.each([AssignmentStatus.DRAFT, AssignmentStatus.PROPOSED])(
    'still replaces the exact %s snapshot',
    async (status) => {
      const f = fixture('2027-03-04', status);
      const pending = f.processor.process(f.job);
      await f.started.promise;
      f.release();
      await pending;

      expect(f.assignments.map((a) => a.id)).toEqual(['replacement']);
      expect(f.visit).toMatchObject({
        visitDate: new Date('2027-03-04T00:00:00Z'),
        windowStartMinute: 600,
        windowEndMinute: 720,
      });
      expect(f.eligibility.evaluate).toHaveBeenCalledWith(
        'visit',
        expect.any(Object),
        {
          excludeAssignmentId: 'snapshotted',
          proposedVisit: {
            visitDate: new Date('2027-03-04T00:00:00Z'),
            windowStartMinute: 600,
            windowEndMinute: 720,
          },
        },
        f.tx,
      );
      expect(f.assignment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          plannedStart: new Date('2027-03-04T10:00:00Z'),
          plannedEnd: new Date('2027-03-04T11:30:00Z'),
        }),
      });
      expect(f.run.status).toBe(ScheduleRunStatus.SUCCEEDED);
    },
  );

  it('evaluates a proposed move without first changing the stored visit', async () => {
    const f = fixture('2027-03-04');
    f.eligibility.evaluate.mockImplementation(async () => {
      expect(f.visit.visitDate).toEqual(new Date('2027-03-03T00:00:00Z'));
      return { isEligible: true, conflicts: [] };
    });
    const pending = f.processor.process(f.job);
    await f.started.promise;
    f.release();
    await pending;
  });
});

describe('at-least-once schedule-run delivery leases', () => {
  const deliveryOptions = {
    executionBudgetSeconds: SELF_HOSTED_EXECUTION_BUDGET_SECONDS,
    retryOnFailure: true,
    executionLeaseSeconds: BULLMQ_EXECUTION_LEASE_SECONDS,
    renewExecutionLease: true,
  };

  it('returns only the public execution result fields', async () => {
    const f = fixture();
    const pending = f.service.execute(f.run.id);
    await f.started.promise;
    f.release();

    await expect(pending).resolves.toEqual({
      scheduled: 1,
      unassigned: 0,
      cancelled: false,
    });
  });

  it('renews a self-hosted lease while the solver is still running', async () => {
    jest.useFakeTimers({ now: new Date('2027-03-01T00:00:00.000Z') });
    try {
      const f = fixture();
      const pending = f.service.deliver(f.run.id, deliveryOptions);
      await f.started.promise;

      await jest.advanceTimersByTimeAsync(
        BULLMQ_LEASE_HEARTBEAT_MILLISECONDS,
      );

      expect(f.run.executionLeaseExpiresAt?.getTime()).toBeGreaterThan(
        new Date('2027-03-01T00:00:00.000Z').getTime() +
          BULLMQ_EXECUTION_LEASE_SECONDS * 1_000,
      );
      f.release();
      await expect(pending).resolves.toMatchObject({ kind: 'completed' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('reclaims a hard-crashed BullMQ owner after its renewable lease expires', async () => {
    const f = fixture();
    f.run.status = ScheduleRunStatus.RUNNING;
    f.run.executionLeaseId = '00000000-0000-4000-8000-000000000001';
    f.run.executionLeaseExpiresAt = new Date(
      Date.now() + BULLMQ_EXECUTION_LEASE_SECONDS * 1_000,
    );

    await expect(f.service.deliver(f.run.id, deliveryOptions)).resolves.toEqual(
      { kind: 'busy' },
    );

    f.run.executionLeaseExpiresAt = new Date(Date.now() - 1);
    const recovery = f.service.deliver(f.run.id, deliveryOptions);
    await f.started.promise;
    f.release();

    await expect(recovery).resolves.toMatchObject({ kind: 'completed' });
    expect(f.run.executionLeaseId).not.toBe(
      '00000000-0000-4000-8000-000000000001',
    );
  });

  it('releases a retryable BullMQ failure so the next delivery can complete', async () => {
    const f = fixture();
    f.scheduler.solve.mockRejectedValueOnce(
      new Error('temporary scheduler failure'),
    );

    await expect(
      f.service.deliver(f.run.id, deliveryOptions),
    ).rejects.toThrow('temporary scheduler failure');
    expect(f.run).toMatchObject({
      status: ScheduleRunStatus.QUEUED,
      executionLeaseId: null,
      executionLeaseExpiresAt: null,
      errorCode: null,
    });

    const retry = f.service.deliver(f.run.id, deliveryOptions);
    await f.started.promise;
    f.release();

    await expect(retry).resolves.toMatchObject({ kind: 'completed' });
  });

  it('reports a concurrent duplicate delivery as busy without a second solve', async () => {
    const f = fixture();
    const first = f.service.deliver(f.run.id, deliveryOptions);
    await f.started.promise;

    await expect(f.service.deliver(f.run.id, deliveryOptions)).resolves.toEqual(
      { kind: 'busy' },
    );
    expect(f.scheduler.solve).toHaveBeenCalledTimes(1);

    f.release();
    await expect(first).resolves.toMatchObject({ kind: 'completed' });
  });

  it.each([
    ScheduleRunStatus.SUCCEEDED,
    ScheduleRunStatus.FAILED,
    ScheduleRunStatus.SUPERSEDED,
  ])('acknowledges a settled %s delivery without invoking the solver', async (status) => {
    const f = fixture();
    f.run.status = status;

    await expect(f.service.deliver(f.run.id, deliveryOptions)).resolves.toEqual(
      { kind: 'settled' },
    );
    expect(f.scheduler.solve).not.toHaveBeenCalled();
  });

  it('acknowledges an already-cancelled delivery as cancelled', async () => {
    const f = fixture();
    f.run.status = ScheduleRunStatus.CANCELLED;

    await expect(f.service.deliver(f.run.id, deliveryOptions)).resolves.toEqual(
      { kind: 'cancelled' },
    );
    expect(f.scheduler.solve).not.toHaveBeenCalled();
  });

  it('reclaims an expired lease and completes the delivery', async () => {
    const f = fixture();
    f.run.status = ScheduleRunStatus.RUNNING;
    f.run.executionLeaseId = '00000000-0000-4000-8000-000000000001';
    f.run.executionLeaseExpiresAt = new Date(Date.now() - 1_000);

    const pending = f.service.deliver(f.run.id, deliveryOptions);
    await f.started.promise;
    f.release();

    await expect(pending).resolves.toMatchObject({ kind: 'completed' });
    expect(f.run.executionAttempt).toBe(1);
    expect(f.run.executionLeaseId).not.toBe(
      '00000000-0000-4000-8000-000000000001',
    );
  });

  it('reserves time for solver transport and persistence inside the execution lease', async () => {
    const f = fixture();
    f.run.timeLimitSeconds = 300;

    const pending = f.service.deliver(f.run.id, {
      executionBudgetSeconds: 55,
      retryOnFailure: true,
    });
    await f.started.promise;
    f.release();
    await pending;

    expect(f.scheduler.solve).toHaveBeenCalledWith(
      expect.objectContaining({ time_limit_seconds: 4 }),
      18_000,
    );
  });

  it('rejects stale progress, failure, and finalization after another delivery reclaims the lease', async () => {
    const f = fixture();
    const staleLease = {
      id: '00000000-0000-4000-8000-000000000001',
      expiresAt: new Date(Date.now() + 60_000),
    };
    f.run.status = ScheduleRunStatus.RUNNING;
    f.run.executionLeaseId = '00000000-0000-4000-8000-000000000002';
    f.run.executionLeaseExpiresAt = new Date(Date.now() + 60_000);

    await expect(f.service.setProgress(f.run.id, staleLease, 99)).rejects.toMatchObject({
      code: 'RESOURCE_CONFLICT',
    });
    await expect(
      f.service.fail(f.run.id, staleLease, 'STALE', 'must not persist'),
    ).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    await expect(
      (
        f.service as unknown as {
          finish: (
            id: string,
            scheduled: number,
            unassigned: number,
            lease: typeof staleLease,
          ) => Promise<unknown>;
        }
      ).finish(f.run.id, 9, 0, staleLease),
    ).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });

    expect(f.run).toMatchObject({
      status: ScheduleRunStatus.RUNNING,
      executionLeaseId: '00000000-0000-4000-8000-000000000002',
    });
  });

  it('acknowledges a cancelled delivery without invoking the solver', async () => {
    const f = fixture();
    f.run.cancelRequestedAt = new Date();

    await expect(f.service.deliver(f.run.id, deliveryOptions)).resolves.toEqual(
      {
        kind: 'cancelled',
      },
    );
    expect(f.scheduler.solve).not.toHaveBeenCalled();
  });

  it('keeps a cancellation delivery retriable while the current lease is live', async () => {
    const f = fixture();
    f.run.status = ScheduleRunStatus.RUNNING;
    f.run.cancelRequestedAt = new Date();
    f.run.executionLeaseId = '00000000-0000-4000-8000-000000000001';
    f.run.executionLeaseExpiresAt = new Date(Date.now() + 60_000);

    await expect(f.service.deliver(f.run.id, deliveryOptions)).resolves.toEqual(
      { kind: 'busy' },
    );
    expect(f.scheduler.solve).not.toHaveBeenCalled();
    expect(f.run.status).toBe(ScheduleRunStatus.RUNNING);
  });

  it('atomically refuses a lease after the delivery generation is superseded', async () => {
    const f = fixture();
    const supersededDispatchId = f.dispatchOutbox.id;
    f.dispatchOutbox.id = '00000000-0000-4000-8000-000000000002';

    await expect(
      f.service.deliver(f.run.id, {
        ...deliveryOptions,
        dispatchId: supersededDispatchId,
      }),
    ).resolves.toEqual({ kind: 'busy' });

    expect(f.scheduler.solve).not.toHaveBeenCalled();
    expect(f.run.status).toBe(ScheduleRunStatus.QUEUED);
  });

  it('atomically refuses a lease after a terminal callback is recorded', async () => {
    const f = fixture();
    f.dispatchOutbox.terminalFailureAt = new Date();

    await expect(
      f.service.deliver(f.run.id, {
        ...deliveryOptions,
        dispatchId: f.dispatchOutbox.id,
      }),
    ).resolves.toEqual({ kind: 'busy' });

    expect(f.scheduler.solve).not.toHaveBeenCalled();
    expect(f.run.status).toBe(ScheduleRunStatus.QUEUED);
  });

  it('only accepts a QStash failure callback for the stored delivery ID', async () => {
    const f = fixture();

    await f.service.failForQStash(
      f.run.id,
      '00000000-0000-4000-8000-000000000000',
      'msg_other',
      'QSTASH_DELIVERY_FAILED',
      'failed',
    );
    expect(f.run.status).toBe(ScheduleRunStatus.QUEUED);

    await f.service.failForQStash(
      f.run.id,
      f.dispatchOutbox.id,
      'msg_current',
      'QSTASH_DELIVERY_FAILED',
      'failed',
    );
    expect(f.run).toMatchObject({
      status: ScheduleRunStatus.FAILED,
      errorCode: 'QSTASH_DELIVERY_FAILED',
    });
    expect(f.dispatchOutbox).toMatchObject({
      status: 'CANCELLED',
      terminalFailureMessageId: null,
      terminalFailureCode: null,
      terminalFailureMessage: null,
      terminalFailureAt: null,
    });
  });

  it('settles a signed QStash failure after publish succeeded but the job-id write was lost', async () => {
    const f = fixture();
    f.run.jobId = null;
    f.dispatchOutbox.status = 'PENDING';
    f.dispatchOutbox.messageId = null;

    await expect(
      f.service.failForQStash(
        f.run.id,
        f.dispatchOutbox.id,
        'msg_recovered',
        'QSTASH_DELIVERY_FAILED',
        'failed',
      ),
    ).resolves.toBe('failed');

    expect(f.run).toMatchObject({
      status: ScheduleRunStatus.FAILED,
      jobId: 'msg_recovered',
    });
    expect(f.dispatchOutbox.status).toBe('CANCELLED');
    expect(f.dispatchOutbox.terminalFailureAt).toBeNull();
  });

  it('consumes a matching terminal callback when the run is already settled', async () => {
    const f = fixture();
    f.run.status = ScheduleRunStatus.SUCCEEDED;

    await expect(
      f.service.failForQStash(
        f.run.id,
        f.dispatchOutbox.id,
        'msg_current',
        'QSTASH_DELIVERY_FAILED',
        'failed',
      ),
    ).resolves.toBe('ignored');

    expect(f.run.status).toBe(ScheduleRunStatus.SUCCEEDED);
    expect(f.dispatchOutbox).toMatchObject({
      status: 'CANCELLED',
      terminalFailureMessageId: null,
      terminalFailureCode: null,
      terminalFailureMessage: null,
      terminalFailureAt: null,
    });
  });

  it('settles an exactly-expiring cancellation during the direct QStash failure callback', async () => {
    jest.useFakeTimers();
    try {
      const now = new Date('2027-03-01T12:00:00.000Z');
      jest.setSystemTime(now);
      const f = fixture();
      f.run.status = ScheduleRunStatus.RUNNING;
      f.run.cancelRequestedAt = now;
      f.run.executionLeaseId = '00000000-0000-4000-8000-000000000001';
      f.run.executionLeaseExpiresAt = now;

      await expect(
        f.service.failForQStash(
          f.run.id,
          f.dispatchOutbox.id,
          'msg_current',
          'QSTASH_DELIVERY_FAILED',
          'failed',
        ),
      ).resolves.toBe('ignored');

      expect(f.run).toMatchObject({
        status: ScheduleRunStatus.CANCELLED,
        executionLeaseId: null,
        executionLeaseExpiresAt: null,
      });
      expect(f.dispatchOutbox).toMatchObject({
        status: 'CANCELLED',
        terminalFailureAt: null,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('durably records a matching QStash terminal failure while another lease is active', async () => {
    const f = fixture();
    f.run.status = ScheduleRunStatus.RUNNING;
    f.run.executionLeaseId = '00000000-0000-4000-8000-000000000001';
    f.run.executionLeaseExpiresAt = new Date(Date.now() + 60_000);

    await expect(
      f.service.failForQStash(
        f.run.id,
        f.dispatchOutbox.id,
        'msg_current',
        'QSTASH_DELIVERY_FAILED',
        'failed',
      ),
    ).resolves.toBe('deferred');

    expect(f.run.status).toBe(ScheduleRunStatus.RUNNING);
    expect(f.dispatchOutbox.terminalFailureAt).toBeInstanceOf(Date);
  });
});

/**
 * The daily cap, held where the move is actually committed.
 *
 * Generation spreads a calendar so no branch-day carries more than
 * `VISIT_GENERATION_DAILY_CAP`. The solver is never told that number, so it
 * moved work on to days that were already full and handed the manager back the
 * twenty-job day the cap exists to prevent. These cover the decision itself:
 * what is refused, what is not, and what a manager is told when it is.
 */
describe('the daily-cap backstop on a solver move', () => {
  it('refuses a move on to a day already at the cap and leaves the visit where it was', async () => {
    const f = fixture('2027-03-04', AssignmentStatus.DRAFT, {
      '2027-03-04': 12,
    });

    const pending = f.processor.process(f.job);
    await f.started.promise;
    f.release();
    await pending;

    // The visit keeps its generated date, and the assignment is written for
    // that date rather than the one the solver chose.
    expect(f.visit.visitDate).toEqual(new Date('2027-03-03T00:00:00Z'));
    expect(f.visit.status).toBe(VisitStatus.SCHEDULED);
    expect(f.generatedVisit.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: VisitStatus.SCHEDULED },
      }),
    );
    // The engine was asked about the day the visit is standing on, not the
    // day the solver wanted: refusing a move is not refusing an assignment.
    expect(f.eligibility.evaluate).toHaveBeenCalledWith(
      f.visit.id,
      expect.anything(),
      expect.objectContaining({ proposedVisit: undefined }),
      expect.anything(),
    );
  });

  it('lets a move on to a day with room through', async () => {
    const f = fixture('2027-03-04', AssignmentStatus.DRAFT, {
      '2027-03-04': 10,
    });

    const pending = f.processor.process(f.job);
    await f.started.promise;
    f.release();
    await pending;

    // Ten reference hours plus the visit's own ninety minutes stays under
    // twelve, so the move is the solver's to place. A backstop that refused
    // this would have satisfied the cap by destroying the optimizer.
    expect(f.visit.visitDate).toEqual(new Date('2027-03-04T00:00:00Z'));
    expect(f.visit.status).toBe(VisitStatus.SCHEDULED);
  });

  it('still assigns a crew to a visit standing on a day that is already over the cap', async () => {
    // Twenty on the visit's own day, and the solver is not moving it. A day
    // over the cap from protected work still needs its crews; only making it
    // worse is refused.
    const f = fixture('2027-03-03', AssignmentStatus.DRAFT, {
      '2027-03-03': 20,
    });

    const pending = f.processor.process(f.job);
    await f.started.promise;
    f.release();
    await pending;

    expect(f.visit.status).toBe(VisitStatus.SCHEDULED);
    expect(f.reasons.createMany).not.toHaveBeenCalled();
    expect(f.assignments.map((entry) => entry.id)).toContain('replacement');
  });

  it('tells the manager the day was full when the kept day cannot be crewed', async () => {
    const f = fixture('2027-03-04', AssignmentStatus.DRAFT, {
      '2027-03-04': 12,
    });
    // The solver's crew works on the 4th and not on the 3rd. With the move
    // refused the visit has nowhere to be staffed, and must say so rather
    // than disappear.
    f.eligibility.evaluate.mockResolvedValue({
      isEligible: false,
      conflicts: [
        {
          code: 'EMPLOYEE_DOUBLE_BOOKED',
          message: 'Employee is already booked.',
          remediation: 'Choose somebody else.',
          resources: { employeeIds: ['employee'] },
        },
      ],
    } as never);

    const pending = f.processor.process(f.job);
    await f.started.promise;
    f.release();
    await pending;

    expect(f.visit.status).toBe(VisitStatus.UNASSIGNED);
    expect(f.visit.visitDate).toEqual(new Date('2027-03-03T00:00:00Z'));

    const written = f.reasons.createMany.mock.calls[0][0] as {
      data: { code: string; message: string; details: unknown }[];
    };
    // The cap refusal comes first: it is why the visit is on this day at all,
    // and a queue that only said "employee double booked" would be telling
    // the manager to fix the wrong thing.
    expect(written.data.map((row) => row.code)).toEqual([
      'DAILY_VISIT_CAP_REACHED',
      'EMPLOYEE_DOUBLE_BOOKED',
    ]);
    expect(written.data[0].message).toContain('2027-03-04');
    expect(written.data[0].message).toContain('720 crew-minutes');
    expect(written.data[0].message).toContain('2027-03-03');
    expect(written.data[0].details).toMatchObject({
      remediation: expect.stringContaining('2027-03-04'),
    });
  });

  /**
   * A refused move must not leave the engine reasoning about the day the
   * visit did not go to.
   *
   * The visit keeps its generated date, so every conflict recorded beside the
   * cap refusal has to have been judged against that date: the crews and
   * vehicles busy then, the site's hours then. Were the engine still handed
   * the day the solver proposed, the queue would name clashes on a day the
   * visit is not on — and the Edit crew drawer, which checks live against the
   * real date, would contradict it on the same screen.
   */
  it('judges a refused move against the day the visit kept, never the day it was offered', async () => {
    const f = fixture('2027-03-04', AssignmentStatus.DRAFT, {
      '2027-03-04': 12,
    });
    f.eligibility.evaluate.mockResolvedValue({
      isEligible: false,
      conflicts: [
        {
          code: 'EMPLOYEE_DOUBLE_BOOKED',
          message: 'Employee is already booked.',
          remediation: 'Choose somebody else.',
          resources: { employeeIds: ['employee'] },
        },
      ],
    } as never);

    const pending = f.processor.process(f.job);
    await f.started.promise;
    f.release();
    await pending;

    // proposedVisit undefined: the engine reads the visit's own stored date,
    // window and duration, and loads that day's busy windows.
    expect(f.eligibility.evaluate).toHaveBeenCalledWith(
      'visit',
      expect.any(Object),
      expect.objectContaining({ proposedVisit: undefined }),
      f.tx,
    );
    expect(f.visit.visitDate).toEqual(new Date('2027-03-03T00:00:00Z'));
  });

  /**
   * The same rule for the other way a move can fail.
   *
   * The cap refuses a move before the engine ever sees it, and that path has
   * been right since the last round. But a move the cap lets through can still
   * be refused by the engine itself — the crew the solver chose is busy on the
   * day it wanted — and that refusal used to be recorded as-is: conflicts
   * judged against the proposed day, written against a visit that never left
   * its generated one. A coordinator found unassigned visits dated Monday 21
   * September whose reasons cited clashes on the previous Friday and Saturday,
   * and there is no way to tell from the queue that those dates are not the
   * visit's own. Sent to the wrong day, a manager checks the wrong crews.
   */
  it('re-judges a move the engine refuses against the day the visit keeps', async () => {
    // Ten reference hours on the 4th, comfortably under the cap once the
    // visit's own ninety minutes are added: the cap lets the move through,
    // so the refusal here is the engine's own.
    const f = fixture('2027-03-04', AssignmentStatus.DRAFT, {
      '2027-03-04': 10,
    });
    f.eligibility.evaluate.mockImplementation(
      (async (
        _visitId: string,
        _proposal: unknown,
        options: { proposedVisit?: { visitDate: Date } },
      ) => ({
        isEligible: false,
        conflicts: [
          {
            code: 'EMPLOYEE_DOUBLE_BOOKED',
            message: `Employee is already on another job on ${
              options.proposedVisit
                ? options.proposedVisit.visitDate.toISOString().slice(0, 10)
                : '2027-03-03'
            }.`,
            remediation: 'Choose somebody else.',
            resources: { employeeIds: ['employee'] },
          },
        ],
      })) as never,
    );

    const pending = f.processor.process(f.job);
    await f.started.promise;
    f.release();
    await pending;

    expect(f.visit.visitDate).toEqual(new Date('2027-03-03T00:00:00Z'));
    expect(f.visit.status).toBe(VisitStatus.UNASSIGNED);
    // The last question asked was about the day the visit is actually on.
    expect(f.eligibility.evaluate).toHaveBeenLastCalledWith(
      'visit',
      expect.any(Object),
      expect.objectContaining({ proposedVisit: undefined }),
      f.tx,
    );

    const written = f.reasons.createMany.mock.calls[0][0] as {
      data: { code: string; message: string }[];
    };
    expect(written.data).toHaveLength(1);
    expect(written.data[0].message).toContain('2027-03-03');
    // The day the visit did not go to must not appear as though it were the
    // visit's own.
    expect(written.data[0].message).not.toContain('2027-03-04');
  });

  /**
   * Refusing a move is not refusing an assignment — the principle the cap
   * backstop already runs on, applied to the engine's own refusal. A crew that
   * cannot serve the day the solver wanted may well be free on the day the
   * visit was generated for, and leaving that visit unstaffed helps nobody.
   */
  it('staffs the day the visit keeps when only the move was impossible', async () => {
    const f = fixture('2027-03-04', AssignmentStatus.DRAFT, {
      '2027-03-04': 11,
    });
    f.eligibility.evaluate.mockImplementation(
      (async (
        _visitId: string,
        _proposal: unknown,
        options: { proposedVisit?: unknown },
      ) =>
        options.proposedVisit
          ? {
              isEligible: false,
              conflicts: [
                {
                  code: 'EMPLOYEE_DOUBLE_BOOKED',
                  message: 'Employee is already on another job on 2027-03-04.',
                  remediation: 'Choose somebody else.',
                  resources: { employeeIds: ['employee'] },
                },
              ],
            }
          : { isEligible: true, conflicts: [] }) as never,
    );

    const pending = f.processor.process(f.job);
    await f.started.promise;
    f.release();
    await pending;

    expect(f.visit.visitDate).toEqual(new Date('2027-03-03T00:00:00Z'));
    expect(f.visit.status).toBe(VisitStatus.SCHEDULED);
    expect(f.reasons.createMany).not.toHaveBeenCalled();
  });

  it('reads no day load at all when the solver moves nothing', async () => {
    const f = fixture();

    const pending = f.processor.process(f.job);
    await f.started.promise;
    f.release();
    await pending;

    // A run that proposes no move asks the database nothing extra. The cap is
    // a rule about moving work, so a solve that only staffs what is already
    // dated pays nothing for it — and takes no branch-day lock, so it never
    // queues behind a run that is actually moving something.
    expect(f.generatedVisit.dayLoadFindMany).not.toHaveBeenCalled();
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
    expect(f.visit.status).toBe(VisitStatus.SCHEDULED);
  });

  it('holds the day it is moving on to before it counts what stands there', async () => {
    const f = fixture('2027-03-04', AssignmentStatus.DRAFT, {
      '2027-03-04': 11,
    });

    const pending = f.processor.process(f.job);
    await f.started.promise;
    f.release();
    await pending;

    // The count is an aggregate and locks nothing, so reading it before the
    // day is held would let two runs over disjoint work both see room for one
    // and both take it. The lock names the destination day, in this codebase's
    // own advisory scheme, and it is asked for first.
    const [lock] = f.tx.$executeRaw.mock.calls;
    expect(lock.slice(1)).toEqual([
      BRANCH_DAY_LOCK_CLASS,
      branchDayLockKey(BranchCode.COLOMBO, '2027-03-04'),
    ]);
    expect(f.tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      f.generatedVisit.dayLoadFindMany.mock.invocationCallOrder[0],
    );
  });
});

/**
 * The Dispatch Board's Supervisor column reads the PMS grade; the Edit crew
 * drawer reads the crew row's role. The solver was stamping SUPERVISOR on
 * whoever came first in `employee_ids`, which the Python model sorts by
 * employee UUID — so on the same visit the column named the PMS-grade person
 * and the drawer called them a Technician while labelling somebody else
 * Supervisor. The role now follows the grade that actually satisfies the rule.
 */
describe('solvedCrewRoles', () => {
  const pms = (...ids: string[]) => (id: string) => ids.includes(id);

  it('makes the PMS-grade member the supervisor, wherever the solver put them', () => {
    expect(solvedCrewRoles(['tech-22', 'tech-13'], pms('tech-13'))).toEqual([
      { employeeId: 'tech-22', role: CrewRole.TECHNICIAN },
      { employeeId: 'tech-13', role: CrewRole.SUPERVISOR },
    ]);
  });

  it('names exactly one supervisor when the crew holds more than one PMS grade', () => {
    const roles = solvedCrewRoles(['a', 'b', 'c'], pms('b', 'c'));

    expect(roles.filter((member) => member.role === CrewRole.SUPERVISOR)).toEqual([
      { employeeId: 'b', role: CrewRole.SUPERVISOR },
    ]);
  });

  it('retains the exact pinned supervisor when another PMS-grade member sorts first', () => {
    expect(solvedCrewRoles(['a', 'b'], pms('a', 'b'), ['b'])).toEqual([
      { employeeId: 'a', role: CrewRole.TECHNICIAN },
      { employeeId: 'b', role: CrewRole.SUPERVISOR },
    ]);
  });

  it('retains every historical supervisor identity when a pinned crew had more than one', () => {
    expect(solvedCrewRoles(['a', 'b', 'c'], pms('a', 'b'), ['a', 'b'])).toEqual([
      { employeeId: 'a', role: CrewRole.SUPERVISOR },
      { employeeId: 'b', role: CrewRole.SUPERVISOR },
      { employeeId: 'c', role: CrewRole.TECHNICIAN },
    ]);
  });

  it('falls back to the first member when no grade is known, rather than leaving nobody in charge', () => {
    // The eligibility engine refuses a crew with no PMS grade, so this is a
    // defined outcome for an impossible input, not a supported one.
    expect(solvedCrewRoles(['a', 'b'], () => false)).toEqual([
      { employeeId: 'a', role: CrewRole.SUPERVISOR },
      { employeeId: 'b', role: CrewRole.TECHNICIAN },
    ]);
  });

  it('has nothing to say about an empty crew', () => {
    expect(solvedCrewRoles([], () => true)).toEqual([]);
  });
});

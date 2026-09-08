import {
  AssignmentStatus,
  BranchCode,
  Prisma,
  ScheduleRunStatus,
  VisitStatus,
} from '@prisma/client';
import { Job } from 'bullmq';

import { AuditService } from '../../audit/audit.service';
import { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../prisma/prisma.service';
import { EligibilityService } from '../eligibility/eligibility.service';
import {
  ScheduleRunJobData,
  ScheduleRunProcessor,
} from './schedule-run.processor';
import { ScheduleRunService } from './schedule-run.service';
import { SELF_HOSTED_EXECUTION_BUDGET_SECONDS } from './schedule-run-execution-budget';
import { SchedulerClient, SolveResponse } from './scheduler.client';
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
) {
  const started = deferred<void>();
  const answer = deferred<SolveResponse>();
  const visit = {
    id: 'visit',
    updatedAt: new Date('2027-02-01T00:00:00Z'),
    branchId: 'branch',
    branchCode: BranchCode.COLOMBO,
    visitDate: new Date('2027-03-03T00:00:00Z'),
    windowStartMinute: 540,
    windowEndMinute: 720,
    durationMinutes: 90,
    requiredCrewSize: 1,
    status: VisitStatus.SCHEDULED,
    serviceAgreementId: 'agreement',
    serviceAgreement: {
      requiredSkills: [],
      dayRules: [],
      serviceSiteId: 'site',
      serviceWindowStartMinute: 540,
      serviceWindowEndMinute: 720,
      serviceSite: { operatingHours: [] },
    },
  };
  const oldAssignment = {
    id: 'snapshotted',
    status: initialStatus,
    crewMembers: [{ employeeId: 'employee', isPmsSupervisor: true }],
    vehicles: [],
    locks: [],
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
  const generatedVisit = {
    findMany: jest.fn(async () => [
      { ...visit, assignments: assignments.map((a) => ({ ...a })) },
    ]),
    findUniqueOrThrow: jest.fn(async () => ({ ...visit })),
    update: jest.fn(async ({ data }: { data: Partial<typeof visit> }) =>
      Object.assign(visit, data),
    ),
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
          if (
            condition.executionLeaseExpiresAt === null &&
            run.executionLeaseExpiresAt
          )
            return false;
          const expiry = condition.executionLeaseExpiresAt as
            { gt?: Date; lt?: Date } | undefined;
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
    generatedVisit,
    visitUnassignedReason: { deleteMany: jest.fn(), createMany: jest.fn() },
    $queryRaw: jest.fn(async (query: Prisma.Sql) =>
      query.sql.includes('generated_visits')
        ? [{ id: visit.id }]
        : assignments
            .filter((entry) => entry.id === query.values[0])
            .map((entry) => ({ status: entry.status })),
    ),
  };
  const prisma = {
    ...tx,
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
  );
  const processor = new ScheduleRunProcessor(service);
  const job = {
    data: { runId: run.id, timeLimitSeconds: 1 },
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
  };

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
    ScheduleRunStatus.CANCELLED,
  ])('acknowledges a settled %s delivery without invoking the solver', async (status) => {
    const f = fixture();
    f.run.status = status;

    await expect(f.service.deliver(f.run.id, deliveryOptions)).resolves.toEqual(
      { kind: 'settled' },
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
      expect.objectContaining({ time_limit_seconds: 9 }),
      19_000,
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

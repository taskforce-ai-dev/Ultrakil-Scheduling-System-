import {
  AssignmentStatus,
  BranchCode,
  Prisma,
  ScheduleRunStatus,
  VisitStatus,
} from '@prisma/client';
import { Job } from 'bullmq';

import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EligibilityService } from '../eligibility/eligibility.service';
import {
  ScheduleRunJobData,
  ScheduleRunProcessor,
} from './schedule-run.processor';
import { ScheduleRunService } from './schedule-run.service';
import { SchedulerClient, SolveResponse } from './scheduler.client';

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
    status: ScheduleRunStatus.QUEUED,
    rangeStart: new Date('2027-03-01T00:00:00Z'),
    rangeEnd: new Date('2027-03-07T00:00:00Z'),
    cancelRequestedAt: null,
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
    create: jest.fn(async () =>
      assignments.push({
        ...oldAssignment,
        id: 'replacement',
        status: AssignmentStatus.DRAFT,
      }),
    ),
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
  const tx = {
    assignment,
    generatedVisit,
    visitUnassignedReason: { deleteMany: jest.fn(), createMany: jest.fn() },
    $queryRaw: jest.fn(async (query: Prisma.Sql) =>
      assignments
        .filter((entry) => entry.id === query.values[0])
        .map((entry) => ({ status: entry.status })),
    ),
  };
  const prisma = {
    ...tx,
    scheduleRun: {
      findUnique: jest.fn(async () => ({ ...run })),
      update: jest.fn(async ({ data }: { data: Partial<typeof run> }) =>
        Object.assign(run, data),
      ),
    },
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
    started,
    release,
    processor,
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
  };
}

describe('solver replacement lifecycle fence', () => {
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
    expect(f.reasons.createMany).toHaveBeenCalledWith({
      data: [
        {
          generatedVisitId: 'visit',
          scheduleRunId: 'run',
          code: 'NO_CREW',
          message: 'No crew available',
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

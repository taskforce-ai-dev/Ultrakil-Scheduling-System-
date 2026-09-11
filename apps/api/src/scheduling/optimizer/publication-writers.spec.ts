import {
  AssignmentStatus,
  BranchCode,
  CrewRole,
  DataProvenance,
  LockScope,
  Prisma,
  ScheduleRunStatus,
  SiteBranchConfidence,
  SiteBranchSource,
  VisitStatus,
} from '@prisma/client';

import { AuditService } from '../../audit/audit.service';
import { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../prisma/prisma.service';
import { AssignmentsService } from '../eligibility/assignments.service';
import { EligibilityService } from '../eligibility/eligibility.service';
import { EligibilityResult } from '../eligibility/rules';
import { VisitsService } from '../visits/visits.service';
import { PublishingService } from './publishing.service';

const actor = { id: 'actor' } as AuthenticatedUser;
const proposal = {
  plannedStartMinute: 540,
  plannedEndMinute: 630,
  crew: [{ employeeId: 'employee', role: CrewRole.SUPERVISOR }],
};

function fixture() {
  const visit = {
    id: 'visit',
    branchId: 'branch',
    branchCode: BranchCode.COLOMBO,
    visitDate: new Date('2027-03-03T00:00:00Z'),
    status: VisitStatus.SCHEDULED,
    windowStartMinute: 480,
    windowEndMinute: 1020,
    durationMinutes: 90,
    requiredCrewSize: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    isManuallyAdjusted: false,
    lockedAt: null,
    // Confirmed source data by default: the publication gate has nothing to
    // warn about unless a test deliberately unconfirms something.
    windowProvenance: DataProvenance.SOURCE as DataProvenance,
    serviceAgreement: {
      customer: { name: 'Customer' },
      serviceSite: {
        name: 'Site',
        branchConfidence: SiteBranchConfidence.CONFIRMED as SiteBranchConfidence,
        branchSource: SiteBranchSource.MANAGER_CONFIRMED as SiteBranchSource,
        _count: { operatingHours: 1 },
      },
      jobType: { name: 'Job' },
      crewSizeProvenance: DataProvenance.SOURCE as DataProvenance,
      durationProvenance: DataProvenance.SOURCE as DataProvenance,
      dayRuleProvenance: DataProvenance.SOURCE as DataProvenance,
    },
    _count: { assignments: 1 },
  };
  const original = {
    id: 'draft',
    generatedVisitId: visit.id,
    status: AssignmentStatus.DRAFT as AssignmentStatus,
    publishedAt: null as Date | null,
    scheduleRunId: 'original-run',
    plannedStart: new Date('2027-03-03T09:00:00Z'),
    plannedEnd: new Date('2027-03-03T10:30:00Z'),
    createdAt: new Date(),
    updatedAt: new Date(),
    branchCode: BranchCode.COLOMBO,
    crewMembers: [
      {
        employeeId: 'employee',
        employee: { fullName: 'Employee' },
        role: CrewRole.SUPERVISOR,
        isPmsSupervisor: true,
      },
    ],
    vehicles: [] as {
      vehicleId: string;
      vehicle: { label: string; branchId: string | null };
      driverEmployeeId: string | null;
    }[],
    locks: [],
  };
  const assignments = [original];
  const outbox: { assignmentId: string }[] = [];
  let heldLock: {
    assignmentId: string;
    scope: LockScope;
    reason: string | null;
    lockedByUserId: string;
    releasedAt: Date | null;
    updatedAt: Date;
  } | null = null;
  let beforeTransaction: () => Promise<void> = async () => undefined;
  const rows = () =>
    assignments.map((entry) => ({
      ...entry,
      generatedVisit: structuredClone(visit),
      _count: {
        notificationOutboxEntries: outbox.filter(
          (n) => n.assignmentId === entry.id,
        ).length,
      },
    }));
  const remove = (id: string, statuses?: AssignmentStatus[]) => {
    const index = assignments.findIndex(
      (entry) =>
        entry.id === id && (!statuses || statuses.includes(entry.status)),
    );
    if (index < 0) return 0;
    assignments.splice(index, 1);
    for (let i = outbox.length - 1; i >= 0; i--)
      if (outbox[i].assignmentId === id) outbox.splice(i, 1);
    return 1;
  };
  const assignment = {
    findFirst: jest.fn(
      async ({ where }: { where: { status?: { in: AssignmentStatus[] } } }) =>
        rows().find(
          (entry) => !where.status || where.status.in.includes(entry.status),
        ) ?? null,
    ),
    findUnique: jest.fn(
      async ({ where }: { where: { id: string } }) =>
        rows().find((entry) => entry.id === where.id) ?? null,
    ),
    findUniqueOrThrow: jest.fn(
      async ({ where }: { where: { id: string } }) =>
        rows().find((entry) => entry.id === where.id)!,
    ),
    findMany: jest.fn(
      async (args: {
        where?: {
          status?: AssignmentStatus | { in: AssignmentStatus[] };
          id?: { in: string[] };
        };
      }) =>
        rows().filter((entry) => {
          const status = args.where?.status;
          return (
            (!status ||
              (typeof status === 'string'
                ? entry.status === status
                : status.in.includes(entry.status))) &&
            (!args.where?.id || args.where.id.in.includes(entry.id))
          );
        }),
    ),
    delete: jest.fn(async ({ where }: { where: { id: string } }) =>
      remove(where.id),
    ),
    deleteMany: jest.fn(
      async ({
        where,
      }: {
        where: { id: string; status: { in: AssignmentStatus[] } };
      }) => ({ count: remove(where.id, where.status.in) }),
    ),
    updateMany: jest.fn(
      async ({
        where,
        data,
      }: {
        where: {
          id: string | { in: string[] };
          status?: AssignmentStatus | { in: AssignmentStatus[] };
        };
        data: Partial<typeof original>;
      }) => {
        let count = 0;
        for (const entry of assignments) {
          const matchesId =
            typeof where.id === 'string'
              ? entry.id === where.id
              : where.id.in.includes(entry.id);
          const status = where.status;
          if (
            matchesId &&
            (!status ||
              (typeof status === 'string'
                ? entry.status === status
                : status.in.includes(entry.status)))
          ) {
            Object.assign(entry, data);
            count++;
          }
        }
        return { count };
      },
    ),
    create: jest.fn(async () => {
      const created = {
        ...original,
        id: 'replacement',
        status: AssignmentStatus.DRAFT,
      };
      assignments.push(created);
      return created;
    }),
  };
  const assignmentLock = {
    findUnique: jest.fn(async ({ include }: { include?: unknown }) =>
      heldLock
        ? {
            ...heldLock,
            ...(include
              ? { assignment: { generatedVisitId: original.generatedVisitId } }
              : {}),
          }
        : null,
    ),
    upsert: jest.fn(
      async ({ create, update }: { create: typeof heldLock; update: object }) => {
        heldLock = heldLock
          ? Object.assign(heldLock, update)
          : { ...create!, releasedAt: null, updatedAt: new Date() };
        return heldLock;
      },
    ),
    update: jest.fn(async ({ data }: { data: object }) =>
      Object.assign(heldLock!, data),
    ),
  };
  const audit = { record: jest.fn() };
  const run = {
    id: 'original-run',
    status: ScheduleRunStatus.SUCCEEDED,
    publishedAt: null,
    visitsConsidered: 1,
    visitsScheduled: 1,
    visitsUnassigned: 0,
  };
  const prisma = {
    assignment,
    assignmentLock,
    generatedVisit: {
      findUnique: jest.fn(async () => structuredClone(visit)),
      findUniqueOrThrow: jest.fn(async () => structuredClone(visit)),
      update: jest.fn(async ({ data }: { data: Partial<typeof visit> }) =>
        Object.assign(visit, data),
      ),
    },
    employee: {
      findMany: jest.fn(async () => [{ id: 'employee', isPmsGrade: true }]),
    },
    visitUnassignedReason: { deleteMany: jest.fn(), createMany: jest.fn() },
    assignmentNotificationOutbox: { createMany: jest.fn() },
    scheduleRun: {
      findUnique: jest.fn(async () => ({ ...run, assignments: rows() })),
      findUniqueOrThrow: jest.fn(async () => run),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    $queryRaw: jest.fn(async (query: Prisma.Sql) =>
      query.sql.includes('employees')
        ? query.values.map((id) => ({ id }))
        : query.sql.includes('vehicles')
          ? query.values.map((id) => ({ id }))
          : [{ id: visit.id }],
    ),
    $transaction: jest.fn(
      async (work: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
        await beforeTransaction();
        return work(prisma);
      },
    ),
  };
  const eligibility = {
    evaluate: jest.fn(
      async (): Promise<EligibilityResult> => ({ isEligible: true, conflicts: [] }),
    ),
  };
  const client = prisma as unknown as PrismaService;
  const auditService = audit as unknown as AuditService;
  return {
    visit,
    original,
    assignments,
    outbox,
    heldLock: () => heldLock,
    holdLock: () => {
      heldLock = {
        assignmentId: original.id,
        scope: LockScope.CREW,
        reason: 'Existing lock',
        lockedByUserId: actor.id,
        releasedAt: null,
        updatedAt: new Date(),
      };
    },
    prisma,
    audit,
    eligibility,
    run,
    manual: new AssignmentsService(
      client,
      eligibility as unknown as EligibilityService,
      auditService,
    ),
    visits: new VisitsService(
      client,
      auditService,
      eligibility as unknown as EligibilityService,
    ),
    publishing: new PublishingService(
      client,
      auditService,
      eligibility as unknown as EligibilityService,
    ),
    beforeTransaction: (hook: () => Promise<void>) => {
      beforeTransaction = hook;
    },
    publish: () => {
      original.status = AssignmentStatus.PUBLISHED;
      original.publishedAt = new Date();
      outbox.push({ assignmentId: original.id });
    },
  };
}

describe('standard writers preserve publication', () => {
  it('locks manual assignment resources before eligibility is evaluated', async () => {
    const f = fixture();

    await f.manual.assign('visit', proposal, actor);

    const resourceLockCall = f.prisma.$queryRaw.mock.calls.findIndex(
      ([query]: [Prisma.Sql]) => query.sql.includes('employees'),
    );
    expect(resourceLockCall).toBeGreaterThanOrEqual(0);
    expect(
      f.prisma.$queryRaw.mock.invocationCallOrder[resourceLockCall],
    ).toBeLessThan(f.eligibility.evaluate.mock.invocationCallOrder[0]);
  });

  it.each(['assign', 'unassign'])(
    'fences %s when publication wins after the draft read',
    async (operation) => {
      const f = fixture();
      f.beforeTransaction(async () => {
        f.publish();
      });
      const pending =
        operation === 'assign'
          ? f.manual.assign('visit', proposal, actor)
          : f.manual.unassign('visit', actor);
      const failure = await pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(f.assignments).toEqual([f.original]);
      expect(f.outbox).toHaveLength(1);
      expect(f.visit.status).toBe(VisitStatus.SCHEDULED);
      expect(failure).toMatchObject({ code: 'RESOURCE_CONFLICT' });
    },
  );

  it.each([
    AssignmentStatus.PUBLISHED,
    AssignmentStatus.ACKNOWLEDGED,
    AssignmentStatus.IN_PROGRESS,
    AssignmentStatus.COMPLETED,
    AssignmentStatus.SUPERSEDED,
    AssignmentStatus.CANCELLED,
  ])(
    'preserves %s publication history for all manual writers',
    async (status) => {
      const f = fixture();
      f.publish();
      f.original.status = status;
      for (const mutation of [
        () => f.manual.assign('visit', proposal, actor),
        () => f.manual.unassign('visit', actor),
        () => f.visits.adjust('visit', { visitDate: '2027-03-04' }, actor),
      ]) {
        expect(
          await mutation().then(
            () => undefined,
            (error: unknown) => error,
          ),
        ).toMatchObject({ code: 'RESOURCE_CONFLICT' });
      }
      expect(f.outbox).toHaveLength(1);
      expect(f.assignments).toEqual([f.original]);
      expect(f.visit.visitDate).toEqual(new Date('2027-03-03T00:00:00Z'));
    },
  );

  it('does not record a rejected empty-snapshot proposal over a new publication', async () => {
    const f = fixture();
    f.assignments.splice(0);
    f.eligibility.evaluate.mockResolvedValue({
      isEligible: false,
      conflicts: [],
    });
    f.beforeTransaction(async () => {
      f.assignments.push(f.original);
      f.publish();
    });
    const failure = await f.manual.assign('visit', proposal, actor).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(f.visit.status).toBe(VisitStatus.SCHEDULED);
    expect(f.prisma.visitUnassignedReason.createMany).not.toHaveBeenCalled();
    expect(failure).toMatchObject({ code: 'RESOURCE_CONFLICT' });
  });

  it.each(['assign', 'unassign'])(
    'still permits a legitimate DRAFT %s',
    async (operation) => {
      const f = fixture();
      if (operation === 'assign') {
        await f.manual.assign('visit', proposal, actor);
        expect(f.assignments.map((entry) => entry.id)).toEqual(['replacement']);
      } else {
        await f.manual.unassign('visit', actor);
        expect(f.assignments).toHaveLength(0);
        expect(f.visit.status).toBe(VisitStatus.UNASSIGNED);
      }
    },
  );

  it('checks and replaces a manual assignment inside one bounded transaction', async () => {
    const f = fixture();

    await f.manual.assign('visit', proposal, actor);

    expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 30_000,
    });
    expect(f.eligibility.evaluate).toHaveBeenCalledWith(
      'visit',
      expect.any(Object),
      { excludeAssignmentId: 'draft' },
      f.prisma,
    );
  });

  it('moves draft timing with an eligible visit adjustment', async () => {
    const f = fixture();
    await f.visits.adjust('visit', { visitDate: '2027-03-04' }, actor);
    expect(f.original.plannedStart).toEqual(new Date('2027-03-04T09:00:00Z'));
    expect(f.original.plannedEnd).toEqual(new Date('2027-03-04T10:30:00Z'));
    expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 30_000,
    });
    expect(f.eligibility.evaluate).toHaveBeenCalledWith(
      'visit',
      expect.any(Object),
      expect.objectContaining({ excludeAssignmentId: 'draft' }),
      f.prisma,
    );
    const resourceLockCall = f.prisma.$queryRaw.mock.calls.findIndex(
      ([query]: [Prisma.Sql]) => query.sql.includes('employees'),
    );
    expect(resourceLockCall).toBeGreaterThanOrEqual(0);
    expect(
      f.prisma.$queryRaw.mock.invocationCallOrder[resourceLockCall],
    ).toBeLessThan(f.eligibility.evaluate.mock.invocationCallOrder[0]);
  });

  it('rejects an adjustment that makes the draft crew ineligible before any write', async () => {
    const f = fixture();
    const visitBefore = structuredClone(f.visit);
    const assignmentBefore = structuredClone(f.original);
    f.eligibility.evaluate.mockResolvedValue({
      isEligible: false,
      conflicts: [],
    });
    expect(
      await f.visits.adjust('visit', { requiredCrewSize: 3 }, actor).then(
        () => undefined,
        (error: unknown) => error,
      ),
    ).toMatchObject({ code: 'ASSIGNMENT_NOT_ELIGIBLE' });
    expect(f.visit).toEqual(visitBefore);
    expect(f.original).toEqual(assignmentBefore);
    expect(f.prisma.assignment.updateMany).not.toHaveBeenCalled();
  });

  it('publishes locked, reloaded assignment data inside one bounded transaction', async () => {
    const f = fixture();
    f.beforeTransaction(async () => {
      f.visit.visitDate = new Date('2027-03-04T00:00:00Z');
      f.original.plannedStart = new Date('2027-03-04T09:00:00Z');
      f.original.plannedEnd = new Date('2027-03-04T10:30:00Z');
    });
    await f.publishing.publish('original-run', null, actor);
    expect(
      f.prisma.assignmentNotificationOutbox.createMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            payload: expect.objectContaining({
              visitDate: '2027-03-04',
              plannedStart: '2027-03-04T09:00:00.000Z',
            }),
          }),
        ],
      }),
    );
    expect(f.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        after: expect.objectContaining({
          snapshot: [
            expect.objectContaining({
              visitDate: '2027-03-04',
              plannedStart: '2027-03-04T09:00:00.000Z',
            }),
          ],
        }),
      }),
      expect.anything(),
    );
    expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 30_000,
    });
    const resourceLockCall = f.prisma.$queryRaw.mock.calls.findIndex(
      ([query]: [Prisma.Sql]) => query.sql.includes('employees'),
    );
    expect(resourceLockCall).toBeGreaterThanOrEqual(0);
    expect(
      f.prisma.$queryRaw.mock.invocationCallOrder[resourceLockCall],
    ).toBeLessThan(f.eligibility.evaluate.mock.invocationCallOrder[0]);
  });

  const publicationHistoryCases = [
    ...[
      AssignmentStatus.PUBLISHED,
      AssignmentStatus.ACKNOWLEDGED,
      AssignmentStatus.IN_PROGRESS,
      AssignmentStatus.COMPLETED,
      AssignmentStatus.SUPERSEDED,
    ].map((status) => ({ label: status, status, publishedAt: null, outbox: false })),
    {
      label: 'publishedAt lineage',
      status: AssignmentStatus.DRAFT,
      publishedAt: new Date('2027-03-03T10:31:00Z'),
      outbox: false,
    },
    {
      label: 'notification outbox lineage',
      status: AssignmentStatus.DRAFT,
      publishedAt: null,
      outbox: true,
    },
  ];

  const targetHistoryMutationCases = (['lock', 'unlock'] as const).flatMap(
    (operation) =>
      publicationHistoryCases.map((history) => ({ operation, ...history })),
  );

  it.each(targetHistoryMutationCases)(
    '$label prevents $operation from mutating the historical target',
    async ({ operation, ...history }) => {
      const f = fixture();
      f.original.status = history.status;
      f.original.publishedAt = history.publishedAt;
      if (history.outbox) f.outbox.push({ assignmentId: f.original.id });
      if (operation === 'unlock') f.holdLock();

      const failure = await (operation === 'lock'
        ? f.publishing.lock(
            f.original.id,
            LockScope.CREW,
            'Do not mutate history',
            actor,
          )
        : f.publishing.unlock(f.original.id, LockScope.CREW, actor)
      ).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toMatchObject({ code: 'RESOURCE_CONFLICT' });
      expect(f.prisma.assignmentLock.upsert).not.toHaveBeenCalled();
      expect(f.prisma.assignmentLock.update).not.toHaveBeenCalled();
      expect(f.prisma.generatedVisit.update).not.toHaveBeenCalled();
      expect(f.audit.record).not.toHaveBeenCalled();
    },
  );

  it('allows a mutable draft target to be locked and unlocked', async () => {
    const f = fixture();

    await f.publishing.lock(
      f.original.id,
      LockScope.CREW,
      'Keep this crew',
      actor,
    );
    await f.publishing.unlock(f.original.id, LockScope.CREW, actor);

    expect(f.prisma.assignmentLock.upsert).toHaveBeenCalledTimes(1);
    expect(f.prisma.assignmentLock.update).toHaveBeenCalledTimes(1);
    expect(f.heldLock()!.releasedAt).toBeInstanceOf(Date);
  });

  it('allows locking and unlocking a mutable draft when the visit has older publication history', async () => {
    const f = fixture();
    f.assignments.unshift({
      ...f.original,
      id: 'published-history',
      status: AssignmentStatus.SUPERSEDED,
      publishedAt: new Date('2027-03-02T10:30:00Z'),
    });
    f.outbox.push({ assignmentId: 'published-history' });

    await f.publishing.lock(
      f.original.id,
      LockScope.CREW,
      'Keep the new draft crew',
      actor,
    );
    await f.publishing.unlock(f.original.id, LockScope.CREW, actor);

    expect(f.prisma.assignmentLock.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ assignmentId: f.original.id }),
      }),
    );
    expect(f.prisma.assignmentLock.update).toHaveBeenCalledTimes(1);
  });

  it('refuses publication when the locked snapshot turns out to rest on unconfirmed source data', async () => {
    // Readiness read before the transaction says READY. A correction lands
    // while publication waits for the visit lock, so the assignments actually
    // being published are no longer backed by confirmed hours.
    const f = fixture();
    f.beforeTransaction(async () => {
      f.visit.windowProvenance = DataProvenance.DEFAULTED;
    });

    const failure = await f.publishing
      .publish('original-run', 'Publishing this week.', actor)
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toMatchObject({
      code: 'RESOURCE_CONFLICT',
      details: {
        publishReadiness: expect.objectContaining({
          requiresProvenanceAcknowledgement: true,
          provenanceWarnings: [
            expect.objectContaining({ code: 'HOURS_UNCONFIRMED', affectedVisitCount: 1 }),
          ],
        }),
      },
    });
    expect(f.original.status).toBe(AssignmentStatus.DRAFT);
    expect(f.prisma.scheduleRun.updateMany).not.toHaveBeenCalled();
    expect(f.prisma.assignment.updateMany).not.toHaveBeenCalled();
    expect(f.prisma.assignmentNotificationOutbox.createMany).not.toHaveBeenCalled();
    expect(f.audit.record).not.toHaveBeenCalled();
  });

  it('evaluates the source-data gate from the locked snapshot, not the pre-lock read', async () => {
    // The mirror image: unconfirmed before the lock, corrected and confirmed by
    // the time the locks are held. Publication proceeds and records no warning
    // the locked snapshot did not carry.
    const f = fixture();
    f.visit.windowProvenance = DataProvenance.DEFAULTED;
    f.beforeTransaction(async () => {
      f.visit.windowProvenance = DataProvenance.MANAGER_CONFIRMED;
    });

    await f.publishing.publish('original-run', 'Hours confirmed with the site.', actor);

    expect(f.original.status).toBe(AssignmentStatus.PUBLISHED);
    expect(f.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        after: expect.objectContaining({ provenanceWarnings: [] }),
      }),
      expect.anything(),
    );
  });

  it('publishes unconfirmed source data with an acknowledgement and a reason, and records both', async () => {
    const f = fixture();
    f.visit.windowProvenance = DataProvenance.DEFAULTED;
    f.visit.serviceAgreement.crewSizeProvenance = DataProvenance.DEFAULTED;
    f.original.vehicles.push({
      vehicleId: 'vehicle-one',
      vehicle: { label: 'Vehicle one', branchId: null },
      driverEmployeeId: 'employee',
    });

    await f.publishing.publish(
      'original-run',
      'Hours and crew size carried over from the workbook; branch manager agreed.',
      actor,
      false,
      true,
    );

    expect(f.original.status).toBe(AssignmentStatus.PUBLISHED);
    expect(f.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'schedule_run.published',
        after: expect.objectContaining({
          reason:
            'Hours and crew size carried over from the workbook; branch manager agreed.',
          acknowledgedProvenance: true,
          acknowledgedPartial: false,
          provenanceWarnings: [
            { code: 'CREW_SIZE_UNCONFIRMED', message: expect.any(String), affectedVisitCount: 1 },
            { code: 'HOURS_UNCONFIRMED', message: expect.any(String), affectedVisitCount: 1 },
            {
              code: 'VEHICLE_BRANCH_UNCONFIRMED',
              message: expect.any(String),
              affectedVisitCount: 1,
            },
          ],
        }),
      }),
      expect.anything(),
    );
  });

  it('makes a partial run and an unconfirmed-source run both acknowledgeable on one publish', async () => {
    const f = fixture();
    f.run.visitsConsidered = 2;
    f.run.visitsScheduled = 1;
    f.run.visitsUnassigned = 1;
    f.visit.windowProvenance = DataProvenance.DEFAULTED;
    const reason = 'One visit stays unassigned and the hours are the 08:00-17:00 fallback.';

    // The partial acknowledgement alone does not cover the unconfirmed hours.
    const partialOnly = await f.publishing
      .publish('original-run', reason, actor, true, false)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(partialOnly).toMatchObject({
      code: 'RESOURCE_CONFLICT',
      message: expect.stringContaining('unconfirmed'),
    });
    expect(f.original.status).toBe(AssignmentStatus.DRAFT);

    // Nor does the provenance acknowledgement alone cover the unassigned visit.
    const provenanceOnly = await f.publishing
      .publish('original-run', reason, actor, false, true)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(provenanceOnly).toMatchObject({
      code: 'RESOURCE_CONFLICT',
      message: expect.stringContaining('left visits unassigned'),
    });
    expect(f.original.status).toBe(AssignmentStatus.DRAFT);
    expect(f.audit.record).not.toHaveBeenCalled();

    await f.publishing.publish('original-run', reason, actor, true, true);

    expect(f.original.status).toBe(AssignmentStatus.PUBLISHED);
    expect(f.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        after: expect.objectContaining({
          acknowledgedPartial: true,
          acknowledgedProvenance: true,
          provenanceWarnings: [expect.objectContaining({ code: 'HOURS_UNCONFIRMED' })],
        }),
      }),
      expect.anything(),
    );
  });

  it('refuses a pre-upgrade multi-vehicle draft when publish-time eligibility rejects it', async () => {
    const f = fixture();
    f.original.vehicles.push(
      {
        vehicleId: 'vehicle-one',
        vehicle: { label: 'Vehicle one', branchId: 'branch' },
        driverEmployeeId: 'employee',
      },
      {
        vehicleId: 'vehicle-two',
        vehicle: { label: 'Vehicle two', branchId: 'branch' },
        driverEmployeeId: 'employee',
      },
    );
    f.eligibility.evaluate.mockResolvedValue({
      isEligible: false,
      conflicts: [
        {
          code: 'TOO_MANY_VEHICLES',
          message: 'A crew travels in one vehicle.',
          remediation: 'Remove the extra vehicle.',
          resources: { visitId: 'visit', vehicleIds: ['vehicle-one', 'vehicle-two'] },
        },
      ],
    });

    const failure = await f.publishing
      .publish('original-run', null, actor)
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(failure).toMatchObject({ code: 'ASSIGNMENT_NOT_ELIGIBLE' });
    expect(f.eligibility.evaluate).toHaveBeenCalledWith(
      'visit',
      expect.objectContaining({
        plannedStartMinute: 540,
        plannedEndMinute: 630,
        vehicles: [
          { vehicleId: 'vehicle-one', driverEmployeeId: 'employee' },
          { vehicleId: 'vehicle-two', driverEmployeeId: 'employee' },
        ],
      }),
      { excludeAssignmentId: 'draft' },
      f.prisma,
    );
    expect(f.original.status).toBe(AssignmentStatus.DRAFT);
    expect(f.prisma.scheduleRun.updateMany).not.toHaveBeenCalled();
    expect(f.prisma.assignment.updateMany).not.toHaveBeenCalled();
    expect(f.prisma.assignmentNotificationOutbox.createMany).not.toHaveBeenCalled();
    expect(f.audit.record).not.toHaveBeenCalled();
  });
});

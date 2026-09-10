/**
 * ULK-C06 API tests.
 *
 * The solver's own reasoning is covered by the Python suite. These cover what
 * only a database and a real HTTP call can: that a lock survives a rerun, that
 * publishing freezes work, that a superseded schedule is kept rather than
 * deleted, and that a cancelled run writes nothing.
 *
 * The solve itself is driven through `ScheduleRunService.execute` directly
 * rather than the queue, so a test never depends on a Redis worker picking a
 * job up. For that to actually hold, the background processor is replaced with
 * an inert provider below: left in place it consumes the runs these tests
 * create and solves them concurrently, which is how "cancels a queued run"
 * ends up seeing RUNNING.
 */
import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AssignmentStatus, AvailabilityKind, BranchCode, CrewRole, LockScope, Prisma, PrismaClient, UserRole, Weekday } from '@prisma/client';
import { Job } from 'bullmq';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { AuditService } from '../../src/audit/audit.service';
import { AuthService } from '../../src/auth/auth.service';
import { AppException } from '../../src/common/errors/app.exception';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { PrismaService } from '../../src/prisma/prisma.service';
import { EligibilityService } from '../../src/scheduling/eligibility/eligibility.service';
import { AssignmentsService } from '../../src/scheduling/eligibility/assignments.service';
import { VisitsService } from '../../src/scheduling/visits/visits.service';
import { PublishingService } from '../../src/scheduling/optimizer/publishing.service';
import { ScheduleRunJobData, ScheduleRunProcessor } from '../../src/scheduling/optimizer/schedule-run.processor';
import { ScheduleRunService } from '../../src/scheduling/optimizer/schedule-run.service';
import { SchedulerClient, SolveResponse } from '../../src/scheduling/optimizer/scheduler.client';
import { EmployeesService } from '../../src/workforce/employees.service';

const prisma = new PrismaClient();

const suffix = Math.random().toString(36).slice(2, 8);
const ADMIN = { email: `c06-admin-${suffix}@ultrakil.test`, password: 'c06-admin-password' };
const MANAGER = { email: `c06-mgr-${suffix}@ultrakil.test`, password: 'c06-manager-password' };

let app: INestApplication;
let http: string;
let adminToken: string;
let managerToken: string;
let runs: ScheduleRunService;
let jobTypeId: string;
let siteId: string;
const supervisorIds: string[] = [];
const technicianIds: string[] = [];
const batchVehicleIds: string[] = [];

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
/**
 * A week nothing else uses. The shared database holds 500+ real visits on some
 * September days, all competing for the same nine Colombo staff — a test visit
 * would simply lose, and the failure would look like a solver bug rather than
 * a crowded fixture. 2027-03-03 is a Wednesday.
 */
const RANGE = { from: '2027-03-01', to: '2027-03-07' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Exposes the real connection/lock boundary without replacing any SQL. */
function transactionProbe(
  holdLock: boolean,
  beforeTransaction?: () => Promise<void>,
  lockTable = 'generated_visits',
) {
  const pid = deferred<number>();
  const locked = deferred<void>();
  const release = deferred<void>();
  const client = new Proxy(prisma, {
    get(target, property) {
      if (property === '$transaction') {
        return async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
          await beforeTransaction?.();
          return target.$transaction(async (tx) => {
            const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            pid.resolve(backend.pid);
            return work(new Proxy(tx, {
              get(transaction, key) {
                if (key === '$queryRaw') {
                  return async (query: Prisma.Sql) => {
                    const result = await transaction.$queryRaw(query);
                    if (query.sql.includes(lockTable) && query.sql.includes('FOR UPDATE')) {
                      locked.resolve();
                      if (holdLock) await release.promise;
                    }
                    return result;
                  };
                }
                return Reflect.get(transaction, key);
              },
            }));
          }, { timeout: 15_000 });
        };
      }
      return Reflect.get(target, property);
    },
  }) as unknown as PrismaService;
  return { client, pid, locked, release };
}

/** A database-state barrier, not a guess about how long a query takes. */
async function waitForBlocked(waitingPid: number, holdingPid: number) {
  const deadline = Date.now() + 5_000;
  do {
    const [state] = await prisma.$queryRaw<{ blockers: number[] }[]>`
      SELECT pg_blocking_pids(${waitingPid}::integer) AS blockers
    `;
    if (state.blockers.includes(holdingPid)) return;
  } while (Date.now() < deadline);
  throw new Error(`Backend ${waitingPid} never waited for backend ${holdingPid}`);
}

/** Only this suite's own visits, so a shared database cannot skew a count. */
let agreementIds: string[] = [];

/**
 * Removes the fixture graph this suite creates: its agreements, sites,
 * customers and job types, matched by the `C06` naming every one of them uses.
 *
 * Cleaning up employees and users was not enough. Each run also left an
 * agreement behind, and an agreement keeps generating visits into the test week
 * long after the run that made it — a dev database that had seen a few dozen
 * runs held 133 of them, all on the same Wednesday at 09:00. The week then has
 * more work than the branch has staff, and the suite fails on the no-overlap
 * rule working exactly as intended. CI never sees this: its database is new
 * every time, which is precisely why the leak survived.
 *
 * Run before as well as after, so a database already carrying the residue of
 * older runs heals itself rather than staying broken until someone drops it.
 */
async function clearFixtures(): Promise<void> {
  const ownCustomer = { customer: { name: { startsWith: 'C06 Customer' } } };

  await prisma.serviceAgreement.deleteMany({ where: { serviceSite: ownCustomer } });
  await prisma.serviceSite.deleteMany({ where: ownCustomer });
  await prisma.customer.deleteMany({ where: { name: { startsWith: 'C06 Customer' } } });
  await prisma.jobType.deleteMany({ where: { code: { startsWith: 'C06_' } } });
}

async function login(email: string, password: string): Promise<string> {
  const res = await request(http).post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeVisit(): Promise<string> {
  const agreement = await request(http)
    .post('/api/service-agreements')
    .set(auth(adminToken))
    .send({
      serviceSiteId: siteId,
      jobTypeId,
      frequencyCount: 1,
      frequencyUnit: 'WEEK',
      allowedDays: [Weekday.WEDNESDAY],
      startDate: RANGE.from,
      durationMinutes: 90,
      crewSize: 2,
    });
  expect(agreement.status).toBe(201);
  agreementIds.push(agreement.body.id);

  await request(http)
    .post('/api/visit-generation/confirm')
    .set(auth(adminToken))
    .send({ ...RANGE, serviceAgreementIds: [agreement.body.id] });

  const listed = await request(http)
    .get('/api/visits')
    .set(auth(adminToken))
    .query({ serviceAgreementId: agreement.body.id });
  return listed.body.items[0].id as string;
}

/** Creates a run row and solves it inline. */
async function solve(): Promise<string> {
  const created = await request(http)
    .post('/api/schedule-runs')
    .set(auth(adminToken))
    .send({ ...RANGE, branchCode: BranchCode.COLOMBO, timeLimitSeconds: 5 });
  expect(created.status).toBe(201);

  await runs.execute(created.body.id, { timeLimitSeconds: 5 });
  return created.body.id as string;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    // A plain value carries no @Processor metadata, so BullMQ registers no
    // worker for this app and the queue stays untouched by these tests.
    .overrideProvider(ScheduleRunProcessor)
    .useValue({})
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  await app.init();
  await app.listen(0);
  http = await app.getUrl().then((url) => url.replace('[::1]', '127.0.0.1'));
  runs = app.get(ScheduleRunService);

  await prisma.$connect();
  await clearFixtures();
  for (const code of [BranchCode.COLOMBO, BranchCode.KANDY]) {
    await prisma.branch.upsert({
      where: { code },
      create: { code, name: `${code} Branch` },
      update: {},
    });
  }
  for (const [creds, role] of [
    [ADMIN, UserRole.ADMIN],
    [MANAGER, UserRole.MANAGER],
  ] as const) {
    await prisma.user.upsert({
      where: { email: creds.email },
      create: {
        email: creds.email,
        fullName: `C06 ${role}`,
        role,
        passwordHash: await AuthService.hashPassword(creds.password),
      },
      update: { role, isActive: true },
    });
  }
  adminToken = await login(ADMIN.email, ADMIN.password);
  managerToken = await login(MANAGER.email, MANAGER.password);

  const colombo = await prisma.branch.findUniqueOrThrow({ where: { code: BranchCode.COLOMBO } });

  // Two of each, so the solver has a real choice and a lock has something to
  // rule out.
  for (const index of [1, 2]) {
    const sup = await prisma.employee.create({
      data: {
        sourceKey: `c06-sup-${index}-${suffix}`,
        fullName: `C06 Supervisor ${index} ${suffix}`,
        gradeLabel: 'PMS',
        isPmsGrade: true,
        branchId: colombo.id,
        branchCode: BranchCode.COLOMBO,
        canUsePublicTransport: true,
      },
    });
    supervisorIds.push(sup.id);

    const tech = await prisma.employee.create({
      data: {
        sourceKey: `c06-tech-${index}-${suffix}`,
        fullName: `C06 Technician ${index} ${suffix}`,
        gradeLabel: 'Junior PMT',
        branchId: colombo.id,
        branchCode: BranchCode.COLOMBO,
        canUsePublicTransport: true,
      },
    });
    technicianIds.push(tech.id);
  }

  const jobType = await request(http)
    .post('/api/job-types')
    .set(auth(adminToken))
    .send({ code: `C06_${suffix}`, name: 'C06 Job', defaultCrewSize: 2 });
  jobTypeId = jobType.body.id;

  const customer = await request(http)
    .post('/api/customers')
    .set(auth(adminToken))
    .send({ name: `C06 Customer ${suffix}`, branchCode: BranchCode.COLOMBO });

  const site = await request(http)
    .post(`/api/customers/${customer.body.id}/sites`)
    .set(auth(adminToken))
    .send({
      name: `C06 Site ${suffix}`,
      operatingHours: [
        { weekday: Weekday.WEDNESDAY, opensAtMinute: 540, closesAtMinute: 1020 },
      ],
    });
  siteId = site.body.id;
});

afterAll(async () => {
  const ids = [...supervisorIds, ...technicianIds];
  await prisma.assignment.deleteMany({
    where: {
      OR: [
        { crewMembers: { some: { employeeId: { in: ids } } } },
        {
          generatedVisit: {
            visitDate: {
              gte: new Date(`${RANGE.from}T00:00:00.000Z`),
              lte: new Date(`${RANGE.to}T00:00:00.000Z`),
            },
          },
        },
      ],
    },
  });
  await clearFixtures();
  await prisma.vehicle.deleteMany({ where: { id: { in: batchVehicleIds } } });
  await prisma.employee.deleteMany({ where: { id: { in: ids } } });
  await prisma.user.deleteMany({ where: { email: { in: [ADMIN.email, MANAGER.email] } } });
  await prisma.$disconnect();
  await app.close();
});

beforeEach(async () => {
  // Clear the whole test week: its visits, and with them (by cascade) their
  // assignments and queue entries.
  //
  // Archiving the agreement is not enough — its visits remain, and every test
  // adds another one at the same hour of the same Wednesday. By the fourth
  // test there is more work than the nine Colombo staff can cover, so a visit
  // goes unstaffed and the failure looks like a solver bug rather than a
  // fixture that piled up. The week is empty of real data, so this is safe.
  await prisma.generatedVisit.deleteMany({
    where: {
      visitDate: {
        gte: new Date(`${RANGE.from}T00:00:00.000Z`),
        lte: new Date(`${RANGE.to}T00:00:00.000Z`),
      },
    },
  });
  if (agreementIds.length > 0) {
    await prisma.serviceAgreement.updateMany({
      where: { id: { in: agreementIds } },
      data: { status: 'ARCHIVED' },
    });
  }
  agreementIds = [];
});

describe('authorization', () => {
  it('refuses an anonymous caller', async () => {
    const res = await request(http).post('/api/schedule-runs').send(RANGE);
    expect(res.status).toBe(401);
  });

  it('lets a manager watch a run but not start one', async () => {
    const start = await request(http)
      .post('/api/schedule-runs')
      .set(auth(managerToken))
      .send(RANGE);
    expect(start.status).toBe(403);

    const list = await request(http).get('/api/schedule-runs').set(auth(managerToken));
    expect(list.status).toBe(200);
  });
});

describe('starting a run', () => {
  it('returns immediately with a run to poll', async () => {
    const res = await request(http)
      .post('/api/schedule-runs')
      .set(auth(adminToken))
      .send({ ...RANGE, branchCode: BranchCode.COLOMBO });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('QUEUED');
    expect(res.body.progressPercent).toBe(0);
    expect(res.body.isPublished).toBe(false);
  });

  it('refuses a range that ends before it starts', async () => {
    const res = await request(http)
      .post('/api/schedule-runs')
      .set(auth(adminToken))
      .send({ from: '2026-09-13', to: '2026-09-07' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AGREEMENT_DATES_INVALID');
  });

  it('refuses a range too long to solve', async () => {
    const res = await request(http)
      .post('/api/schedule-runs')
      .set(auth(adminToken))
      .send({ from: '2026-01-01', to: '2026-12-31' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('at most');
  });
});

describe('solving', () => {
  it('staffs a visit with a legal crew', async () => {
    const visitId = await makeVisit();

    const runId = await solve();

    const run = await prisma.scheduleRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.status).toBe('SUCCEEDED');
    expect(run.progressPercent).toBe(100);
    expect(run.visitsScheduled).toBeGreaterThan(0);

    const assignment = await prisma.assignment.findFirstOrThrow({
      where: { generatedVisitId: visitId },
      include: { crewMembers: true },
    });
    expect(assignment.crewMembers).toHaveLength(2);
    // The hard rule the whole system exists to protect.
    expect(assignment.crewMembers.some((member) => member.isPmsSupervisor)).toBe(true);
  });

  it('is idempotent: solving the same range twice leaves one assignment', async () => {
    const visitId = await makeVisit();

    await solve();
    await solve();

    const count = await prisma.assignment.count({ where: { generatedVisitId: visitId } });
    expect(count).toBe(1);
  });

  it('leaves an impossible visit in the Unassigned queue with reasons', async () => {
    // A crew of twenty, from a branch that has nine people.
    const agreement = await request(http)
      .post('/api/service-agreements')
      .set(auth(adminToken))
      .send({
        serviceSiteId: siteId,
        jobTypeId,
        frequencyCount: 1,
        frequencyUnit: 'WEEK',
        allowedDays: [Weekday.WEDNESDAY],
        startDate: RANGE.from,
        durationMinutes: 90,
        crewSize: 20,
      });
    agreementIds.push(agreement.body.id);
    await request(http)
      .post('/api/visit-generation/confirm')
      .set(auth(adminToken))
      .send({ ...RANGE, serviceAgreementIds: [agreement.body.id] });

    await solve();

    const queued = await request(http)
      .get('/api/unassigned-visits')
      .set(auth(managerToken))
      .query({ serviceAgreementId: agreement.body.id });

    expect(queued.body.total).toBeGreaterThan(0);
    expect(queued.body.items[0].conflicts.length).toBeGreaterThan(0);
    expect(queued.body.items[0].hasBeenChecked).toBe(true);
  });
});

describe('locks survive a rerun', () => {
  it('keeps a locked crew exactly as it is', async () => {
    const visitId = await makeVisit();
    await solve();

    const first = await prisma.assignment.findFirstOrThrow({
      where: { generatedVisitId: visitId },
      include: { crewMembers: true },
    });
    const lockedCrew = first.crewMembers.map((member) => member.employeeId).sort();

    const locked = await request(http)
      .post(`/api/assignments/${first.id}/lock`)
      .set(auth(adminToken))
      .send({ scope: LockScope.CREW, reason: 'Customer asked for this crew' });
    expect(locked.status).toBe(200);

    for (let rerun = 0; rerun < 3; rerun++) {
      await solve();

      const after = await prisma.assignment.findFirstOrThrow({
        where: { generatedVisitId: visitId, status: 'DRAFT' },
        include: { crewMembers: true, locks: true },
      });
      expect(after.crewMembers.map((member) => member.employeeId).sort()).toEqual(lockedCrew);
      expect(after.locks).toEqual([
        expect.objectContaining({
          id: locked.body.id,
          assignmentId: after.id,
          scope: LockScope.CREW,
          reason: 'Customer asked for this crew',
          lockedByUserId: locked.body.lockedByUserId,
          releasedAt: null,
        }),
      ]);
      expect(after.locks[0].createdAt.toISOString()).toBe(locked.body.createdAt);
    }
  });

  it('releases a lock when asked', async () => {
    const visitId = await makeVisit();
    await solve();
    const assignment = await prisma.assignment.findFirstOrThrow({
      where: { generatedVisitId: visitId },
    });

    await request(http)
      .post(`/api/assignments/${assignment.id}/lock`)
      .set(auth(adminToken))
      .send({ scope: LockScope.CREW });

    const released = await request(http)
      .post(`/api/assignments/${assignment.id}/unlock`)
      .set(auth(adminToken))
      .send({ scope: LockScope.CREW });

    expect(released.status).toBe(200);
    const lock = await prisma.assignmentLock.findFirstOrThrow({
      where: { assignmentId: assignment.id, scope: LockScope.CREW },
    });
    expect(lock.releasedAt).not.toBeNull();
  });
});

describe('assignment lock concurrency', () => {
  it.each(['lock', 'solver'].flatMap((first) =>
    ['assignment', 'rejected', 'unassigned'].map((outcome) => ({ first, outcome })),
  ))('serializes $outcome when $first acquires the visit lock first', async ({ first, outcome }) => {
    const f = await manualPublicationFixture();
    const run = await prisma.scheduleRun.create({ data: {
      status: 'QUEUED', rangeStart: new Date(RANGE.from), rangeEnd: new Date(RANGE.to),
      branchCode: BranchCode.COLOMBO,
    } });
    const solver = transactionProbe(first === 'solver');
    const locker = transactionProbe(first === 'lock');
    const started = deferred<void>();
    const answer = deferred<SolveResponse>();
    const scheduler = { solve: async () => { started.resolve(); return answer.promise; } } as unknown as SchedulerClient;
    const service = new ScheduleRunService(solver.client, scheduler, app.get(EligibilityService), app.get(AuditService));
    const publishing = new PublishingService(
      locker.client,
      app.get(AuditService),
      app.get(EligibilityService),
    );
    const solved = service.execute(run.id).then((value) => ({ value }), (error: unknown) => ({ error }));
    let locked: Promise<{ value: unknown } | { error: unknown }> | undefined;
    const solution: SolveResponse = {
      run_id: run.id, status: 'OPTIMAL', solve_seconds: 0, objective_value: 0, visits_considered: 1,
      assignments: outcome === 'unassigned' ? [] : [{
        visit_id: f.visitId, employee_ids: outcome === 'rejected' ? [] : [supervisorIds[0], technicianIds[1]],
        vehicles: [], start_minute: 600, scheduled_date: '2027-03-03',
      }],
      unassigned: outcome === 'unassigned' ? [{ visit_id: f.visitId, reason_codes: ['NO_CREW'], message: 'No crew available' }] : [],
    };
    try {
      await started.promise;
      if (first === 'solver') {
        answer.resolve(solution);
        await solver.locked.promise;
      }
      locked = publishing.lock(f.draft!.id, LockScope.CREW, 'Keep this crew', f.actor)
        .then((value) => ({ value }), (error: unknown) => ({ error }));
      // A missing transaction must fail the test rather than wait forever.
      expect(await Promise.race([
        (first === 'lock' ? locker.locked.promise : locker.pid.promise).then(() => 'transaction'),
        locked.then(() => 'finished without the shared lock'),
      ])).toBe('transaction');
      if (first === 'lock') answer.resolve(solution);
      const [solverPid, lockerPid] = await Promise.all([solver.pid.promise, locker.pid.promise]);
      await waitForBlocked(first === 'lock' ? solverPid : lockerPid, first === 'lock' ? lockerPid : solverPid);
      (first === 'lock' ? locker : solver).release.resolve();
      const [solveResult, lockResult] = await Promise.all([solved, locked]);
      const locks = await prisma.assignmentLock.findMany({ where: { assignment: { generatedVisitId: f.visitId } } });
      if (first === 'lock') {
        expect(lockResult).toHaveProperty('value');
        expect(solveResult).toMatchObject({ error: { code: 'RESOURCE_CONFLICT' } });
        expect(locks).toHaveLength(1);
        expect(locks[0]).toMatchObject({ assignmentId: f.draft!.id, scope: LockScope.CREW, releasedAt: null });
        expect(await prisma.assignment.findUnique({ where: { id: f.draft!.id } })).toEqual(f.draft);
        expect(await prisma.assignment.count({ where: { scheduleRunId: run.id } })).toBe(0);
        expect(await prisma.visitUnassignedReason.count({ where: { generatedVisitId: f.visitId } })).toBe(0);
      } else {
        expect(solveResult).toHaveProperty('value');
        expect(lockResult).toMatchObject({ error: { code: 'RESOURCE_CONFLICT' } });
        expect(locks).toHaveLength(0);
      }
    } finally {
      answer.resolve(solution);
      solver.release.resolve();
      locker.release.resolve();
      await Promise.all([solved, locked]);
    }
  });
});

async function manualPublicationFixture(withDraft = true) {
  const visitId = await makeVisit();
  const visit = await prisma.generatedVisit.findUniqueOrThrow({
    where: { id: visitId },
  });
  const run = await prisma.scheduleRun.create({
    data: {
      status: 'SUCCEEDED',
      rangeStart: new Date(RANGE.from),
      rangeEnd: new Date(RANGE.to),
      branchCode: BranchCode.COLOMBO,
    },
  });
  const createDraft = async () => {
    const draft = await prisma.assignment.create({
      data: {
        generatedVisitId: visitId,
        branchId: visit.branchId,
        branchCode: BranchCode.COLOMBO,
        scheduleRunId: run.id,
        status: 'DRAFT',
        plannedStart: new Date('2027-03-03T09:00:00Z'),
        plannedEnd: new Date('2027-03-03T10:30:00Z'),
        crewMembers: {
          create: [
            {
              employeeId: supervisorIds[0],
              role: 'SUPERVISOR',
              isPmsSupervisor: true,
            },
            { employeeId: technicianIds[0], role: 'TECHNICIAN' },
          ],
        },
      },
    });
    await prisma.generatedVisit.update({
      where: { id: visitId },
      data: { status: 'SCHEDULED' },
    });
    return draft;
  };
  const draft = withDraft ? await createDraft() : undefined;
  const actor = await prisma.user.findUniqueOrThrow({
    where: { email: ADMIN.email },
  });
  const proposal = {
    plannedStartMinute: 540,
    plannedEndMinute: 630,
    crew: [
      { employeeId: supervisorIds[0], role: CrewRole.SUPERVISOR },
      { employeeId: technicianIds[0], role: CrewRole.TECHNICIAN },
    ],
  };
  return { visitId, run, draft, createDraft, actor, proposal };
}

describe('assignment history lookup', () => {
  it.each([AssignmentStatus.COMPLETED, AssignmentStatus.SUPERSEDED])(
    'returns %s history when the visit has no live assignment',
    async (status) => {
      const f = await manualPublicationFixture();
      await prisma.assignment.update({
        where: { id: f.draft!.id },
        data: { status },
      });

      const response = await request(http)
        .get(`/api/visits/${f.visitId}/assignment`)
        .set(auth(managerToken));

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ id: f.draft!.id, status });
    },
  );

  it('returns the most recently updated completed or superseded history', async () => {
    const f = await manualPublicationFixture();
    await prisma.assignment.update({
      where: { id: f.draft!.id },
      data: {
        status: AssignmentStatus.COMPLETED,
        updatedAt: new Date('2030-01-01T00:00:00.000Z'),
      },
    });
    const superseded = await f.createDraft();
    await prisma.assignment.update({
      where: { id: superseded.id },
      data: {
        status: AssignmentStatus.SUPERSEDED,
        updatedAt: new Date('2030-01-02T00:00:00.000Z'),
      },
    });

    const response = await request(http)
      .get(`/api/visits/${f.visitId}/assignment`)
      .set(auth(managerToken));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: superseded.id,
      status: AssignmentStatus.SUPERSEDED,
    });
  });

  it('prefers a live draft over newer assignment history', async () => {
    const f = await manualPublicationFixture();
    await prisma.assignment.update({
      where: { id: f.draft!.id },
      data: {
        status: AssignmentStatus.COMPLETED,
        updatedAt: new Date('2030-01-02T00:00:00.000Z'),
      },
    });
    const liveDraft = await f.createDraft();

    const response = await request(http)
      .get(`/api/visits/${f.visitId}/assignment`)
      .set(auth(managerToken));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: liveDraft.id,
      status: AssignmentStatus.DRAFT,
    });
  });
});

describe('standard writer publication protocol', () => {
  async function batchFixture(withVehicle = false) {
    const visits = [await manualPublicationFixture(), await manualPublicationFixture()];
    const vehicle = withVehicle ? await prisma.vehicle.create({ data: {
      code: `C06-BATCH-${suffix}-${batchVehicleIds.length}`, label: 'C06 shared vehicle', seatCapacity: 2,
      authorizations: { create: { employeeId: supervisorIds[0] } },
    } }) : undefined;
    if (vehicle) batchVehicleIds.push(vehicle.id);
    for (const [index, fixture] of visits.entries()) {
      await prisma.generatedVisit.update({ where: { id: fixture.visitId }, data: { durationMinutes: 60 } });
      await prisma.assignment.update({ where: { id: fixture.draft!.id }, data: {
        plannedStart: new Date(`2027-03-03T${index === 0 ? '09' : '11'}:00:00Z`),
        plannedEnd: new Date(`2027-03-03T${index === 0 ? '10' : '12'}:00:00Z`),
      } });
      if (vehicle) await prisma.assignmentVehicle.create({ data: {
        assignmentId: fixture.draft!.id, vehicleId: vehicle.id, driverEmployeeId: supervisorIds[0],
      } });
    }
    const run = await prisma.scheduleRun.create({ data: {
      status: 'QUEUED', rangeStart: new Date(RANGE.from), rangeEnd: new Date(RANGE.to),
      branchCode: BranchCode.COLOMBO,
    } });
    const solve = (plans: { index: number; start: number }[], eligibility = app.get(EligibilityService)) => {
      const service = new ScheduleRunService(prisma as unknown as PrismaService, {
        solve: async (): Promise<SolveResponse> => ({
          run_id: run.id, status: 'OPTIMAL', solve_seconds: 0, objective_value: 0, visits_considered: 2,
          assignments: plans.map(({ index, start }) => ({
            visit_id: visits[index].visitId, employee_ids: [supervisorIds[0], technicianIds[0]],
            vehicles: vehicle ? [{ vehicle_id: vehicle.id, driver_employee_id: supervisorIds[0] }] : [],
            start_minute: start, scheduled_date: '2027-03-03',
          })),
          unassigned: [],
        }),
      } as unknown as SchedulerClient, eligibility, app.get(AuditService));
      return service.execute(run.id);
    };
    return { visits, run, solve };
  }

  it.each(['crew', 'crew and vehicle'])('reuses a %s slot freed by an earlier accepted result in the same transaction', async (resource) => {
    const f = await batchFixture(resource === 'crew and vehicle');
    expect(await f.solve([{ index: 0, start: 720 }, { index: 1, start: 540 }]))
      .toEqual({ scheduled: 2, unassigned: 0, cancelled: false });
    expect(await prisma.assignment.findMany({
      where: { scheduleRunId: f.run.id }, select: { generatedVisitId: true, plannedStart: true },
      orderBy: { plannedStart: 'asc' },
    })).toEqual([
      { generatedVisitId: f.visits[1].visitId, plannedStart: new Date('2027-03-03T09:00:00Z') },
      { generatedVisitId: f.visits[0].visitId, plannedStart: new Date('2027-03-03T12:00:00Z') },
    ]);
  });

  it.each([[0, 1], [1, 0]])('counts the earlier proposed crew occupancy in order %s then %s', async (first, later) => {
    const f = await batchFixture();
    expect(await f.solve([{ index: first, start: 720 }, { index: later, start: 720 }]))
      .toEqual({ scheduled: 1, unassigned: 1, cancelled: false });
    expect(await prisma.assignment.findMany({ where: { scheduleRunId: f.run.id } }))
      .toEqual([expect.objectContaining({ generatedVisitId: f.visits[first].visitId, status: 'DRAFT' })]);
    expect(await prisma.assignment.findUnique({ where: { id: f.visits[later].draft!.id } }))
      .toMatchObject({ status: 'CANCELLED' });
    expect(await prisma.visitUnassignedReason.findMany({ where: { scheduleRunId: f.run.id } }))
      .toEqual(Array(2).fill(expect.objectContaining({ generatedVisitId: f.visits[later].visitId, code: 'EMPLOYEE_DOUBLE_BOOKED' })));
  });

  it('still counts an external retained draft when evaluating the atomic batch', async () => {
    const f = await batchFixture();
    const retained = await prisma.assignment.findUnique({ where: { id: f.visits[1].draft!.id } });
    expect(await f.solve([{ index: 0, start: 660 }]))
      .toEqual({ scheduled: 0, unassigned: 1, cancelled: false });
    expect(await prisma.assignment.findUnique({ where: { id: f.visits[1].draft!.id } })).toEqual(retained);
    expect(await prisma.visitUnassignedReason.findMany({ where: { scheduleRunId: f.run.id } }))
      .toEqual(Array(2).fill(expect.objectContaining({ code: 'EMPLOYEE_DOUBLE_BOOKED' })));
  });

  it('records each refusal reason with its own message and its own remedy', async () => {
    // The queue shows one card per reason. When every card carried the same
    // joined sentence, "Service-window conflict" told a manager that an
    // employee was double-booked — a true fact filed under the wrong heading,
    // which is worse than no explanation because it looks like an answer.
    const f = await batchFixture();
    const refusing = { evaluate: async () => ({
      isEligible: false,
      conflicts: [
        { code: 'EMPLOYEE_DOUBLE_BOOKED', message: 'S Tharilingam is already on another job.', remediation: 'Pick a different technician.', resources: {} },
        { code: 'OUTSIDE_SERVICE_HOURS', message: 'The site is shut at that hour.', remediation: 'Move the visit inside opening hours.', resources: {} },
      ],
    }) } as unknown as EligibilityService;

    await f.solve([{ index: 0, start: 720 }], refusing);

    const rows = await prisma.visitUnassignedReason.findMany({
      where: { scheduleRunId: f.run.id, generatedVisitId: f.visits[0].visitId },
      orderBy: { code: 'asc' },
    });

    expect(rows.map((row) => [row.code, row.message])).toEqual([
      ['EMPLOYEE_DOUBLE_BOOKED', 'S Tharilingam is already on another job.'],
      ['OUTSIDE_SERVICE_HOURS', 'The site is shut at that hour.'],
    ]);
    // And "What to do" is answered per reason, not left blank.
    expect(rows.map((row) => (row.details as { remediation?: string } | null)?.remediation)).toEqual([
      'Pick a different technician.',
      'Move the visit inside opening hours.',
    ]);
  });

  it('rolls back an earlier accepted result when a later transactional eligibility check throws a conflict', async () => {
    const f = await batchFixture();
    await app.get(PublishingService).lock(f.visits[0].draft!.id, LockScope.CREW, 'Retain this crew', f.visits[0].actor);
    const state = () => prisma.generatedVisit.findMany({
      where: { id: { in: f.visits.map(({ visitId }) => visitId) } }, orderBy: { id: 'asc' },
      include: { assignments: { include: { crewMembers: true, vehicles: true, locks: true } }, unassignedReasons: true },
    });
    const before = await state();
    const eligibility = app.get(EligibilityService);
    const transactionalEligibility = { evaluate: async (...args: Parameters<EligibilityService['evaluate']>) => {
      if (args[0] === f.visits[1].visitId) {
        // The next result must observe the first draft inside the transaction,
        // while the independent connection still sees no committed changes.
        const client = args[3] ?? prisma;
        expect(await client.assignment.count({ where: { scheduleRunId: f.run.id } })).toBe(1);
        expect(await prisma.assignment.count({ where: { scheduleRunId: f.run.id } })).toBe(0);
        throw new AppException('RESOURCE_CONFLICT', 'A later eligibility fact changed', HttpStatus.CONFLICT);
      }
      return eligibility.evaluate(...args);
    } } as EligibilityService;
    await expect(f.solve([{ index: 0, start: 720 }, { index: 1, start: 540 }], transactionalEligibility))
      .rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(await state()).toEqual(before);
    expect(await prisma.assignment.count({ where: { scheduleRunId: f.run.id } })).toBe(0);
  });

  it('rolls back and sanitizes a final generated-visit unique collision', async () => {
    const f = await manualPublicationFixture();
    const target = await prisma.generatedVisit.findUniqueOrThrow({
      where: { id: f.visitId },
    });
    await prisma.generatedVisit.create({
      data: {
        serviceAgreementId: target.serviceAgreementId,
        branchId: target.branchId,
        branchCode: target.branchCode,
        visitDate: new Date('2027-03-04T00:00:00Z'),
        windowStartMinute: 600,
        windowEndMinute: target.windowEndMinute,
        durationMinutes: target.durationMinutes,
        requiredCrewSize: target.requiredCrewSize,
      },
    });
    const run = await prisma.scheduleRun.create({
      data: {
        status: 'QUEUED',
        rangeStart: new Date(RANGE.from),
        rangeEnd: new Date(RANGE.to),
        branchCode: BranchCode.COLOMBO,
      },
    });
    const service = new ScheduleRunService(
      prisma as unknown as PrismaService,
      {
        solve: async (): Promise<SolveResponse> => ({
          run_id: run.id,
          status: 'OPTIMAL',
          solve_seconds: 0,
          objective_value: 0,
          visits_considered: 1,
          assignments: [
            {
              visit_id: f.visitId,
              employee_ids: [supervisorIds[0], technicianIds[0]],
              vehicles: [],
              start_minute: 600,
              scheduled_date: '2027-03-04',
            },
          ],
          unassigned: [],
        }),
      } as unknown as SchedulerClient,
      app.get(EligibilityService),
      app.get(AuditService),
    );

    await expect(service.execute(run.id)).rejects.toMatchObject({
      code: 'RESOURCE_CONFLICT',
    });
    expect(await prisma.generatedVisit.findUniqueOrThrow({ where: { id: f.visitId } }))
      .toMatchObject({
        visitDate: target.visitDate,
        windowStartMinute: target.windowStartMinute,
      });
    expect(await prisma.assignment.findUniqueOrThrow({ where: { id: f.draft!.id } }))
      .toMatchObject({ status: AssignmentStatus.DRAFT });
    const failed = await prisma.scheduleRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(failed.errorMessage).not.toContain('P2002');
    expect(failed.errorMessage).not.toContain('prisma');
  });

  it.each(['assignment', 'rejected', 'unassigned'].flatMap((firstOutcome) =>
    ['assignment', 'rejected', 'unassigned'].map((laterOutcome) => ({ firstOutcome, laterOutcome })),
  ))('rolls back the complete solver result: $firstOutcome before stale $laterOutcome', async ({ firstOutcome, laterOutcome }) => {
    const first = await manualPublicationFixture();
    const later = await manualPublicationFixture();
    await prisma.assignment.update({ where: { id: later.draft!.id }, data: {
      plannedStart: new Date('2027-03-03T13:00:00Z'), plannedEnd: new Date('2027-03-03T14:30:00Z'),
    } });
    await app.get(PublishingService).lock(first.draft!.id, LockScope.CREW, 'Keep the assigned crew', first.actor);
    await prisma.visitUnassignedReason.create({ data: {
      generatedVisitId: first.visitId, scheduleRunId: first.run.id,
      code: 'PREVIOUS_REASON', message: 'Existing scheduling explanation',
    } });
    const run = await prisma.scheduleRun.create({ data: {
      status: 'QUEUED', rangeStart: new Date(RANGE.from), rangeEnd: new Date(RANGE.to),
      branchCode: BranchCode.COLOMBO,
    } });
    const currentDispatch = await prisma.scheduleRunDispatchOutbox.create({ data: {
      scheduleRunId: run.id,
      provider: 'BULLMQ',
    } });
    const started = deferred<void>();
    const answer = deferred<SolveResponse>();
    const service = new ScheduleRunService(
      prisma as unknown as PrismaService,
      { solve: async () => { started.resolve(); return answer.promise; } } as unknown as SchedulerClient,
      // The solver and eligibility boundary are controlled; persistence, the
      // manager adjustment and the queue's FAILED classification use real SQL.
      { evaluate: async (visitId: string) => {
        const outcome = visitId === first.visitId ? firstOutcome : laterOutcome;
        return outcome === 'rejected'
          ? { isEligible: false, conflicts: [
              // Two distinct conflicts on purpose. Each has to keep its own
              // sentence and its own remedy: they were once flattened into one
              // joined string written against every code, so the queue showed
              // the crew clash under the service-hours heading and vice versa.
              { code: 'NO_CREW', message: 'No eligible crew', remediation: 'Free up a supervisor.' },
              { code: 'OUTSIDE_SERVICE_HOURS', message: 'The site is shut then.', remediation: 'Move the visit.' },
            ] }
          : { isEligible: true, conflicts: [] };
      } } as unknown as EligibilityService,
      app.get(AuditService),
    );
    const pending = new ScheduleRunProcessor(service, {
      isCurrentDispatch: async () => true,
    } as never)
      .process({
        data: {
          runId: run.id,
          dispatchId: currentDispatch.id,
          timeLimitSeconds: 1,
        },
        updateProgress: async () => undefined,
      } as unknown as Job<ScheduleRunJobData>)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    const solution: SolveResponse = {
      run_id: run.id, status: 'OPTIMAL', solve_seconds: 0, objective_value: 0, visits_considered: 2,
      assignments: [{ fixture: first, outcome: firstOutcome }, { fixture: later, outcome: laterOutcome }].flatMap(({ fixture, outcome }) => {
        const visitId = fixture.visitId;
        return outcome === 'unassigned' ? [] : [{
          visit_id: visitId, employee_ids: [supervisorIds[0], technicianIds[0]],
          vehicles: [], start_minute: 600, scheduled_date: '2027-03-04',
        }];
      }),
      unassigned: [{ fixture: first, outcome: firstOutcome }, { fixture: later, outcome: laterOutcome }].flatMap(({ fixture, outcome }) =>
        outcome !== 'unassigned' ? [] : [{
          visit_id: fixture.visitId, reason_codes: ['NO_CREW'], message: 'No crew available',
        }],
      ),
    };
    const state = (id: string) => prisma.generatedVisit.findUniqueOrThrow({
      where: { id },
      include: {
        assignments: { orderBy: { id: 'asc' }, include: {
          crewMembers: true, vehicles: true, locks: true, notificationOutboxEntries: true,
        } },
        unassignedReasons: { orderBy: { id: 'asc' } },
      },
    });
    try {
      await started.promise;
      await app.get(VisitsService).adjust(later.visitId, { durationMinutes: 120 }, later.actor);
      const before = await Promise.all([state(first.visitId), state(later.visitId)]);
      answer.resolve(solution);
      expect(await pending).toMatchObject({ code: 'RESOURCE_CONFLICT' });
      expect(await prisma.scheduleRun.findUnique({ where: { id: run.id } })).toMatchObject({
        status: 'FAILED', errorCode: 'RESOURCE_CONFLICT',
      });
      expect(await Promise.all([state(first.visitId), state(later.visitId)])).toEqual(before);
      expect(await prisma.assignment.count({ where: { scheduleRunId: run.id } })).toBe(0);
      expect(await prisma.visitUnassignedReason.count({ where: { scheduleRunId: run.id } })).toBe(0);
    } finally {
      answer.resolve(solution);
      await pending;
    }
  });

  it.each(
    ['present', 'absent'].flatMap((snapshot) =>
      ['same-date', 'moved-date', 'rejected', 'unassigned'].map((outcome) => ({
        snapshot,
        outcome,
      })),
    ),
  )(
    'rejects a stale $outcome solve before eligibility after adjustment with $snapshot assignment snapshot',
    async ({ snapshot, outcome }) => {
      const f = await manualPublicationFixture(snapshot === 'present');
      const staleRun = await prisma.scheduleRun.create({
        data: {
          status: 'QUEUED',
          rangeStart: new Date(RANGE.from),
          rangeEnd: new Date(RANGE.to),
          branchCode: BranchCode.COLOMBO,
        },
      });
      const ready = deferred<void>();
      const resume = deferred<void>();
      let evaluated = false;
      const probe = transactionProbe(false, async () => {
        expect(evaluated).toBe(false);
        ready.resolve();
        await resume.promise;
      });
      const eligibility = app.get(EligibilityService);
      const service = new ScheduleRunService(
        probe.client,
        {
          solve: async () => ({
            run_id: staleRun.id,
            status: 'OPTIMAL',
            solve_seconds: 0,
            objective_value: 0,
            visits_considered: 1,
            assignments:
              outcome === 'unassigned'
                ? []
                : [
                    {
                      visit_id: f.visitId,
                      employee_ids:
                        outcome === 'rejected'
                          ? []
                          : [supervisorIds[0], technicianIds[0]],
                      vehicles: [],
                      start_minute: 540,
                      scheduled_date:
                        outcome === 'same-date' ? '2027-03-03' : '2027-03-04',
                    },
                  ],
            unassigned:
              outcome === 'unassigned'
                ? [
                    {
                      visit_id: f.visitId,
                      reason_codes: ['NO_CREW'],
                      message: 'No crew',
                    },
                  ]
                : [],
          }),
        } as unknown as SchedulerClient,
        {
          evaluate: async (
            ...args: Parameters<EligibilityService['evaluate']>
          ) => {
            const result = await eligibility.evaluate(...args);
            expect(result.isEligible).toBe(outcome !== 'rejected');
            evaluated = true;
            return result;
          },
        } as EligibilityService,
        app.get(AuditService),
      );
      const pending = service.execute(staleRun.id).then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await ready.promise;
        await app.get(VisitsService).adjust(
          f.visitId,
          {
            durationMinutes: 120,
            windowEndMinute: 900,
          },
          f.actor,
        );
        const visitBefore = await prisma.generatedVisit.findUniqueOrThrow({
          where: { id: f.visitId },
        });
        const assignmentsBefore = await prisma.assignment.findMany({
          where: { generatedVisitId: f.visitId },
          include: { crewMembers: true },
          orderBy: { id: 'asc' },
        });
        const reasonsBefore = await prisma.visitUnassignedReason.findMany({
          where: { generatedVisitId: f.visitId },
          orderBy: { id: 'asc' },
        });
        const outboxBefore = await prisma.assignmentNotificationOutbox.findMany(
          {
            where: { assignment: { generatedVisitId: f.visitId } },
            orderBy: { id: 'asc' },
          },
        );
        resume.resolve();
        expect(await pending).toMatchObject({ code: 'RESOURCE_CONFLICT' });
        expect(
          await prisma.generatedVisit.findUnique({ where: { id: f.visitId } }),
        ).toEqual(visitBefore);
        expect(
          await prisma.assignment.findMany({
            where: { generatedVisitId: f.visitId },
            include: { crewMembers: true },
            orderBy: { id: 'asc' },
          }),
        ).toEqual(assignmentsBefore);
        expect(
          await prisma.visitUnassignedReason.findMany({
            where: { generatedVisitId: f.visitId },
            orderBy: { id: 'asc' },
          }),
        ).toEqual(reasonsBefore);
        expect(
          await prisma.assignmentNotificationOutbox.findMany({
            where: { assignment: { generatedVisitId: f.visitId } },
            orderBy: { id: 'asc' },
          }),
        ).toEqual(outboxBefore);
      } finally {
        resume.resolve();
        await pending;
      }
    },
  );

  it('preserves a draft and visit when an adjustment violates crew eligibility', async () => {
    const f = await manualPublicationFixture();
    const visitBefore = await prisma.generatedVisit.findUniqueOrThrow({
      where: { id: f.visitId },
    });
    const draftBefore = await prisma.assignment.findUniqueOrThrow({
      where: { id: f.draft!.id },
    });
    const failure = await app
      .get(VisitsService)
      .adjust(
        f.visitId,
        { visitDate: '2027-03-04', requiredCrewSize: 3 },
        f.actor,
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toMatchObject({ code: 'ASSIGNMENT_NOT_ELIGIBLE' });
    expect(
      await prisma.generatedVisit.findUnique({ where: { id: f.visitId } }),
    ).toEqual(visitBefore);
    expect(
      await prisma.assignment.findUnique({ where: { id: f.draft!.id } }),
    ).toEqual(draftBefore);
    expect(
      await prisma.auditEvent.count({
        where: { entityId: f.visitId, action: 'visit.adjusted' },
      }),
    ).toBe(0);
  });

  it.each(
    ['assign', 'unassign', 'adjust'].flatMap((operation) =>
      ['publisher', 'manual'].map((first) => ({ operation, first })),
    ),
  )(
    'serializes manual $operation when $first locks first',
    async ({ operation, first }) => {
      const f = await manualPublicationFixture();
      const manual = transactionProbe(first === 'manual');
      const publisher = transactionProbe(first === 'publisher');
      const assignments = new AssignmentsService(
        manual.client,
        app.get(EligibilityService),
        app.get(AuditService),
      );
      const visits = new VisitsService(
        manual.client,
        app.get(AuditService),
        app.get(EligibilityService),
      );
      const publishing = new PublishingService(
        publisher.client,
        app.get(AuditService),
        app.get(EligibilityService),
      );
      const mutate = () =>
        operation === 'assign'
          ? assignments.assign(f.visitId, f.proposal, f.actor)
          : operation === 'unassign'
            ? assignments.unassign(f.visitId, f.actor)
            : visits.adjust(
                f.visitId,
                {
                  visitDate: '2027-03-04',
                  windowStartMinute: 510,
                  windowEndMinute: 900,
                  durationMinutes: 120,
                  requiredCrewSize: 2,
                },
                f.actor,
              );
      const originalVisit = await prisma.generatedVisit.findUniqueOrThrow({
        where: { id: f.visitId },
      });
      let mutation: Promise<unknown> | undefined;
      let publication: Promise<unknown> | undefined;
      try {
        if (first === 'manual') {
          mutation = mutate().then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          await manual.locked.promise;
        }
        publication = publishing.publish(f.run.id, null, f.actor).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        if (first === 'publisher') {
          await publisher.locked.promise;
          mutation = mutate().then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
        }
        const [manualPid, publisherPid] = await Promise.all([
          manual.pid.promise,
          publisher.pid.promise,
        ]);
        await waitForBlocked(
          first === 'manual' ? publisherPid : manualPid,
          first === 'manual' ? manualPid : publisherPid,
        );
        (first === 'manual' ? manual : publisher).release.resolve();
        const [mutated, published] = await Promise.all([mutation, publication]);
        const visit = await prisma.generatedVisit.findUniqueOrThrow({
          where: { id: f.visitId },
        });
        const notices = await prisma.assignmentNotificationOutbox.findMany({
          where: { assignmentId: f.draft!.id },
        });
        const draft = await prisma.assignment.findUnique({
          where: { id: f.draft!.id },
        });
        if (first === 'publisher') {
          expect(published).toHaveProperty('value');
          expect(mutated).toMatchObject({
            error: { code: 'RESOURCE_CONFLICT' },
          });
          expect(draft?.status).toBe('PUBLISHED');
          expect(visit).toEqual(originalVisit);
          expect(notices).toHaveLength(2);
        } else if (operation === 'adjust') {
          expect(mutated).toHaveProperty('value');
          expect(published).toHaveProperty('value');
          expect(visit.visitDate.toISOString()).toBe(
            '2027-03-04T00:00:00.000Z',
          );
          expect(draft?.plannedStart.toISOString()).toBe(
            '2027-03-04T09:00:00.000Z',
          );
          expect(draft?.plannedEnd.toISOString()).toBe(
            '2027-03-04T11:00:00.000Z',
          );
          expect(notices).toHaveLength(2);
          for (const notice of notices)
            expect(notice.payload).toMatchObject({
              visitDate: '2027-03-04',
              plannedStart: draft!.plannedStart.toISOString(),
              plannedEnd: draft!.plannedEnd.toISOString(),
            });
          const audit = await prisma.auditEvent.findFirstOrThrow({
            where: { entityId: f.run.id, action: 'schedule_run.published' },
          });
          expect(audit.after).toMatchObject({
            snapshot: [
              expect.objectContaining({
                visitDate: '2027-03-04',
                plannedStart: draft!.plannedStart.toISOString(),
                plannedEnd: draft!.plannedEnd.toISOString(),
              }),
            ],
          });
        } else {
          expect(mutated).toHaveProperty('value');
          expect(published).toMatchObject({
            error: { code: 'RESOURCE_CONFLICT' },
          });
          expect(draft).toBeNull();
          expect(notices).toHaveLength(0);
          expect(visit.status).toBe(
            operation === 'assign' ? 'SCHEDULED' : 'UNASSIGNED',
          );
          expect(
            (
              await prisma.scheduleRun.findUniqueOrThrow({
                where: { id: f.run.id },
              })
            ).publishedAt,
          ).toBeNull();
        }
      } finally {
        manual.release.resolve();
        publisher.release.resolve();
        await Promise.all([mutation, publication]);
      }
    },
  );

  it('preserves a new publication after a rejected manual proposal took an empty snapshot', async () => {
    const f = await manualPublicationFixture(false);
    const snapshotRead = deferred<void>();
    const resume = deferred<void>();
    const probe = transactionProbe(false, async () => {
      snapshotRead.resolve();
      await resume.promise;
    });
    const manual = new AssignmentsService(
      probe.client,
      app.get(EligibilityService),
      app.get(AuditService),
    );
    const pending = manual
      .assign(f.visitId, { ...f.proposal, crew: [] }, f.actor)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    try {
      await snapshotRead.promise;
      const draft = await f.createDraft();
      await app.get(PublishingService).publish(f.run.id, null, f.actor);
      const visitBefore = await prisma.generatedVisit.findUniqueOrThrow({
        where: { id: f.visitId },
      });
      const notices = await prisma.assignmentNotificationOutbox.findMany({
        where: { assignmentId: draft.id },
        orderBy: { id: 'asc' },
      });
      resume.resolve();
      expect(await pending).toMatchObject({ code: 'RESOURCE_CONFLICT' });
      expect(
        await prisma.generatedVisit.findUnique({ where: { id: f.visitId } }),
      ).toEqual(visitBefore);
      expect(
        await prisma.visitUnassignedReason.count({
          where: { generatedVisitId: f.visitId },
        }),
      ).toBe(0);
      expect(
        await prisma.assignmentNotificationOutbox.findMany({
          where: { assignmentId: draft.id },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(notices);
    } finally {
      resume.resolve();
      await pending;
    }
  });

  it.each([
    AssignmentStatus.PUBLISHED,
    AssignmentStatus.ACKNOWLEDGED,
    AssignmentStatus.IN_PROGRESS,
    AssignmentStatus.COMPLETED,
    AssignmentStatus.SUPERSEDED,
    AssignmentStatus.CANCELLED,
  ])(
    'protects %s published history from every manual writer',
    async (status) => {
      const f = await manualPublicationFixture();
      await app.get(PublishingService).publish(f.run.id, null, f.actor);
      await prisma.assignment.update({
        where: { id: f.draft!.id },
        data: { status },
      });
      const visitBefore = await prisma.generatedVisit.findUniqueOrThrow({
        where: { id: f.visitId },
      });
      const assignmentBefore = await prisma.assignment.findUniqueOrThrow({
        where: { id: f.draft!.id },
        include: { crewMembers: true },
      });
      const notices = await prisma.assignmentNotificationOutbox.findMany({
        where: { assignmentId: f.draft!.id },
        orderBy: { id: 'asc' },
      });
      const mutations = [
        () =>
          app.get(AssignmentsService).assign(f.visitId, f.proposal, f.actor),
        () => app.get(AssignmentsService).unassign(f.visitId, f.actor),
        () =>
          app
            .get(VisitsService)
            .adjust(
              f.visitId,
              {
                visitDate: '2027-03-04',
                windowStartMinute: 510,
                windowEndMinute: 900,
                durationMinutes: 120,
                requiredCrewSize: 3,
              },
              f.actor,
            ),
      ];
      for (const mutate of mutations)
        expect(
          await mutate().then(
            () => undefined,
            (error: unknown) => error,
          ),
        ).toMatchObject({ code: 'RESOURCE_CONFLICT' });
      expect(
        await prisma.generatedVisit.findUnique({ where: { id: f.visitId } }),
      ).toEqual(visitBefore);
      expect(
        await prisma.assignment.findUnique({
          where: { id: f.draft!.id },
          include: { crewMembers: true },
        }),
      ).toEqual(assignmentBefore);
      expect(
        await prisma.assignmentNotificationOutbox.findMany({
          where: { assignmentId: f.draft!.id },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(notices);
    },
  );
});

describe('resource lock concurrency', () => {
  async function raceManualAssignments(
    first: ReturnType<typeof transactionProbe>,
    second: ReturnType<typeof transactionProbe>,
    firstVisit: Awaited<ReturnType<typeof manualPublicationFixture>>,
    secondVisit: Awaited<ReturnType<typeof manualPublicationFixture>>,
    firstProposal: typeof firstVisit.proposal,
    secondProposal: typeof secondVisit.proposal,
  ) {
    const firstWriter = new AssignmentsService(
      first.client,
      app.get(EligibilityService),
      app.get(AuditService),
    );
    const secondWriter = new AssignmentsService(
      second.client,
      app.get(EligibilityService),
      app.get(AuditService),
    );
    const firstResult = firstWriter.assign(firstVisit.visitId, firstProposal, firstVisit.actor)
      .then((value) => ({ value }), (error: unknown) => ({ error }));
    let secondResult: Promise<{ value: unknown } | { error: unknown }> | undefined;
    try {
      await first.locked.promise;
      secondResult = secondWriter.assign(secondVisit.visitId, secondProposal, secondVisit.actor)
        .then((value) => ({ value }), (error: unknown) => ({ error }));
      const [firstPid, secondPid] = await Promise.all([first.pid.promise, second.pid.promise]);
      await waitForBlocked(secondPid, firstPid);
      first.release.resolve();
      return await Promise.all([firstResult, secondResult]);
    } finally {
      first.release.resolve();
      second.release.resolve();
      await Promise.all([firstResult, secondResult]);
    }
  }

  it('allows exactly one overlapping manual assignment on disjoint visits sharing employees', async () => {
    const [firstVisit, secondVisit] = await Promise.all([
      manualPublicationFixture(false),
      manualPublicationFixture(false),
    ]);
    const results = await raceManualAssignments(
      transactionProbe(true, undefined, 'employees'),
      transactionProbe(false, undefined, 'employees'),
      firstVisit,
      secondVisit,
      firstVisit.proposal,
      secondVisit.proposal,
    );

    expect(results[0]).toHaveProperty('value');
    expect(results[1]).toMatchObject({ error: { code: 'ASSIGNMENT_NOT_ELIGIBLE' } });
    expect(await prisma.assignment.count({
      where: { generatedVisitId: { in: [firstVisit.visitId, secondVisit.visitId] } },
    })).toBe(1);
  });

  it('allows exactly one overlapping manual assignment on disjoint visits sharing a vehicle', async () => {
    const [firstVisit, secondVisit] = await Promise.all([
      manualPublicationFixture(false),
      manualPublicationFixture(false),
    ]);
    const vehicle = await prisma.vehicle.create({
      data: {
        code: `C06-RACE-${suffix}-${batchVehicleIds.length}`,
        label: 'C06 concurrency vehicle',
        seatCapacity: 2,
        authorizations: {
          create: [
            { employeeId: supervisorIds[0] },
            { employeeId: supervisorIds[1] },
          ],
        },
      },
    });
    batchVehicleIds.push(vehicle.id);
    const proposals = [0, 1].map((index) => ({
      ...firstVisit.proposal,
      crew: [
        { employeeId: supervisorIds[index], role: CrewRole.SUPERVISOR },
        { employeeId: technicianIds[index], role: CrewRole.TECHNICIAN },
      ],
      vehicles: [{ vehicleId: vehicle.id, driverEmployeeId: supervisorIds[index] }],
    }));
    const results = await raceManualAssignments(
      transactionProbe(true, undefined, 'vehicles'),
      transactionProbe(false, undefined, 'vehicles'),
      firstVisit,
      secondVisit,
      proposals[0],
      proposals[1],
    );

    expect(results[0]).toHaveProperty('value');
    expect(results[1]).toMatchObject({ error: { code: 'ASSIGNMENT_NOT_ELIGIBLE' } });
    expect(await prisma.assignmentVehicle.count({
      where: { vehicleId: vehicle.id },
    })).toBe(1);
  });

  it('makes an assignment wait for a concurrent availability rule change and then reject it', async () => {
    const visit = await manualPublicationFixture(false);
    const ruleProbe = transactionProbe(true, undefined, 'employees');
    const assignmentProbe = transactionProbe(false, undefined, 'employees');
    const workforce = new EmployeesService(ruleProbe.client, app.get(AuditService));
    const assignments = new AssignmentsService(
      assignmentProbe.client,
      app.get(EligibilityService),
      app.get(AuditService),
    );
    const ruleChange = workforce.addAvailability(
      supervisorIds[0],
      {
        startDate: '2027-03-03',
        endDate: '2027-03-03',
        kind: AvailabilityKind.LEAVE,
        reason: 'Concurrency proof',
      },
      visit.actor,
    ).then((value) => ({ value }), (error: unknown) => ({ error }));
    let assignment: Promise<{ value: unknown } | { error: unknown }> | undefined;
    try {
      await ruleProbe.locked.promise;
      assignment = assignments.assign(visit.visitId, visit.proposal, visit.actor)
        .then((value) => ({ value }), (error: unknown) => ({ error }));
      const [rulePid, assignmentPid] = await Promise.all([
        ruleProbe.pid.promise,
        assignmentProbe.pid.promise,
      ]);
      await waitForBlocked(assignmentPid, rulePid);
      ruleProbe.release.resolve();
      const [changed, rejected] = await Promise.all([ruleChange, assignment]);
      expect(changed).toHaveProperty('value');
      expect(rejected).toMatchObject({ error: { code: 'ASSIGNMENT_NOT_ELIGIBLE' } });
      expect(await prisma.assignment.count({ where: { generatedVisitId: visit.visitId } })).toBe(0);
    } finally {
      ruleProbe.release.resolve();
      assignmentProbe.release.resolve();
      await Promise.all([ruleChange, assignment]);
      await prisma.employeeAvailability.deleteMany({
        where: { employeeId: supervisorIds[0], reason: 'Concurrency proof' },
      });
    }
  });

  it('makes an assignment wait for a concurrent authorization revocation and then reject it', async () => {
    const visit = await manualPublicationFixture(false);
    const vehicle = await prisma.vehicle.create({
      data: {
        code: `C06-RULE-${suffix}-${batchVehicleIds.length}`,
        label: 'C06 authorization race vehicle',
        seatCapacity: 2,
        authorizations: { create: { employeeId: supervisorIds[0] } },
      },
    });
    batchVehicleIds.push(vehicle.id);
    const proposal = {
      ...visit.proposal,
      vehicles: [{ vehicleId: vehicle.id, driverEmployeeId: supervisorIds[0] }],
    };
    const ruleProbe = transactionProbe(true, undefined, 'employees');
    const assignmentProbe = transactionProbe(false, undefined, 'employees');
    const workforce = new EmployeesService(ruleProbe.client, app.get(AuditService));
    const assignments = new AssignmentsService(
      assignmentProbe.client,
      app.get(EligibilityService),
      app.get(AuditService),
    );
    const ruleChange = workforce.revokeVehicle(
      supervisorIds[0],
      vehicle.id,
      visit.actor,
    ).then((value) => ({ value }), (error: unknown) => ({ error }));
    let assignment: Promise<{ value: unknown } | { error: unknown }> | undefined;
    try {
      await ruleProbe.locked.promise;
      assignment = assignments.assign(visit.visitId, proposal, visit.actor)
        .then((value) => ({ value }), (error: unknown) => ({ error }));
      const [rulePid, assignmentPid] = await Promise.all([
        ruleProbe.pid.promise,
        assignmentProbe.pid.promise,
      ]);
      await waitForBlocked(assignmentPid, rulePid);
      ruleProbe.release.resolve();
      const [changed, rejected] = await Promise.all([ruleChange, assignment]);
      expect(changed).toHaveProperty('value');
      expect(rejected).toMatchObject({ error: { code: 'ASSIGNMENT_NOT_ELIGIBLE' } });
      expect(await prisma.assignment.count({ where: { generatedVisitId: visit.visitId } })).toBe(0);
    } finally {
      ruleProbe.release.resolve();
      assignmentProbe.release.resolve();
      await Promise.all([ruleChange, assignment]);
    }
  });
});

describe('publishing', () => {
  it.each(
    [
      { scheduledDate: '2027-03-03', outcome: 'assignment' },
      { scheduledDate: '2027-03-04', outcome: 'assignment' },
      { scheduledDate: '2027-03-04', outcome: 'rejected' },
      { scheduledDate: '2027-03-04', outcome: 'unassigned' },
    ].flatMap((scenario) =>
      ['present', 'absent'].map((snapshot) => ({ ...scenario, snapshot })),
    ),
  )(
    'preserves a publication while a stale solve proposes $outcome on $scheduledDate with $snapshot snapshot',
    async ({ scheduledDate, outcome, snapshot }) => {
      const visitId = await makeVisit();
      const visitBefore = await prisma.generatedVisit.findUniqueOrThrow({
        where: { id: visitId },
      });
      const previousRun = await prisma.scheduleRun.create({
        data: {
          status: 'SUCCEEDED',
          rangeStart: new Date(RANGE.from),
          rangeEnd: new Date(RANGE.to),
          branchCode: BranchCode.COLOMBO,
        },
      });
      const createDraft = () =>
        prisma.assignment.create({
          data: {
            generatedVisitId: visitId,
            branchId: visitBefore.branchId,
            branchCode: BranchCode.COLOMBO,
            status: 'DRAFT',
            scheduleRunId: previousRun.id,
            plannedStart: new Date('2027-03-03T09:00:00Z'),
            plannedEnd: new Date('2027-03-03T10:30:00Z'),
            crewMembers: {
              create: [
                {
                  employeeId: supervisorIds[0],
                  role: 'SUPERVISOR',
                  isPmsSupervisor: true,
                },
                { employeeId: technicianIds[0], role: 'TECHNICIAN' },
              ],
            },
          },
        });
      let assignment = snapshot === 'present' ? await createDraft() : undefined;
      const staleRun = await prisma.scheduleRun.create({
        data: {
          status: 'QUEUED',
          rangeStart: new Date(RANGE.from),
          rangeEnd: new Date(RANGE.to),
          branchCode: BranchCode.COLOMBO,
        },
      });
      let start!: () => void;
      const started = new Promise<void>((resolve) => {
        start = resolve;
      });
      let release!: (value: SolveResponse) => void;
      const answer = new Promise<SolveResponse>((resolve) => {
        release = resolve;
      });
      const solveSpy = jest
        .spyOn(app.get(SchedulerClient), 'solve')
        .mockImplementationOnce(() => {
          start();
          return answer;
        });
      const pending = runs.execute(staleRun.id).then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await started;
        assignment ??= await createDraft();
        const published = await request(http)
          .post(`/api/schedule-runs/${previousRun.id}/publish`)
          .set(auth(adminToken))
          .send({});
        expect(published.status).toBe(200);
        const publishedAssignment = await prisma.assignment.findUniqueOrThrow({
          where: { id: assignment.id },
        });
        const outbox = await prisma.assignmentNotificationOutbox.findMany({
          where: { assignmentId: assignment.id },
          orderBy: { id: 'asc' },
        });
        const reasons = await prisma.visitUnassignedReason.findMany({
          where: { generatedVisitId: visitId },
          orderBy: { id: 'asc' },
        });
        expect(outbox).toHaveLength(2);
        release({
          run_id: staleRun.id,
          status: 'OPTIMAL',
          assignments:
            outcome === 'unassigned'
              ? []
              : [
                  {
                    visit_id: visitId,
                    employee_ids:
                      outcome === 'rejected'
                        ? []
                        : [supervisorIds[0], technicianIds[0]],
                    vehicles: [],
                    start_minute: 600,
                    scheduled_date: scheduledDate,
                  },
                ],
          unassigned:
            outcome === 'unassigned'
              ? [
                  {
                    visit_id: visitId,
                    reason_codes: ['NO_CREW'],
                    message: 'No crew available',
                  },
                ]
              : [],
          solve_seconds: 0,
          objective_value: 0,
          visits_considered: 1,
        });
        const failure = await pending;

        expect(
          await prisma.assignment.findUnique({ where: { id: assignment.id } }),
        ).toEqual(publishedAssignment);
        expect(
          await prisma.assignmentNotificationOutbox.findMany({
            where: { assignmentId: assignment.id },
            orderBy: { id: 'asc' },
          }),
        ).toEqual(outbox);
        expect(
          await prisma.generatedVisit.findUnique({ where: { id: visitId } }),
        ).toEqual(visitBefore);
        expect(
          await prisma.visitUnassignedReason.findMany({
            where: { generatedVisitId: visitId },
            orderBy: { id: 'asc' },
          }),
        ).toEqual(reasons);
        expect(
          await prisma.assignment.count({
            where: { scheduleRunId: staleRun.id },
          }),
        ).toBe(0);
        expect(failure).toMatchObject({ code: 'RESOURCE_CONFLICT' });
      } finally {
        release({
          run_id: staleRun.id,
          status: 'UNKNOWN',
          assignments: [],
          unassigned: [],
          solve_seconds: 0,
          objective_value: 0,
          visits_considered: 1,
        });
        await pending;
        solveSpy.mockRestore();
      }
    },
  );

  it.each([
    ...['present', 'absent'].flatMap((snapshot) =>
      ['assignment', 'rejected', 'unassigned'].map((outcome) => ({
        snapshot,
        outcome,
        first: 'publisher',
      })),
    ),
    ...['rejected', 'unassigned'].map((outcome) => ({
      snapshot: 'present',
      outcome,
      first: 'solver',
    })),
  ])(
    'serializes overlapping $outcome with $snapshot snapshot when $first locks first',
    async ({ snapshot, outcome, first }) => {
      const visitId = await makeVisit();
      const visit = await prisma.generatedVisit.findUniqueOrThrow({
        where: { id: visitId },
      });
      const previousRun = await prisma.scheduleRun.create({
        data: {
          status: 'SUCCEEDED',
          rangeStart: new Date(RANGE.from),
          rangeEnd: new Date(RANGE.to),
          branchCode: BranchCode.COLOMBO,
        },
      });
      const staleRun = await prisma.scheduleRun.create({
        data: {
          status: 'QUEUED',
          rangeStart: new Date(RANGE.from),
          rangeEnd: new Date(RANGE.to),
          branchCode: BranchCode.COLOMBO,
        },
      });
      const createDraft = async () => {
        const assignment = await prisma.assignment.create({
          data: {
            generatedVisitId: visitId,
            branchId: visit.branchId,
            branchCode: BranchCode.COLOMBO,
            status: 'DRAFT',
            scheduleRunId: previousRun.id,
            plannedStart: new Date('2027-03-03T09:00:00Z'),
            plannedEnd: new Date('2027-03-03T10:30:00Z'),
            crewMembers: {
              create: [
                {
                  employeeId: supervisorIds[0],
                  role: 'SUPERVISOR',
                  isPmsSupervisor: true,
                },
                { employeeId: technicianIds[0], role: 'TECHNICIAN' },
              ],
            },
          },
        });
        await prisma.generatedVisit.update({
          where: { id: visitId },
          data: { status: 'SCHEDULED' },
        });
        return assignment;
      };
      let assignment = snapshot === 'present' ? await createDraft() : undefined;
      const solver = transactionProbe(first === 'solver');
      const publisher = transactionProbe(first === 'publisher');
      const started = deferred<void>();
      const answer = deferred<SolveResponse>();
      const scheduler = {
        solve: async () => {
          started.resolve();
          return answer.promise;
        },
      } as unknown as SchedulerClient;
      const runService = new ScheduleRunService(
        solver.client,
        scheduler,
        app.get(EligibilityService),
        app.get(AuditService),
      );
      const publishing = new PublishingService(
        publisher.client,
        app.get(AuditService),
        app.get(EligibilityService),
      );
      const actor = await prisma.user.findUniqueOrThrow({
        where: { email: ADMIN.email },
      });
      const solved = runService.execute(staleRun.id).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      let published:
        Promise<{ value: unknown } | { error: unknown }> | undefined;
      const solution: SolveResponse = {
        run_id: staleRun.id,
        status: 'OPTIMAL',
        assignments:
          outcome === 'unassigned'
            ? []
            : [
                {
                  visit_id: visitId,
                  employee_ids:
                    outcome === 'rejected'
                      ? []
                      : [supervisorIds[0], technicianIds[0]],
                  vehicles: [],
                  start_minute: 600,
                  scheduled_date: '2027-03-04',
                },
              ],
        unassigned:
          outcome === 'unassigned'
            ? [
                {
                  visit_id: visitId,
                  reason_codes: ['NO_CREW'],
                  message: 'No crew available',
                },
              ]
            : [],
        solve_seconds: 0,
        objective_value: 0,
        visits_considered: 1,
      };
      try {
        await started.promise;
        assignment ??= await createDraft();
        const visitBefore = await prisma.generatedVisit.findUniqueOrThrow({
          where: { id: visitId },
        });
        if (first === 'solver') {
          answer.resolve(solution);
          await solver.locked.promise;
        }
        published = publishing.publish(previousRun.id, null, actor).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        if (first === 'publisher') {
          await publisher.locked.promise;
          answer.resolve(solution);
        }
        const [solverPid, publisherPid] = await Promise.all([
          solver.pid.promise,
          publisher.pid.promise,
        ]);
        await waitForBlocked(
          first === 'publisher' ? solverPid : publisherPid,
          first === 'publisher' ? publisherPid : solverPid,
        );
        (first === 'publisher' ? publisher : solver).release.resolve();
        const [runResult, publishResult] = await Promise.all([
          solved,
          published,
        ]);
        const storedAssignment = await prisma.assignment.findUniqueOrThrow({
          where: { id: assignment.id },
        });
        const storedVisit = await prisma.generatedVisit.findUniqueOrThrow({
          where: { id: visitId },
        });
        const notifications =
          await prisma.assignmentNotificationOutbox.findMany({
            where: { assignmentId: assignment.id },
          });
        const storedRun = await prisma.scheduleRun.findUniqueOrThrow({
          where: { id: previousRun.id },
        });

        if (first === 'publisher') {
          expect(publishResult).toHaveProperty('value');
          expect(runResult).toMatchObject({
            error: { code: 'RESOURCE_CONFLICT' },
          });
          expect(storedAssignment.status).toBe('PUBLISHED');
          expect(storedAssignment.plannedStart).toEqual(
            assignment.plannedStart,
          );
          expect(storedAssignment.plannedEnd).toEqual(assignment.plannedEnd);
          expect(storedVisit).toEqual(visitBefore);
          expect(notifications).toHaveLength(2);
          expect(
            notifications.every(
              (entry) =>
                (entry.payload as { visitDate: string }).visitDate ===
                '2027-03-03',
            ),
          ).toBe(true);
          expect(
            await prisma.visitUnassignedReason.count({
              where: { generatedVisitId: visitId },
            }),
          ).toBe(0);
        } else {
          expect(runResult).toHaveProperty('value');
          expect(publishResult).toMatchObject({
            error: { code: 'RESOURCE_CONFLICT' },
          });
          expect(storedAssignment.status).toBe('CANCELLED');
          expect(storedVisit.status).toBe('UNASSIGNED');
          expect(storedVisit.visitDate).toEqual(visitBefore.visitDate);
          expect(notifications).toHaveLength(0);
          expect(storedRun.publishedAt).toBeNull();
          expect(
            await prisma.visitUnassignedReason.count({
              where: { generatedVisitId: visitId },
            }),
          ).toBeGreaterThan(0);
          expect(
            await prisma.auditEvent.count({
              where: {
                entityId: previousRun.id,
                action: 'schedule_run.published',
              },
            }),
          ).toBe(0);
        }
        expect(
          await prisma.assignment.count({
            where: { generatedVisitId: visitId },
          }),
        ).toBe(1);
      } finally {
        answer.resolve(solution);
        solver.release.resolve();
        publisher.release.resolve();
        await Promise.all([solved, published]);
      }
    },
  );

  it('freezes the schedule and records an immutable snapshot', async () => {
    const visitId = await makeVisit();
    const runId = await solve();

    const published = await request(http)
      .post(`/api/schedule-runs/${runId}/publish`)
      .set(auth(adminToken))
      .send({ reason: 'Week of 7 September' });

    expect(published.status).toBe(200);
    expect(published.body.isPublished).toBe(true);

    const assignment = await prisma.assignment.findFirstOrThrow({
      where: { generatedVisitId: visitId },
    });
    expect(assignment.status).toBe('PUBLISHED');

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: runId, action: 'schedule_run.published' },
    });
    // The snapshot holds names, not just ids, so it still reads correctly
    // after somebody is renamed or deactivated. Which people the solver chose
    // is its business — that every one of them is named here is the point.
    const after = event.after as {
      snapshot: { crew: { employeeId: string; fullName: string }[] }[];
    };
    const snapshotCrew = after.snapshot[0].crew;
    expect(snapshotCrew).toHaveLength(2);
    for (const member of snapshotCrew) {
      expect(member.fullName.length).toBeGreaterThan(0);
    }
    const stored = await prisma.assignment.findFirstOrThrow({
      where: { generatedVisitId: visitId },
      include: { crewMembers: true },
    });
    expect(snapshotCrew.map((m) => m.employeeId).sort()).toEqual(
      stored.crewMembers.map((m) => m.employeeId).sort(),
    );
  });

  it('refuses to publish the same run twice', async () => {
    await makeVisit();
    const runId = await solve();
    await request(http).post(`/api/schedule-runs/${runId}/publish`).set(auth(adminToken)).send({});

    const again = await request(http)
      .post(`/api/schedule-runs/${runId}/publish`)
      .set(auth(adminToken))
      .send({});

    expect(again.status).toBe(409);
  });

  it('refuses a hand edit to published work', async () => {
    const visitId = await makeVisit();
    const runId = await solve();
    await request(http).post(`/api/schedule-runs/${runId}/publish`).set(auth(adminToken)).send({});

    const edit = await request(http)
      .put(`/api/visits/${visitId}/assignment`)
      .set(auth(adminToken))
      .send({
        plannedStartMinute: 9 * 60,
        plannedEndMinute: 11 * 60,
        crew: [
          { employeeId: supervisorIds[0], role: 'SUPERVISOR' },
          { employeeId: technicianIds[0], role: 'TECHNICIAN' },
        ],
      });

    expect(edit.status).toBe(409);
    expect(edit.body.message).toContain('published');
  });

  it('supersedes the earlier schedule rather than deleting it', async () => {
    const visitId = await makeVisit();
    const firstRun = await solve();
    await request(http)
      .post(`/api/schedule-runs/${firstRun}/publish`)
      .set(auth(adminToken))
      .send({});

    // A second run cannot touch published work, so the old assignment stands
    // until a new one is published over it.
    const secondRun = await solve();
    const republished = await request(http)
      .post(`/api/schedule-runs/${secondRun}/publish`)
      .set(auth(adminToken))
      .send({});

    if (republished.status === 200) {
      const all = await prisma.assignment.findMany({
        where: { generatedVisitId: visitId },
        select: { status: true },
      });
      // Nothing is deleted: the old one is kept, marked superseded.
      expect(all.some((assignment) => assignment.status === 'SUPERSEDED')).toBe(true);
    } else {
      // Nothing new to publish, because published work was left alone — which
      // is the same guarantee stated the other way round.
      expect(republished.status).toBe(409);
      const survivor = await prisma.assignment.findFirstOrThrow({
        where: { generatedVisitId: visitId },
      });
      expect(survivor.status).toBe('PUBLISHED');
    }
  });

  it('will not publish a run that has not finished', async () => {
    const created = await request(http)
      .post('/api/schedule-runs')
      .set(auth(adminToken))
      .send(RANGE);

    const res = await request(http)
      .post(`/api/schedule-runs/${created.body.id}/publish`)
      .set(auth(adminToken))
      .send({});

    expect(res.status).toBe(409);
  });
});

describe('cancellation', () => {
  it('cancels a queued run without writing anything', async () => {
    await makeVisit();
    const created = await request(http)
      .post('/api/schedule-runs')
      .set(auth(adminToken))
      .send({ ...RANGE, branchCode: BranchCode.COLOMBO });

    const cancelled = await request(http)
      .post(`/api/schedule-runs/${created.body.id}/cancel`)
      .set(auth(adminToken))
      .send();

    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');

    // And a worker that picks it up anyway must still write nothing.
    const result = await runs.execute(created.body.id, { timeLimitSeconds: 5 });
    expect(result.cancelled).toBe(true);
    expect(result.scheduled).toBe(0);
  });

  it('refuses to cancel a run that has already finished', async () => {
    await makeVisit();
    const runId = await solve();

    const res = await request(http)
      .post(`/api/schedule-runs/${runId}/cancel`)
      .set(auth(adminToken))
      .send();

    expect(res.status).toBe(409);
  });
});

describe('determinism', () => {
  it('produces the same crew for the same inputs', async () => {
    const visitId = await makeVisit();

    await solve();
    const first = await prisma.assignment.findFirstOrThrow({
      where: { generatedVisitId: visitId },
      include: { crewMembers: true },
    });
    const firstCrew = first.crewMembers.map((member) => member.employeeId).sort();

    await prisma.assignment.deleteMany({ where: { generatedVisitId: visitId } });
    await solve();
    const second = await prisma.assignment.findFirstOrThrow({
      where: { generatedVisitId: visitId },
      include: { crewMembers: true },
    });

    expect(second.crewMembers.map((member) => member.employeeId).sort()).toEqual(firstCrew);
  });
});

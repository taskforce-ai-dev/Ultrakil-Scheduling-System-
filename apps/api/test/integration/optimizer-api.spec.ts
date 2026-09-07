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
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AssignmentStatus, BranchCode, CrewRole, LockScope, Prisma, PrismaClient, UserRole, Weekday } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { AuditService } from '../../src/audit/audit.service';
import { AuthService } from '../../src/auth/auth.service';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { PrismaService } from '../../src/prisma/prisma.service';
import { EligibilityService } from '../../src/scheduling/eligibility/eligibility.service';
import { AssignmentsService } from '../../src/scheduling/eligibility/assignments.service';
import { VisitsService } from '../../src/scheduling/visits/visits.service';
import { PublishingService } from '../../src/scheduling/optimizer/publishing.service';
import { ScheduleRunProcessor } from '../../src/scheduling/optimizer/schedule-run.processor';
import { ScheduleRunService } from '../../src/scheduling/optimizer/schedule-run.service';
import { SchedulerClient, SolveResponse } from '../../src/scheduling/optimizer/scheduler.client';

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
function transactionProbe(holdLock: boolean, beforeTransaction?: () => Promise<void>) {
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
                    if (query.sql.includes('generated_visits') && query.sql.includes('FOR UPDATE')) {
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

    await solve();

    const after = await prisma.assignment.findFirstOrThrow({
      where: { generatedVisitId: visitId },
      include: { crewMembers: true },
    });
    expect(after.crewMembers.map((member) => member.employeeId).sort()).toEqual(lockedCrew);
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

describe('standard writer publication protocol', () => {
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

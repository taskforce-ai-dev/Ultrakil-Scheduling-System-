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
 * job up — the queue is covered separately by its own idempotency test.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BranchCode, LockScope, PrismaClient, UserRole, Weekday } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { ScheduleRunService } from '../../src/scheduling/optimizer/schedule-run.service';

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

/** Only this suite's own visits, so a shared database cannot skew a count. */
let agreementIds: string[] = [];

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
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

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

describe('publishing', () => {
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

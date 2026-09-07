/**
 * ULK-C07 API tests.
 *
 * Covers the two new Phase 2-compatible read models: the unified calendar
 * (GET /schedule/calendar) and one employee's published daily assignments
 * (GET /employees/:id/assignments) — plus the notification outbox row
 * publishing is supposed to write. Assignment creation goes through the same
 * `PUT /visits/:id/assignment` route ULK-C05's tests use, so these do not
 * depend on the Python solver being reachable; publishing goes through the
 * real `PublishingService` via a hand-made `ScheduleRun` row, so the outbox
 * write under test is the production code path, not a shortcut around it.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AssignmentStatus,
  BranchCode,
  PrismaClient,
  ScheduleRunStatus,
  UserRole,
  Weekday,
} from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { cleanupCapturedIds } from '../support/fixture-cleanup';

const prisma = new PrismaClient();

const suffix = Math.random().toString(36).slice(2, 8);
const ADMIN = {
  email: `c07-admin-${suffix}@ultrakil.test`,
  password: 'c07-admin-password',
};

let app: INestApplication | undefined;
let http: string;
let adminToken: string;
let managerToken: string;
let jobTypeId: string | undefined;
let customerId: string | undefined;
let siteId: string | undefined;
let supervisorId: string | undefined;
let technicianId: string | undefined;
let vehicleId: string | undefined;
const scheduleRunIds: string[] = [];
const userIds: string[] = [];

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const HORIZON = { from: '2026-09-07', to: '2026-09-13' }; // one week, Mon-Sun
const VISIT_DATE = '2026-09-09'; // the Wednesday in that week

async function login(email: string, password: string): Promise<string> {
  const res = await request(http).post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  expect(res.body.accessToken).toEqual(expect.any(String));
  return res.body.accessToken as string;
}

/** An agreement with one Wednesday visit generated, and that visit's id. */
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
      startDate: HORIZON.from,
      durationMinutes: 90,
      crewSize: 2,
      notes: `C07 instructions ${suffix}`,
    });
  expect(agreement.status).toBe(201);
  expect(agreement.body.id).toEqual(expect.any(String));

  const generated = await request(http)
    .post('/api/visit-generation/confirm')
    .set(auth(adminToken))
    .send({ ...HORIZON, serviceAgreementIds: [agreement.body.id] });
  expect(generated.status).toBe(200);

  const listed = await request(http)
    .get('/api/visits')
    .set(auth(adminToken))
    .query({ serviceAgreementId: agreement.body.id });
  expect(listed.status).toBe(200);
  expect(listed.body.items).toHaveLength(1);
  expect(listed.body.items[0].id).toEqual(expect.any(String));
  return listed.body.items[0].id as string;
}

/** Puts a legal crew on a visit and returns the assignment id. */
async function assignCrew(visitId: string): Promise<string> {
  const res = await request(http)
    .put(`/api/visits/${visitId}/assignment`)
    .set(auth(adminToken))
    .send({
      plannedStartMinute: 9 * 60,
      plannedEndMinute: 11 * 60 + 30,
      crew: [
        { employeeId: supervisorId, role: 'SUPERVISOR' },
        { employeeId: technicianId, role: 'TECHNICIAN' },
      ],
      vehicles: [{ vehicleId, driverEmployeeId: supervisorId }],
    });
  expect(res.status).toBe(200);
  expect(res.body.id).toEqual(expect.any(String));
  return res.body.id as string;
}

/** Publishes the assignment through the real publishing flow, no solver involved. */
async function publish(assignmentId: string): Promise<void> {
  const run = await prisma.scheduleRun.create({
    data: {
      status: ScheduleRunStatus.SUCCEEDED,
      rangeStart: new Date(`${HORIZON.from}T00:00:00.000Z`),
      rangeEnd: new Date(`${HORIZON.to}T00:00:00.000Z`),
      finishedAt: new Date(),
    },
  });
  scheduleRunIds.push(run.id);
  await prisma.assignment.update({
    where: { id: assignmentId },
    data: { scheduleRunId: run.id },
  });

  const published = await request(http)
    .post(`/api/schedule-runs/${run.id}/publish`)
    .set(auth(adminToken))
    .send({});
  expect(published.status).toBe(200);
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

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

  await prisma.$connect();
  for (const code of [BranchCode.COLOMBO, BranchCode.KANDY]) {
    await prisma.branch.upsert({
      where: { code },
      create: { code, name: `${code} Branch` },
      update: {},
    });
  }
  const admin = await prisma.user.upsert({
    where: { email: ADMIN.email },
    create: {
      email: ADMIN.email,
      fullName: `C07 ${UserRole.ADMIN}`,
      role: UserRole.ADMIN,
      passwordHash: await AuthService.hashPassword(ADMIN.password),
    },
    update: { role: UserRole.ADMIN, isActive: true },
  });
  userIds.push(admin.id);
  adminToken = await login(ADMIN.email, ADMIN.password);
  const managerEmail = `c07-manager-${suffix}@ultrakil.test`;
  const manager = await prisma.user.create({ data: {
    email: managerEmail, fullName: 'C07 Manager', role: UserRole.MANAGER,
    passwordHash: await AuthService.hashPassword(ADMIN.password),
  } });
  userIds.push(manager.id);
  managerToken = await login(managerEmail, ADMIN.password);

  const colombo = await prisma.branch.findUniqueOrThrow({
    where: { code: BranchCode.COLOMBO },
  });

  const supervisor = await prisma.employee.create({
    data: {
      sourceKey: `c07-sup-${suffix}`,
      fullName: `C07 Supervisor ${suffix}`,
      gradeLabel: 'PMS',
      isPmsGrade: true,
      branchId: colombo.id,
      branchCode: BranchCode.COLOMBO,
    },
  });
  supervisorId = supervisor.id;

  const technician = await prisma.employee.create({
    data: {
      sourceKey: `c07-tech-${suffix}`,
      fullName: `C07 Technician ${suffix}`,
      gradeLabel: 'Junior PMT',
      branchId: colombo.id,
      branchCode: BranchCode.COLOMBO,
    },
  });
  technicianId = technician.id;
  const vehicle = await prisma.vehicle.create({ data: {
    code: `C07-VAN-${suffix}`, label: `C07 Van ${suffix}`, seatCapacity: 4,
    branchId: colombo.id,
    authorizations: { create: { employeeId: supervisorId } },
  } });
  vehicleId = vehicle.id;

  const jobType = await request(http)
    .post('/api/job-types')
    .set(auth(adminToken))
    .send({ code: `C07_${suffix}`, name: 'C07 Job', defaultCrewSize: 2 });
  expect(jobType.status).toBe(201);
  expect(jobType.body.id).toEqual(expect.any(String));
  jobTypeId = jobType.body.id;

  const customer = await request(http)
    .post('/api/customers')
    .set(auth(adminToken))
    .send({ name: `C07 Customer ${suffix}`, branchCode: BranchCode.COLOMBO });
  expect(customer.status).toBe(201);
  expect(customer.body.id).toEqual(expect.any(String));
  customerId = customer.body.id;

  const site = await request(http)
    .post(`/api/customers/${customerId}/sites`)
    .set(auth(adminToken))
    .send({
      name: `C07 Site ${suffix}`,
      operatingHours: [
        {
          weekday: Weekday.WEDNESDAY,
          opensAtMinute: 540,
          closesAtMinute: 1020,
        },
      ],
    });
  expect(site.status).toBe(201);
  expect(site.body.id).toEqual(expect.any(String));
  siteId = site.body.id;
});

beforeEach(async () => {
  await cleanupCapturedIds([supervisorId, technicianId], (ids) =>
    prisma.assignment.deleteMany({
      where: { crewMembers: { some: { employeeId: { in: ids } } } },
    }),
  );
});

afterAll(async () => {
  const employees = [supervisorId, technicianId];
  try {
    await cleanupCapturedIds(employees, (ids) => prisma.assignmentNotificationOutbox.deleteMany({
      where: { employeeId: { in: ids } },
    }));
    await cleanupCapturedIds(employees, (ids) => prisma.assignment.deleteMany({
      where: { crewMembers: { some: { employeeId: { in: ids } } } },
    }));
    await cleanupCapturedIds(scheduleRunIds, (ids) => prisma.scheduleRun.deleteMany({
      where: { id: { in: ids } },
    }));
    await cleanupCapturedIds([siteId], (ids) => prisma.serviceAgreement.deleteMany({
      where: { serviceSiteId: { in: ids } },
    }));
    await cleanupCapturedIds([siteId], (ids) => prisma.serviceSite.deleteMany({ where: { id: { in: ids } } }));
    await cleanupCapturedIds([customerId], (ids) => prisma.customer.deleteMany({ where: { id: { in: ids } } }));
    await cleanupCapturedIds([jobTypeId], (ids) => prisma.jobType.deleteMany({ where: { id: { in: ids } } }));
    await cleanupCapturedIds(employees, (ids) => prisma.employee.deleteMany({ where: { id: { in: ids } } }));
    await cleanupCapturedIds([vehicleId], (ids) => prisma.vehicle.deleteMany({ where: { id: { in: ids } } }));
    await cleanupCapturedIds(userIds, (ids) => prisma.user.deleteMany({ where: { id: { in: ids } } }));
  } finally {
    await prisma.$disconnect();
    await app?.close();
  }
});

describe('unified calendar', () => {
  it.each([true, false])('reports hoursUnconfirmed=%s consistently with the visit read model', async (unconfirmed) => {
    const visitId = await makeVisit();
    const originalHours = await prisma.siteOperatingHours.findMany({ where: { serviceSiteId: siteId! } });
    try {
      if (unconfirmed) await prisma.siteOperatingHours.deleteMany({ where: { serviceSiteId: siteId! } });
      const [calendar, visit] = await Promise.all([
        request(http).get('/api/schedule/calendar').set(auth(adminToken)).query(HORIZON),
        request(http).get(`/api/visits/${visitId}`).set(auth(adminToken)),
      ]);
      expect(calendar.status).toBe(200);
      expect(visit.status).toBe(200);
      expect(visit.body.hoursUnconfirmed).toBe(unconfirmed);
      expect(calendar.body.items.find((item: { visitId: string }) => item.visitId === visitId))
        .toHaveProperty('hoursUnconfirmed', unconfirmed);
    } finally {
      if (unconfirmed) await prisma.siteOperatingHours.createMany({ data: originalHours });
    }
  });

  it('refuses an anonymous caller', async () => {
    const res = await request(http)
      .get('/api/schedule/calendar')
      .query({ from: HORIZON.from, to: HORIZON.to });
    expect(res.status).toBe(401);
  });

  it('rejects a range wider than 120 days', async () => {
    const res = await request(http)
      .get('/api/schedule/calendar')
      .set(auth(adminToken))
      .query({ from: '2026-01-01', to: '2026-12-31' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('rejects timestamps where the contract requires a date-only value', async () => {
    const res = await request(http)
      .get('/api/schedule/calendar')
      .set(auth(adminToken))
      .query({ from: '2026-09-07T10:00:00Z', to: HORIZON.to });
    expect(res.status).toBe(400);
  });

  it('joins date, time, crew, supervisor and vehicle onto one row', async () => {
    const visitId = await makeVisit();
    await assignCrew(visitId);

    const res = await request(http).get('/api/schedule/calendar').set(auth(adminToken)).query({
      from: HORIZON.from,
      to: HORIZON.to,
      branchCode: BranchCode.COLOMBO,
    });

    expect(res.status).toBe(200);
    const entry = res.body.items.find((item: { visitId: string }) => item.visitId === visitId);
    expect(entry).toBeDefined();
    expect(entry.visitDate).toBe(VISIT_DATE);
    expect(entry.instructions).toBe(`C07 instructions ${suffix}`);
    expect(entry.assignment).not.toBeNull();
    expect(entry.assignment.status).toBe('DRAFT');
    expect(entry.assignment.supervisorEmployeeId).toBe(supervisorId);
    expect(entry.assignment.crew).toHaveLength(2);
    expect(entry.windowStartMinute).toBe(540);
    expect(entry.windowEndMinute).toBe(1020);
    expect(entry.assignment.plannedStartMinute).toBe(540);
    expect(entry.assignment.plannedEndMinute).toBe(690);
    expect(entry.assignment.vehicles).toEqual([{
      vehicleId, label: `C07 Van ${suffix}`,
      driverEmployeeId: supervisorId, driverName: `C07 Supervisor ${suffix}`,
    }]);
  });

  it('leaves an unstaffed visit with a null assignment', async () => {
    const visitId = await makeVisit();

    const res = await request(http)
      .get('/api/schedule/calendar')
      .set(auth(adminToken))
      .query({ from: HORIZON.from, to: HORIZON.to });

    const entry = res.body.items.find((item: { visitId: string }) => item.visitId === visitId);
    expect(entry.assignment).toBeNull();
  });

  it('measures assignment times from the UTC visit date, preserving the next midnight', async () => {
    const visitId = await makeVisit();
    const assignmentId = await assignCrew(visitId);
    // Isolate read-model arithmetic from daytime eligibility and local timezones.
    await prisma.assignment.update({ where: { id: assignmentId }, data: {
      plannedStart: new Date(`${VISIT_DATE}T23:30:00.000Z`),
      plannedEnd: new Date('2026-09-10T00:00:00.000Z'),
    } });
    const res = await request(http).get('/api/schedule/calendar')
      .set(auth(adminToken)).query(HORIZON);
    expect(res.status).toBe(200);
    const entry = res.body.items.find((item: { visitId: string }) => item.visitId === visitId);
    expect(entry.assignment).toMatchObject({ plannedStartMinute: 1410, plannedEndMinute: 1440 });
  });
});

describe('employee published assignments', () => {
  it('requires authentication and permits manager/admin read access', async () => {
    expect((await request(http).get(`/api/employees/${supervisorId}/assignments`)).status).toBe(401);
    expect((await request(http).get(`/api/employees/${supervisorId}/assignments`)
      .set(auth(managerToken))).status).toBe(200);
  });

  it.each([
    { publishedAt: null, withRun: false },
    { publishedAt: null, withRun: true },
    { publishedAt: new Date('2026-09-07T00:00:00Z'), withRun: false },
  ])('hides forced published status without full publication provenance: %p', async ({ publishedAt, withRun }) => {
    const assignmentId = await assignCrew(await makeVisit());
    let scheduleRunId: string | null = null;
    if (withRun) {
      const run = await prisma.scheduleRun.create({ data: {
        status: ScheduleRunStatus.SUCCEEDED,
        rangeStart: new Date(`${HORIZON.from}T00:00:00Z`),
        rangeEnd: new Date(`${HORIZON.to}T00:00:00Z`),
      } });
      scheduleRunIds.push(run.id);
      scheduleRunId = run.id;
    }
    await prisma.assignment.update({ where: { id: assignmentId }, data: {
      status: AssignmentStatus.PUBLISHED, publishedAt, scheduleRunId,
    } });
    const result = await request(http).get(`/api/employees/${supervisorId}/assignments`)
      .set(auth(adminToken));
    expect(result.body.items).toEqual([]);
    expect(result.body.total).toBe(0);
  });

  it.each([
    ['2026-09-08T23:59:59.999Z', 0],
    ['2026-09-09T00:00:00.000Z', 1],
    ['2026-09-09T23:59:59.999Z', 1],
    ['2026-09-10T00:00:00.000Z', 0],
  ])('filters the entire inclusive day at the timestamp boundary %s', async (plannedStart, count) => {
    const assignmentId = await assignCrew(await makeVisit());
    await publish(assignmentId);
    // Fixture timestamps isolate the read filter from working-hour eligibility.
    await prisma.assignment.update({ where: { id: assignmentId }, data: {
      plannedStart: new Date(plannedStart),
      plannedEnd: new Date(new Date(plannedStart).getTime() + 60_000),
    } });
    const result = await request(http).get(`/api/employees/${supervisorId}/assignments`)
      .set(auth(adminToken)).query({ from: VISIT_DATE, to: VISIT_DATE });
    expect(result.status).toBe(200);
    expect(result.body.items).toHaveLength(count);
    expect(result.body.total).toBe(count);
  });

  it('uses the published planned date after the mutable visit date changes, with inclusive bounds', async () => {
    const visitId = await makeVisit();
    const assignmentId = await assignCrew(visitId);
    await publish(assignmentId);
    await prisma.generatedVisit.update({ where: { id: visitId }, data: {
      visitDate: new Date('2026-09-16T00:00:00Z'),
    } });
    const result = await request(http).get(`/api/employees/${technicianId}/assignments`)
      .set(auth(managerToken)).query({ from: VISIT_DATE, to: VISIT_DATE });
    expect(result.body.items).toHaveLength(1);
    expect(result.body.items[0]).toMatchObject({ assignmentId, visitDate: VISIT_DATE,
      role: 'TECHNICIAN', isPmsSupervisor: false, plannedStartMinute: 540, plannedEndMinute: 690 });
    const nextDay = await request(http).get(`/api/employees/${technicianId}/assignments`)
      .set(auth(managerToken)).query({ from: '2026-09-10', to: '2026-09-16' });
    expect(nextDay.body.items).toEqual([]);
  });

  it('is empty for a draft crew — nothing has been published yet', async () => {
    const visitId = await makeVisit();
    await assignCrew(visitId);

    const res = await request(http)
      .get(`/api/employees/${supervisorId}/assignments`)
      .set(auth(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });

  it('lists a published assignment once the schedule is published, and writes the outbox', async () => {
    const visitId = await makeVisit();
    const assignmentId = await assignCrew(visitId);
    await publish(assignmentId);

    const res = await request(http)
      .get(`/api/employees/${supervisorId}/assignments`)
      .set(auth(adminToken))
      .query({ from: HORIZON.from, to: HORIZON.to });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const item = res.body.items[0];
    expect(item.assignmentId).toBe(assignmentId);
    expect(item.visitDate).toBe(VISIT_DATE);
    expect(item.isPmsSupervisor).toBe(true);
    const saved = await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
    expect(item).toMatchObject({
      status: 'PUBLISHED', scheduleRunId: saved.scheduleRunId,
      publishedAt: saved.publishedAt!.toISOString(),
      instructions: `C07 instructions ${suffix}`,
      supervisorEmployeeId: supervisorId, supervisorName: `C07 Supervisor ${suffix}`,
      crew: [
        { employeeId: supervisorId, fullName: `C07 Supervisor ${suffix}`, role: 'SUPERVISOR', isPmsSupervisor: true },
        { employeeId: technicianId, fullName: `C07 Technician ${suffix}`, role: 'TECHNICIAN', isPmsSupervisor: false },
      ],
      vehicles: [{ vehicleId, label: `C07 Van ${suffix}`, driverEmployeeId: supervisorId, driverName: `C07 Supervisor ${suffix}` }],
    });
    // Phase 2 hooks — nothing writes these in Phase 1.
    expect(item.acknowledgedAt).toBeNull();
    expect(item.startedAt).toBeNull();
    expect(item.completedAt).toBeNull();

    // The outbox row publishing is supposed to write, one per crew member.
    const outbox = await prisma.assignmentNotificationOutbox.findMany({
      where: { assignmentId },
    });
    expect(outbox).toHaveLength(2);
    expect(outbox.every((row) => row.eventType === 'assignment.published')).toBe(true);
    expect(outbox.some((row) => row.employeeId === supervisorId)).toBe(true);
    const payload = outbox.find((row) => row.employeeId === supervisorId)?.payload as {
      visitId: string;
    };
    expect(payload.visitId).toBe(visitId);

    // Acknowledgement is a state after publication, not a reason to make the
    // job disappear from the employee's daily list.
    await prisma.assignment.update({
      where: { id: assignmentId },
      data: {
        status: AssignmentStatus.ACKNOWLEDGED,
        acknowledgedAt: new Date(),
      },
    });
    const acknowledged = await request(http)
      .get(`/api/employees/${supervisorId}/assignments`)
      .set(auth(adminToken))
      .query({ from: HORIZON.from, to: HORIZON.to });
    expect(
      acknowledged.body.items.some(
        (entry: { assignmentId: string }) => entry.assignmentId === assignmentId,
      ),
    ).toBe(true);
    await prisma.assignment.update({ where: { id: assignmentId }, data: {
      status: AssignmentStatus.COMPLETED, completedAt: new Date(),
    } });
    const completed = await request(http).get(`/api/employees/${supervisorId}/assignments`)
      .set(auth(adminToken));
    expect(completed.body.items[0].status).toBe('COMPLETED');
    expect(completed.body.items[0].completedAt).not.toBeNull();
  });

  it('allows only one of two concurrent publish attempts to create notifications', async () => {
    const visitId = await makeVisit();
    const assignmentId = await assignCrew(visitId);
    const run = await prisma.scheduleRun.create({
      data: {
        status: ScheduleRunStatus.SUCCEEDED,
        rangeStart: new Date(`${HORIZON.from}T00:00:00.000Z`),
        rangeEnd: new Date(`${HORIZON.to}T00:00:00.000Z`),
        finishedAt: new Date(),
      },
    });
    scheduleRunIds.push(run.id);
    await prisma.assignment.update({
      where: { id: assignmentId },
      data: { scheduleRunId: run.id },
    });

    const results = await Promise.all([
      request(http).post(`/api/schedule-runs/${run.id}/publish`).set(auth(adminToken)).send({}),
      request(http).post(`/api/schedule-runs/${run.id}/publish`).set(auth(adminToken)).send({}),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);

    const outbox = await prisma.assignmentNotificationOutbox.findMany({
      where: { assignmentId },
    });
    expect(outbox).toHaveLength(2);
  });

  it('rejects a reversed assignment date range', async () => {
    const res = await request(http)
      .get(`/api/employees/${supervisorId}/assignments`)
      .set(auth(adminToken))
      .query({ from: HORIZON.to, to: HORIZON.from });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('404s for an employee that does not exist', async () => {
    const res = await request(http)
      .get('/api/employees/00000000-0000-0000-0000-000000000000/assignments')
      .set(auth(adminToken));
    expect(res.status).toBe(404);
  });
});

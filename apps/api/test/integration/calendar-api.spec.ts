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

const prisma = new PrismaClient();

const suffix = Math.random().toString(36).slice(2, 8);
const ADMIN = { email: `c07-admin-${suffix}@ultrakil.test`, password: 'c07-admin-password' };

let app: INestApplication;
let http: string;
let adminToken: string;
let jobTypeId: string;
let siteId: string;
let supervisorId: string;
let technicianId: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const HORIZON = { from: '2026-09-07', to: '2026-09-13' }; // one week, Mon-Sun
const VISIT_DATE = '2026-09-09'; // the Wednesday in that week

async function login(email: string, password: string): Promise<string> {
  const res = await request(http).post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
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

  const generated = await request(http)
    .post('/api/visit-generation/confirm')
    .set(auth(adminToken))
    .send({ ...HORIZON, serviceAgreementIds: [agreement.body.id] });
  expect(generated.status).toBe(200);

  const listed = await request(http)
    .get('/api/visits')
    .set(auth(adminToken))
    .query({ serviceAgreementId: agreement.body.id });
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
    });
  expect(res.status).toBe(200);
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
  await prisma.assignment.update({ where: { id: assignmentId }, data: { scheduleRunId: run.id } });

  const published = await request(http)
    .post(`/api/schedule-runs/${run.id}/publish`)
    .set(auth(adminToken))
    .send({});
  expect(published.status).toBe(200);
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

  await prisma.$connect();
  for (const code of [BranchCode.COLOMBO, BranchCode.KANDY]) {
    await prisma.branch.upsert({
      where: { code },
      create: { code, name: `${code} Branch` },
      update: {},
    });
  }
  await prisma.user.upsert({
    where: { email: ADMIN.email },
    create: {
      email: ADMIN.email,
      fullName: `C07 ${UserRole.ADMIN}`,
      role: UserRole.ADMIN,
      passwordHash: await AuthService.hashPassword(ADMIN.password),
    },
    update: { role: UserRole.ADMIN, isActive: true },
  });
  adminToken = await login(ADMIN.email, ADMIN.password);

  const colombo = await prisma.branch.findUniqueOrThrow({ where: { code: BranchCode.COLOMBO } });

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

  const jobType = await request(http)
    .post('/api/job-types')
    .set(auth(adminToken))
    .send({ code: `C07_${suffix}`, name: 'C07 Job', defaultCrewSize: 2 });
  jobTypeId = jobType.body.id;

  const customer = await request(http)
    .post('/api/customers')
    .set(auth(adminToken))
    .send({ name: `C07 Customer ${suffix}`, branchCode: BranchCode.COLOMBO });

  const site = await request(http)
    .post(`/api/customers/${customer.body.id}/sites`)
    .set(auth(adminToken))
    .send({
      name: `C07 Site ${suffix}`,
      operatingHours: [
        { weekday: Weekday.WEDNESDAY, opensAtMinute: 540, closesAtMinute: 1020 },
      ],
    });
  siteId = site.body.id;
});

afterAll(async () => {
  const ids = [supervisorId, technicianId];
  await prisma.assignmentNotificationOutbox.deleteMany({ where: { employeeId: { in: ids } } });
  await prisma.assignment.deleteMany({ where: { crewMembers: { some: { employeeId: { in: ids } } } } });
  await prisma.serviceAgreement.deleteMany({ where: { serviceSite: { customer: { name: { startsWith: 'C07 Customer' } } } } });
  await prisma.serviceSite.deleteMany({ where: { customer: { name: { startsWith: 'C07 Customer' } } } });
  await prisma.customer.deleteMany({ where: { name: { startsWith: 'C07 Customer' } } });
  await prisma.jobType.deleteMany({ where: { code: { startsWith: 'C07_' } } });
  await prisma.employee.deleteMany({ where: { sourceKey: { contains: suffix } } });
  await prisma.user.deleteMany({ where: { email: ADMIN.email } });
  await prisma.$disconnect();
  await app.close();
});

describe('unified calendar', () => {
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

  it('joins date, time, crew, supervisor and vehicle onto one row', async () => {
    const visitId = await makeVisit();
    await assignCrew(visitId);

    const res = await request(http)
      .get('/api/schedule/calendar')
      .set(auth(adminToken))
      .query({ from: HORIZON.from, to: HORIZON.to, branchCode: BranchCode.COLOMBO });

    expect(res.status).toBe(200);
    const entry = res.body.items.find((item: { visitId: string }) => item.visitId === visitId);
    expect(entry).toBeDefined();
    expect(entry.visitDate).toBe(VISIT_DATE);
    expect(entry.instructions).toBe(`C07 instructions ${suffix}`);
    expect(entry.assignment).not.toBeNull();
    expect(entry.assignment.status).toBe('DRAFT');
    expect(entry.assignment.supervisorEmployeeId).toBe(supervisorId);
    expect(entry.assignment.crew).toHaveLength(2);
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
});

describe('employee published assignments', () => {
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
  });

  it('404s for an employee that does not exist', async () => {
    const res = await request(http)
      .get('/api/employees/00000000-0000-0000-0000-000000000000/assignments')
      .set(auth(adminToken));
    expect(res.status).toBe(404);
  });
});

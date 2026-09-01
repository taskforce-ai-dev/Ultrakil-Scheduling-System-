/**
 * ULK-C05 API tests.
 *
 * The unit tests in `rules.spec.ts` prove the judgements. These prove the
 * things only a real database can: that the engine cannot be bypassed by an
 * ordinary API call, that a refusal actually lands in the Unassigned queue,
 * and that double-booking is caught across two separate assignments.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BranchCode, PrismaClient, UserRole, Weekday } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';

const prisma = new PrismaClient();

const suffix = Math.random().toString(36).slice(2, 8);
const ADMIN = { email: `c05-admin-${suffix}@ultrakil.test`, password: 'c05-admin-password' };
const MANAGER = { email: `c05-mgr-${suffix}@ultrakil.test`, password: 'c05-manager-password' };

let app: INestApplication;
let http: string;
let adminToken: string;
let managerToken: string;
let jobTypeId: string;
let siteId: string;
let supervisorId: string;
let technicianId: string;
let vehicleId: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const HORIZON = { from: '2026-09-07', to: '2026-09-13' }; // one week, Mon-Sun

async function login(email: string, password: string): Promise<string> {
  const res = await request(http).post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

/** An agreement with one Wednesday visit generated, and that visit's id. */
async function visitForAssignment(): Promise<string> {
  const agreement = await request(http)
    .post('/api/service-agreements')
    .set(auth(adminToken))
    .send({
      serviceSiteId: siteId,
      jobTypeId,
      frequencyCount: 1,
      frequencyUnit: 'WEEK',
      allowedDays: [Weekday.WEDNESDAY],
      startDate: '2026-09-07',
      durationMinutes: 90,
      crewSize: 2,
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

const goodCrew = () => ({
  plannedStartMinute: 9 * 60,
  plannedEndMinute: 11 * 60,
  crew: [
    { employeeId: supervisorId, role: 'SUPERVISOR' },
    { employeeId: technicianId, role: 'TECHNICIAN' },
  ],
});

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
  for (const [creds, role] of [
    [ADMIN, UserRole.ADMIN],
    [MANAGER, UserRole.MANAGER],
  ] as const) {
    await prisma.user.upsert({
      where: { email: creds.email },
      create: {
        email: creds.email,
        fullName: `C05 ${role}`,
        role,
        passwordHash: await AuthService.hashPassword(creds.password),
      },
      update: { role, isActive: true },
    });
  }
  adminToken = await login(ADMIN.email, ADMIN.password);
  managerToken = await login(MANAGER.email, MANAGER.password);

  const colombo = await prisma.branch.findUniqueOrThrow({ where: { code: BranchCode.COLOMBO } });

  const supervisor = await prisma.employee.create({
    data: {
      sourceKey: `c05-sup-${suffix}`,
      fullName: `C05 Supervisor ${suffix}`,
      gradeLabel: 'PMS',
      isPmsGrade: true,
      branchId: colombo.id,
      branchCode: BranchCode.COLOMBO,
    },
  });
  supervisorId = supervisor.id;

  const technician = await prisma.employee.create({
    data: {
      sourceKey: `c05-tech-${suffix}`,
      fullName: `C05 Technician ${suffix}`,
      gradeLabel: 'Junior PMT',
      branchId: colombo.id,
      branchCode: BranchCode.COLOMBO,
    },
  });
  technicianId = technician.id;

  const vehicle = await prisma.vehicle.create({
    data: {
      code: `C05-VAN-${suffix}`,
      label: `C05 Van ${suffix}`,
      seatCapacity: 4,
      branchId: colombo.id,
    },
  });
  vehicleId = vehicle.id;

  const jobType = await request(http)
    .post('/api/job-types')
    .set(auth(adminToken))
    .send({ code: `C05_${suffix}`, name: 'C05 Job', defaultCrewSize: 2 });
  jobTypeId = jobType.body.id;

  const customer = await request(http)
    .post('/api/customers')
    .set(auth(adminToken))
    .send({ name: `C05 Customer ${suffix}`, branchCode: BranchCode.COLOMBO });

  const site = await request(http)
    .post(`/api/customers/${customer.body.id}/sites`)
    .set(auth(adminToken))
    .send({
      name: `C05 Site ${suffix}`,
      operatingHours: [Weekday.WEDNESDAY].map((weekday) => ({
        weekday,
        opensAtMinute: 540,
        closesAtMinute: 1020,
      })),
    });
  siteId = site.body.id;
});

/**
 * Every test in this file books the same two people on the same Wednesday, so
 * without this the second test would be told — correctly — that the crew is
 * already out on the first test's visit. Clearing between tests keeps each
 * one's intent readable; the double-booking rule gets its own tests below.
 */
beforeEach(async () => {
  await prisma.assignment.deleteMany({
    where: { crewMembers: { some: { employeeId: { in: [supervisorId, technicianId] } } } },
  });
});

afterAll(async () => {
  // Crew rows restrict deletion of an employee, so the assignments have to go
  // first — otherwise cleanup throws and Jest hangs instead of exiting.
  await prisma.assignment.deleteMany({
    where: { crewMembers: { some: { employeeId: { in: [supervisorId, technicianId] } } } },
  });
  await prisma.employee.deleteMany({ where: { sourceKey: { contains: suffix } } });
  await prisma.vehicle.deleteMany({ where: { code: { contains: suffix } } });
  await prisma.user.deleteMany({ where: { email: { in: [ADMIN.email, MANAGER.email] } } });
  await prisma.$disconnect();
  await app.close();
});

describe('authorization', () => {
  it('refuses an anonymous caller', async () => {
    const visitId = await visitForAssignment();
    const res = await request(http).put(`/api/visits/${visitId}/assignment`).send(goodCrew());

    expect(res.status).toBe(401);
  });

  it('lets a manager check but not assign', async () => {
    const visitId = await visitForAssignment();

    const check = await request(http)
      .post(`/api/visits/${visitId}/assignment/check`)
      .set(auth(managerToken))
      .send(goodCrew());
    expect(check.status).toBe(200);

    const assign = await request(http)
      .put(`/api/visits/${visitId}/assignment`)
      .set(auth(managerToken))
      .send(goodCrew());
    expect(assign.status).toBe(403);
  });
});

describe('checking writes nothing', () => {
  it('reports eligibility without creating an assignment', async () => {
    const visitId = await visitForAssignment();

    const res = await request(http)
      .post(`/api/visits/${visitId}/assignment/check`)
      .set(auth(adminToken))
      .send(goodCrew());

    expect(res.status).toBe(200);
    expect(res.body.isEligible).toBe(true);
    expect(await prisma.assignment.count({ where: { generatedVisitId: visitId } })).toBe(0);
  });
});

describe('assigning a crew', () => {
  it('records the crew, the supervisor flag and the audit entry', async () => {
    const visitId = await visitForAssignment();

    const res = await request(http)
      .put(`/api/visits/${visitId}/assignment`)
      .set(auth(adminToken))
      .send(goodCrew());

    expect(res.status).toBe(200);
    expect(res.body.crew).toHaveLength(2);
    expect(res.body.crew.some((member: { isPmsSupervisor: boolean }) => member.isPmsSupervisor)).toBe(true);

    const visit = await prisma.generatedVisit.findUniqueOrThrow({ where: { id: visitId } });
    expect(visit.status).toBe('SCHEDULED');

    const event = await prisma.auditEvent.findFirst({
      where: { entityId: res.body.id, action: 'assignment.created' },
    });
    expect(event).not.toBeNull();
  });

  it('accepts a vehicle with an authorized driver in the crew', async () => {
    const visitId = await visitForAssignment();
    await prisma.vehicleAuthorization.upsert({
      where: { employeeId_vehicleId: { employeeId: supervisorId, vehicleId } },
      create: { employeeId: supervisorId, vehicleId },
      update: {},
    });

    const res = await request(http)
      .put(`/api/visits/${visitId}/assignment`)
      .set(auth(adminToken))
      .send({
        ...goodCrew(),
        vehicles: [{ vehicleId, driverEmployeeId: supervisorId }],
      });

    expect(res.status).toBe(200);
    expect(res.body.vehicles[0].driverEmployeeId).toBe(supervisorId);
  });

  it('takes a crew off again and returns the visit to the queue', async () => {
    const visitId = await visitForAssignment();
    await request(http)
      .put(`/api/visits/${visitId}/assignment`)
      .set(auth(adminToken))
      .send(goodCrew());

    const res = await request(http)
      .delete(`/api/visits/${visitId}/assignment`)
      .set(auth(adminToken));

    expect(res.status).toBe(204);
    const visit = await prisma.generatedVisit.findUniqueOrThrow({ where: { id: visitId } });
    expect(visit.status).toBe('UNASSIGNED');
  });
});

describe('the engine cannot be bypassed', () => {
  it('refuses an ineligible crew and lists every reason', async () => {
    const visitId = await visitForAssignment();

    // One technician, no supervisor, and too few for the crew size.
    const res = await request(http)
      .put(`/api/visits/${visitId}/assignment`)
      .set(auth(adminToken))
      .send({
        plannedStartMinute: 9 * 60,
        plannedEndMinute: 11 * 60,
        crew: [{ employeeId: technicianId, role: 'TECHNICIAN' }],
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ASSIGNMENT_NOT_ELIGIBLE');
    const codes = res.body.details.conflicts.map((c: { code: string }) => c.code);
    expect(codes).toContain('CREW_TOO_SMALL');
    expect(codes).toContain('NO_PMS_SUPERVISOR_AVAILABLE');

    // And nothing was written.
    expect(await prisma.assignment.count({ where: { generatedVisitId: visitId } })).toBe(0);
  });

  it('puts the refused visit in the Unassigned queue with its reasons', async () => {
    const visitId = await visitForAssignment();
    await request(http)
      .put(`/api/visits/${visitId}/assignment`)
      .set(auth(adminToken))
      .send({
        plannedStartMinute: 9 * 60,
        plannedEndMinute: 11 * 60,
        crew: [{ employeeId: technicianId, role: 'TECHNICIAN' }],
      });

    const queue = await request(http)
      .get('/api/unassigned-visits')
      .set(auth(managerToken))
      .query({ from: HORIZON.from, to: HORIZON.to });

    expect(queue.status).toBe(200);
    const entry = queue.body.items.find(
      (item: { visitId: string }) => item.visitId === visitId,
    );
    expect(entry).toBeDefined();
    expect(entry.conflicts.length).toBeGreaterThan(1);
    // The way out is carried through to the queue, not just the error.
    expect(entry.conflicts[0].remediation).not.toBe('');
  });

  it('clears the queue entry once the visit is properly staffed', async () => {
    const visitId = await visitForAssignment();
    await request(http)
      .put(`/api/visits/${visitId}/assignment`)
      .set(auth(adminToken))
      .send({
        plannedStartMinute: 9 * 60,
        plannedEndMinute: 11 * 60,
        crew: [{ employeeId: technicianId, role: 'TECHNICIAN' }],
      });
    expect(
      await prisma.visitUnassignedReason.count({ where: { generatedVisitId: visitId } }),
    ).toBeGreaterThan(0);

    await request(http)
      .put(`/api/visits/${visitId}/assignment`)
      .set(auth(adminToken))
      .send(goodCrew());

    expect(
      await prisma.visitUnassignedReason.count({ where: { generatedVisitId: visitId } }),
    ).toBe(0);
  });
});

describe('a rejected replacement', () => {
  it('leaves the existing crew in place and keeps the visit out of the queue', async () => {
    const visitId = await visitForAssignment();
    await request(http)
      .put(`/api/visits/${visitId}/assignment`)
      .set(auth(adminToken))
      .send(goodCrew());

    // Now try to replace it with a crew that cannot take the job.
    const res = await request(http)
      .put(`/api/visits/${visitId}/assignment`)
      .set(auth(adminToken))
      .send({
        plannedStartMinute: 9 * 60,
        plannedEndMinute: 11 * 60,
        crew: [{ employeeId: technicianId, role: 'TECHNICIAN' }],
      });

    expect(res.status).toBe(409);

    // The good crew is still on the visit, and it is still SCHEDULED — a
    // refused change must never unstaff work that was already fine.
    const visit = await prisma.generatedVisit.findUniqueOrThrow({ where: { id: visitId } });
    expect(visit.status).toBe('SCHEDULED');
    expect(await prisma.assignment.count({ where: { generatedVisitId: visitId } })).toBe(1);
    expect(
      await prisma.visitUnassignedReason.count({ where: { generatedVisitId: visitId } }),
    ).toBe(0);
  });
});

describe('double booking across two visits', () => {
  it('refuses the same crew on two overlapping visits on one day', async () => {
    const first = await visitForAssignment();
    const second = await visitForAssignment();

    const one = await request(http)
      .put(`/api/visits/${first}/assignment`)
      .set(auth(adminToken))
      .send(goodCrew());
    expect(one.status).toBe(200);

    const two = await request(http)
      .put(`/api/visits/${second}/assignment`)
      .set(auth(adminToken))
      .send(goodCrew());

    expect(two.status).toBe(409);
    const codes = two.body.details.conflicts.map((c: { code: string }) => c.code);
    expect(codes).toContain('EMPLOYEE_DOUBLE_BOOKED');
  });

  it('allows the same crew on two visits that do not overlap', async () => {
    const first = await visitForAssignment();
    const second = await visitForAssignment();

    await request(http)
      .put(`/api/visits/${first}/assignment`)
      .set(auth(adminToken))
      .send({ ...goodCrew(), plannedStartMinute: 9 * 60, plannedEndMinute: 11 * 60 });

    const two = await request(http)
      .put(`/api/visits/${second}/assignment`)
      .set(auth(adminToken))
      .send({ ...goodCrew(), plannedStartMinute: 13 * 60, plannedEndMinute: 15 * 60 });

    expect(two.status).toBe(200);
  });

  it('does not report a crew as clashing with its own existing assignment', async () => {
    const visitId = await visitForAssignment();
    await request(http)
      .put(`/api/visits/${visitId}/assignment`)
      .set(auth(adminToken))
      .send(goodCrew());

    // Re-assigning the same crew to the same visit must not see itself.
    const again = await request(http)
      .put(`/api/visits/${visitId}/assignment`)
      .set(auth(adminToken))
      .send(goodCrew());

    expect(again.status).toBe(200);
  });
});

describe('determinism against the database', () => {
  it('returns the same conflicts for the same request twice', async () => {
    const visitId = await visitForAssignment();
    const body = {
      plannedStartMinute: 6 * 60,
      plannedEndMinute: 7 * 60,
      crew: [{ employeeId: technicianId, role: 'TECHNICIAN' }],
    };

    const first = await request(http)
      .post(`/api/visits/${visitId}/assignment/check`)
      .set(auth(adminToken))
      .send(body);
    const second = await request(http)
      .post(`/api/visits/${visitId}/assignment/check`)
      .set(auth(adminToken))
      .send(body);

    expect(first.body).toEqual(second.body);
    expect(first.body.conflicts.length).toBeGreaterThan(2);
  });
});

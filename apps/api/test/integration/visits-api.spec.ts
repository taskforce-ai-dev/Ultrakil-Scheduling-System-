/**
 * ULK-C04 — reading and hand-editing the generated calendar.
 *
 * Generation is only half the acceptance criterion; the other half is that a
 * manager can "later see exactly why each visit exists" and take a visit into
 * their own hands. Both need real rows: origin reads an agreement version
 * snapshot, and protection is only meaningful if a later generation run
 * actually honours it.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BranchCode, PrismaClient, UserRole, VisitStatus, Weekday } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';

const prisma = new PrismaClient();

const suffix = Math.random().toString(36).slice(2, 8);
const ADMIN = { email: `c04v-admin-${suffix}@ultrakil.test`, password: 'c04v-admin-password' };
const MANAGER = { email: `c04v-mgr-${suffix}@ultrakil.test`, password: 'c04v-manager-password' };

let app: INestApplication;
let http: string;
let adminToken: string;
let managerToken: string;
let jobTypeId: string;
let siteId: string;
let customerId: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** 2026-09-07 is a Monday; four whole weeks. */
const HORIZON = { from: '2026-09-07', to: '2026-10-04' };

async function login(email: string, password: string): Promise<string> {
  const res = await request(http).post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

/** An agreement with its four Wednesday visits already generated. */
async function agreementWithVisits(overrides: Record<string, unknown> = {}) {
  const created = await request(http)
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
      ...overrides,
    });
  expect(created.status).toBe(201);

  const generated = await request(http)
    .post('/api/visit-generation/confirm')
    .set(auth(adminToken))
    .send({ ...HORIZON, serviceAgreementIds: [created.body.id] });
  expect(generated.status).toBe(200);

  return created.body as { id: string };
}

const listVisits = (query: Record<string, unknown>) =>
  request(http).get('/api/visits').set(auth(managerToken)).query(query);

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
        fullName: `C04 visits ${role}`,
        role,
        passwordHash: await AuthService.hashPassword(creds.password),
      },
      update: { role, isActive: true },
    });
  }
  adminToken = await login(ADMIN.email, ADMIN.password);
  managerToken = await login(MANAGER.email, MANAGER.password);

  const jobType = await request(http)
    .post('/api/job-types')
    .set(auth(adminToken))
    .send({ code: `C04V_${suffix}`, name: 'C04 Visits Job', defaultCrewSize: 2 });
  jobTypeId = jobType.body.id;

  const customer = await request(http)
    .post('/api/customers')
    .set(auth(adminToken))
    .send({ name: `C04 Visits Customer ${suffix}`, branchCode: BranchCode.COLOMBO });
  customerId = customer.body.id;

  const site = await request(http)
    .post(`/api/customers/${customerId}/sites`)
    .set(auth(adminToken))
    .send({
      name: `C04 Visits Site ${suffix}`,
      operatingHours: [
        Weekday.MONDAY,
        Weekday.TUESDAY,
        Weekday.WEDNESDAY,
        Weekday.THURSDAY,
        Weekday.FRIDAY,
      ].map((weekday) => ({ weekday, opensAtMinute: 540, closesAtMinute: 1020 })),
    });
  siteId = site.body.id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: [ADMIN.email, MANAGER.email] } } });
  await prisma.$disconnect();
  await app.close();
});

describe('authorization', () => {
  it('refuses an anonymous caller', async () => {
    const res = await request(http).get('/api/visits');

    expect(res.status).toBe(401);
  });

  it('lets a manager read the calendar but not change it', async () => {
    const agreement = await agreementWithVisits();
    const listed = await listVisits({ serviceAgreementId: agreement.id });
    expect(listed.status).toBe(200);

    const visitId = listed.body.items[0].id;
    const edit = await request(http)
      .patch(`/api/visits/${visitId}`)
      .set(auth(managerToken))
      .send({ durationMinutes: 30 });

    expect(edit.status).toBe(403);
    expect(edit.body.code).toBe('INSUFFICIENT_ROLE');
  });
});

describe('listing the calendar', () => {
  it('returns the four generated visits in date order', async () => {
    const agreement = await agreementWithVisits();

    const res = await listVisits({ serviceAgreementId: agreement.id });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    const dates = res.body.items.map((v: { visitDate: string }) => v.visitDate);
    expect(dates).toEqual([...dates].sort());
    expect(res.body.items[0]).toMatchObject({
      branchCode: BranchCode.COLOMBO,
      jobTypeName: 'C04 Visits Job',
      hoursUnconfirmed: false,
      isProtected: false,
      protectionReason: null,
      manuallyAdjustedAt: null,
      assignmentCount: 0,
    });
    expect(res.body.items[0].customerName).toContain('C04 Visits Customer');
  });

  it('narrows to a date range', async () => {
    const agreement = await agreementWithVisits();

    const res = await listVisits({
      serviceAgreementId: agreement.id,
      from: '2026-09-07',
      to: '2026-09-20',
    });

    expect(res.body.total).toBe(2);
  });

  it('finds visits by customer and by name', async () => {
    const agreement = await agreementWithVisits();

    const byCustomer = await listVisits({ serviceAgreementId: agreement.id, customerId });
    expect(byCustomer.body.total).toBe(4);

    const bySearch = await listVisits({
      serviceAgreementId: agreement.id,
      search: `Visits Customer ${suffix}`,
    });
    expect(bySearch.body.total).toBe(4);

    const noMatch = await listVisits({
      serviceAgreementId: agreement.id,
      search: 'a customer that does not exist',
    });
    expect(noMatch.body.total).toBe(0);
  });

  it('narrows by job type', async () => {
    const agreement = await agreementWithVisits();

    const match = await listVisits({ serviceAgreementId: agreement.id, jobTypeId });
    expect(match.body.total).toBe(4);

    const otherJobType = await request(http)
      .post('/api/job-types')
      .set(auth(adminToken))
      .send({ code: `C04V_OTHER_${suffix}`, name: 'Other Job', defaultCrewSize: 1 });

    const noMatch = await listVisits({
      serviceAgreementId: agreement.id,
      jobTypeId: otherJobType.body.id,
    });
    expect(noMatch.body.total).toBe(0);
  });

  it('applies customer and job type together rather than only the last one', async () => {
    const agreement = await agreementWithVisits();

    const otherJobType = await request(http)
      .post('/api/job-types')
      .set(auth(adminToken))
      .send({ code: `C04V_BOTH_${suffix}`, name: 'Both Job', defaultCrewSize: 1 });

    // The customer matches but the job type does not. If the two filters
    // overwrote each other this would wrongly return all four visits.
    const res = await listVisits({
      serviceAgreementId: agreement.id,
      customerId,
      jobTypeId: otherJobType.body.id,
    });

    expect(res.body.total).toBe(0);
  });

  it('excludes the other branch', async () => {
    const agreement = await agreementWithVisits();

    const res = await listVisits({
      serviceAgreementId: agreement.id,
      branchCode: BranchCode.KANDY,
    });

    expect(res.body.total).toBe(0);
  });

  it('pages', async () => {
    const agreement = await agreementWithVisits();

    const first = await listVisits({ serviceAgreementId: agreement.id, page: 1, pageSize: 3 });
    const second = await listVisits({ serviceAgreementId: agreement.id, page: 2, pageSize: 3 });

    expect(first.body.items).toHaveLength(3);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.total).toBe(4);
  });

  it('shows only the visits a manager owns when asked', async () => {
    const agreement = await agreementWithVisits();
    const all = await listVisits({ serviceAgreementId: agreement.id });
    const pinned = all.body.items[0].id;

    await request(http)
      .post(`/api/visits/${pinned}/lock`)
      .set(auth(adminToken))
      .send({ reason: 'Customer confirmed this date' });

    const res = await listVisits({ serviceAgreementId: agreement.id, protectedOnly: true });

    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      id: pinned,
      isProtected: true,
      protectionReason: 'LOCKED',
      lockReason: 'Customer confirmed this date',
    });
  });
});

describe('why a visit exists', () => {
  it('explains it by the agreement version that produced it', async () => {
    const agreement = await agreementWithVisits({ frequencyInterval: 2 });
    const listed = await listVisits({ serviceAgreementId: agreement.id });

    const res = await request(http)
      .get(`/api/visits/${listed.body.items[0].id}`)
      .set(auth(managerToken));

    expect(res.status).toBe(200);
    expect(res.body.origin).toMatchObject({
      serviceAgreementId: agreement.id,
      jobTypeName: 'C04 Visits Job',
      agreementVersionNumber: 1,
      frequencyLabel: 'Fortnightly',
      allowedDaysAtGeneration: [Weekday.WEDNESDAY],
    });
    expect(res.body.origin.generatedByRunId).toBeTruthy();
  });

  it('still explains it by the old rules after the agreement changes', async () => {
    const agreement = await agreementWithVisits();
    const listed = await listVisits({ serviceAgreementId: agreement.id });
    const visitId = listed.body.items[0].id;

    // Pin it first, so regeneration cannot quietly replace the row we are
    // about to ask about.
    await request(http).post(`/api/visits/${visitId}/lock`).set(auth(adminToken)).send({});

    await request(http)
      .patch(`/api/service-agreements/${agreement.id}`)
      .set(auth(adminToken))
      .send({ allowedDays: [Weekday.FRIDAY], preferredDays: [] });

    const res = await request(http).get(`/api/visits/${visitId}`).set(auth(managerToken));

    // The agreement now says Friday, but this visit was made under Wednesday
    // and says so.
    expect(res.body.origin.allowedDaysAtGeneration).toEqual([Weekday.WEDNESDAY]);
  });

  it('404s on a visit that is gone', async () => {
    const res = await request(http)
      .get('/api/visits/8f1d2b4e-0000-4000-8000-000000000000')
      .set(auth(managerToken));

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('hand-editing a visit', () => {
  it('moves it and protects it from the next run', async () => {
    const agreement = await agreementWithVisits();
    const listed = await listVisits({ serviceAgreementId: agreement.id });
    const visit = listed.body.items[0];

    const edit = await request(http)
      .patch(`/api/visits/${visit.id}`)
      .set(auth(adminToken))
      .send({
        visitDate: '2026-09-10',
        windowStartMinute: 600,
        windowEndMinute: 780,
        reason: 'Customer asked for the Thursday',
      });

    expect(edit.status).toBe(200);
    expect(edit.body).toMatchObject({
      visitDate: '2026-09-10',
      windowStartMinute: 600,
      isManuallyAdjusted: true,
      isProtected: true,
      protectionReason: 'MANUALLY_ADJUSTED',
    });

    // The promise is only real if regeneration honours it.
    const regenerated = await request(http)
      .post('/api/visit-generation/confirm')
      .set(auth(adminToken))
      .send({ ...HORIZON, serviceAgreementIds: [agreement.id] });

    expect(regenerated.body.protectedVisits).toContainEqual(
      expect.objectContaining({ visitId: visit.id, protection: 'MANUALLY_ADJUSTED' }),
    );
    const after = await prisma.generatedVisit.findUniqueOrThrow({ where: { id: visit.id } });
    expect(after.windowStartMinute).toBe(600);
  });

  it('records who changed it and why', async () => {
    const agreement = await agreementWithVisits();
    const listed = await listVisits({ serviceAgreementId: agreement.id });
    const visitId = listed.body.items[0].id;

    await request(http)
      .patch(`/api/visits/${visitId}`)
      .set(auth(adminToken))
      .send({ durationMinutes: 45, reason: 'Half the treatment done last week' });

    const event = await prisma.auditEvent.findFirst({
      where: { entityId: visitId, action: 'visit.adjusted' },
    });
    expect(event).not.toBeNull();
    expect(event?.actorLabel).toContain(ADMIN.email);
  });

  it('refuses a window that ends before it starts', async () => {
    const agreement = await agreementWithVisits();
    const listed = await listVisits({ serviceAgreementId: agreement.id });

    const res = await request(http)
      .patch(`/api/visits/${listed.body.items[0].id}`)
      .set(auth(adminToken))
      .send({ windowStartMinute: 780, windowEndMinute: 600 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SERVICE_WINDOW_INVALID');
  });

  it('refuses a visit longer than its own window', async () => {
    const agreement = await agreementWithVisits();
    const listed = await listVisits({ serviceAgreementId: agreement.id });

    const res = await request(http)
      .patch(`/api/visits/${listed.body.items[0].id}`)
      .set(auth(adminToken))
      .send({ windowStartMinute: 540, windowEndMinute: 600, durationMinutes: 120 });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('does not fit');
  });

  it('will not rewrite a completed visit', async () => {
    const agreement = await agreementWithVisits();
    const listed = await listVisits({ serviceAgreementId: agreement.id });
    const visitId = listed.body.items[0].id;
    await prisma.generatedVisit.update({
      where: { id: visitId },
      data: { status: VisitStatus.COMPLETED },
    });

    const res = await request(http)
      .patch(`/api/visits/${visitId}`)
      .set(auth(adminToken))
      .send({ durationMinutes: 30 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RESOURCE_CONFLICT');
  });
});

describe('pinning a visit', () => {
  it('locks it, then hands it back', async () => {
    const agreement = await agreementWithVisits();
    const listed = await listVisits({ serviceAgreementId: agreement.id });
    const visitId = listed.body.items[0].id;

    const locked = await request(http)
      .post(`/api/visits/${visitId}/lock`)
      .set(auth(adminToken))
      .send({ reason: 'Promised on the phone' });

    expect(locked.status).toBe(200);
    expect(locked.body).toMatchObject({
      isLocked: true,
      lockReason: 'Promised on the phone',
      protectionReason: 'LOCKED',
    });

    const unlocked = await request(http)
      .post(`/api/visits/${visitId}/unlock`)
      .set(auth(adminToken))
      .send({});

    expect(unlocked.status).toBe(200);
    expect(unlocked.body).toMatchObject({
      isLocked: false,
      lockReason: null,
      isProtected: false,
    });
  });

  it('a released visit is generation-owned again', async () => {
    const agreement = await agreementWithVisits();
    const listed = await listVisits({ serviceAgreementId: agreement.id });
    const visitId = listed.body.items[0].id;

    await request(http).post(`/api/visits/${visitId}/lock`).set(auth(adminToken)).send({});
    await request(http).post(`/api/visits/${visitId}/unlock`).set(auth(adminToken)).send({});

    await request(http)
      .patch(`/api/service-agreements/${agreement.id}`)
      .set(auth(adminToken))
      .send({ crewSize: 6 });

    await request(http)
      .post('/api/visit-generation/confirm')
      .set(auth(adminToken))
      .send({ ...HORIZON, serviceAgreementIds: [agreement.id] });

    const after = await prisma.generatedVisit.findUniqueOrThrow({ where: { id: visitId } });
    expect(after.requiredCrewSize).toBe(6);
  });

  it('records the lock and the unlock', async () => {
    const agreement = await agreementWithVisits();
    const listed = await listVisits({ serviceAgreementId: agreement.id });
    const visitId = listed.body.items[0].id;

    await request(http).post(`/api/visits/${visitId}/lock`).set(auth(adminToken)).send({});
    await request(http).post(`/api/visits/${visitId}/unlock`).set(auth(adminToken)).send({});

    const actions = await prisma.auditEvent.findMany({
      where: { entityId: visitId, action: { in: ['visit.locked', 'visit.unlocked'] } },
      select: { action: true },
    });
    expect(actions.map((a) => a.action).sort()).toEqual(['visit.locked', 'visit.unlocked']);
  });
});

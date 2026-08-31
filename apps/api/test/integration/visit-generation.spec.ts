/**
 * ULK-C04 API tests.
 *
 * Generation's whole promise is that it never loses manager-controlled work,
 * and that promise only holds across real transactions against real rows —
 * which visits already exist, which are locked, what a second run does to a
 * calendar the first one built. None of that is observable from a unit test.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  BranchCode,
  PrismaClient,
  UserRole,
  VisitStatus,
  Weekday,
} from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';

const prisma = new PrismaClient();

const suffix = Math.random().toString(36).slice(2, 8);
const ADMIN = { email: `c04-admin-${suffix}@ultrakil.test`, password: 'c04-admin-password' };
const MANAGER = { email: `c04-mgr-${suffix}@ultrakil.test`, password: 'c04-manager-password' };

let app: INestApplication;
let http: string;
let adminToken: string;
let managerToken: string;
let jobTypeId: string;
let siteId: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** 2026-09-07 is a Monday, so weeks line up with the calendar. */
const HORIZON = { from: '2026-09-07', to: '2026-10-04' }; // four whole weeks

async function login(email: string, password: string): Promise<string> {
  const res = await request(http).post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function createAgreement(overrides: Record<string, unknown> = {}) {
  const res = await request(http)
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
  expect(res.status).toBe(201);
  return res.body;
}

const preview = (body: Record<string, unknown> = {}) =>
  request(http)
    .post('/api/visit-generation/preview')
    .set(auth(adminToken))
    .send({ ...HORIZON, ...body });

const confirm = (body: Record<string, unknown> = {}) =>
  request(http)
    .post('/api/visit-generation/confirm')
    .set(auth(adminToken))
    .send({ ...HORIZON, ...body });

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
        fullName: `C04 ${role}`,
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
    .send({ code: `C04_${suffix}`, name: 'C04 Job', defaultCrewSize: 2 });
  jobTypeId = jobType.body.id;

  const customer = await request(http)
    .post('/api/customers')
    .set(auth(adminToken))
    .send({ name: `C04 Customer ${suffix}`, branchCode: BranchCode.COLOMBO });

  const site = await request(http)
    .post(`/api/customers/${customer.body.id}/sites`)
    .set(auth(adminToken))
    .send({
      name: `C04 Site ${suffix}`,
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
    const res = await request(http).post('/api/visit-generation/preview').send(HORIZON);

    expect(res.status).toBe(401);
  });

  it('lets a manager preview but not confirm', async () => {
    const canPreview = await request(http)
      .post('/api/visit-generation/preview')
      .set(auth(managerToken))
      .send(HORIZON);
    expect(canPreview.status).toBe(200);

    const cannotConfirm = await request(http)
      .post('/api/visit-generation/confirm')
      .set(auth(managerToken))
      .send(HORIZON);
    expect(cannotConfirm.status).toBe(403);
    expect(cannotConfirm.body.code).toBe('INSUFFICIENT_ROLE');
  });
});

describe('the horizon', () => {
  it('refuses a range that ends before it starts', async () => {
    const res = await preview({ from: '2026-10-04', to: '2026-09-07' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AGREEMENT_DATES_INVALID');
  });

  it('refuses a range longer than a year', async () => {
    const res = await preview({ from: '2026-01-01', to: '2027-06-01' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('at most a year');
  });

  it('never places a visit outside the horizon', async () => {
    const agreement = await createAgreement();
    const res = await preview({ serviceAgreementIds: [agreement.id] });

    for (const visit of res.body.additions) {
      expect(visit.visitDate >= HORIZON.from).toBe(true);
      expect(visit.visitDate <= HORIZON.to).toBe(true);
    }
  });
});

describe('preview writes nothing', () => {
  it('proposes visits without creating them', async () => {
    const agreement = await createAgreement();

    const res = await preview({ serviceAgreementIds: [agreement.id] });
    expect(res.status).toBe(200);
    expect(res.body.isPreview).toBe(true);
    expect(res.body.additions.length).toBeGreaterThan(0);
    expect(res.body.scheduleRunId).toBeNull();

    const stored = await prisma.generatedVisit.count({
      where: { serviceAgreementId: agreement.id },
    });
    expect(stored).toBe(0);
  });
});

describe('generation and idempotency', () => {
  it('creates one visit a week across four weeks', async () => {
    const agreement = await createAgreement();

    const res = await confirm({ serviceAgreementIds: [agreement.id] });
    expect(res.status).toBe(200);
    expect(res.body.additions).toHaveLength(4);
    expect(res.body.scheduleRunId).toBeTruthy();

    const stored = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: agreement.id },
      orderBy: { visitDate: 'asc' },
    });
    expect(stored).toHaveLength(4);
    // Every one a Wednesday, the only allowed day.
    for (const visit of stored) expect(visit.visitDate.getUTCDay()).toBe(3);
  });

  it('the same request twice creates no duplicates', async () => {
    const agreement = await createAgreement();

    await confirm({ serviceAgreementIds: [agreement.id] });
    const second = await confirm({ serviceAgreementIds: [agreement.id] });

    expect(second.body.additions).toEqual([]);
    expect(second.body.updates).toEqual([]);
    expect(second.body.removals).toEqual([]);
    expect(second.body.unchangedCount).toBe(4);

    const stored = await prisma.generatedVisit.count({
      where: { serviceAgreementId: agreement.id },
    });
    expect(stored).toBe(4);
  });

  it('records the agreement and its version on every visit', async () => {
    const agreement = await createAgreement();
    await confirm({ serviceAgreementIds: [agreement.id] });

    const visits = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: agreement.id },
      include: { agreementVersion: true },
    });

    for (const visit of visits) {
      expect(visit.serviceAgreementId).toBe(agreement.id);
      // Without this a schedule stops being explainable the moment the
      // agreement changes.
      expect(visit.agreementVersion?.versionNumber).toBe(1);
    }
  });

  it('generates monthly recurrence across a month boundary', async () => {
    const agreement = await createAgreement({
      frequencyCount: 1,
      frequencyUnit: 'MONTH',
      allowedDays: [Weekday.WEDNESDAY],
    });

    const res = await confirm({
      serviceAgreementIds: [agreement.id],
      from: '2026-09-01',
      to: '2026-11-30',
    });

    const months = new Set(res.body.additions.map((v: { visitDate: string }) => v.visitDate.slice(0, 7)));
    expect(months.size).toBeGreaterThanOrEqual(3);
  });

  it('honours a fortnightly cycle', async () => {
    const agreement = await createAgreement({
      frequencyCount: 1,
      frequencyUnit: 'WEEK',
      frequencyInterval: 2,
      allowedDays: [Weekday.WEDNESDAY],
    });

    const res = await confirm({ serviceAgreementIds: [agreement.id] });

    // Four weeks is two fortnights.
    expect(res.body.additions).toHaveLength(2);
  });
});

describe('agreement rules are respected', () => {
  it('generates nothing for a paused agreement', async () => {
    const agreement = await createAgreement();
    await request(http)
      .post(`/api/service-agreements/${agreement.id}/status`)
      .set(auth(adminToken))
      .send({ status: 'PAUSED' });

    const res = await confirm({ serviceAgreementIds: [agreement.id] });

    expect(res.body.agreementsConsidered).toBe(0);
    expect(res.body.additions).toEqual([]);
  });

  it('stops at the agreement end date', async () => {
    const agreement = await createAgreement({ endDate: '2026-09-20' });

    const res = await preview({ serviceAgreementIds: [agreement.id] });

    for (const visit of res.body.additions) {
      expect(visit.visitDate <= '2026-09-20').toBe(true);
    }
  });

  it('uses a preferred day when it can and an allowed day when it cannot', async () => {
    const agreement = await createAgreement({
      frequencyCount: 2,
      allowedDays: [Weekday.MONDAY, Weekday.WEDNESDAY],
      preferredDays: [Weekday.WEDNESDAY],
    });

    const res = await preview({ serviceAgreementIds: [agreement.id] });

    const preferred = res.body.additions.filter((v: { isPreferredDay: boolean }) => v.isPreferredDay);
    const merelyAllowed = res.body.additions.filter(
      (v: { isPreferredDay: boolean }) => !v.isPreferredDay,
    );
    // Two a week over four weeks: one Wednesday (preferred) and one Monday.
    expect(preferred.length).toBe(4);
    expect(merelyAllowed.length).toBe(4);
  });

  it('reports a period that cannot hold its promised visits', async () => {
    const agreement = await createAgreement({
      frequencyCount: 3,
      allowedDays: [Weekday.WEDNESDAY],
    });

    const res = await preview({ serviceAgreementIds: [agreement.id] });

    expect(res.body.shortfalls.length).toBeGreaterThan(0);
    expect(res.body.shortfalls[0]).toMatchObject({ requested: 3, scheduled: 1 });
    expect(res.body.shortfalls[0].customerName).toContain('C04 Customer');
  });

  it('filters by branch', async () => {
    const agreement = await createAgreement();

    const kandy = await preview({
      serviceAgreementIds: [agreement.id],
      branchCode: BranchCode.KANDY,
    });
    expect(kandy.body.agreementsConsidered).toBe(0);

    const colombo = await preview({
      serviceAgreementIds: [agreement.id],
      branchCode: BranchCode.COLOMBO,
    });
    expect(colombo.body.agreementsConsidered).toBe(1);
  });
});

describe('regeneration never loses manager-controlled work', () => {
  it('updates an untouched visit when the agreement changes', async () => {
    const agreement = await createAgreement();
    await confirm({ serviceAgreementIds: [agreement.id] });

    await request(http)
      .patch(`/api/service-agreements/${agreement.id}`)
      .set(auth(adminToken))
      .send({ crewSize: 5 });

    const res = await confirm({ serviceAgreementIds: [agreement.id] });

    expect(res.body.updates).toHaveLength(4);
    expect(res.body.updates[0].changes).toContainEqual({
      field: 'requiredCrewSize',
      from: '2',
      to: '5',
    });

    const stored = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: agreement.id },
    });
    for (const visit of stored) expect(visit.requiredCrewSize).toBe(5);
  });

  it('leaves a locked visit alone and reports it', async () => {
    const agreement = await createAgreement();
    await confirm({ serviceAgreementIds: [agreement.id] });

    const [locked] = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: agreement.id },
      orderBy: { visitDate: 'asc' },
      take: 1,
    });
    await prisma.generatedVisit.update({
      where: { id: locked.id },
      data: { lockedAt: new Date(), lockReason: 'Customer confirmed this date' },
    });

    await request(http)
      .patch(`/api/service-agreements/${agreement.id}`)
      .set(auth(adminToken))
      .send({ crewSize: 7 });

    const res = await confirm({ serviceAgreementIds: [agreement.id] });

    expect(res.body.protectedVisits).toContainEqual(
      expect.objectContaining({ visitId: locked.id, protection: 'LOCKED', wouldHave: 'UPDATE' }),
    );

    const after = await prisma.generatedVisit.findUniqueOrThrow({ where: { id: locked.id } });
    expect(after.requiredCrewSize).toBe(2); // untouched
  });

  it('leaves a hand-edited visit alone', async () => {
    const agreement = await createAgreement();
    await confirm({ serviceAgreementIds: [agreement.id] });

    const [edited] = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: agreement.id },
      take: 1,
    });
    await prisma.generatedVisit.update({
      where: { id: edited.id },
      data: { isManuallyAdjusted: true, manuallyAdjustedAt: new Date() },
    });

    await request(http)
      .patch(`/api/service-agreements/${agreement.id}`)
      .set(auth(adminToken))
      .send({ durationMinutes: 200 });

    const res = await confirm({ serviceAgreementIds: [agreement.id] });

    expect(res.body.protectedVisits).toContainEqual(
      expect.objectContaining({ visitId: edited.id, protection: 'MANUALLY_ADJUSTED' }),
    );
    const after = await prisma.generatedVisit.findUniqueOrThrow({ where: { id: edited.id } });
    expect(after.durationMinutes).toBe(90);
  });

  it('will not remove a scheduled visit the agreement no longer wants', async () => {
    const agreement = await createAgreement();
    await confirm({ serviceAgreementIds: [agreement.id] });

    const [kept] = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: agreement.id },
      take: 1,
    });
    await prisma.generatedVisit.update({
      where: { id: kept.id },
      data: { status: VisitStatus.SCHEDULED },
    });

    // Move the agreement to a weekday it never lands on, so every visit is
    // obsolete.
    await request(http)
      .patch(`/api/service-agreements/${agreement.id}`)
      .set(auth(adminToken))
      .send({ allowedDays: [Weekday.FRIDAY], preferredDays: [] });

    const res = await confirm({ serviceAgreementIds: [agreement.id] });

    expect(res.body.protectedVisits).toContainEqual(
      expect.objectContaining({
        visitId: kept.id,
        protection: 'ALREADY_SCHEDULED',
        wouldHave: 'REMOVE',
      }),
    );

    const survivor = await prisma.generatedVisit.findUnique({ where: { id: kept.id } });
    expect(survivor).not.toBeNull();
  });

  it('removes an untouched visit the agreement no longer wants, having said so', async () => {
    const agreement = await createAgreement();
    await confirm({ serviceAgreementIds: [agreement.id] });

    const before = await prisma.generatedVisit.count({
      where: { serviceAgreementId: agreement.id },
    });
    expect(before).toBe(4);

    await request(http)
      .patch(`/api/service-agreements/${agreement.id}`)
      .set(auth(adminToken))
      .send({ allowedDays: [Weekday.FRIDAY], preferredDays: [] });

    // Preview announces the removals first; confirm then applies them.
    const announced = await preview({ serviceAgreementIds: [agreement.id] });
    expect(announced.body.removals).toHaveLength(4);

    await confirm({ serviceAgreementIds: [agreement.id] });

    const remaining = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: agreement.id },
    });
    expect(remaining).toHaveLength(4);
    for (const visit of remaining) expect(visit.visitDate.getUTCDay()).toBe(5); // Friday
  });
});

describe('the run is recorded', () => {
  it('writes a schedule run and an audit entry', async () => {
    const agreement = await createAgreement();
    const res = await confirm({ serviceAgreementIds: [agreement.id] });

    const run = await prisma.scheduleRun.findUniqueOrThrow({
      where: { id: res.body.scheduleRunId },
    });
    expect(run.status).toBe('SUCCEEDED');
    expect(run.requestedByUserId).toBeTruthy();
    expect(run.finishedAt).not.toBeNull();

    const event = await prisma.auditEvent.findFirst({
      where: { entityId: run.id, action: 'visit_generation.confirmed' },
    });
    expect(event).not.toBeNull();
    expect(event?.actorLabel).toContain(ADMIN.email);
  });
});

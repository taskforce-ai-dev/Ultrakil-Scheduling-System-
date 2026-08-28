/**
 * ULK-C03 API tests.
 *
 * Boots the real application against a real PostgreSQL and drives it over
 * HTTP. The rules this task must guarantee — that a preferred day cannot sit
 * outside the allowed days, that a site cannot drift into the other branch,
 * that an impossible frequency is refused rather than quietly trimmed — live
 * in pipes, guards and transactions that a unit test would bypass.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BranchCode, PrismaClient, UserRole, Weekday } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';

const prisma = new PrismaClient();

const ADMIN = { email: 'c03-admin@ultrakil.test', password: 'c03-admin-password' };
const MANAGER = { email: 'c03-manager@ultrakil.test', password: 'c03-manager-password' };

let app: INestApplication;
let http: string;
let adminToken: string;
let managerToken: string;
let jobTypeId: string;
let customerId: string;
let siteId: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Mon/Wed/Fri/Sat, with different hours per day — a coffee-shop pattern. */
const CAFE_HOURS = [
  { weekday: Weekday.MONDAY, opensAtMinute: 6 * 60, closesAtMinute: 8 * 60 },
  { weekday: Weekday.WEDNESDAY, opensAtMinute: 6 * 60, closesAtMinute: 9 * 60 },
  { weekday: Weekday.FRIDAY, opensAtMinute: 5 * 60 + 30, closesAtMinute: 7 * 60 + 30 },
  { weekday: Weekday.SATURDAY, opensAtMinute: 7 * 60, closesAtMinute: 11 * 60 },
];

async function login(email: string, password: string): Promise<string> {
  const res = await request(http).post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function createCustomer(overrides: Record<string, unknown> = {}) {
  const res = await request(http)
    .post('/api/customers')
    .set(auth(adminToken))
    .send({ name: `Cust ${Math.random().toString(36).slice(2, 8)}`, branchCode: BranchCode.COLOMBO, ...overrides });
  expect(res.status).toBe(201);
  return res.body;
}

async function createSite(
  parentId: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await request(http)
    .post(`/api/customers/${parentId}/sites`)
    .set(auth(adminToken))
    .send({ name: `Site ${Math.random().toString(36).slice(2, 8)}`, operatingHours: CAFE_HOURS, ...overrides });
  expect(res.status).toBe(201);
  return res.body;
}

function agreementPayload(overrides: Record<string, unknown> = {}) {
  return {
    serviceSiteId: siteId,
    jobTypeId,
    frequencyCount: 2,
    frequencyUnit: 'WEEK',
    allowedDays: [Weekday.MONDAY, Weekday.WEDNESDAY, Weekday.FRIDAY, Weekday.SATURDAY],
    preferredDays: [Weekday.WEDNESDAY, Weekday.SATURDAY],
    startDate: '2026-09-07',
    durationMinutes: 90,
    ...overrides,
  };
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

  for (const [creds, role] of [
    [ADMIN, UserRole.ADMIN],
    [MANAGER, UserRole.MANAGER],
  ] as const) {
    await prisma.user.upsert({
      where: { email: creds.email },
      create: {
        email: creds.email,
        fullName: `C03 ${role}`,
        role,
        passwordHash: await AuthService.hashPassword(creds.password),
      },
      update: {
        role,
        isActive: true,
        passwordHash: await AuthService.hashPassword(creds.password),
      },
    });
  }

  adminToken = await login(ADMIN.email, ADMIN.password);
  managerToken = await login(MANAGER.email, MANAGER.password);

  const jobType = await request(http)
    .post('/api/job-types')
    .set(auth(adminToken))
    .send({
      code: `TERMITE_${Math.random().toString(36).slice(2, 6)}`,
      name: 'Termite Control',
      defaultDurationMinutes: 90,
      defaultCrewSize: 2,
    });
  expect(jobType.status).toBe(201);
  jobTypeId = jobType.body.id;

  const customer = await createCustomer({ name: 'Starbucks New Jersey' });
  customerId = customer.id;
  const site = await createSite(customerId, { name: 'Newark Penn Station' });
  siteId = site.id;
});

afterAll(async () => {
  await prisma.user.deleteMany({
    where: { email: { in: [ADMIN.email, MANAGER.email] } },
  });
  await prisma.$disconnect();
  await app.close();
});

// ---------------------------------------------------------------------------

describe('authorization', () => {
  it('refuses an anonymous caller', async () => {
    const res = await request(http).get('/api/customers');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('lets a manager read but not write', async () => {
    const read = await request(http).get('/api/customers').set(auth(managerToken));
    expect(read.status).toBe(200);

    const write = await request(http)
      .post('/api/customers')
      .set(auth(managerToken))
      .send({ name: 'Should not exist', branchCode: BranchCode.COLOMBO });

    expect(write.status).toBe(403);
    expect(write.body.code).toBe('INSUFFICIENT_ROLE');
  });

  it('refuses to create an agreement without a token', async () => {
    const res = await request(http).post('/api/service-agreements').send(agreementPayload());

    expect(res.status).toBe(401);
  });
});

describe('customers and sites', () => {
  it('holds several sites under one customer', async () => {
    const customer = await createCustomer({ name: 'Multi Site Holdings' });
    await createSite(customer.id, { name: 'Branch One' });
    await createSite(customer.id, { name: 'Branch Two' });

    const res = await request(http)
      .get(`/api/customers/${customer.id}`)
      .set(auth(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.sites).toHaveLength(2);
    expect(res.body.sites.map((site: { name: string }) => site.name).sort()).toEqual([
      'Branch One',
      'Branch Two',
    ]);
  });

  it('gives a site its customer branch by default', async () => {
    const customer = await createCustomer({ branchCode: BranchCode.KANDY });
    const site = await createSite(customer.id);

    expect(site.branchCode).toBe(BranchCode.KANDY);
  });

  it('refuses a site in the other branch from its customer', async () => {
    const customer = await createCustomer({ branchCode: BranchCode.COLOMBO });

    const res = await request(http)
      .post(`/api/customers/${customer.id}/sites`)
      .set(auth(adminToken))
      .send({ name: 'Wrong branch', branchCode: BranchCode.KANDY });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SITE_BRANCH_MISMATCH');
    expect(res.body.message).toContain('kept apart');
  });

  it('refuses to move a customer with sites to the other branch', async () => {
    const customer = await createCustomer({ branchCode: BranchCode.COLOMBO });
    await createSite(customer.id);

    const res = await request(http)
      .patch(`/api/customers/${customer.id}`)
      .set(auth(adminToken))
      .send({ branchCode: BranchCode.KANDY });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SITE_BRANCH_MISMATCH');
  });

  it('rejects a duplicate customer code', async () => {
    // Unique per run: this suite runs against a database that keeps its rows
    // between runs, and a hard-coded code would collide with itself.
    const customerCode = `DUPE-${Math.random().toString(36).slice(2, 8)}`;
    await createCustomer({ customerCode });

    const res = await request(http)
      .post('/api/customers')
      .set(auth(adminToken))
      .send({ name: 'Second', branchCode: BranchCode.COLOMBO, customerCode });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CUSTOMER_CODE_TAKEN');
  });
});

describe('opening hours', () => {
  it('stores different hours for different weekdays', async () => {
    const customer = await createCustomer();
    const site = await createSite(customer.id, { operatingHours: CAFE_HOURS });

    const monday = site.operatingHours.find(
      (h: { weekday: Weekday }) => h.weekday === Weekday.MONDAY,
    );
    const saturday = site.operatingHours.find(
      (h: { weekday: Weekday }) => h.weekday === Weekday.SATURDAY,
    );

    expect(monday).toMatchObject({ opensAtMinute: 360, closesAtMinute: 480 });
    expect(saturday).toMatchObject({ opensAtMinute: 420, closesAtMinute: 660 });
  });

  it('stores several windows on one weekday — a site that shuts for lunch', async () => {
    const customer = await createCustomer();
    const site = await createSite(customer.id, {
      operatingHours: [
        { weekday: Weekday.MONDAY, opensAtMinute: 8 * 60, closesAtMinute: 12 * 60 },
        { weekday: Weekday.MONDAY, opensAtMinute: 13 * 60, closesAtMinute: 17 * 60 },
      ],
    });

    const mondays = site.operatingHours.filter(
      (h: { weekday: Weekday }) => h.weekday === Weekday.MONDAY,
    );
    expect(mondays).toHaveLength(2);
  });

  it('rejects a window that ends before it starts', async () => {
    const customer = await createCustomer();

    const res = await request(http)
      .post(`/api/customers/${customer.id}/sites`)
      .set(auth(adminToken))
      .send({
        name: 'Backwards hours',
        operatingHours: [
          { weekday: Weekday.MONDAY, opensAtMinute: 17 * 60, closesAtMinute: 9 * 60 },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OPERATING_HOURS_INVALID');
    expect(res.body.message).toContain('must end after it starts');
  });

  it('rejects two overlapping windows on the same weekday', async () => {
    const customer = await createCustomer();

    const res = await request(http)
      .post(`/api/customers/${customer.id}/sites`)
      .set(auth(adminToken))
      .send({
        name: 'Overlapping hours',
        operatingHours: [
          { weekday: Weekday.MONDAY, opensAtMinute: 8 * 60, closesAtMinute: 13 * 60 },
          { weekday: Weekday.MONDAY, opensAtMinute: 12 * 60, closesAtMinute: 17 * 60 },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OPERATING_HOURS_OVERLAP');
  });

  it('replaces hours wholesale, so a removed weekday really closes', async () => {
    const customer = await createCustomer();
    const site = await createSite(customer.id, { operatingHours: CAFE_HOURS });

    const res = await request(http)
      .patch(`/api/service-sites/${site.id}`)
      .set(auth(adminToken))
      .send({
        operatingHours: [
          { weekday: Weekday.MONDAY, opensAtMinute: 9 * 60, closesAtMinute: 17 * 60 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.operatingHours).toHaveLength(1);
    expect(res.body.operatingHours[0].weekday).toBe(Weekday.MONDAY);
  });
});

describe('service agreement validation', () => {
  it('refuses a preferred day that is not an allowed day', async () => {
    const res = await request(http)
      .post('/api/service-agreements')
      .set(auth(adminToken))
      .send(
        agreementPayload({
          allowedDays: [Weekday.MONDAY, Weekday.WEDNESDAY],
          preferredDays: [Weekday.SUNDAY],
        }),
      );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PREFERRED_DAYS_NOT_ALLOWED');
    expect(res.body.message).toContain('SUNDAY');
  });

  it('refuses an agreement with no allowed days at all', async () => {
    const res = await request(http)
      .post('/api/service-agreements')
      .set(auth(adminToken))
      .send(agreementPayload({ allowedDays: [], preferredDays: [] }));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ALLOWED_DAYS_REQUIRED');
  });

  it('refuses a crew size below one', async () => {
    const res = await request(http)
      .post('/api/service-agreements')
      .set(auth(adminToken))
      .send(agreementPayload({ crewSize: 0 }));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a service window that ends before it starts', async () => {
    const res = await request(http)
      .post('/api/service-agreements')
      .set(auth(adminToken))
      .send(
        agreementPayload({
          serviceWindowStartMinute: 12 * 60,
          serviceWindowEndMinute: 8 * 60,
        }),
      );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SERVICE_WINDOW_INVALID');
  });

  it('refuses an end date before the start date', async () => {
    const res = await request(http)
      .post('/api/service-agreements')
      .set(auth(adminToken))
      .send(agreementPayload({ startDate: '2026-09-07', endDate: '2026-09-01' }));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AGREEMENT_DATES_INVALID');
  });

  it('refuses an impossible combination rather than trimming it silently', async () => {
    // The site is shut on Sunday, so no visit could ever happen.
    const res = await request(http)
      .post('/api/service-agreements')
      .set(auth(adminToken))
      .send(agreementPayload({ allowedDays: [Weekday.SUNDAY], preferredDays: [] }));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('AGREEMENT_UNSATISFIABLE');
    expect(res.body.message).toContain('closed');
  });

  it('takes the branch from the site, never from the caller', async () => {
    const kandyCustomer = await createCustomer({ branchCode: BranchCode.KANDY });
    const kandySite = await createSite(kandyCustomer.id);

    const res = await request(http)
      .post('/api/service-agreements')
      .set(auth(adminToken))
      .send(agreementPayload({ serviceSiteId: kandySite.id }));

    expect(res.status).toBe(201);
    expect(res.body.branchCode).toBe(BranchCode.KANDY);
  });
});

describe('weekly and monthly frequency', () => {
  it('previews a weekly agreement at the promised rate', async () => {
    const created = await request(http)
      .post('/api/service-agreements')
      .set(auth(adminToken))
      .send(agreementPayload({ frequencyCount: 2, frequencyUnit: 'WEEK' }));
    expect(created.status).toBe(201);

    const preview = await request(http)
      .get(`/api/service-agreements/${created.body.id}/schedule-preview?horizonWeeks=2`)
      .set(auth(adminToken));

    expect(preview.status).toBe(200);
    expect(preview.body.visits).toHaveLength(4);
    expect(preview.body.shortfalls).toEqual([]);
  });

  it('previews a monthly agreement at the promised rate', async () => {
    const created = await request(http)
      .post('/api/service-agreements')
      .set(auth(adminToken))
      .send(
        agreementPayload({
          frequencyCount: 3,
          frequencyUnit: 'MONTH',
          startDate: '2026-09-01',
        }),
      );
    expect(created.status).toBe(201);

    const preview = await request(http)
      .get(`/api/service-agreements/${created.body.id}/schedule-preview?horizonWeeks=4`)
      .set(auth(adminToken));

    expect(preview.body.visits).toHaveLength(3);
  });

  it('reports a shortfall rather than dropping required visits', async () => {
    // Four a week, but the site opens on only one allowed day.
    const created = await request(http)
      .post('/api/service-agreements')
      .set(auth(adminToken))
      .send(
        agreementPayload({
          frequencyCount: 4,
          allowedDays: [Weekday.WEDNESDAY],
          preferredDays: [],
        }),
      );
    expect(created.status).toBe(201);

    const preview = await request(http)
      .get(`/api/service-agreements/${created.body.id}/schedule-preview?horizonWeeks=2`)
      .set(auth(adminToken));

    expect(preview.body.shortfalls.length).toBeGreaterThan(0);
    expect(preview.body.shortfalls[0]).toMatchObject({ requested: 4, scheduled: 1 });
    expect(preview.body.shortfalls[0].message).toContain('short by 3');
  });
});

describe('acceptance scenario — a Starbucks New Jersey-style site', () => {
  let agreementId: string;

  beforeAll(async () => {
    const created = await request(http)
      .post('/api/service-agreements')
      .set(auth(adminToken))
      .send(agreementPayload({ notes: 'Termite control, twice weekly, before opening.' }));
    expect(created.status).toBe(201);
    agreementId = created.body.id;
  });

  it('records twice-weekly termite control with allowed and preferred days', async () => {
    const res = await request(http)
      .get(`/api/service-agreements/${agreementId}`)
      .set(auth(adminToken));

    expect(res.body).toMatchObject({
      customerName: 'Starbucks New Jersey',
      siteName: 'Newark Penn Station',
      jobTypeName: 'Termite Control',
      frequencyCount: 2,
      frequencyUnit: 'WEEK',
    });
    expect(res.body.allowedDays).toEqual([
      Weekday.MONDAY,
      Weekday.WEDNESDAY,
      Weekday.FRIDAY,
      Weekday.SATURDAY,
    ]);
    expect(res.body.preferredDays).toEqual([Weekday.WEDNESDAY, Weekday.SATURDAY]);
  });

  it('gives each weekday its own service hours in the preview', async () => {
    const res = await request(http)
      .get(`/api/service-agreements/${agreementId}/schedule-preview?horizonWeeks=2`)
      .set(auth(adminToken));

    const wednesday = res.body.visits.find(
      (v: { weekday: Weekday }) => v.weekday === Weekday.WEDNESDAY,
    );
    const saturday = res.body.visits.find(
      (v: { weekday: Weekday }) => v.weekday === Weekday.SATURDAY,
    );

    expect(wednesday).toMatchObject({ windowStartMinute: 360, windowEndMinute: 540 });
    expect(saturday).toMatchObject({ windowStartMinute: 420, windowEndMinute: 660 });
  });

  it('prefers Wednesday and Saturday over Monday and Friday', async () => {
    const res = await request(http)
      .get(`/api/service-agreements/${agreementId}/schedule-preview?horizonWeeks=2`)
      .set(auth(adminToken));

    expect(res.body.visits.every((v: { isPreferredDay: boolean }) => v.isPreferredDay)).toBe(
      true,
    );
  });
});

describe('archive behaviour', () => {
  let agreementId: string;

  beforeAll(async () => {
    const created = await request(http)
      .post('/api/service-agreements')
      .set(auth(adminToken))
      .send(agreementPayload());
    agreementId = created.body.id;
  });

  it('pauses without deleting, and comes back', async () => {
    const paused = await request(http)
      .post(`/api/service-agreements/${agreementId}/status`)
      .set(auth(adminToken))
      .send({ status: 'PAUSED', reason: 'Site closed for refurbishment' });

    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('PAUSED');
    expect(paused.body.isActive).toBe(false);

    const resumed = await request(http)
      .post(`/api/service-agreements/${agreementId}/status`)
      .set(auth(adminToken))
      .send({ status: 'ACTIVE' });

    expect(resumed.body.status).toBe('ACTIVE');
    expect(resumed.body.isActive).toBe(true);
  });

  it('hides archived agreements from the default list but keeps them', async () => {
    const created = await request(http)
      .post('/api/service-agreements')
      .set(auth(adminToken))
      .send(agreementPayload());
    const archivedId = created.body.id;

    await request(http)
      .post(`/api/service-agreements/${archivedId}/status`)
      .set(auth(adminToken))
      .send({ status: 'ARCHIVED' });

    const listed = await request(http)
      .get('/api/service-agreements?pageSize=200')
      .set(auth(adminToken));
    expect(
      listed.body.items.some((a: { id: string }) => a.id === archivedId),
    ).toBe(false);

    const stillThere = await request(http)
      .get(`/api/service-agreements/${archivedId}`)
      .set(auth(adminToken));
    expect(stillThere.status).toBe(200);
    expect(stillThere.body.status).toBe('ARCHIVED');
  });

  it('refuses to edit or revive an archived agreement', async () => {
    const created = await request(http)
      .post('/api/service-agreements')
      .set(auth(adminToken))
      .send(agreementPayload());
    const archivedId = created.body.id;

    await request(http)
      .post(`/api/service-agreements/${archivedId}/status`)
      .set(auth(adminToken))
      .send({ status: 'ARCHIVED' });

    const edited = await request(http)
      .patch(`/api/service-agreements/${archivedId}`)
      .set(auth(adminToken))
      .send({ frequencyCount: 1 });
    expect(edited.status).toBe(409);
    expect(edited.body.code).toBe('AGREEMENT_ARCHIVED');

    const revived = await request(http)
      .post(`/api/service-agreements/${archivedId}/status`)
      .set(auth(adminToken))
      .send({ status: 'ACTIVE' });
    expect(revived.status).toBe(409);
    expect(revived.body.code).toBe('AGREEMENT_ARCHIVED');
  });

  it('refuses an agreement against a deactivated site', async () => {
    const customer = await createCustomer();
    const site = await createSite(customer.id);

    await request(http)
      .post(`/api/service-sites/${site.id}/deactivate`)
      .set(auth(adminToken));

    const res = await request(http)
      .post('/api/service-agreements')
      .set(auth(adminToken))
      .send(agreementPayload({ serviceSiteId: site.id }));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SITE_INACTIVE');
  });
});

describe('versions and audit', () => {
  it('keeps a version per change, so a past visit stays explainable', async () => {
    const created = await request(http)
      .post('/api/service-agreements')
      .set(auth(adminToken))
      .send(agreementPayload({ frequencyCount: 1 }));
    const id = created.body.id;
    expect(created.body.currentVersion).toBe(1);

    const updated = await request(http)
      .patch(`/api/service-agreements/${id}`)
      .set(auth(adminToken))
      .send({ frequencyCount: 2 });
    expect(updated.body.currentVersion).toBe(2);

    const versions = await request(http)
      .get(`/api/service-agreements/${id}/versions`)
      .set(auth(adminToken));

    expect(versions.status).toBe(200);
    expect(versions.body).toHaveLength(2);
    // Newest first, and the old snapshot still records the original frequency.
    expect(versions.body[0].versionNumber).toBe(2);
    expect(versions.body[0].snapshot.frequencyCount).toBe(2);
    expect(versions.body[1].snapshot.frequencyCount).toBe(1);
    expect(versions.body[0].changedByLabel).toContain(ADMIN.email);
  });

  it('records before and after for an edited agreement', async () => {
    const created = await request(http)
      .post('/api/service-agreements')
      .set(auth(adminToken))
      .send(agreementPayload({ crewSize: 2 }));

    await request(http)
      .patch(`/api/service-agreements/${created.body.id}`)
      .set(auth(adminToken))
      .send({ crewSize: 4 });

    const event = await prisma.auditEvent.findFirst({
      where: { entityId: created.body.id, action: 'service_agreement.updated' },
      orderBy: { createdAt: 'desc' },
    });

    expect(event).not.toBeNull();
    expect((event?.before as { crewSize: number }).crewSize).toBe(2);
    expect((event?.after as { crewSize: number }).crewSize).toBe(4);
    expect(event?.actorLabel).toContain(ADMIN.email);
  });

  it('audits customer and site creation too', async () => {
    const customer = await createCustomer({ name: 'Audited Customer' });

    const event = await prisma.auditEvent.findFirst({
      where: { entityId: customer.id, action: 'customer.created' },
    });

    expect(event).not.toBeNull();
    expect(event?.before).toBeNull();
  });
});

describe('job types', () => {
  it('rejects a duplicate code, normalised for case and spacing', async () => {
    const code = `FUMIGATION_${Math.random().toString(36).slice(2, 6)}`;

    const first = await request(http)
      .post('/api/job-types')
      .set(auth(adminToken))
      .send({ code, name: 'Fumigation' });
    expect(first.status).toBe(201);

    const second = await request(http)
      .post('/api/job-types')
      .set(auth(adminToken))
      .send({ code: code.toLowerCase(), name: 'Fumigation again' });

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('JOB_TYPE_CODE_TAKEN');
  });

  it('supplies the defaults an agreement omits', async () => {
    const jobType = await request(http)
      .post('/api/job-types')
      .set(auth(adminToken))
      .send({
        code: `DEFAULTS_${Math.random().toString(36).slice(2, 6)}`,
        name: 'With defaults',
        defaultCrewSize: 5,
        defaultDurationMinutes: 45,
      });

    const agreement = await request(http)
      .post('/api/service-agreements')
      .set(auth(adminToken))
      .send(agreementPayload({ jobTypeId: jobType.body.id, durationMinutes: undefined }));

    expect(agreement.status).toBe(201);
    expect(agreement.body.crewSize).toBe(5);
    expect(agreement.body.durationMinutes).toBe(45);
  });

  it('deactivates rather than deleting, and blocks new agreements', async () => {
    const jobType = await request(http)
      .post('/api/job-types')
      .set(auth(adminToken))
      .send({ code: `RETIRED_${Math.random().toString(36).slice(2, 6)}`, name: 'Retired' });

    await request(http)
      .post(`/api/job-types/${jobType.body.id}/deactivate`)
      .set(auth(adminToken));

    const res = await request(http)
      .post('/api/service-agreements')
      .set(auth(adminToken))
      .send(agreementPayload({ jobTypeId: jobType.body.id }));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JOB_TYPE_INACTIVE');

    const stillReadable = await request(http)
      .get(`/api/job-types/${jobType.body.id}`)
      .set(auth(adminToken));
    expect(stillReadable.status).toBe(200);
  });
});

describe('required skills', () => {
  it('stores the skills a crew member must hold, normalised', async () => {
    const res = await request(http)
      .post('/api/service-agreements')
      .set(auth(adminToken))
      .send(agreementPayload({ requiredSkillCodes: ['mbr_fumigation', 'RODENT_MANAGEMENT'] }));

    expect(res.status).toBe(201);
    expect(res.body.requiredSkillCodes).toEqual([
      'MBR_FUMIGATION',
      'RODENT_MANAGEMENT',
    ]);
  });
});

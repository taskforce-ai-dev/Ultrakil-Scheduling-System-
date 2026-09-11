/**
 * Tests the master-schedule importer's database writes.
 *
 * The real workbook holds live customer data and is never committed, so it
 * cannot be a fixture. These tests hand the importer a small parsed structure
 * instead — that is the seam that matters here, because the risk in this code
 * is not reading the spreadsheet (unit-tested against real strings elsewhere)
 * but what it writes: duplicating customers on a re-run, or creating an
 * agreement from a row nobody could interpret.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AgreementStatus,
  FrequencyUnit,
  PrismaClient,
  UserRole,
  Weekday,
} from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { importSchedule } from '../../src/catalog/schedule-import/importer';
import { ParsedSchedule } from '../../src/catalog/schedule-import/types';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';

const prisma = new PrismaClient();

/** Unique per run: this database keeps its rows between runs. */
const suffix = Math.random().toString(36).slice(2, 8);
const CUSTOMER = `Import Test Co ${suffix}`;

// The manager half of these tests goes through the real API rather than
// through Prisma. Reaching into the database would prove only that the
// importer respects columns somebody set by hand; the question is whether the
// workflow a manager actually has sets them at all.
const ADMIN = {
  email: `schedule-import-admin-${suffix}@ultrakil.test`,
  password: 'schedule-import-admin-password',
};

let app: INestApplication;
let http: string;
let adminToken: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

function buildSchedule(overrides: Partial<ParsedSchedule> = {}): ParsedSchedule {
  return {
    customers: [
      {
        name: CUSTOMER,
        sourceSheet: 'Main',
        isServiced: true,
        sites: [
          {
            name: `${CUSTOMER} — Head Office`,
            addressLine: '1 Test Road, Colombo 03',
            regionLabel: 'Metro',
            locationCode: 'HO-1',
            isServiced: true,
          },
        ],
        agreements: [
          {
            siteName: `${CUSTOMER} — Head Office`,
            isServiced: true,
            treatmentCodes: ['GPC', 'RC'],
            frequency: {
              kind: 'parsed',
              frequency: { count: 2, unit: FrequencyUnit.MONTH, interval: 1 },
              source: 'Twice a month',
            },
            dayRule: {
              kind: 'parsed',
              allowedDays: [Weekday.MONDAY, Weekday.THURSDAY],
              source: 'Monday, Thursday',
            },
            effort: { durationMinutes: 90, crewSize: 3 },
            endDate: null,
            notes: null,
          },
        ],
      },
    ],
    issues: [],
    sheetSummary: [],
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
  await Promise.all(['COLOMBO', 'KANDY'].map((code) =>
    prisma.branch.upsert({
      where: { code: code as 'COLOMBO' | 'KANDY' },
      create: { code: code as 'COLOMBO' | 'KANDY', name: `${code} Branch` },
      update: {},
    }),
  ));

  await prisma.user.upsert({
    where: { email: ADMIN.email },
    create: {
      email: ADMIN.email,
      fullName: 'Schedule Import Admin',
      role: UserRole.ADMIN,
      passwordHash: await AuthService.hashPassword(ADMIN.password),
    },
    update: {
      role: UserRole.ADMIN,
      isActive: true,
      passwordHash: await AuthService.hashPassword(ADMIN.password),
    },
  });

  const login = await request(http)
    .post('/api/auth/login')
    .send({ email: ADMIN.email, password: ADMIN.password });
  expect(login.status).toBe(200);
  adminToken = login.body.accessToken as string;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: ADMIN.email } });
  await prisma.$disconnect();
  await app.close();
});

describe('master schedule import', () => {
  it('creates the customer, its site and the agreement', async () => {
    const summary = await importSchedule(prisma, buildSchedule());

    expect(summary.customersCreated).toBe(1);
    expect(summary.sitesCreated).toBe(1);
    expect(summary.agreementsCreated).toBe(1);

    const customer = await prisma.customer.findFirstOrThrow({
      where: { name: CUSTOMER },
      include: {
        serviceSites: true,
        serviceAgreements: { include: { dayRules: true } },
      },
    });

    expect(customer.branchCode).toBe('COLOMBO');
    expect(customer.serviceSites[0].addressLine).toBe('1 Test Road, Colombo 03');
    expect(customer.serviceSites[0]).toMatchObject({
      branchConfidence: 'MATCHED',
      branchSource: 'ADDRESS_MATCH',
    });

    const agreement = customer.serviceAgreements[0];
    expect(agreement).toMatchObject({
      frequencyCount: 2,
      frequencyUnit: FrequencyUnit.MONTH,
      // Taken from the workbook's "Duration and PCT", not the job type default.
      crewSize: 3,
      durationMinutes: 90,
      crewSizeProvenance: 'SOURCE',
      durationProvenance: 'SOURCE',
      dayRuleProvenance: 'SOURCE',
      status: AgreementStatus.ACTIVE,
    });
    expect(agreement.dayRules.map((rule) => rule.weekday).sort()).toEqual([
      Weekday.MONDAY,
      Weekday.THURSDAY,
    ]);
  });

  it('updates rather than duplicating when run a second time', async () => {
    const summary = await importSchedule(prisma, buildSchedule());

    expect(summary.customersCreated).toBe(0);
    expect(summary.customersUpdated).toBe(1);
    expect(summary.sitesCreated).toBe(0);
    expect(summary.agreementsCreated).toBe(0);
    expect(summary.agreementsUpdated).toBe(1);

    const customers = await prisma.customer.findMany({ where: { name: CUSTOMER } });
    expect(customers).toHaveLength(1);
  });

  it('imports the site but skips the agreement when the frequency is unsupported', async () => {
    const name = `Fortnightly Co ${suffix}`;
    const schedule = buildSchedule();
    schedule.customers = [
      {
        ...schedule.customers[0],
        name,
        sites: [
          { name: `${name} — Site`, addressLine: null, regionLabel: null, locationCode: null, isServiced: true },
        ],
        agreements: [
          {
            ...schedule.customers[0].agreements[0],
            siteName: `${name} — Site`,
            frequency: {
              kind: 'unsupported',
              source: 'Fortnightly',
              reason: 'fortnightly is neither weekly nor monthly',
            },
          },
        ],
      },
    ];

    const summary = await importSchedule(prisma, schedule);

    // The customer is a fact the workbook states; the agreement is not.
    expect(summary.sitesCreated).toBe(1);
    expect(summary.agreementsCreated).toBe(0);
    expect(summary.agreementsSkipped).toBe(1);

    const stored = await prisma.customer.findFirstOrThrow({
      where: { name },
      include: { serviceAgreements: true },
    });
    expect(stored.serviceAgreements).toHaveLength(0);
  });

  it('records in the notes when the allowed days were derived, not stated', async () => {
    const name = `Derived Days Co ${suffix}`;
    const schedule = buildSchedule();
    schedule.customers = [
      {
        ...schedule.customers[0],
        name,
        sites: [
          { name: `${name} — Site`, addressLine: null, regionLabel: null, locationCode: null, isServiced: true },
        ],
        agreements: [
          {
            ...schedule.customers[0].agreements[0],
            siteName: `${name} — Site`,
            dayRule: {
              kind: 'derived',
              allowedDays: [Weekday.FRIDAY],
              sampleSize: 6,
              evidence: 'FRI×6',
            },
          },
        ],
      },
    ];

    await importSchedule(prisma, schedule);

    const agreement = await prisma.serviceAgreement.findFirstOrThrow({
      where: { customer: { name } },
    });

    // Anyone reading this agreement must be able to tell that its days were
    // inferred from past bookings rather than agreed with the customer.
    expect(agreement.notes).toMatch(/were not stated/);
    expect(agreement.notes).toMatch(/FRI×6/);
    expect(agreement.notes).toMatch(/Confirm with the customer/);
    expect(agreement.dayRuleProvenance).toBe('DERIVED');
  });

  it('records defaults without passing them off as workbook facts', async () => {
    const name = `Defaulted Values Co ${suffix}`;
    const schedule = buildSchedule();
    schedule.customers = [
      {
        ...schedule.customers[0],
        name,
        sites: [
          { name: `${name} — Site`, addressLine: null, regionLabel: null, locationCode: null, isServiced: true },
        ],
        agreements: [
          {
            ...schedule.customers[0].agreements[0],
            siteName: `${name} — Site`,
            effort: { durationMinutes: null, crewSize: null },
          },
        ],
      },
    ];

    await importSchedule(prisma, schedule);

    const agreement = await prisma.serviceAgreement.findFirstOrThrow({
      where: { customer: { name } },
    });
    expect(agreement.crewSizeProvenance).toBe('DEFAULTED');
    expect(agreement.durationProvenance).toBe('DEFAULTED');
  });

  it('does not overwrite a manager-confirmed branch or agreement values on re-import', async () => {
    await importSchedule(prisma, buildSchedule());

    const customer = await prisma.customer.findFirstOrThrow({
      where: { name: CUSTOMER },
      include: { serviceSites: true, serviceAgreements: true },
    });
    const site = customer.serviceSites[0];
    const agreement = customer.serviceAgreements[0];

    // The manager's own edits, made the only way a manager can make them. It
    // is these routes — not a hand-written database row — that have to be what
    // establishes confirmation, or nothing here proves the real workflow.
    const siteEdit = await request(http)
      .patch(`/api/service-sites/${site.id}`)
      .set(auth(adminToken))
      .send({ branchCode: 'KANDY' });
    expect(siteEdit.status).toBe(200);

    const agreementEdit = await request(http)
      .patch(`/api/service-agreements/${agreement.id}`)
      .set(auth(adminToken))
      .send({
        crewSize: 7,
        durationMinutes: 135,
        allowedDays: [Weekday.MONDAY, Weekday.THURSDAY],
      });
    expect(agreementEdit.status).toBe(200);

    await importSchedule(prisma, buildSchedule());

    expect(await prisma.serviceSite.findUniqueOrThrow({ where: { id: site.id } })).toMatchObject({
      branchCode: 'KANDY',
      branchConfidence: 'CONFIRMED',
      branchSource: 'MANAGER_CONFIRMED',
    });
    expect(await prisma.serviceAgreement.findUniqueOrThrow({ where: { id: agreement.id } })).toMatchObject({
      crewSize: 7,
      durationMinutes: 135,
      crewSizeProvenance: 'MANAGER_CONFIRMED',
      durationProvenance: 'MANAGER_CONFIRMED',
      dayRuleProvenance: 'MANAGER_CONFIRMED',
    });
  });

  it('reuses one job type per treatment combination', async () => {
    const before = await prisma.jobType.count({ where: { code: { startsWith: 'IMPORTED_' } } });
    await importSchedule(prisma, buildSchedule());
    const after = await prisma.jobType.count({ where: { code: { startsWith: 'IMPORTED_' } } });

    expect(after).toBe(before);
  });
});

describe('records the workbook marks red', () => {
  /** The same customer, with its site and agreement marked as gone. */
  function unservicedSchedule(): ParsedSchedule {
    const schedule = buildSchedule();
    const customer = schedule.customers[0];
    return {
      ...schedule,
      customers: [
        {
          ...customer,
          isServiced: false,
          sites: customer.sites.map((site) => ({ ...site, isServiced: false })),
          agreements: customer.agreements.map((agreement) => ({
            ...agreement,
            isServiced: false,
          })),
        },
      ],
    };
  }

  it('imports them inactive, and their agreements archived', async () => {
    await importSchedule(prisma, unservicedSchedule());

    const customer = await prisma.customer.findFirstOrThrow({
      where: { name: CUSTOMER },
      include: { serviceSites: { include: { serviceAgreements: true } } },
    });

    expect(customer.isActive).toBe(false);
    expect(customer.importedInactiveAt).not.toBeNull();
    expect(customer.serviceSites.every((site) => !site.isActive)).toBe(true);
    // Archived, not deleted: the promise that was once made is still on record.
    expect(
      customer.serviceSites.flatMap((site) => site.serviceAgreements),
    ).not.toHaveLength(0);
    expect(
      customer.serviceSites
        .flatMap((site) => site.serviceAgreements)
        .every((agreement) => agreement.status === AgreementStatus.ARCHIVED),
    ).toBe(true);
  });

  it('does not silently switch them back on when the red is gone', async () => {
    await importSchedule(prisma, unservicedSchedule());
    // The workbook is edited and the fill removed. That is somebody changing a
    // cell, not the client returning, so the importer must not act on it.
    await importSchedule(prisma, buildSchedule());

    const customer = await prisma.customer.findFirstOrThrow({
      where: { name: CUSTOMER },
      include: { serviceSites: true },
    });

    expect(customer.isActive).toBe(false);
    expect(customer.serviceSites.every((site) => !site.isActive)).toBe(true);
  });

  it('reactivates through the manager reactivation routes, and stays reactivated', async () => {
    await importSchedule(prisma, unservicedSchedule());

    const imported = await prisma.customer.findFirstOrThrow({
      where: { name: CUSTOMER },
      include: { serviceSites: { include: { serviceAgreements: true } } },
    });
    const site = imported.serviceSites[0];
    const agreement = site.serviceAgreements[0];

    expect(imported.importedInactiveAt).not.toBeNull();
    expect(agreement.importedInactiveAt).not.toBeNull();

    // What a manager turning the client back on actually does. Each is its own
    // authorised action; there is no other supported way to do it.
    for (const path of [
      `/api/customers/${imported.id}/reactivate`,
      `/api/service-sites/${site.id}/reactivate`,
      `/api/service-agreements/${agreement.id}/reactivate`,
    ]) {
      const res = await request(http).post(path).set(auth(adminToken));
      expect([path, res.status]).toEqual([path, 200]);
    }

    // The marking is gone, because it is the marking that tells the next
    // import to keep the record off. The fact that a workbook once read this
    // customer as gone survives in the audit trail, not in the live row.
    const reactivated = await prisma.customer.findFirstOrThrow({
      where: { name: CUSTOMER },
      include: { serviceSites: { include: { serviceAgreements: true } } },
    });
    expect(reactivated.importedInactiveAt).toBeNull();
    expect(reactivated.serviceSites[0].importedInactiveAt).toBeNull();
    expect(
      reactivated.serviceSites[0].serviceAgreements[0].importedInactiveAt,
    ).toBeNull();

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: {
        entityType: 'Customer',
        entityId: imported.id,
        action: 'customer.reactivated',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(event.after).toMatchObject({
      clearedImportedInactiveAt: imported.importedInactiveAt?.toISOString(),
    });

    await importSchedule(prisma, buildSchedule());

    const customer = await prisma.customer.findFirstOrThrow({
      where: { name: CUSTOMER },
      include: { serviceSites: { include: { serviceAgreements: true } } },
    });
    expect(customer.isActive).toBe(true);
    expect(customer.serviceSites.every((one) => one.isActive)).toBe(true);
    expect(
      customer.serviceSites
        .flatMap((one) => one.serviceAgreements)
        .every((one) => one.status === AgreementStatus.ACTIVE),
    ).toBe(true);
  });

  it('does not re-mark a reactivated record, so the decision survives', async () => {
    await importSchedule(prisma, unservicedSchedule());

    const imported = await prisma.customer.findFirstOrThrow({
      where: { name: CUSTOMER },
      include: { serviceSites: { include: { serviceAgreements: true } } },
    });
    const site = imported.serviceSites[0];
    const agreement = site.serviceAgreements[0];

    for (const path of [
      `/api/customers/${imported.id}/reactivate`,
      `/api/service-sites/${site.id}/reactivate`,
      `/api/service-agreements/${agreement.id}/reactivate`,
    ]) {
      await request(http).post(path).set(auth(adminToken)).expect(200);
    }

    // Two further imports of a workbook that no longer marks the row red.
    await importSchedule(prisma, buildSchedule());
    await importSchedule(prisma, buildSchedule());

    const after = await prisma.customer.findFirstOrThrow({
      where: { name: CUSTOMER },
      include: { serviceSites: { include: { serviceAgreements: true } } },
    });
    expect(after.importedInactiveAt).toBeNull();
    expect(after.serviceSites[0].importedInactiveAt).toBeNull();
    expect(after.serviceSites[0].serviceAgreements[0].importedInactiveAt).toBeNull();
  });

  it('keeps a customer serviced while any one of its sites still is', async () => {
    // A chain that closed one branch is still a paying client everywhere else.
    const schedule = buildSchedule();
    const customer = schedule.customers[0];
    const [live] = customer.sites;

    await importSchedule(prisma, {
      ...schedule,
      customers: [
        {
          ...customer,
          isServiced: true,
          sites: [
            live,
            {
              name: `${CUSTOMER} — Closed Branch`,
              addressLine: null,
              regionLabel: null,
              locationCode: null,
              isServiced: false,
            },
          ],
        },
      ],
    });

    const record = await prisma.customer.findFirstOrThrow({
      where: { name: CUSTOMER },
      include: { serviceSites: true },
    });

    expect(record.isActive).toBe(true);
    expect(record.serviceSites.find((site) => site.name === live.name)?.isActive).toBe(true);
    expect(
      record.serviceSites.find((site) => site.name.endsWith('Closed Branch'))?.isActive,
    ).toBe(false);
  });
});

/**
 * One order for agreement rows, kept by every writer that takes more than one.
 *
 * The workbook importer updates a customer's agreements in **workbook order** —
 * whatever order a spreadsheet kept by hand happens to list them in — inside
 * one transaction per customer. Every schedule writer takes them sorted by id.
 * Two orders over the same rows is a deadlock waiting for the two to overlap,
 * and an import is an admin action that lands in the middle of an ordinary
 * working day, when a generation confirm is the most routine thing there is.
 *
 * Measured before the fix, on this fixture:
 *
 *   ERROR: deadlock detected
 *   DETAIL: Process 1420901 waits for ShareLock on transaction 175253;
 *           blocked by process 1420902.
 *   Process 1420902 waits for ShareLock on transaction 175254;
 *           blocked by process 1420901.
 *
 * Postgres killed the generation, and the manager saw a 500 on Generate. The
 * importer now takes the customer's agreement rows through `lockAgreementRows`
 * before it updates any of them, so the two queue instead.
 *
 * The interleaving is forced rather than raced. The importer clears an
 * agreement's imported bookings immediately after updating the agreement row,
 * so a lock held on one of those booking rows parks it holding exactly one
 * agreement — which is the state the whole hazard depends on.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  BranchCode,
  DataProvenance,
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
import { ScheduleRunProcessor } from '../../src/scheduling/optimizer/schedule-run.processor';

const prisma = new PrismaClient();
const other = new PrismaClient();
const suffix = Math.random().toString(36).slice(2, 8);
const ADMIN = {
  email: `import-race-${suffix}@ultrakil.test`,
  password: 'import-race-password',
};
const CUSTOMER = `Import Race Client ${suffix}`;
const WEEK = { from: '2029-06-04', to: '2029-06-10' };
const at = (date: string) => new Date(`${date}T00:00:00.000Z`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let app: INestApplication;
let http: string;
let token: string;
const auth = () => ({ Authorization: `Bearer ${token}` });

function workbook(siteOrder: string[]): ParsedSchedule {
  return {
    customers: [
      {
        name: CUSTOMER,
        sourceSheet: 'RACE',
        isServiced: true,
        sites: siteOrder.map((name) => ({
          name,
          addressLine: 'Colombo 03',
          regionLabel: null,
          locationCode: null,
          isServiced: true,
        })),
        agreements: siteOrder.map((name) => ({
          siteName: name,
          treatmentCodes: ['GPC'],
          frequency: {
            kind: 'parsed' as const,
            frequency: { count: 1, unit: FrequencyUnit.WEEK, interval: 1 },
            source: 'Weekly',
          },
          dayRule: {
            kind: 'parsed' as const,
            allowedDays: [Weekday.MONDAY],
            source: 'Monday',
          },
          effort: { durationMinutes: 90, crewSize: 2 },
          endDate: null,
          bookedDates: [],
          notes: null,
          isServiced: true,
        })),
      },
    ],
    issues: [],
    sheetSummary: [{ sheet: 'RACE', rows: 2, sites: 2 }],
  };
}

/** Is anything parked on a lock over the table whose name this matches? */
async function blockedOn(fragment: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ blocked: bigint }[]>`
    SELECT count(*) AS blocked
    FROM pg_stat_activity
    WHERE wait_event_type = 'Lock' AND query ILIKE ${'%' + fragment + '%'}
  `;
  return Number(rows[0]?.blocked ?? 0) > 0;
}

async function waitUntilBlockedOn(fragment: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await blockedOn(fragment)) return;
    await sleep(100);
  }
  throw new Error(`Nothing ever blocked on ${fragment}.`);
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
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

  await prisma.$connect();
  await other.$connect();
  await prisma.branch.upsert({
    where: { code: BranchCode.COLOMBO },
    create: { code: BranchCode.COLOMBO, name: 'COLOMBO Branch' },
    update: {},
  });
  await prisma.user.upsert({
    where: { email: ADMIN.email },
    create: {
      email: ADMIN.email,
      fullName: 'Import Race Admin',
      role: UserRole.ADMIN,
      passwordHash: await AuthService.hashPassword(ADMIN.password),
    },
    update: { role: UserRole.ADMIN, isActive: true },
  });
  const login = await request(http)
    .post('/api/auth/login')
    .send({ email: ADMIN.email, password: ADMIN.password });
  token = login.body.accessToken as string;
}, 300_000);

afterAll(async () => {
  const customer = await prisma.customer.findFirst({ where: { name: CUSTOMER } });
  if (customer) {
    const agreements = await prisma.serviceAgreement.findMany({
      where: { customerId: customer.id },
      select: { id: true },
    });
    const ids = agreements.map((a) => a.id);
    await prisma.generatedVisit.deleteMany({ where: { serviceAgreementId: { in: ids } } });
    await prisma.serviceAgreementBooking.deleteMany({
      where: { serviceAgreementId: { in: ids } },
    });
    await prisma.serviceAgreementDayRule.deleteMany({
      where: { serviceAgreementId: { in: ids } },
    });
    await prisma.serviceAgreement.deleteMany({ where: { id: { in: ids } } });
    const sites = await prisma.serviceSite.findMany({
      where: { customerId: customer.id },
      select: { id: true },
    });
    await prisma.siteOperatingHours.deleteMany({
      where: { serviceSiteId: { in: sites.map((s) => s.id) } },
    });
    await prisma.serviceSite.deleteMany({ where: { customerId: customer.id } });
    await prisma.customer.delete({ where: { id: customer.id } });
  }
  await prisma.jobType.deleteMany({ where: { code: `GPC` } }).catch(() => undefined);
  await prisma.scheduleRun.deleteMany({
    where: { rangeStart: at(WEEK.from), rangeEnd: at(WEEK.to) },
  });
  await prisma.user.deleteMany({ where: { email: ADMIN.email } });
  await prisma.$disconnect();
  await other.$disconnect();
  await app.close();
}, 120_000);

it('queues an import and a generation confirm over the same customer instead of deadlocking', async () => {
  // One import to create the customer, its two sites and its two agreements.
  await importSchedule(prisma, workbook(['Race Site One', 'Race Site Two']));

  const customer = await prisma.customer.findFirstOrThrow({ where: { name: CUSTOMER } });
  const agreements = await prisma.serviceAgreement.findMany({
    where: { customerId: customer.id },
    include: { serviceSite: { select: { name: true } } },
  });
  expect(agreements).toHaveLength(2);

  // Workbook order is whatever the sheet says. Put the agreement with the
  // HIGHER id first, so the importer takes them in the opposite order to the
  // sorted lock every schedule writer uses.
  const sorted = [...agreements].sort((a, b) => a.id.localeCompare(b.id));
  const [lower, higher] = sorted;
  const second = workbook([higher.serviceSite.name, lower.serviceSite.name]);

  // The importer's pause point: it clears an agreement's imported bookings
  // straight after updating the agreement row, so a lock held on one of those
  // booking rows parks it holding exactly one agreement.
  const booking = await prisma.serviceAgreementBooking.create({
    data: {
      serviceAgreementId: higher.id,
      bookedDate: at('2020-01-06'),
      provenance: DataProvenance.SOURCE,
    },
  });

  let release: () => void = () => undefined;
  let acquired: () => void = () => undefined;
  const isHeld = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const mayRelease = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = other.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT id FROM service_agreement_bookings WHERE id = ${booking.id}::uuid FOR UPDATE`;
      acquired();
      await mayRelease;
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
  await isHeld;

  let importError: unknown;
  const importing = importSchedule(prisma, second).catch((error: unknown) => {
    importError = error;
  });

  // The importer now holds the higher-id agreement and is stuck clearing its
  // bookings.
  await waitUntilBlockedOn('service_agreement_bookings');

  let confirmError: unknown;
  const confirm = request(http)
    .post('/api/visit-generation/confirm')
    .set(auth())
    .send({
      ...WEEK,
      branchCode: BranchCode.COLOMBO,
      serviceAgreementIds: [lower.id, higher.id],
    })
    .then((response) => response)
    .catch((error: unknown) => {
      confirmError = error;
      return { status: -1, body: {} } as unknown as request.Response;
    });

  // Generation asks for the same two rows, sorted. Before the fix it got the
  // lower one and waited for the higher; now it waits for both from the start.
  await waitUntilBlockedOn('service_agreements');
  release();

  const [response] = await Promise.all([confirm, importing, holder]);

  // Neither side is a deadlock victim: the import commits, and the confirm
  // goes through as soon as it does.
  expect(importError).toBeUndefined();
  expect(confirmError).toBeUndefined();
  expect(response.status).toBe(200);

  // And the run really did the work that needed those rows.
  const visits = await prisma.generatedVisit.findMany({
    where: { serviceAgreementId: { in: [lower.id, higher.id] } },
    select: { serviceAgreementId: true },
  });
  expect(new Set(visits.map((visit) => visit.serviceAgreementId))).toEqual(
    new Set([lower.id, higher.id]),
  );
}, 180_000);

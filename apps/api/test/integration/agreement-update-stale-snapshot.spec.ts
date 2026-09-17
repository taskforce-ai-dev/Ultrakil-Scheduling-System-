/**
 * `AgreementsService.update` reads the agreement once, before its
 * transaction opens, and used to derive every field the edit itself did not
 * carry — crew size, duration, service window, dates, day rules — from that
 * one read for the rest of the method, including the write. Locking the
 * agreement (see `agreement-update-import-lock.spec.ts`) stops a manager's
 * edit from deadlocking against a concurrent import, but does nothing about
 * this: the read happened before the lock even existed, so a re-import that
 * refreshes the agreement's crew size in the gap between that read and the
 * write is invisible to it, and a day-rule-only PATCH silently reverts the
 * import's fresh value back to whatever the pre-lock snapshot said.
 *
 * `update()` now re-reads the agreement *after* it holds the lock, and
 * falls back to that fresh row rather than the pre-transaction one for any
 * field the edit does not itself carry.
 *
 * The interleaving is forced exactly like the sibling spec: a third
 * connection holds the agreement row, so the manager's read (unlocked, and
 * therefore free to proceed under MVCC while the row is merely held rather
 * than written to) captures the pre-import crew size, and both the import
 * and the edit then queue for the same row lock — the import first, so it is
 * the one to actually change the row before the edit's own lock resolves.
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
  email: `stale-snapshot-${suffix}@ultrakil.test`,
  password: 'stale-snapshot-password',
};
const CUSTOMER = `Stale Snapshot Client ${suffix}`;
const SITE = `Stale Snapshot Site ${suffix}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let app: INestApplication;
let http: string;
let token: string;
const auth = () => ({ Authorization: `Bearer ${token}` });

function workbook(crewSize: number): ParsedSchedule {
  return {
    customers: [
      {
        name: CUSTOMER,
        sourceSheet: 'STALE-SNAPSHOT',
        isServiced: true,
        sites: [
          {
            name: SITE,
            addressLine: 'Colombo 03',
            regionLabel: null,
            locationCode: null,
            isServiced: true,
          },
        ],
        agreements: [
          {
            siteName: SITE,
            treatmentCodes: ['STALE'],
            frequency: {
              kind: 'parsed' as const,
              frequency: { count: 1, unit: FrequencyUnit.WEEK, interval: 1 },
              source: 'Weekly',
            },
            dayRule: { kind: 'parsed' as const, allowedDays: [Weekday.MONDAY], source: 'Weekly' },
            effort: { durationMinutes: 90, crewSize },
            endDate: null,
            bookedDates: [],
            notes: null,
            isServiced: true,
          },
        ],
      },
    ],
    issues: [],
    sheetSummary: [{ sheet: 'STALE-SNAPSHOT', rows: 1, sites: 1 }],
  };
}

async function blockedCount(fragment: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ blocked: bigint }[]>`
    SELECT count(*) AS blocked
    FROM pg_stat_activity
    WHERE wait_event_type = 'Lock' AND query ILIKE ${'%' + fragment + '%'}
  `;
  return Number(rows[0]?.blocked ?? 0);
}

async function waitUntilBlockedCountIsAtLeast(fragment: string, atLeast: number): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if ((await blockedCount(fragment)) >= atLeast) return;
    await sleep(100);
  }
  throw new Error(`Fewer than ${atLeast} ever blocked on ${fragment}.`);
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
      fullName: 'Stale Snapshot Admin',
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
    await prisma.serviceAgreementDayRule.deleteMany({
      where: { serviceAgreementId: { in: ids } },
    });
    await prisma.serviceAgreementVersion.deleteMany({
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
  await prisma.jobType.deleteMany({ where: { code: 'IMPORTED_STALE' } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { email: ADMIN.email } });
  await prisma.$disconnect();
  await other.$disconnect();
  await app.close();
}, 120_000);

it('a day-rule-only edit keeps a re-import\'s fresh crew size instead of reverting it to the pre-lock read', async () => {
  await importSchedule(prisma, workbook(2));

  const customer = await prisma.customer.findFirstOrThrow({ where: { name: CUSTOMER } });
  const site = await prisma.serviceSite.findFirstOrThrow({ where: { customerId: customer.id } });
  const agreement = await prisma.serviceAgreement.findFirstOrThrow({
    where: { customerId: customer.id },
  });
  expect(agreement.crewSize).toBe(2);

  await prisma.siteOperatingHours.createMany({
    data: [Weekday.MONDAY, Weekday.TUESDAY].map((weekday) => ({
      serviceSiteId: site.id,
      weekday,
      opensAtMinute: 8 * 60,
      closesAtMinute: 17 * 60,
      provenance: DataProvenance.MANAGER_CONFIRMED,
    })),
  });

  // The pause point: hold the agreement row itself, so the manager's edit
  // can read it (a plain, unlocked SELECT — MVCC lets it proceed against a
  // row merely held, not yet committed-over) but not yet lock it.
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
      await tx.$executeRaw`SELECT id FROM service_agreements WHERE id = ${agreement.id}::uuid FOR UPDATE`;
      acquired();
      await mayRelease;
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
  await isHeld;

  // The re-import queues for the row first.
  let importError: unknown;
  const importing = importSchedule(prisma, workbook(5)).catch((error: unknown) => {
    importError = error;
  });
  await waitUntilBlockedCountIsAtLeast('service_agreements', 1);

  // The manager's edit: its own unlocked read happens now, while the import
  // is still only queued (not committed) — capturing crew size 2 — and it
  // then queues for the row second, behind the import.
  let patchError: unknown;
  const patch = request(http)
    .patch(`/api/service-agreements/${agreement.id}`)
    .set(auth())
    .send({ allowedDays: [Weekday.TUESDAY] })
    .then((response) => response)
    .catch((error: unknown) => {
      patchError = error;
      return { status: -1, body: {} } as unknown as request.Response;
    });
  await waitUntilBlockedCountIsAtLeast('service_agreements', 2);
  release();

  const [response] = await Promise.all([patch, importing, holder]);

  expect(importError).toBeUndefined();
  expect(patchError).toBeUndefined();
  expect(response.status).toBe(200);

  // The import's crew size of 5 survives the edit that ran after it and
  // read a crew size of 2. The old code re-wrote crewSize from the
  // pre-lock snapshot on every save, including this day-rule-only one, and
  // would have left the row at 2 — the import's write undone by an edit
  // that never touched crew size at all.
  const final = await prisma.serviceAgreement.findUniqueOrThrow({
    where: { id: agreement.id },
  });
  expect(final.crewSize).toBe(5);
}, 180_000);

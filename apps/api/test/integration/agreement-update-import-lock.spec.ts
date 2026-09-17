/**
 * Locking the agreement before deleting its own children — the order every
 * writer touching `service_agreements` keeps, now including a single-row
 * edit.
 *
 * `AgreementsService.update` used to delete an agreement's day-rule (and
 * required-skill) rows before it locked the agreement row itself. The
 * workbook importer takes the opposite order on purpose (see
 * `agreement-lock-order.spec.ts`): it locks every agreement a customer's
 * import will touch first, then replaces the same day-rule rows as a nested
 * write. Two orders over the same two resources — the agreement row and its
 * day-rule rows — is exactly the shape that deadlocks: whichever side
 * reaches the day rules first blocks the side that already holds the
 * agreement, and the side already holding the agreement blocks the side
 * reaching for the day rules. Postgres resolves the cycle by killing one
 * transaction, which reaches a manager as a 500 on an ordinary edit.
 *
 * `AgreementsService.update` now calls `lockAgreementRows(tx, [id])` before
 * either `deleteMany`, so a manager's edit racing a re-import queues behind
 * whichever got there first instead of meeting it head on.
 *
 * The interleaving is forced rather than raced, the same way
 * `agreement-lock-order.spec.ts` forces the importer's own pause: a second
 * connection holds the agreement's one day-rule row `FOR UPDATE`, which parks
 * the re-import holding the agreement and waiting on that row. The edit is
 * only asserted to be *waiting for the agreement* — not the day-rule row —
 * which is the one difference the fix makes.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  BranchCode,
  DataProvenance,
  DayRuleKind,
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
  email: `agreement-edit-race-${suffix}@ultrakil.test`,
  password: 'agreement-edit-race-password',
};
const CUSTOMER = `Agreement Edit Race Client ${suffix}`;
const SITE = `Agreement Edit Race Site ${suffix}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let app: INestApplication;
let http: string;
let token: string;
const auth = () => ({ Authorization: `Bearer ${token}` });

function workbook(allowedDays: Weekday[]): ParsedSchedule {
  return {
    customers: [
      {
        name: CUSTOMER,
        sourceSheet: 'EDIT-RACE',
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
            treatmentCodes: ['GPC'],
            frequency: {
              kind: 'parsed' as const,
              frequency: { count: 1, unit: FrequencyUnit.WEEK, interval: 1 },
              source: 'Weekly',
            },
            dayRule: { kind: 'parsed' as const, allowedDays, source: 'Weekly' },
            effort: { durationMinutes: 90, crewSize: 2 },
            endDate: null,
            bookedDates: [],
            notes: null,
            isServiced: true,
          },
        ],
      },
    ],
    issues: [],
    sheetSummary: [{ sheet: 'EDIT-RACE', rows: 1, sites: 1 }],
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
      fullName: 'Agreement Edit Race Admin',
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
  await prisma.jobType.deleteMany({ where: { code: `GPC` } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { email: ADMIN.email } });
  await prisma.$disconnect();
  await other.$disconnect();
  await app.close();
}, 120_000);

it('queues a manager editing an agreement behind a re-import over the same agreement, instead of deadlocking', async () => {
  await importSchedule(prisma, workbook([Weekday.MONDAY]));

  const customer = await prisma.customer.findFirstOrThrow({ where: { name: CUSTOMER } });
  const site = await prisma.serviceSite.findFirstOrThrow({ where: { customerId: customer.id } });
  const agreement = await prisma.serviceAgreement.findFirstOrThrow({
    where: { customerId: customer.id },
  });

  // Neither the re-import nor the manager's edit writes site hours, and
  // `AgreementsService.update` refuses to save a day nothing can be served
  // on. Cover every day either side will ask for.
  await prisma.siteOperatingHours.createMany({
    data: [Weekday.MONDAY, Weekday.TUESDAY, Weekday.WEDNESDAY].map((weekday) => ({
      serviceSiteId: site.id,
      weekday,
      opensAtMinute: 8 * 60,
      closesAtMinute: 17 * 60,
      provenance: DataProvenance.MANAGER_CONFIRMED,
    })),
  });

  const dayRule = await prisma.serviceAgreementDayRule.findFirstOrThrow({
    where: { serviceAgreementId: agreement.id, kind: DayRuleKind.ALLOWED },
  });

  // The pause point: hold the agreement's one day-rule row externally, so
  // whichever side reaches it blocks there instead of racing through.
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
      await tx.$executeRaw`SELECT id FROM service_agreement_day_rules WHERE id = ${dayRule.id}::uuid FOR UPDATE`;
      acquired();
      await mayRelease;
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
  await isHeld;

  // The re-import: locks the agreement first (uncontended, it is the only
  // agreement this customer has), then blocks replacing its day rules —
  // exactly the state a real re-import lands in while a manager edits the
  // same agreement.
  let importError: unknown;
  const importing = importSchedule(prisma, workbook([Weekday.TUESDAY])).catch(
    (error: unknown) => {
      importError = error;
    },
  );
  await waitUntilBlockedOn('service_agreement_day_rules');

  // The manager's edit. Fixed, it locks the agreement before it deletes
  // anything, so it queues behind the import's already-held lock rather than
  // reaching past it for the day-rule row the import is waiting on — the
  // opposite-direction wait that deadlocked before the fix. If it instead
  // raced ahead to delete the day rules first, it would block on
  // 'service_agreement_day_rules' below and this assertion would time out.
  let patchError: unknown;
  const patch = request(http)
    .patch(`/api/service-agreements/${agreement.id}`)
    .set(auth())
    .send({ allowedDays: [Weekday.WEDNESDAY] })
    .then((response) => response)
    .catch((error: unknown) => {
      patchError = error;
      return { status: -1, body: {} } as unknown as request.Response;
    });
  await waitUntilBlockedOn('service_agreements');
  release();

  const [response] = await Promise.all([patch, importing, holder]);

  // Neither side is a deadlock victim: the import commits, and the edit goes
  // through as soon as it does.
  expect(importError).toBeUndefined();
  expect(patchError).toBeUndefined();
  expect(response.status).toBe(200);

  // The edit ran after the import committed, so it is the final word.
  const finalRules = await prisma.serviceAgreementDayRule.findMany({
    where: { serviceAgreementId: agreement.id, kind: DayRuleKind.ALLOWED },
  });
  expect(finalRules.map((rule) => rule.weekday)).toEqual([Weekday.WEDNESDAY]);
}, 180_000);

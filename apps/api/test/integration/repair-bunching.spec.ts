/**
 * `POST /visit-generation/repair-bunching` — the "zero-surprise repair plan"
 * the Technical Director's review asked for: existing current/future
 * generated data has to be brought in line with the crew-minutes cap
 * (`repair-bunching-and-capacity.md` / the capacity-aware feasibility PR
 * comment), without rewriting history and without ever touching booked,
 * published, locked or hand-adjusted work.
 *
 * The fixture simulates exactly what shipped before this branch: several
 * agreements' visits landing on the same day under a cap loose enough to
 * allow it — built here with a `VisitGenerationService` instance whose
 * config is overridden to an enormous cap, so nothing spreads, the same
 * technique `visit-generation.spec.ts` already uses to force a small one.
 * The repair call itself drives the real HTTP endpoint, wired to the app's
 * real (default) cap, so what is proven is the production code path.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { BranchCode, PrismaClient, UserRole, Weekday } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { AuditService } from '../../src/audit/audit.service';
import { AuthService } from '../../src/auth/auth.service';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { PrismaService } from '../../src/prisma/prisma.service';
import { VisitGenerationService } from '../../src/scheduling/visit-generation/visit-generation.service';

const prisma = new PrismaClient();
const suffix = Math.random().toString(36).slice(2, 8);
const ADMIN = {
  email: `repair-bunching-${suffix}@ultrakil.test`,
  password: 'repair-bunching-password',
};

let app: INestApplication;
let http: string;
let token: string;
let customerId: string;
let siteId: string;
let jobTypeId: string;
let actor: { id: string; email: string; fullName: string; role: UserRole };
const auth = () => ({ Authorization: `Bearer ${token}` });

/** The service reads the real clock, so every date is relative to it. */
const TODAY = new Date().toISOString().slice(0, 10);
const addDays = (date: string, days: number) =>
  new Date(new Date(`${date}T00:00:00.000Z`).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

/** The first Wednesday from today onward — a real, stable "bunching day". */
function nextWeekday(from: string, weekday: number): string {
  let cursor = from;
  while (new Date(`${cursor}T00:00:00.000Z`).getUTCDay() !== weekday) {
    cursor = addDays(cursor, 1);
  }
  return cursor;
}
const BUNCH_DAY = nextWeekday(TODAY, 3); // Wednesday

const agreementIds: string[] = [];

async function createAgreement(label: string): Promise<string> {
  const res = await request(http)
    .post('/api/service-agreements')
    .set(auth())
    .send({
      serviceSiteId: siteId,
      jobTypeId,
      frequencyCount: 1,
      frequencyUnit: 'WEEK',
      // Both allowed, so the guard has somewhere to spread the overflow to —
      // exactly the same requirement the load-guard tests already document.
      allowedDays: [Weekday.WEDNESDAY, Weekday.THURSDAY],
      preferredDays: [Weekday.WEDNESDAY],
      startDate: BUNCH_DAY,
      // Three crew-hours each: four fit inside the default 720-crew-minute
      // cap, a fifth does not. Six of them is comfortably over.
      durationMinutes: 180,
      crewSize: 1,
      notes: label,
    });
  expect(res.status).toBe(201);
  agreementIds.push(res.body.id);
  return res.body.id as string;
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
  await prisma.branch.upsert({
    where: { code: BranchCode.COLOMBO },
    create: { code: BranchCode.COLOMBO, name: 'COLOMBO Branch' },
    update: {},
  });
  await prisma.user.upsert({
    where: { email: ADMIN.email },
    create: {
      email: ADMIN.email,
      fullName: 'Repair Bunching Admin',
      role: UserRole.ADMIN,
      passwordHash: await AuthService.hashPassword(ADMIN.password),
    },
    update: { role: UserRole.ADMIN, isActive: true },
  });
  const login = await request(http)
    .post('/api/auth/login')
    .send({ email: ADMIN.email, password: ADMIN.password });
  token = login.body.accessToken as string;
  actor = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN.email } });

  const jobType = await request(http)
    .post('/api/job-types')
    .set(auth())
    .send({ code: `REPAIR_${suffix}`, name: 'Repair Bunching Job', defaultCrewSize: 1 });
  jobTypeId = jobType.body.id;

  const customer = await request(http)
    .post('/api/customers')
    .set(auth())
    .send({ name: `Repair Bunching Client ${suffix}`, branchCode: BranchCode.COLOMBO });
  customerId = customer.body.id;

  const site = await request(http)
    .post(`/api/customers/${customerId}/sites`)
    .set(auth())
    .send({
      name: `Repair Bunching Site ${suffix}`,
      branchCode: BranchCode.COLOMBO,
      operatingHours: [Weekday.WEDNESDAY, Weekday.THURSDAY].map((weekday) => ({
        weekday,
        opensAtMinute: 480,
        closesAtMinute: 1080,
      })),
    });
  siteId = site.body.id;
}, 300_000);

afterAll(async () => {
  const agreements = await prisma.serviceAgreement.findMany({
    where: { customerId },
    select: { id: true },
  });
  const ids = agreements.map((a) => a.id);
  await prisma.generatedVisit.deleteMany({ where: { serviceAgreementId: { in: ids } } });
  await prisma.serviceAgreement.deleteMany({ where: { id: { in: ids } } });
  await prisma.siteOperatingHours.deleteMany({ where: { serviceSiteId: siteId } });
  await prisma.serviceSite.deleteMany({ where: { customerId } });
  await prisma.customer.delete({ where: { id: customerId } });
  await prisma.jobType.deleteMany({ where: { code: `REPAIR_${suffix}` } });
  await prisma.user.deleteMany({ where: { email: ADMIN.email } });
  await prisma.$disconnect();
  await app.close();
}, 120_000);

it('moves an agreement\'s own unbooked visits off a day the crew-minutes cap no longer allows, and never touches protected work', async () => {
  for (let index = 0; index < 6; index += 1) {
    await createAgreement(`bunch-${index}`);
  }

  // Simulate what shipped before this branch: every one of the six planned
  // straight onto the same Wednesday, under a cap loose enough to allow it.
  const looseCap = new VisitGenerationService(
    app.get(PrismaService),
    app.get(AuditService),
    { get: (key: string) => (key === 'visitGeneration.dailyCapacityMinutes' ? 999_999 : undefined) } as unknown as ConfigService,
  );
  const horizon = { from: BUNCH_DAY, to: addDays(BUNCH_DAY, 6) };
  await looseCap.confirm({ ...horizon, serviceAgreementIds: agreementIds }, actor);

  const before = await prisma.generatedVisit.findMany({
    where: { serviceAgreementId: { in: agreementIds } },
  });
  expect(before).toHaveLength(6);
  expect(before.every((visit) => visit.visitDate.toISOString().slice(0, 10) === BUNCH_DAY)).toBe(
    true,
  );

  // One of the six is a manager's own decision — hand-adjusted, and
  // therefore the repair's to leave alone no matter how full its day is.
  const protectedVisit = before[0];
  // Captured straight from this update, so it is a genuine pre-repair
  // baseline — not a value re-read after the repair call runs, which would
  // only prove two reads of the same row agree with each other.
  const protectedBeforeRepair = await prisma.generatedVisit.update({
    where: { id: protectedVisit.id },
    data: { isManuallyAdjusted: true },
  });

  // The real endpoint, wired to the app's real (default) crew-minutes cap.
  const repaired = await request(http)
    .post('/api/visit-generation/repair-bunching')
    .set(auth())
    .send({ serviceAgreementIds: agreementIds });
  expect(repaired.status).toBe(200);

  const after = await prisma.generatedVisit.findMany({
    where: { serviceAgreementId: { in: agreementIds } },
  });
  expect(after).toHaveLength(6);

  const onBunchDay = after.filter(
    (visit) => visit.visitDate.toISOString().slice(0, 10) === BUNCH_DAY,
  );
  const onThursday = after.filter(
    (visit) => visit.visitDate.toISOString().slice(0, 10) === addDays(BUNCH_DAY, 1),
  );
  // Every visit is still one of the two allowed days.
  expect(onBunchDay.length + onThursday.length).toBe(6);
  // The bunch day itself is at or under the cap: at most four of the
  // hundred-and-eighty-minute visits (four are exactly seven hundred and
  // twenty). Sequential per-agreement repair does not promise the fewest
  // possible moves, only that no day it touches is left over the cap.
  expect(onBunchDay.length).toBeLessThanOrEqual(4);
  expect(onBunchDay.length).toBeGreaterThan(0);
  expect(onBunchDay.map((visit) => visit.id)).toEqual(
    expect.arrayContaining([protectedVisit.id]),
  );

  // The protected visit itself: same id, same date, same revision. Compared
  // against the row as it stood right after being marked hand-adjusted —
  // strictly before the repair call ran — so this actually proves the
  // repair never touched it, not merely that two post-repair reads agree.
  const stillProtected = after.find((visit) => visit.id === protectedVisit.id)!;
  expect(stillProtected.visitDate.getTime()).toBe(protectedBeforeRepair.visitDate.getTime());
  expect(stillProtected.updatedAt.getTime()).toBe(protectedBeforeRepair.updatedAt.getTime());

  // `stillOverCap` is not asserted here: the shared integration database
  // holds hundreds of other suites' own stray fixtures that are never
  // cleaned up (documented in `rolling-horizon.spec.ts`), and BUNCH_DAY —
  // deterministically "the next Wednesday from today" — is exactly the kind
  // of date several of them land on too. A day genuinely still over cap
  // because of agreements outside this call's own scope is correct,
  // honestly-reported behaviour, not something this test's own fixture
  // controls. What this test owns and can assert is the database state
  // above: its own six visits, and that at most four of them share the day.
  expect(repaired.body.agreementsRepaired.length).toBeGreaterThan(0);
  for (const entry of repaired.body.agreementsRepaired) {
    expect(agreementIds).toContain(entry.serviceAgreementId);
    expect(entry.visitsMoved).toBeGreaterThan(0);
  }

  // Idempotent: nothing left to move.
  const second = await request(http)
    .post('/api/visit-generation/repair-bunching')
    .set(auth())
    .send({ serviceAgreementIds: agreementIds });
  expect(second.status).toBe(200);
  expect(second.body.agreementsRepaired).toEqual([]);

  const settled = await prisma.generatedVisit.findMany({
    where: { serviceAgreementId: { in: agreementIds } },
    orderBy: { id: 'asc' },
    select: { id: true, visitDate: true },
  });
  // Not merely six visits again, but the exact same six dates the first
  // repair already settled on — the second call moved nothing.
  expect(settled.map((visit) => visit.visitDate.getTime()).sort()).toEqual(
    after.map((visit) => visit.visitDate.getTime()).sort(),
  );
}, 180_000);

it('reports a day it cannot fix because every visit still on it is protected', async () => {
  const day = addDays(BUNCH_DAY, 14);
  const stubbornAgreements: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    const res = await request(http)
      .post('/api/service-agreements')
      .set(auth())
      .send({
        serviceSiteId: siteId,
        jobTypeId,
        frequencyCount: 1,
        frequencyUnit: 'WEEK',
        // Wednesday only: nowhere for the guard to spread the overflow to,
        // so the day the repair inherits is one it can only report.
        allowedDays: [Weekday.WEDNESDAY],
        startDate: day,
        durationMinutes: 180,
        crewSize: 1,
      });
    expect(res.status).toBe(201);
    stubbornAgreements.push(res.body.id);
  }
  agreementIds.push(...stubbornAgreements);

  const looseCap = new VisitGenerationService(
    app.get(PrismaService),
    app.get(AuditService),
    { get: (key: string) => (key === 'visitGeneration.dailyCapacityMinutes' ? 999_999 : undefined) } as unknown as ConfigService,
  );
  await looseCap.confirm(
    { from: day, to: addDays(day, 6), serviceAgreementIds: stubbornAgreements },
    actor,
  );
  // Every one of the five hand-adjusted, so none can move.
  await prisma.generatedVisit.updateMany({
    where: { serviceAgreementId: { in: stubbornAgreements } },
    data: { isManuallyAdjusted: true },
  });

  const repaired = await request(http)
    .post('/api/visit-generation/repair-bunching')
    .set(auth())
    .send({ serviceAgreementIds: stubbornAgreements });
  expect(repaired.status).toBe(200);
  expect(repaired.body.agreementsRepaired).toEqual([]);
  expect(repaired.body.stillOverCap).toEqual(
    expect.arrayContaining([expect.objectContaining({ date: day, branchCode: BranchCode.COLOMBO })]),
  );

  const stillThere = await prisma.generatedVisit.count({
    where: { serviceAgreementId: { in: stubbornAgreements } },
  });
  expect(stillThere).toBe(5);
}, 180_000);

/**
 * `POST /visit-generation/repair-bunching/plan` and `.../apply` — the
 * "zero-surprise repair" the Technical Director's review asked for:
 * existing current/future generated data has to be brought in line with the
 * crew-minutes cap (`repair-bunching-and-capacity.md` / the capacity-aware
 * feasibility PR comment) without rewriting history, without ever touching
 * booked, published, locked or hand-adjusted work, and — the review's own
 * addition — without mutating anything until an administrator has reviewed
 * exactly what would move, confirmed it with a plan hash that proves the
 * review still matches the calendar, and in a way that is safe to repeat.
 *
 * The fixture simulates exactly what shipped before this branch: several
 * agreements' visits landing on the same day under a cap loose enough to
 * allow it — built here with a `VisitGenerationService` instance whose
 * config is overridden to an enormous cap, so nothing spreads, the same
 * technique `visit-generation.spec.ts` already uses to force a small one.
 * The plan and apply calls themselves drive the real HTTP endpoints, wired
 * to the app's real (default) cap, so what is proven is the production code
 * path.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { BranchCode, PrismaClient, UserRole, VisitStatus, Weekday } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { AuditService } from '../../src/audit/audit.service';
import { AuthService } from '../../src/auth/auth.service';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { PrismaService } from '../../src/prisma/prisma.service';
import { BranchDayCapacityService } from '../../src/scheduling/visit-generation/branch-day-capacity.service';
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

/**
 * A Wednesday on or after `BUNCH_DAY + fromOffset` whose Thursday can still
 * take one more visit of `visitMinutes`.
 *
 * Every fixture below is built on the premise `createAgreement` states: both
 * days are allowed, so the guard has somewhere to spread the overflow to. On
 * the shared integration database that premise stopped being a given.
 * Creating an agreement now plans a full twelve months of visits rather than
 * a month, so a suite that ran earlier can leave the neighbouring Thursday
 * sitting exactly at its cap — and on a Thursday with no room, "nothing could
 * be moved" is the repair's correct answer, not a regression in it. Choosing
 * the day rather than assuming it keeps these tests about the repair.
 */
async function wednesdayWithRoomNextDoor(
  fromOffset: number,
  visitMinutes: number,
): Promise<string> {
  const capacityService = app.get(BranchDayCapacityService);
  // A quarter of Wednesdays is far more than enough to find one, and bounded
  // so a genuinely saturated branch fails with a readable message rather than
  // looping.
  for (let offset = fromOffset; offset <= fromOffset + 13 * 7; offset += 7) {
    const thursday = addDays(BUNCH_DAY, offset + 1);
    const standing = await prisma.generatedVisit.findMany({
      where: {
        branchCode: BranchCode.COLOMBO,
        visitDate: new Date(`${thursday}T00:00:00.000Z`),
        status: { not: VisitStatus.CANCELLED },
      },
      select: { durationMinutes: true, requiredCrewSize: true },
    });
    const used = standing.reduce(
      (total, visit) => total + visit.durationMinutes * visit.requiredCrewSize,
      0,
    );
    const capacity = await capacityService.capacityFor(BranchCode.COLOMBO, thursday);
    if (capacity.capacityMinutes - used >= visitMinutes) return addDays(BUNCH_DAY, offset);
  }
  throw new Error(
    `No Wednesday from BUNCH_DAY+${fromOffset} onward has a Thursday with ${visitMinutes} free crew-minutes in COLOMBO.`,
  );
}

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
  // Agreement creation now automatically plans a scoped onboarding horizon.
  // This suite deliberately drives generation itself (via the loosened-cap
  // `VisitGenerationService` instance below) to simulate exactly what
  // shipped before the crew-minutes cap — the automatic side effect would
  // otherwise plant an extra, uncontrolled visit ahead of that setup.
  await prisma.generatedVisit.deleteMany({ where: { serviceAgreementId: res.body.id } });
  return res.body.id as string;
}

/**
 * A `BranchDayCapacityService` stand-in reporting the same fixed capacity
 * for any branch-day, regardless of real workforce data — the shared
 * integration database can carry other suites' own leftover employees on
 * COLOMBO, which would otherwise make the real, resource-derived capacity
 * path answer with whatever headcount is lying around rather than the huge,
 * deliberately-loosened figure this fixture needs.
 */
function fixedCapacity(minutes: number): BranchDayCapacityService {
  return {
    capacitiesFor: async (branchDays: { branchCode: BranchCode; date: string }[]) =>
      new Map(
        branchDays.map(({ branchCode, date }) => [
          `${branchCode}|${date}`,
          { branchCode, date, capacityMinutes: minutes, reason: null },
        ]),
      ),
    // The feasibility pass asks the same service what each branch-day can
    // actually do. This fixture is about a deliberately loosened *cap*, not
    // about starving the branch, so it reports a pool comfortably able to
    // perform whatever the fixture plans.
    workforcesFor: async (branchDays: { branchCode: BranchCode; date: string }[]) =>
      new Map(
        branchDays.map(({ branchCode, date }) => [
          `${branchCode}|${date}`,
          {
            totalEmployeeCount: 99,
            availableEmployeeCount: 99,
            availablePmsCount: 99,
            // Holds every skill, not none. An empty map means zero holders
            // for any code, which makes a day carrying *another* suite's
            // skill-requiring visit report SKILL_NOT_HELD and spread this
            // fixture's work off the day it is built around. The stub's whole
            // premise is a branch that can do anything.
            skillHolderCounts: { get: () => 99 } as unknown as Map<string, number>,
            activeVehicleCount: 99,
            driverCapableVehicleCount: 99,
            // 99 distinct unlimited-seat vehicles, each with its own distinct
            // driver, plus 99 distinct walkers — comfortably enough transport
            // for whatever crew sizes and concurrency this fixture's plans
            // ever put on one day, the same "can do anything" premise as
            // every other field here.
            vehicleResources: Array.from({ length: 99 }, (_, index) => ({
              id: `stub-vehicle-${index}`,
              seatCapacity: null,
              eligibleDriverIds: [`stub-driver-${index}`],
            })),
            availablePublicTransportEmployeeIds: Array.from(
              { length: 99 },
              (_, index) => `stub-walker-${index}`,
            ),
          },
        ]),
      ),
  } as unknown as BranchDayCapacityService;
}

/** A plan/apply request body for the given scope, filled in with the plan's own planHash. */
function applyBodyFor(
  scope: { serviceAgreementIds?: string[] },
  planHash: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    ...scope,
    planHash,
    confirmation: true,
    reason: 'ULK-C10 bunching repair integration test',
    idempotencyKey: randomUUID(),
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
  // This suite's own generated visits, cleared so the branch-days it used are
  // free for whatever runs after it. Generation now leaves work unplanned
  // rather than placing it on a day already at its cap, so a shared calendar
  // that every suite adds to and nobody clears eventually has no room left in
  // it for anybody.
  await prisma.generatedVisit.deleteMany({ where: { serviceAgreement: { jobTypeId } } });
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

it('plans, then applies, moving an agreement\'s own unbooked visits off a day the crew-minutes cap no longer allows — and never touches protected work', async () => {
  // The real endpoint below is now capacity-aware from COLOMBO's actual
  // workforce, not a flat constant — so how many agreements are needed to
  // genuinely exceed that day's capacity depends on real, shared-database
  // headcount rather than a number this fixture could hardcode. Asked once,
  // up front, from the same service the endpoint itself uses.
  const realCapacity = await app
    .get(BranchDayCapacityService)
    .capacityFor(BranchCode.COLOMBO, BUNCH_DAY);
  const visitMinutes = 180;
  const maxPerDay = Math.floor(realCapacity.capacityMinutes / visitMinutes);
  // Comfortably over: at least two more than the day can hold, so there is
  // always genuine work to move regardless of today's real headcount.
  const agreementCount = maxPerDay + 2;

  for (let index = 0; index < agreementCount; index += 1) {
    await createAgreement(`bunch-${index}`);
  }

  // Simulate what shipped before this branch: every one of them planned
  // straight onto the same Wednesday, under a cap loose enough to allow it.
  const looseCap = new VisitGenerationService(
    app.get(PrismaService),
    app.get(AuditService),
    { get: (key: string) => (key === 'visitGeneration.dailyCapacityMinutes' ? 999_999 : undefined) } as unknown as ConfigService,
    fixedCapacity(999_999),
  );
  const horizon = { from: BUNCH_DAY, to: addDays(BUNCH_DAY, 6) };
  await looseCap.confirm({ ...horizon, serviceAgreementIds: agreementIds }, actor);

  const before = await prisma.generatedVisit.findMany({
    where: { serviceAgreementId: { in: agreementIds } },
  });
  expect(before).toHaveLength(agreementCount);
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

  const scope = { serviceAgreementIds: agreementIds };

  // Plan writes nothing: the calendar right after plan is byte-for-byte the
  // one the fixture set up above.
  const planned = await request(http)
    .post('/api/visit-generation/repair-bunching/plan')
    .set(auth())
    .send(scope);
  expect(planned.status).toBe(200);
  expect(typeof planned.body.planHash).toBe('string');
  const stillOnBunchDayAfterPlan = await prisma.generatedVisit.findMany({
    where: { serviceAgreementId: { in: agreementIds } },
  });
  expect(
    stillOnBunchDayAfterPlan.every(
      (visit) => visit.visitDate.toISOString().slice(0, 10) === BUNCH_DAY,
    ),
  ).toBe(true);
  expect(planned.body.moves.length).toBeGreaterThan(0);
  for (const move of planned.body.moves) {
    expect(agreementIds).toContain(move.serviceAgreementId);
    expect(move.visitsMoved).toBeGreaterThan(0);
  }

  // The real endpoint, wired to the app's real (default) crew-minutes cap.
  const applied = await request(http)
    .post('/api/visit-generation/repair-bunching/apply')
    .set(auth())
    .send(applyBodyFor(scope, planned.body.planHash as string));
  expect(applied.status).toBe(200);
  expect(applied.body.replayed).toBe(false);

  const after = await prisma.generatedVisit.findMany({
    where: { serviceAgreementId: { in: agreementIds } },
  });
  expect(after).toHaveLength(agreementCount);

  const onBunchDay = after.filter(
    (visit) => visit.visitDate.toISOString().slice(0, 10) === BUNCH_DAY,
  );
  const onThursday = after.filter(
    (visit) => visit.visitDate.toISOString().slice(0, 10) === addDays(BUNCH_DAY, 1),
  );
  // Every visit is still one of the two allowed days.
  expect(onBunchDay.length + onThursday.length).toBe(agreementCount);
  // The bunch day itself is at or under the cap this branch's real
  // workforce actually carries — `maxPerDay` many of the hundred-and-eighty-
  // minute visits fit, one more would not. Sequential per-agreement repair
  // does not promise the fewest possible moves, only that no day it touches
  // is left over the cap; the protected visit staying is the one exception
  // the cap itself does not govern, so it can hold the count at 1 even on
  // the rare real-world day capacity comes out to zero.
  expect(onBunchDay.length).toBeLessThanOrEqual(Math.max(maxPerDay, 1));
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
  expect(applied.body.agreementsRepaired.length).toBeGreaterThan(0);
  for (const entry of applied.body.agreementsRepaired) {
    expect(agreementIds).toContain(entry.serviceAgreementId);
    expect(entry.visitsMoved).toBeGreaterThan(0);
  }

  // Idempotent end-to-end: a fresh plan over the now-settled calendar finds
  // nothing left to move, and applying it (a different idempotency key —
  // this is a distinct plan/apply round, not a replay of the one above)
  // changes nothing further.
  const secondPlan = await request(http)
    .post('/api/visit-generation/repair-bunching/plan')
    .set(auth())
    .send(scope);
  expect(secondPlan.status).toBe(200);
  expect(secondPlan.body.moves).toEqual([]);

  const secondApply = await request(http)
    .post('/api/visit-generation/repair-bunching/apply')
    .set(auth())
    .send(applyBodyFor(scope, secondPlan.body.planHash as string));
  expect(secondApply.status).toBe(200);
  expect(secondApply.body.agreementsRepaired).toEqual([]);
  expect(secondApply.body.replayed).toBe(false);

  const settled = await prisma.generatedVisit.findMany({
    where: { serviceAgreementId: { in: agreementIds } },
    orderBy: { id: 'asc' },
    select: { id: true, visitDate: true },
  });
  // Not merely six visits again, but the exact same six dates the first
  // repair already settled on — the second round moved nothing.
  expect(settled.map((visit) => visit.visitDate.getTime()).sort()).toEqual(
    after.map((visit) => visit.visitDate.getTime()).sort(),
  );
}, 180_000);

it('reports a day it cannot fix because every visit still on it is protected', async () => {
  const day = addDays(BUNCH_DAY, 14);
  // Same reasoning as the test above: enough agreements to genuinely exceed
  // this branch's real capacity that day, whatever today's real headcount is.
  const realCapacity = await app
    .get(BranchDayCapacityService)
    .capacityFor(BranchCode.COLOMBO, day);
  const stubbornCount = Math.floor(realCapacity.capacityMinutes / 180) + 1;
  const stubbornAgreements: string[] = [];
  for (let index = 0; index < stubbornCount; index += 1) {
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
    // Same automatic-onboarding side effect noted on `createAgreement()`
    // above: this test drives its own loosened-cap generation below.
    await prisma.generatedVisit.deleteMany({ where: { serviceAgreementId: res.body.id } });
  }
  agreementIds.push(...stubbornAgreements);

  const looseCap = new VisitGenerationService(
    app.get(PrismaService),
    app.get(AuditService),
    { get: (key: string) => (key === 'visitGeneration.dailyCapacityMinutes' ? 999_999 : undefined) } as unknown as ConfigService,
    fixedCapacity(999_999),
  );
  await looseCap.confirm(
    { from: day, to: addDays(day, 6), serviceAgreementIds: stubbornAgreements },
    actor,
  );
  // Every one of them hand-adjusted, so none can move.
  await prisma.generatedVisit.updateMany({
    where: { serviceAgreementId: { in: stubbornAgreements } },
    data: { isManuallyAdjusted: true },
  });

  const scope = { serviceAgreementIds: stubbornAgreements };
  const planned = await request(http)
    .post('/api/visit-generation/repair-bunching/plan')
    .set(auth())
    .send(scope);
  expect(planned.status).toBe(200);
  expect(planned.body.moves).toEqual([]);
  expect(planned.body.stillOverCap).toEqual(
    expect.arrayContaining([expect.objectContaining({ date: day, branchCode: BranchCode.COLOMBO })]),
  );

  const applied = await request(http)
    .post('/api/visit-generation/repair-bunching/apply')
    .set(auth())
    .send(applyBodyFor(scope, planned.body.planHash as string));
  expect(applied.status).toBe(200);
  expect(applied.body.agreementsRepaired).toEqual([]);
  expect(applied.body.stillOverCap).toEqual(
    expect.arrayContaining([expect.objectContaining({ date: day, branchCode: BranchCode.COLOMBO })]),
  );

  const stillThere = await prisma.generatedVisit.count({
    where: { serviceAgreementId: { in: stubbornAgreements } },
  });
  expect(stillThere).toBe(stubbornCount);
}, 180_000);

it('replays an apply repeated with the same idempotency key instead of moving anything twice', async () => {
  const visitMinutes = 180;
  const day = await wednesdayWithRoomNextDoor(21, visitMinutes);
  const realCapacity = await app.get(BranchDayCapacityService).capacityFor(BranchCode.COLOMBO, day);
  const count = Math.floor(realCapacity.capacityMinutes / visitMinutes) + 2;
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const res = await request(http)
      .post('/api/service-agreements')
      .set(auth())
      .send({
        serviceSiteId: siteId,
        jobTypeId,
        frequencyCount: 1,
        frequencyUnit: 'WEEK',
        allowedDays: [Weekday.WEDNESDAY, Weekday.THURSDAY],
        preferredDays: [Weekday.WEDNESDAY],
        startDate: day,
        durationMinutes: visitMinutes,
        crewSize: 1,
      });
    expect(res.status).toBe(201);
    ids.push(res.body.id);
    await prisma.generatedVisit.deleteMany({ where: { serviceAgreementId: res.body.id } });
  }
  agreementIds.push(...ids);

  const looseCap = new VisitGenerationService(
    app.get(PrismaService),
    app.get(AuditService),
    { get: (key: string) => (key === 'visitGeneration.dailyCapacityMinutes' ? 999_999 : undefined) } as unknown as ConfigService,
    fixedCapacity(999_999),
  );
  await looseCap.confirm({ from: day, to: addDays(day, 6), serviceAgreementIds: ids }, actor);

  const scope = { serviceAgreementIds: ids };
  const planned = await request(http)
    .post('/api/visit-generation/repair-bunching/plan')
    .set(auth())
    .send(scope);
  expect(planned.status).toBe(200);
  expect(planned.body.moves.length).toBeGreaterThan(0);

  const body = applyBodyFor(scope, planned.body.planHash as string);
  const first = await request(http)
    .post('/api/visit-generation/repair-bunching/apply')
    .set(auth())
    .send(body);
  expect(first.status).toBe(200);
  expect(first.body.replayed).toBe(false);
  expect(first.body.agreementsRepaired.length).toBeGreaterThan(0);

  const afterFirst = await prisma.generatedVisit.findMany({
    where: { serviceAgreementId: { in: ids } },
    orderBy: { id: 'asc' },
    select: { id: true, visitDate: true, updatedAt: true },
  });

  // The exact same request body — same idempotencyKey, same everything —
  // repeated. A genuine second apply would find the calendar already
  // settled and simply move nothing; replay proves something stronger: no
  // second write was attempted at all.
  const second = await request(http)
    .post('/api/visit-generation/repair-bunching/apply')
    .set(auth())
    .send(body);
  expect(second.status).toBe(200);
  expect(second.body.replayed).toBe(true);
  expect(second.body.agreementsRepaired).toEqual(first.body.agreementsRepaired);
  expect(second.body.planHash).toBe(first.body.planHash);

  const afterSecond = await prisma.generatedVisit.findMany({
    where: { serviceAgreementId: { in: ids } },
    orderBy: { id: 'asc' },
    select: { id: true, visitDate: true, updatedAt: true },
  });
  // Not merely the same dates: the same revisions — nothing was written a
  // second time, which a same-outcome-different-write repair could still
  // satisfy but a true replay must not.
  expect(afterSecond).toEqual(afterFirst);
}, 180_000);

/**
 * Builds a bunched day and returns the ids plus a reviewed plan hash, so the
 * two durability tests below start from the same real over-cap calendar the
 * other tests use rather than a contrived one.
 */
async function bunchedScopeFor(dayOffset: number, visitMinutes = 180) {
  const day = await wednesdayWithRoomNextDoor(dayOffset, visitMinutes);
  const realCapacity = await app.get(BranchDayCapacityService).capacityFor(BranchCode.COLOMBO, day);
  const count = Math.floor(realCapacity.capacityMinutes / visitMinutes) + 2;
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const res = await request(http)
      .post('/api/service-agreements')
      .set(auth())
      .send({
        serviceSiteId: siteId,
        jobTypeId,
        frequencyCount: 1,
        frequencyUnit: 'WEEK',
        allowedDays: [Weekday.WEDNESDAY, Weekday.THURSDAY],
        preferredDays: [Weekday.WEDNESDAY],
        startDate: day,
        durationMinutes: visitMinutes,
        crewSize: 1,
      });
    expect(res.status).toBe(201);
    ids.push(res.body.id);
    await prisma.generatedVisit.deleteMany({ where: { serviceAgreementId: res.body.id } });
  }
  agreementIds.push(...ids);

  const looseCap = new VisitGenerationService(
    app.get(PrismaService),
    app.get(AuditService),
    { get: (key: string) => (key === 'visitGeneration.dailyCapacityMinutes' ? 999_999 : undefined) } as unknown as ConfigService,
    fixedCapacity(999_999),
  );
  await looseCap.confirm({ from: day, to: addDays(day, 6), serviceAgreementIds: ids }, actor);

  const scope = { serviceAgreementIds: ids };
  const planned = await request(http)
    .post('/api/visit-generation/repair-bunching/plan')
    .set(auth())
    .send(scope);
  expect(planned.status).toBe(200);
  expect(planned.body.moves.length).toBeGreaterThan(1);
  return { scope, planHash: planned.body.planHash as string, moves: planned.body.moves.length };
}

it('records what a part-way failure already moved, instead of leaving it unrecorded', async () => {
  const { scope, planHash, moves } = await bunchedScopeFor(28);
  const service = app.get(VisitGenerationService);
  const idempotencyKey = randomUUID();

  // Fail the apply mid-loop, after the first agreement has genuinely moved.
  // This is the case the review named: the ledger used to be written only
  // after every move, so a failure here left the calendar changed with
  // nothing at all recording it.
  const realConfirm = service.confirm.bind(service);
  let calls = 0;
  const spy = jest
    .spyOn(service, 'confirm')
    .mockImplementation(async (input: Parameters<typeof realConfirm>[0], who) => {
      calls += 1;
      if (calls > 1) throw new Error('forced failure partway through the repair');
      return realConfirm(input, who);
    });

  try {
    await expect(
      service.applyBunchingRepair(actor, {
        ...scope,
        planHash,
        confirmation: true,
        reason: 'forced-failure durability test',
        idempotencyKey,
      }),
    ).rejects.toThrow('forced failure partway through the repair');
  } finally {
    spy.mockRestore();
  }

  expect(calls).toBeGreaterThan(1);
  expect(moves).toBeGreaterThan(1);

  const batch = await prisma.repairBunchingBatch.findUniqueOrThrow({
    where: { idempotencyKey },
  });

  // The whole point: the row exists, it is not pretending to have succeeded,
  // and it names exactly what did land.
  expect(batch.status).toBe('FAILED');
  expect(batch.result).toBeNull();
  expect(batch.failureReason).toContain('forced failure');
  expect(batch.completedAt).not.toBeNull();

  const applied = batch.appliedMoves as { serviceAgreementId: string }[];
  expect(applied.length).toBe(1);

  // And the move it records is a move that really happened — the ledger is
  // not merely non-empty, it agrees with the calendar.
  const movedAgreement = applied[0].serviceAgreementId;
  const visits = await prisma.generatedVisit.findMany({
    where: { serviceAgreementId: movedAgreement },
  });
  expect(visits.length).toBeGreaterThan(0);
}, 180_000);

it('lets only one of two concurrent applies sharing an idempotency key move anything', async () => {
  const { scope, planHash } = await bunchedScopeFor(35);
  const service = app.get(VisitGenerationService);
  const idempotencyKey = randomUUID();
  const body = {
    ...scope,
    planHash,
    confirmation: true,
    reason: 'same-key concurrency test',
    idempotencyKey,
  };

  // Fired together, not in sequence. Before the key was claimed up front,
  // both of these could run the entire move loop and only the final insert
  // decided a winner — which is to say, both moved work.
  const [first, second] = await Promise.allSettled([
    service.applyBunchingRepair(actor, body),
    service.applyBunchingRepair(actor, body),
  ]);

  const settled = [first, second];
  const fulfilled = settled.filter((outcome) => outcome.status === 'fulfilled');
  const rejected = settled.filter((outcome) => outcome.status === 'rejected');

  // Exactly one applies. The loser is refused rather than silently repeating
  // the work: it arrived while the winner still held the key.
  expect(fulfilled.length).toBe(1);
  expect(rejected.length).toBe(1);

  const batches = await prisma.repairBunchingBatch.findMany({ where: { idempotencyKey } });
  expect(batches.length).toBe(1);
  expect(batches[0].status).toBe('COMPLETED');
}, 180_000);

it('rejects reusing an idempotency key for a materially different apply request', async () => {
  const day = addDays(BUNCH_DAY, 28);
  const res = await request(http)
    .post('/api/service-agreements')
    .set(auth())
    .send({
      serviceSiteId: siteId,
      jobTypeId,
      frequencyCount: 1,
      frequencyUnit: 'WEEK',
      allowedDays: [Weekday.WEDNESDAY],
      startDate: day,
      durationMinutes: 60,
      crewSize: 1,
    });
  expect(res.status).toBe(201);
  agreementIds.push(res.body.id);
  await prisma.generatedVisit.deleteMany({ where: { serviceAgreementId: res.body.id } });

  const scope = { serviceAgreementIds: [res.body.id] };
  const planned = await request(http)
    .post('/api/visit-generation/repair-bunching/plan')
    .set(auth())
    .send(scope);
  expect(planned.status).toBe(200);

  const sharedKey = randomUUID();
  const first = await request(http)
    .post('/api/visit-generation/repair-bunching/apply')
    .set(auth())
    .send(applyBodyFor(scope, planned.body.planHash as string, { idempotencyKey: sharedKey }));
  expect(first.status).toBe(200);

  // Same key, but a different reason — the same "the key names one request"
  // guarantee `published-assignment-repair` already gives assignment repairs.
  const reused = await request(http)
    .post('/api/visit-generation/repair-bunching/apply')
    .set(auth())
    .send(
      applyBodyFor(scope, planned.body.planHash as string, {
        idempotencyKey: sharedKey,
        reason: 'a completely different reason',
      }),
    );
  expect(reused.status).toBe(409);
  expect(reused.body.code).toBe('RESOURCE_CONFLICT');
}, 180_000);

it('refuses to apply a plan the calendar has moved past since it was reviewed', async () => {
  const visitMinutes = 180;
  const day = await wednesdayWithRoomNextDoor(35, visitMinutes);
  const realCapacity = await app.get(BranchDayCapacityService).capacityFor(BranchCode.COLOMBO, day);
  const count = Math.floor(realCapacity.capacityMinutes / visitMinutes) + 2;
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const res = await request(http)
      .post('/api/service-agreements')
      .set(auth())
      .send({
        serviceSiteId: siteId,
        jobTypeId,
        frequencyCount: 1,
        frequencyUnit: 'WEEK',
        allowedDays: [Weekday.WEDNESDAY, Weekday.THURSDAY],
        preferredDays: [Weekday.WEDNESDAY],
        startDate: day,
        durationMinutes: visitMinutes,
        crewSize: 1,
      });
    expect(res.status).toBe(201);
    ids.push(res.body.id);
    await prisma.generatedVisit.deleteMany({ where: { serviceAgreementId: res.body.id } });
  }
  agreementIds.push(...ids);

  const looseCap = new VisitGenerationService(
    app.get(PrismaService),
    app.get(AuditService),
    { get: (key: string) => (key === 'visitGeneration.dailyCapacityMinutes' ? 999_999 : undefined) } as unknown as ConfigService,
    fixedCapacity(999_999),
  );
  await looseCap.confirm({ from: day, to: addDays(day, 6), serviceAgreementIds: ids }, actor);

  const scope = { serviceAgreementIds: ids };
  const planned = await request(http)
    .post('/api/visit-generation/repair-bunching/plan')
    .set(auth())
    .send(scope);
  expect(planned.status).toBe(200);
  expect(planned.body.moves.length).toBeGreaterThan(0);

  // The calendar moves after the plan was reviewed but before it is
  // applied: a manager hand-adjusts one of the very visits the plan was
  // about to move. Nothing about the request below changes — this is
  // exactly the race the plan-hash check exists to catch.
  const toProtect = await prisma.generatedVisit.findFirst({
    where: { serviceAgreementId: { in: ids } },
    orderBy: { visitDate: 'asc' },
  });
  await prisma.generatedVisit.update({
    where: { id: toProtect!.id },
    data: { isManuallyAdjusted: true },
  });

  const applied = await request(http)
    .post('/api/visit-generation/repair-bunching/apply')
    .set(auth())
    .send(applyBodyFor(scope, planned.body.planHash as string));
  expect(applied.status).toBe(409);
  expect(applied.body.code).toBe('RESOURCE_CONFLICT');

  // Refused wholesale: not one visit skipped and the rest applied, nothing
  // moved at all.
  const untouched = await prisma.generatedVisit.findMany({
    where: { serviceAgreementId: { in: ids } },
  });
  expect(untouched.every((visit) => visit.visitDate.toISOString().slice(0, 10) === day)).toBe(
    true,
  );

  // A fresh plan now describes the calendar as it actually stands, and that
  // one applies cleanly.
  const replanned = await request(http)
    .post('/api/visit-generation/repair-bunching/plan')
    .set(auth())
    .send(scope);
  expect(replanned.status).toBe(200);
  expect(replanned.body.planHash).not.toBe(planned.body.planHash);

  const reapplied = await request(http)
    .post('/api/visit-generation/repair-bunching/apply')
    .set(auth())
    .send(applyBodyFor(scope, replanned.body.planHash as string));
  expect(reapplied.status).toBe(200);
  expect(reapplied.body.agreementsRepaired.length).toBeGreaterThan(0);
}, 180_000);

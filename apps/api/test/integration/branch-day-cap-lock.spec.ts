/**
 * The daily cap under two writers at once.
 *
 * `VISIT_GENERATION_DAILY_CAP` is enforced twice: generation's load guard
 * spreads work off a full day, and `DailyLoadLedger` refuses a solver's move
 * on to one. Both decide by counting what already stands on the day — and a
 * count is an aggregate, which at READ COMMITTED locks nothing at all. The row
 * locks each writer already takes are on the visits, agreements and crews *it*
 * is changing, so two runs over disjoint work share none of them, and an
 * addition creates a row that nobody could have locked in advance.
 *
 * Measured before the fix, on this fixture: two `POST /visit-generation/confirm`
 * calls fired together at a COLOMBO day carrying eleven of its twelve, each
 * for an agreement the other knew nothing about. Both returned 200, both were
 * told the day had room, and the day ended with thirteen visits and not one
 * warning to say so. Sequentially the same pair leaves twelve, because the
 * second run can see the first run's work and spreads its own visit to the
 * Tuesday.
 *
 * These tests are what stops that coming back. A unit test cannot: nothing
 * about serialization is visible from inside one process.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AvailabilityKind,
  BranchCode,
  DataProvenance,
  DayRuleKind,
  FrequencyUnit,
  Prisma,
  PrismaClient,
  UserRole,
  VisitStatus,
  Weekday,
} from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { DEFAULT_EMPLOYEE_WORKDAY_MINUTES } from '../../src/config/constants';
import {
  BRANCH_DAY_LOCK_CLASS,
  branchDayLockKey,
  lockBranchDays,
} from '../../src/scheduling/optimizer/branch-day-lock';
import { lockAgreementRows } from '../../src/common/locks/agreement-lock';
import { ScheduleRunProcessor } from '../../src/scheduling/optimizer/schedule-run.processor';
import { ScheduleRunService } from '../../src/scheduling/optimizer/schedule-run.service';

const prisma = new PrismaClient();
/** A second connection, so one transaction can be held open against another. */
const other = new PrismaClient();

const suffix = Math.random().toString(36).slice(2, 8);
const ADMIN = {
  email: `day-lock-admin-${suffix}@ultrakil.test`,
  password: 'day-lock-admin-password',
};

/**
 * Two whole weeks in 2029 that no other suite touches. The cap is a property
 * of a whole branch-day, so a day shared with another fixture would be
 * counting that fixture too. Both weeks start on a Monday.
 */
const RACE_WEEK = { from: '2029-03-05', to: '2029-03-11' };
const WAIT_WEEK = { from: '2029-03-12', to: '2029-03-18' };
const DEADLOCK_WEEK = { from: '2029-03-19', to: '2029-03-25' };
const RACE_DAY = RACE_WEEK.from;
const WAIT_DAY = WAIT_WEEK.from;
const at = (date: string) => new Date(`${date}T00:00:00.000Z`);

/**
 * One crew-hour: every agreement and filler visit in this suite is this
 * size, so a visit's crew-minutes cost is exactly one unit of it, and the
 * cap reads as a plain visit count again.
 */
const REFERENCE_VISIT_MINUTES = 60;
/**
 * The real, resource-derived cap now depends on COLOMBO's actual workforce,
 * which this shared database's other suites also leave fixtures in. `beforeAll`
 * pins it to exactly one available PMS-grade employee for every date this
 * suite touches, so the day's true capacity is this one figure rather than
 * whatever headcount happens to be lying around.
 */
const CAP_VISITS = DEFAULT_EMPLOYEE_WORKDAY_MINUTES / REFERENCE_VISIT_MINUTES;

/** One short of full, so exactly one writer can have the last slot. */
const FILLERS = CAP_VISITS - 1;

const ALL_WEEKDAYS = [
  Weekday.MONDAY,
  Weekday.TUESDAY,
  Weekday.WEDNESDAY,
  Weekday.THURSDAY,
  Weekday.FRIDAY,
  Weekday.SATURDAY,
  Weekday.SUNDAY,
];

let app: INestApplication;
let http: string;
let token: string;
let runs: ScheduleRunService;
let branchId: string;
let customerId: string;
let jobTypeId: string;
/** Work on the days that belongs to no run these tests make. */
let fillerAgreementId: string;
const agreementIds: string[] = [];
/** Cleared in `afterAll`: the leave rows that pin COLOMBO's real capacity. */
const pinnedAvailabilityIds: string[] = [];
/** Set in `beforeAll` only when this suite had to create its own PMS-grade employee. */
let dedicatedEmployeeId: string | undefined;

const auth = () => ({ Authorization: `Bearer ${token}` });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * An agreement asking for one visit a week, on any weekday.
 *
 * Every weekday allowed on purpose. It is what makes the sequential ordering
 * of these runs correct on its own: a second run that can see the first run's
 * work has somewhere else to put its own visit, and the load guard spreads it
 * there. A run that could only ever use the Monday would be *allowed* over the
 * cap — the guard warns and proceeds when a visit has nowhere to go — and the
 * day's count would then prove nothing about locking.
 */
async function makeAgreement(label: string, startDate: string): Promise<string> {
  const site = await prisma.serviceSite.create({
    data: {
      customerId,
      name: `Day Lock Site ${label} ${suffix}`,
      branchId,
      branchCode: BranchCode.COLOMBO,
      operatingHours: {
        create: ALL_WEEKDAYS.map((weekday) => ({
          weekday,
          opensAtMinute: 8 * 60,
          closesAtMinute: 17 * 60,
          provenance: DataProvenance.MANAGER_CONFIRMED,
        })),
      },
    },
  });
  const agreement = await prisma.serviceAgreement.create({
    data: {
      customerId,
      serviceSiteId: site.id,
      jobTypeId,
      branchId,
      branchCode: BranchCode.COLOMBO,
      frequencyCount: 1,
      frequencyUnit: FrequencyUnit.WEEK,
      frequencyInterval: 1,
      crewSize: 1,
      durationMinutes: REFERENCE_VISIT_MINUTES,
      startDate: at(startDate),
      dayRules: {
        create: ALL_WEEKDAYS.map((weekday) => ({
          weekday,
          kind: DayRuleKind.ALLOWED,
        })),
      },
    },
  });
  agreementIds.push(agreement.id);
  return agreement.id;
}

/**
 * Work standing on the day that belongs to nobody in this run's scope.
 *
 * Hand-adjusted, so no generation run may move or remove it, and all on one
 * agreement with staggered start minutes, because a visit is identified by its
 * agreement, date and start time.
 */
async function fillDay(agreementId: string, date: string, count: number) {
  for (let index = 0; index < count; index += 1) {
    await prisma.generatedVisit.create({
      data: {
        serviceAgreementId: agreementId,
        branchId,
        branchCode: BranchCode.COLOMBO,
        visitDate: at(date),
        windowStartMinute: 8 * 60 + index,
        windowEndMinute: 17 * 60,
        durationMinutes: REFERENCE_VISIT_MINUTES,
        requiredCrewSize: 1,
        status: VisitStatus.PENDING,
        isManuallyAdjusted: true,
      },
    });
  }
}

/** Everything not cancelled standing on one COLOMBO day. */
async function loadOn(date: string): Promise<number> {
  return prisma.generatedVisit.count({
    where: {
      branchCode: BranchCode.COLOMBO,
      visitDate: at(date),
      status: { not: VisitStatus.CANCELLED },
    },
  });
}

/** Whoever is waiting for that branch-day's advisory lock, right now. */
async function waitingFor(date: string): Promise<number> {
  const key = branchDayLockKey(BranchCode.COLOMBO, date);
  const rows = await prisma.$queryRaw<{ waiting: bigint }[]>`
    SELECT count(*) AS waiting
    FROM pg_locks
    WHERE locktype = 'advisory'
      AND classid = ${BRANCH_DAY_LOCK_CLASS}::int
      AND objid = ${key}::int
      AND NOT granted
  `;
  return Number(rows[0]?.waiting ?? 0);
}

/** Give a writer up to ten seconds to arrive at the lock and block on it. */
async function waitUntilBlockedOn(date: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await waitingFor(date)) > 0) return;
    await sleep(100);
  }
  throw new Error(`Nothing ever waited for the ${date} branch-day lock.`);
}

/** Someone is parked on a lock over one of the two tables the writers share. */
async function somethingIsBlocked(): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ blocked: bigint }[]>`
    SELECT count(*) AS blocked
    FROM pg_stat_activity
    WHERE wait_event_type = 'Lock'
      AND (query ILIKE '%service_agreements%' OR query ILIKE '%generated_visits%')
  `;
  return Number(rows[0]?.blocked ?? 0) > 0;
}

/** Give a writer up to ten seconds to reach a lock it cannot have yet. */
async function waitUntilSomethingBlocks(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await somethingIsBlocked()) return;
    await sleep(100);
  }
  throw new Error('Nothing ever blocked on an agreement or a visit.');
}

/**
 * Holds one branch-day, lets the test fill it, and releases.
 *
 * The open transaction is the deterministic part. A race reproduced by firing
 * two requests together reproduces only most of the time; a writer parked on
 * the lock while the day is filled underneath it reproduces every time, and
 * fails loudly if the writer never asks for the lock at all.
 */
function holdDay(date: string) {
  let acquired: () => void = () => undefined;
  let release: () => void = () => undefined;
  const isHeld = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const mayRelease = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writeBeforeCommit: ((tx: Prisma.TransactionClient) => Promise<void>) | undefined;

  const finished = other.$transaction(
    async (tx) => {
      await lockBranchDays(tx, [{ branchCode: BranchCode.COLOMBO, date }]);
      acquired();
      await mayRelease;
      if (writeBeforeCommit) await writeBeforeCommit(tx);
    },
    { timeout: 60_000, maxWait: 30_000 },
  );

  return {
    isHeld,
    /**
     * Writes inside the held transaction, then commits and drops the lock.
     *
     * One commit, one release: that is the shape of the race. Whoever was
     * waiting wakes up to a day that already has the other writer's visit on
     * it, which is precisely the thing an unlocked count could not see.
     */
    async releaseAfter(
      write: (tx: Prisma.TransactionClient) => Promise<void>,
    ): Promise<void> {
      writeBeforeCommit = write;
      release();
      await finished;
    },
  };
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    // A plain value carries no @Processor metadata, so BullMQ registers no
    // worker and nothing here is solved behind the tests' back.
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
  runs = app.get(ScheduleRunService);

  await prisma.$connect();
  await other.$connect();

  const branch = await prisma.branch.upsert({
    where: { code: BranchCode.COLOMBO },
    create: { code: BranchCode.COLOMBO, name: 'COLOMBO Branch' },
    update: {},
  });
  branchId = branch.id;

  await prisma.user.upsert({
    where: { email: ADMIN.email },
    create: {
      email: ADMIN.email,
      fullName: 'Day Lock Admin',
      role: UserRole.ADMIN,
      passwordHash: await AuthService.hashPassword(ADMIN.password),
    },
    update: { role: UserRole.ADMIN, isActive: true },
  });
  const login = await request(http)
    .post('/api/auth/login')
    .send({ email: ADMIN.email, password: ADMIN.password });
  expect(login.status).toBe(200);
  token = login.body.accessToken as string;

  const jobType = await prisma.jobType.create({
    data: {
      code: `DAYLOCK_${suffix}`,
      name: 'Day Lock Treatment',
      defaultCrewSize: 1,
      defaultDurationMinutes: REFERENCE_VISIT_MINUTES,
    },
  });
  jobTypeId = jobType.id;

  const customer = await prisma.customer.create({
    data: {
      name: `Day Lock Client ${suffix}`,
      branchId,
      branchCode: BranchCode.COLOMBO,
    },
  });
  customerId = customer.id;

  // Pin COLOMBO's real, resource-derived capacity to exactly one available
  // PMS-grade employee for every date this suite touches — this database is
  // shared, and other suites' own leftover COLOMBO employees would otherwise
  // make the day's true capacity whatever headcount happens to be lying
  // around, rather than the fixed figure `CAP_VISITS` is built against.
  const colomboEmployees = await prisma.employee.findMany({
    where: { branchCode: BranchCode.COLOMBO, isActive: true },
    select: { id: true, isPmsGrade: true },
  });
  let keepId = colomboEmployees.find((employee) => employee.isPmsGrade)?.id;
  if (!keepId) {
    // A genuinely fresh database — CI's own — carries no workforce at all,
    // so there is nothing to find a PMS-grade employee among. This suite
    // needs exactly one deterministic PMS-grade employee to pin COLOMBO's
    // capacity against, so it creates its own rather than assuming one is
    // already on record — the same reasoning
    // visit-generation-view-churn.spec.ts already uses for KANDY.
    const dedicated = await prisma.employee.create({
      data: {
        sourceKey: `day-lock-supervisor-${suffix}`,
        fullName: `Day Lock Supervisor ${suffix}`,
        gradeLabel: 'PMS',
        isPmsGrade: true,
        branchId,
        branchCode: BranchCode.COLOMBO,
      },
    });
    dedicatedEmployeeId = dedicated.id;
    keepId = dedicated.id;
  }
  const toPin = colomboEmployees.filter((employee) => employee.id !== keepId);
  if (toPin.length > 0) {
    const pinned = await prisma.employeeAvailability.createManyAndReturn({
      data: toPin.map((employee) => ({
        employeeId: employee.id,
        startDate: at('2029-01-01'),
        endDate: at('2029-12-31'),
        kind: AvailabilityKind.LEAVE,
        reason: 'branch-day-cap-lock.spec.ts: pinned for a deterministic capacity',
      })),
      select: { id: true },
    });
    pinnedAvailabilityIds.push(...pinned.map((row) => row.id));
  }

  fillerAgreementId = await makeAgreement('filler', RACE_WEEK.from);
  await fillDay(fillerAgreementId, RACE_DAY, FILLERS);
  await fillDay(fillerAgreementId, WAIT_DAY, FILLERS);
}, 300_000);

afterAll(async () => {
  // This suite's own generated visits, cleared so the branch-days it used are
  // free for whatever runs after it. Generation now leaves work unplanned
  // rather than placing it on a day already at its cap, so a shared calendar
  // that every suite adds to and nobody clears eventually has no room left in
  // it for anybody.
  await prisma.generatedVisit.deleteMany({ where: { serviceAgreement: { jobTypeId } } });
  if (pinnedAvailabilityIds.length > 0) {
    await prisma.employeeAvailability.deleteMany({
      where: { id: { in: pinnedAvailabilityIds } },
    });
  }
  if (dedicatedEmployeeId) {
    await prisma.employee.delete({ where: { id: dedicatedEmployeeId } }).catch(() => undefined);
  }
  // This database is shared with every other integration suite, and a stray
  // visit on one of these days would quietly change another suite's counts.
  if (agreementIds.length > 0) {
    const visitIds = (
      await prisma.generatedVisit.findMany({
        where: { serviceAgreementId: { in: agreementIds } },
        select: { id: true },
      })
    ).map((visit) => visit.id);
    if (visitIds.length > 0) {
      await prisma.assignment.deleteMany({
        where: { generatedVisitId: { in: visitIds } },
      });
      await prisma.visitUnassignedReason.deleteMany({
        where: { generatedVisitId: { in: visitIds } },
      });
    }
    await prisma.generatedVisit.deleteMany({
      where: { serviceAgreementId: { in: agreementIds } },
    });
    await prisma.serviceAgreement.deleteMany({
      where: { id: { in: agreementIds } },
    });
  }
  if (customerId) {
    const siteIds = (
      await prisma.serviceSite.findMany({
        where: { customerId },
        select: { id: true },
      })
    ).map((site) => site.id);
    if (siteIds.length > 0) {
      await prisma.siteOperatingHours.deleteMany({
        where: { serviceSiteId: { in: siteIds } },
      });
      await prisma.serviceSite.deleteMany({ where: { id: { in: siteIds } } });
    }
    await prisma.customer.delete({ where: { id: customerId } });
  }
  if (jobTypeId) {
    await prisma.jobType.delete({ where: { id: jobTypeId } }).catch(() => undefined);
  }
  await prisma.scheduleRun.deleteMany({
    where: {
      OR: [
        { rangeStart: at(RACE_WEEK.from), rangeEnd: at(RACE_WEEK.to) },
        { rangeStart: at(WAIT_WEEK.from), rangeEnd: at(WAIT_WEEK.to) },
        { rangeStart: at(DEADLOCK_WEEK.from), rangeEnd: at(DEADLOCK_WEEK.to) },
      ],
    },
  });
  await prisma.user.deleteMany({ where: { email: ADMIN.email } });
  await prisma.$disconnect();
  await other.$disconnect();
  await app.close();
}, 120_000);

describe('two generation confirms racing for the last slot on a day', () => {
  it('leaves the day at the cap, and loses neither visit', async () => {
    const first = await makeAgreement('race-a', RACE_WEEK.from);
    const second = await makeAgreement('race-b', RACE_WEEK.from);
    expect(await loadOn(RACE_DAY)).toBe(FILLERS);

    const confirm = (agreementId: string) =>
      request(http)
        .post('/api/visit-generation/confirm')
        .set(auth())
        .send({
          ...RACE_WEEK,
          branchCode: BranchCode.COLOMBO,
          serviceAgreementIds: [agreementId],
        });

    const [a, b] = await Promise.all([confirm(first), confirm(second)]);

    // Either both runs got in — because they did not actually overlap — or one
    // of them was told the day filled up underneath it. Nothing else is an
    // acceptable outcome, and a 500 here is the bug coming back by another
    // route.
    for (const response of [a, b]) {
      expect([200, 409]).toContain(response.status);
      if (response.status === 409) {
        expect(response.body.code).toBe('RESOURCE_CONFLICT');
      }
    }
    // The day is the whole point: twelve, never thirteen.
    expect(await loadOn(RACE_DAY)).toBeLessThanOrEqual(CAP_VISITS);

    // A refusal must cost the manager nothing but a second press. Previewing
    // again sees the day as it now is, and the load guard spreads the visit to
    // another day of the same week.
    const outcomes = [
      { response: a, agreementId: first },
      { response: b, agreementId: second },
    ];
    for (const refused of outcomes.filter((one) => one.response.status === 409)) {
      const retry = await confirm(refused.agreementId);
      expect(retry.status).toBe(200);
    }

    // Every agreement served, no day of the week over the cap.
    for (const agreementId of [first, second]) {
      const visits = await prisma.generatedVisit.findMany({
        where: { serviceAgreementId: agreementId },
        select: { visitDate: true },
      });
      expect(visits).toHaveLength(1);
      const date = visits[0].visitDate.toISOString().slice(0, 10);
      expect(date >= RACE_WEEK.from && date <= RACE_WEEK.to).toBe(true);
    }
    const days = await prisma.generatedVisit.groupBy({
      by: ['visitDate'],
      where: {
        branchCode: BranchCode.COLOMBO,
        visitDate: { gte: at(RACE_WEEK.from), lte: at(RACE_WEEK.to) },
        status: { not: VisitStatus.CANCELLED },
      },
      _count: { _all: true },
    });
    for (const day of days) {
      expect(day._count._all).toBeLessThanOrEqual(CAP_VISITS);
    }
  }, 180_000);
});

describe('a writer already holding the branch-day', () => {
  it('makes generation wait for the day, and re-read it before adding to it', async () => {
    const agreementId = await makeAgreement('wait', WAIT_WEEK.from);
    expect(await loadOn(WAIT_DAY)).toBe(FILLERS);

    const holder = holdDay(WAIT_DAY);
    await holder.isHeld;

    const confirm = request(http)
      .post('/api/visit-generation/confirm')
      .set(auth())
      .send({
        ...WAIT_WEEK,
        branchCode: BranchCode.COLOMBO,
        serviceAgreementIds: [agreementId],
      });
    const settled = confirm.then((response) => response);

    // Proof that the real path asks for this exact key, and waits: the run
    // planned its visit on to the Monday while the day still had room, and is
    // now parked on the lock rather than counting anything.
    await waitUntilBlockedOn(WAIT_DAY);

    // The last slot, taken by the other writer while the run waits.
    //
    // On the filler's agreement, not this run's, and the distinction is a rule
    // rather than a detail: a writer that takes a branch-day and *then* wants
    // an agreement is holding the two in the opposite order to everything
    // else here, and Postgres would rightly deadlock it against a generation
    // that locked the agreement first. The holder stands for another planner
    // filling the day, and another planner has its own agreements.
    await holder.releaseAfter(async (tx) => {
      await tx.generatedVisit.create({
        data: {
          serviceAgreementId: fillerAgreementId,
          branchId,
          branchCode: BranchCode.COLOMBO,
          visitDate: at(WAIT_DAY),
          windowStartMinute: 7 * 60,
          windowEndMinute: 17 * 60,
          durationMinutes: REFERENCE_VISIT_MINUTES,
          requiredCrewSize: 1,
          status: VisitStatus.PENDING,
          isManuallyAdjusted: true,
        },
      });
    });

    const response = await settled;
    // The count it read once it had the lock is the one the other writer
    // committed, so the plan it was about to apply is refused rather than
    // applied on top.
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('RESOURCE_CONFLICT');
    expect(response.body.message).toContain(WAIT_DAY);
    expect(await loadOn(WAIT_DAY)).toBe(CAP_VISITS);
  }, 180_000);

  it('makes the optimizer wait for the day, and count it afterwards', async () => {
    const agreementId = await makeAgreement('optimizer', WAIT_WEEK.from);
    const day = WAIT_WEEK.to;
    await fillDay(agreementId, day, FILLERS);
    expect(await loadOn(day)).toBe(FILLERS);

    const holder = holdDay(day);
    await holder.isHeld;

    // The persistence transaction's own ledger read, driven straight at one
    // proposed move on to the held day. `lockAndReadDailyLoad` is private —
    // nothing but that transaction has any business building a ledger — but it
    // is the only place the optimizer learns how full a day is, and this is
    // the narrowest reach that can watch it do so.
    const ledgerRead = prisma.$transaction(
      async (tx) =>
        (
          runs as unknown as {
            lockAndReadDailyLoad(
              tx: unknown,
              proposals: {
                branchCode: BranchCode;
                visitDate: Date;
                proposedVisit?: { visitDate: Date };
                crewMinutes: number;
              }[],
            ): Promise<{
              minutesOn(branchCode: BranchCode, date: string): number;
              admitsMoveOnto(
                branchCode: BranchCode,
                date: string,
                crewMinutes: number,
              ): boolean;
            }>;
          }
        ).lockAndReadDailyLoad(tx, [
          {
            branchCode: BranchCode.COLOMBO,
            visitDate: at(WAIT_WEEK.from),
            proposedVisit: { visitDate: at(day) },
            crewMinutes: REFERENCE_VISIT_MINUTES,
          },
        ]),
      { timeout: 60_000, maxWait: 30_000 },
    );

    await waitUntilBlockedOn(day);

    await holder.releaseAfter(async (tx) => {
      await tx.generatedVisit.create({
        data: {
          serviceAgreementId: agreementId,
          branchId,
          branchCode: BranchCode.COLOMBO,
          visitDate: at(day),
          windowStartMinute: 7 * 60,
          windowEndMinute: 17 * 60,
          durationMinutes: REFERENCE_VISIT_MINUTES,
          requiredCrewSize: 1,
          status: VisitStatus.PENDING,
          isManuallyAdjusted: true,
        },
      });
    });

    const ledger = await ledgerRead;
    expect(ledger.minutesOn(BranchCode.COLOMBO, day)).toBe(
      CAP_VISITS * REFERENCE_VISIT_MINUTES,
    );
    expect(
      ledger.admitsMoveOnto(BranchCode.COLOMBO, day, REFERENCE_VISIT_MINUTES),
    ).toBe(false);
  }, 180_000);

  it('does not hold up a writer working on another day or another branch', async () => {
    const holder = holdDay(RACE_DAY);
    await holder.isHeld;

    // Different day, same branch; same day, different branch. Neither shares a
    // key with the held day, so neither waits — a lock that serialised these
    // would serialise a whole company behind one branch's Monday.
    await expect(
      prisma.$transaction(
        async (tx) => {
          await lockBranchDays(tx, [
            { branchCode: BranchCode.COLOMBO, date: RACE_WEEK.to },
            { branchCode: BranchCode.KANDY, date: RACE_DAY },
          ]);
          return 'through';
        },
        { timeout: 10_000 },
      ),
    ).resolves.toBe('through');

    await holder.releaseAfter(async () => undefined);
  }, 120_000);
});

/**
 * The two writers take the same locks in the same order, or they meet head on.
 *
 * `persistResult` locks the agreement `FOR UPDATE` first and waits for the
 * branch-day last. Generation locked neither when all it had to do was *add* a
 * visit: with nothing changing, there was no visit row to lock and no
 * agreement row either — and the insert that followed still needed the
 * agreement, because Postgres takes a `FOR KEY SHARE` on the referenced row
 * for the foreign key. So generation held the day and wanted the agreement
 * while the optimizer held the agreement and wanted the day. Postgres named it
 * exactly and killed one of them:
 *
 *   deadlock detected — Process A waits for ShareLock on transaction …;
 *   Process B waits for ExclusiveLock on advisory lock [… 1430998084 …]
 *
 * which reached the manager as a 500 on Generate.
 */
describe('a writer that took the agreement first', () => {
  it('is queued behind, not deadlocked with, a generation that only adds', async () => {
    const agreementId = await makeAgreement('deadlock', DEADLOCK_WEEK.from);
    const day = DEADLOCK_WEEK.from;

    let release: () => void = () => undefined;
    const mayRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    let heldTheDay = false;
    let holderError: unknown;

    // The optimizer's own order, using the optimizer's own helpers: the
    // agreement first, then — after this run has had every chance to get
    // ahead of it — the branch-day.
    const holder = other
      .$transaction(
        async (tx) => {
          await lockAgreementRows(tx, [agreementId]);
          await mayRelease;
          await lockBranchDays(tx, [{ branchCode: BranchCode.COLOMBO, date: day }]);
          heldTheDay = true;
        },
        { timeout: 60_000, maxWait: 30_000 },
      )
      .catch((error: unknown) => {
        holderError = error;
      });
    await sleep(500);

    // A brand-new agreement over a week nothing has been generated for: the
    // plan is one addition and nothing else, which is the case that used to
    // reach the branch-day holding no agreement at all.
    const confirm = request(http)
      .post('/api/visit-generation/confirm')
      .set(auth())
      .send({
        ...DEADLOCK_WEEK,
        branchCode: BranchCode.COLOMBO,
        serviceAgreementIds: [agreementId],
      })
      .then((response) => response);

    // Generation gets as far as it can while the agreement row is held, and
    // then waits — for the agreement, not holding the day.
    await waitUntilSomethingBlocks();
    release();

    const [response] = await Promise.all([confirm, holder]);

    expect(holderError).toBeUndefined();
    expect(heldTheDay).toBe(true);
    expect(response.status).toBe(200);

    // And the run really did the thing that needs the agreement.
    const visits = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: agreementId },
      select: { visitDate: true },
    });
    expect(visits).toHaveLength(1);
  }, 180_000);
});

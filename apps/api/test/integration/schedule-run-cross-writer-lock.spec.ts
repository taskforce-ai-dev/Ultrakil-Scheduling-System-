/**
 * The daily cap under two real writers of the *same* kind, and under one of
 * each kind, both driving the exact production code path — not a stand-in
 * holding the lock on a writer's behalf.
 *
 * `branch-day-cap-lock.spec.ts` proves the shared lock from both directions
 * independently: a real generation confirm queuing behind an external holder,
 * and the optimizer's own `lockAndReadDailyLoad` queuing behind one. What it
 * does not cover is two real writers contending for the same day's last slot
 * at once — the literal "two concurrent optimizer runs" and "generation
 * confirmation racing an optimizer run" this review asked for, closed here by
 * calling `ScheduleRunService`'s own private `persistResult` for real,
 * concurrently, the same way `schedule-run.service.spec.ts` reaches it in a
 * unit test but against a real database and a real second writer instead of
 * a mock.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  BranchCode,
  CrewRole,
  DataProvenance,
  DayRuleKind,
  FrequencyUnit,
  PrismaClient,
  ScheduleRunStatus,
  UserRole,
  VisitStatus,
  Weekday,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { BranchDayCapacityService } from '../../src/scheduling/visit-generation/branch-day-capacity.service';
import { ScheduleRunProcessor } from '../../src/scheduling/optimizer/schedule-run.processor';
import { ScheduleRunService } from '../../src/scheduling/optimizer/schedule-run.service';

const prisma = new PrismaClient();
const suffix = Math.random().toString(36).slice(2, 8);
const ADMIN = {
  email: `cross-writer-${suffix}@ultrakil.test`,
  password: 'cross-writer-password',
};

/** Two whole weeks nothing else in the suite touches. */
const WRITERS_WEEK = { from: '2029-04-02', to: '2029-04-08' };
const CROSS_WEEK = { from: '2029-04-09', to: '2029-04-15' };
const WRITERS_DAY = WRITERS_WEEK.from;
const CROSS_DAY = CROSS_WEEK.from;
const at = (date: string) => new Date(`${date}T00:00:00.000Z`);

/**
 * One crew-hour: every agreement and visit in this suite is this size, so a
 * visit's crew-minutes cost is exactly one unit of it, and the cap reads as
 * a plain visit count again.
 */
const REFERENCE_VISIT_MINUTES = 60;

/**
 * How many reference-hour visits fill a branch-day, and one short of that —
 * read fresh from the real, resource-derived capacity each test's own crew
 * creation ends up affecting (a PMS-grade supervisor made for the race adds
 * to COLOMBO's real headcount, and so to its real capacity), rather than a
 * constant computed before that headcount existed.
 */
async function capVisitsOn(date: string): Promise<number> {
  const capacity = await app.get(BranchDayCapacityService).capacityFor(BranchCode.COLOMBO, date);
  return Math.floor(capacity.capacityMinutes / REFERENCE_VISIT_MINUTES);
}

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
const employeeIds: string[] = [];
const agreementIds: string[] = [];

const auth = () => ({ Authorization: `Bearer ${token}` });

/** A crew of its own, so the two writers in a test never double-book anyone. */
async function makeCrew(label: string): Promise<{ supervisorId: string; technicianId: string }> {
  const supervisor = await prisma.employee.create({
    data: {
      sourceKey: `cross-writer-sup-${label}-${suffix}`,
      fullName: `Cross Writer Supervisor ${label} ${suffix}`,
      gradeLabel: 'PMS',
      isPmsGrade: true,
      branchId,
      branchCode: BranchCode.COLOMBO,
      canUsePublicTransport: true,
    },
  });
  const technician = await prisma.employee.create({
    data: {
      sourceKey: `cross-writer-tech-${label}-${suffix}`,
      fullName: `Cross Writer Technician ${label} ${suffix}`,
      gradeLabel: 'Junior PMT',
      branchId,
      branchCode: BranchCode.COLOMBO,
      canUsePublicTransport: true,
    },
  });
  employeeIds.push(supervisor.id, technician.id);
  return { supervisorId: supervisor.id, technicianId: technician.id };
}

/** An agreement asking for one visit a week, on any weekday — see branch-day-cap-lock.spec.ts. */
async function makeAgreement(label: string, startDate: string): Promise<string> {
  const site = await prisma.serviceSite.create({
    data: {
      customerId,
      name: `Cross Writer Site ${label} ${suffix}`,
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
        create: ALL_WEEKDAYS.map((weekday) => ({ weekday, kind: DayRuleKind.ALLOWED })),
      },
    },
  });
  agreementIds.push(agreement.id);
  return agreement.id;
}

/** Work standing on the day that belongs to nobody in this run's scope. */
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

/** A visit sitting somewhere else, free to be proposed on to the contested day. */
async function makeMovableVisit(agreementId: string, originDate: string) {
  return prisma.generatedVisit.create({
    data: {
      serviceAgreementId: agreementId,
      branchId,
      branchCode: BranchCode.COLOMBO,
      visitDate: at(originDate),
      windowStartMinute: 8 * 60,
      windowEndMinute: 17 * 60,
      durationMinutes: REFERENCE_VISIT_MINUTES,
      requiredCrewSize: 1,
      status: VisitStatus.PENDING,
    },
  });
}

/** Everything not cancelled standing on one COLOMBO day. */
async function loadOn(date: string): Promise<number> {
  return prisma.generatedVisit.count({
    where: { branchCode: BranchCode.COLOMBO, visitDate: at(date), status: { not: VisitStatus.CANCELLED } },
  });
}

/** A RUNNING schedule run this test owns, with a lease `persistResult` will accept. */
async function makeLeasedRun(week: { from: string; to: string }) {
  const leaseId = randomUUID();
  const run = await prisma.scheduleRun.create({
    data: {
      status: ScheduleRunStatus.RUNNING,
      branchCode: BranchCode.COLOMBO,
      rangeStart: at(week.from),
      rangeEnd: at(week.to),
      executionLeaseId: leaseId,
      executionLeaseExpiresAt: new Date(Date.now() + 5 * 60_000),
    },
  });
  return { runId: run.id, lease: { id: leaseId, expiresAt: run.executionLeaseExpiresAt as Date } };
}

interface PersistResultLike {
  persistResult(
    runId: string,
    proposals: unknown[],
    unassigned: unknown[],
    lease: { id: string; expiresAt: Date },
  ): Promise<{ scheduled: number; unassigned: number; cancelled: boolean }>;
}

/** The real write path a solve commits through — reached directly, as `branch-day-cap-lock.spec.ts` reaches `lockAndReadDailyLoad`. */
function persistMoveTo(
  runId: string,
  lease: { id: string; expiresAt: Date },
  visit: { id: string; serviceAgreementId: string; updatedAt: Date; visitDate: Date },
  crew: { supervisorId: string; technicianId: string },
  targetDate: string,
) {
  return (runs as unknown as PersistResultLike).persistResult(
    runId,
    [
      {
        visitId: visit.id,
        serviceAgreementId: visit.serviceAgreementId,
        expectedUpdatedAt: visit.updatedAt,
        dto: {
          plannedStartMinute: 8 * 60,
          plannedEndMinute: 8 * 60 + 90,
          crew: [
            { employeeId: crew.supervisorId, role: CrewRole.SUPERVISOR },
            { employeeId: crew.technicianId, role: CrewRole.TECHNICIAN },
          ],
          vehicles: [],
        },
        proposedVisit: {
          visitDate: at(targetDate),
          windowStartMinute: 8 * 60,
          windowEndMinute: 8 * 60 + 90,
        },
        branchCode: BranchCode.COLOMBO,
        visitDate: visit.visitDate,
        // The visit's own cost against the cap: `makeMovableVisit` creates it
        // at `REFERENCE_VISIT_MINUTES` minutes, one crew member — the same
        // figure `persistResult`'s real caller reads off the row itself.
        crewMinutes: REFERENCE_VISIT_MINUTES,
      },
    ],
    [],
    lease,
  );
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
  runs = app.get(ScheduleRunService);

  await prisma.$connect();
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
      fullName: 'Cross Writer Admin',
      role: UserRole.ADMIN,
      passwordHash: await AuthService.hashPassword(ADMIN.password),
    },
    update: { role: UserRole.ADMIN, isActive: true },
  });
  const login = await request(http)
    .post('/api/auth/login')
    .send({ email: ADMIN.email, password: ADMIN.password });
  token = login.body.accessToken as string;

  const jobType = await prisma.jobType.create({
    data: {
      code: `CROSSWRITER_${suffix}`,
      name: 'Cross Writer Treatment',
      defaultCrewSize: 2,
      defaultDurationMinutes: 90,
    },
  });
  jobTypeId = jobType.id;

  const customer = await prisma.customer.create({
    data: { name: `Cross Writer Client ${suffix}`, branchId, branchCode: BranchCode.COLOMBO },
  });
  customerId = customer.id;
}, 300_000);

afterAll(async () => {
  // This suite's own generated visits, cleared so the branch-days it used are
  // free for whatever runs after it. Generation now leaves work unplanned
  // rather than placing it on a day already at its cap, so a shared calendar
  // that every suite adds to and nobody clears eventually has no room left in
  // it for anybody.
  await prisma.generatedVisit.deleteMany({ where: { serviceAgreement: { jobTypeId } } });
  if (agreementIds.length > 0) {
    const visitIds = (
      await prisma.generatedVisit.findMany({
        where: { serviceAgreementId: { in: agreementIds } },
        select: { id: true },
      })
    ).map((visit) => visit.id);
    if (visitIds.length > 0) {
      await prisma.assignment.deleteMany({ where: { generatedVisitId: { in: visitIds } } });
      await prisma.visitUnassignedReason.deleteMany({ where: { generatedVisitId: { in: visitIds } } });
    }
    await prisma.generatedVisit.deleteMany({ where: { serviceAgreementId: { in: agreementIds } } });
    await prisma.serviceAgreement.deleteMany({ where: { id: { in: agreementIds } } });
  }
  if (employeeIds.length > 0) {
    await prisma.employee.deleteMany({ where: { id: { in: employeeIds } } });
  }
  if (customerId) {
    const siteIds = (
      await prisma.serviceSite.findMany({ where: { customerId }, select: { id: true } })
    ).map((site) => site.id);
    if (siteIds.length > 0) {
      await prisma.siteOperatingHours.deleteMany({ where: { serviceSiteId: { in: siteIds } } });
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
        { rangeStart: at(WRITERS_WEEK.from), rangeEnd: at(WRITERS_WEEK.to) },
        { rangeStart: at(CROSS_WEEK.from), rangeEnd: at(CROSS_WEEK.to) },
      ],
    },
  });
  await prisma.user.deleteMany({ where: { email: ADMIN.email } });
  await prisma.$disconnect();
  await app.close();
}, 120_000);

/**
 * No branch-day this suite's own work stands on — today or any day after it —
 * carries more crew-minutes than the capacity calculated for that day.
 *
 * The cap is the promise; a test that only checks the one contested day
 * proves that day and nothing else. This reads every current or future
 * branch-day any of this suite's agreements put work on, recomputes each
 * day's capacity from the real workforce the same way generation does, and
 * counts everything standing there — this suite's work and anybody else's,
 * because a cap is a property of the day, not of who filled it.
 *
 * Days whose calculated capacity is zero are skipped, and deliberately: zero
 * is what `branch-day-capacity.ts` reports when it cannot answer — no PMS
 * supervisor available, no authorized driver — which is a gap in the
 * workforce records rather than a measurement that the work will not fit.
 * Generation does not shed against it either (see `load-guard.ts`), so
 * asserting on it here would be asserting on a different rule than the one
 * being kept.
 */
async function expectNoBranchDayOverItsCapacity(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const mine = await prisma.generatedVisit.findMany({
    where: {
      serviceAgreementId: { in: agreementIds },
      status: { not: VisitStatus.CANCELLED },
      visitDate: { gte: at(today) },
    },
    select: { branchCode: true, visitDate: true },
  });
  const days = [
    ...new Set(
      mine.map((visit) => `${visit.branchCode}|${visit.visitDate.toISOString().slice(0, 10)}`),
    ),
  ].sort();

  const capacity = app.get(BranchDayCapacityService);
  const over: string[] = [];
  for (const key of days) {
    const [branchCode, date] = key.split('|') as [BranchCode, string];
    const standing = await prisma.generatedVisit.findMany({
      where: { branchCode, visitDate: at(date), status: { not: VisitStatus.CANCELLED } },
      select: {
        durationMinutes: true,
        requiredCrewSize: true,
        status: true,
        isManuallyAdjusted: true,
        lockedAt: true,
        assignments: { select: { id: true }, take: 1 },
      },
    });
    const crewMinutes = standing.reduce(
      (total, visit) => total + visit.durationMinutes * visit.requiredCrewSize,
      0,
    );
    const calculated = await capacity.capacityFor(branchCode, date);
    if (calculated.capacityMinutes === 0 || crewMinutes <= calculated.capacityMinutes) continue;

    // Over its cap — but a day can be over it for a reason nothing is allowed
    // to fix. A booked date, a locked visit, one a manager moved by hand, one
    // already staffed: generation may not touch any of them, and the honest
    // answer there is the warning it already gives. What must never happen is
    // a day over its cap while work generation *could* have left unplanned is
    // standing on it — so that, and only that, is what fails here.
    const movable = standing.filter(
      (visit) =>
        visit.lockedAt === null &&
        !visit.isManuallyAdjusted &&
        visit.assignments.length === 0 &&
        (visit.status === VisitStatus.PENDING || visit.status === VisitStatus.UNASSIGNED),
    );
    if (movable.length > 0) {
      over.push(
        `${key}: ${crewMinutes} crew-minutes against a calculated cap of ${calculated.capacityMinutes}, with ${movable.length} visit(s) generation could have left unplanned`,
      );
    }
  }
  expect(over).toEqual([]);
}

it('two real optimizer writes racing for the last slot leave the day at the cap', async () => {
  const filler = await makeAgreement('writers-filler', WRITERS_WEEK.from);
  const agreementA = await makeAgreement('writers-a', WRITERS_WEEK.from);
  const agreementB = await makeAgreement('writers-b', WRITERS_WEEK.from);
  const visitA = await makeMovableVisit(agreementA, WRITERS_WEEK.to);
  const visitB = await makeMovableVisit(agreementB, WRITERS_WEEK.to);
  // Each crew's own PMS-grade supervisor adds to COLOMBO's real headcount,
  // so capacity is read only after both exist — not before, when it would
  // already be stale by the time the race below actually checks it.
  const crewA = await makeCrew('writers-a');
  const crewB = await makeCrew('writers-b');

  const capVisits = await capVisitsOn(WRITERS_DAY);
  const fillers = capVisits - 1;
  await fillDay(filler, WRITERS_DAY, fillers);
  expect(await loadOn(WRITERS_DAY)).toBe(fillers);

  const { runId: runIdA, lease: leaseA } = await makeLeasedRun(WRITERS_WEEK);
  const { runId: runIdB, lease: leaseB } = await makeLeasedRun(WRITERS_WEEK);

  const [resultA, resultB] = await Promise.all([
    persistMoveTo(runIdA, leaseA, visitA, crewA, WRITERS_DAY),
    persistMoveTo(runIdB, leaseB, visitB, crewB, WRITERS_DAY),
  ]);

  // Both writers finish — the lock queues them rather than erroring either
  // one out, and a refused move still staffs the visit on the day it already
  // had, so both come back scheduled. The day is the whole point: never over
  // the cap, and exactly the one slot that was free is the one that got
  // taken — checked below by where each visit actually landed.
  expect(resultA.scheduled).toBe(1);
  expect(resultB.scheduled).toBe(1);
  const finalLoad = await loadOn(WRITERS_DAY);
  expect(finalLoad).toBe(capVisits);

  const [after, before] = await Promise.all([
    prisma.generatedVisit.findUniqueOrThrow({ where: { id: visitA.id } }),
    prisma.generatedVisit.findUniqueOrThrow({ where: { id: visitB.id } }),
  ]);
  const dates = [after, before].map((visit) => visit.visitDate.toISOString().slice(0, 10));
  // One moved on to the contested day, the other kept its own — never both,
  // and never neither.
  expect(dates.filter((date) => date === WRITERS_DAY)).toHaveLength(1);
  expect(dates.filter((date) => date === WRITERS_WEEK.to)).toHaveLength(1);
  // The cap held, and not only on the day these two writers were fighting over.
  await expectNoBranchDayOverItsCapacity();
}, 180_000);

it('a real generation confirm and a real optimizer write racing for the last slot leave the day at the cap', async () => {
  const filler = await makeAgreement('cross-filler', CROSS_WEEK.from);

  // The optimizer's side: an existing visit elsewhere in the week, proposed
  // on to the contested day.
  const agreementOpt = await makeAgreement('cross-optimizer', CROSS_WEEK.from);
  const visitOpt = await makeMovableVisit(agreementOpt, CROSS_WEEK.to);
  // This crew's own PMS-grade supervisor adds to COLOMBO's real headcount,
  // so capacity is read only after it exists.
  const crewOpt = await makeCrew('cross-optimizer');
  const { runId, lease } = await makeLeasedRun(CROSS_WEEK);

  const capVisits = await capVisitsOn(CROSS_DAY);
  const fillers = capVisits - 1;
  await fillDay(filler, CROSS_DAY, fillers);
  expect(await loadOn(CROSS_DAY)).toBe(fillers);

  // Generation's side: a brand-new agreement generation itself will plan
  // straight on to the contested day, because every other weekday of its
  // week already has its own filler-free visit from a wider fixture pass —
  // simplest is a single-day allowance, so the load guard has nowhere else to
  // put it and it goes to the one day this agreement allows.
  //
  // A single allowed day is the whole point, and this test briefly gave it up
  // when the guard still placed work on a day it knew was full: the day ended
  // one visit over the cap whenever generation read the calendar second, and
  // no lock could help, because the overfill was decided before the lock was
  // taken. The guard now leaves that visit unplanned and says why, so the one
  // allowed day is back.
  const site = await prisma.serviceSite.create({
    data: {
      customerId,
      name: `Cross Writer Site generation ${suffix}`,
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
  const agreementGen = await prisma.serviceAgreement.create({
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
      startDate: at(CROSS_WEEK.from),
      dayRules: {
        create: [{ weekday: Weekday.MONDAY, kind: DayRuleKind.ALLOWED }],
      },
    },
  });
  agreementIds.push(agreementGen.id);

  const [optimizerResult, confirmResponse] = await Promise.all([
    persistMoveTo(runId, lease, visitOpt, crewOpt, CROSS_DAY),
    request(http)
      .post('/api/visit-generation/confirm')
      .set(auth())
      .send({ ...CROSS_WEEK, branchCode: BranchCode.COLOMBO, serviceAgreementIds: [agreementGen.id] }),
  ]);

  for (const status of [confirmResponse.status]) {
    expect([200, 409]).toContain(status);
  }
  const finalLoad = await loadOn(CROSS_DAY);
  expect(finalLoad).toBeLessThanOrEqual(capVisits);

  // Between them, at most one of the two actually landed on the contested
  // day — the cap is one slot, and neither writer may both think it won.
  const genVisits = await prisma.generatedVisit.findMany({
    where: { serviceAgreementId: agreementGen.id },
    select: { visitDate: true },
  });
  const genLandedOnDay = genVisits.some(
    (visit) => visit.visitDate.toISOString().slice(0, 10) === CROSS_DAY,
  );
  const optimizerLandedOnDay = optimizerResult.scheduled === 1;
  expect(genLandedOnDay && optimizerLandedOnDay).toBe(false);

  // A confirm that succeeds has either placed the visit or said, in the same
  // response, exactly why it could not — never neither. Which of the two
  // depends on who read the calendar first, and that is the point: the run
  // that reads a full day plans nothing on it and reports a shortfall rather
  // than committing the day over its cap.
  if (confirmResponse.status === 200) {
    if (genVisits.length === 1) {
      expect(genVisits[0].visitDate.toISOString().slice(0, 10)).toBe(CROSS_DAY);
      expect(optimizerLandedOnDay).toBe(false);
    } else {
      expect(genVisits).toHaveLength(0);
      expect(
        (confirmResponse.body.shortfalls as { reason: string; message: string }[]).map(
          (shortfall) => shortfall.reason,
        ),
      ).toContain('BRANCH_DAY_AT_CAPACITY');
    }
  }
  // The cap held, and not only on the day these two writers were fighting over.
  await expectNoBranchDayOverItsCapacity();
}, 180_000);

// ---------------------------------------------------------------------------
// The same contest, with the ordering forced rather than raced.
//
// The test above runs both writers at once, so which of them reads the
// calendar first is up to the machine. That is worth having — it is what
// actually happens — but it means the interesting half only gets exercised
// when the scheduler happens to cooperate, and for a long time it did not:
// the ordering where generation reads a day that is already full went
// untested, and the cap quietly did not hold there. These two force each
// ordering in turn, so both are covered on every run.

/** An agreement allowed exactly one weekday, so the guard has nowhere to spread to. */
async function makeSingleDayAgreement(
  label: string,
  startDate: string,
  weekday: Weekday,
  options: { frequencyCount?: number; durationMinutes?: number } = {},
): Promise<string> {
  const site = await prisma.serviceSite.create({
    data: {
      customerId,
      name: `Cross Writer Site ${label} ${suffix}`,
      branchId,
      branchCode: BranchCode.COLOMBO,
      operatingHours: {
        create: ALL_WEEKDAYS.map((day) => ({
          weekday: day,
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
      frequencyCount: options.frequencyCount ?? 1,
      frequencyUnit: FrequencyUnit.WEEK,
      frequencyInterval: 1,
      crewSize: 1,
      durationMinutes: options.durationMinutes ?? REFERENCE_VISIT_MINUTES,
      startDate: at(startDate),
      dayRules: { create: [{ weekday, kind: DayRuleKind.ALLOWED }] },
    },
  });
  agreementIds.push(agreement.id);
  return agreement.id;
}

const FULL_WEEK = { from: '2029-04-16', to: '2029-04-22' };
const FULL_DAY = FULL_WEEK.from;

it('leaves a visit unplanned, with its reason, when the one day it allows is already full', async () => {
  const filler = await makeAgreement('forced-filler', FULL_WEEK.from);
  const agreementOpt = await makeAgreement('forced-optimizer', FULL_WEEK.from);
  const visitOpt = await makeMovableVisit(agreementOpt, FULL_WEEK.to);
  const crewOpt = await makeCrew('forced-optimizer');
  const { runId, lease } = await makeLeasedRun(FULL_WEEK);

  const capVisits = await capVisitsOn(FULL_DAY);
  await fillDay(filler, FULL_DAY, capVisits - 1);

  const agreementGen = await makeSingleDayAgreement('forced-generation', FULL_WEEK.from, Weekday.MONDAY);

  // The optimizer goes first and takes the day's last slot, so the day is
  // exactly at its cap by the time generation reads it.
  const optimizerResult = await persistMoveTo(runId, lease, visitOpt, crewOpt, FULL_DAY);
  expect(optimizerResult.scheduled).toBe(1);
  expect(await loadOn(FULL_DAY)).toBe(capVisits);

  const confirmed = await request(http)
    .post('/api/visit-generation/confirm')
    .set(auth())
    .send({ ...FULL_WEEK, branchCode: BranchCode.COLOMBO, serviceAgreementIds: [agreementGen] });

  // The run succeeds — nothing has gone wrong, and refusing it outright would
  // stop a branch generating the moment one of its days filled up. What it
  // does not do is create the visit.
  expect(confirmed.status).toBe(200);
  expect(confirmed.body.additions).toHaveLength(0);
  expect(await loadOn(FULL_DAY)).toBe(capVisits);
  expect(
    await prisma.generatedVisit.count({ where: { serviceAgreementId: agreementGen } }),
  ).toBe(0);

  // And it says so, in the same vocabulary as every other period that cannot
  // hold what its agreement promises: a stable reason, the period it belongs
  // to, and how much of it landed.
  const shortfall = (
    confirmed.body.shortfalls as {
      serviceAgreementId: string;
      reason: string;
      requested: number;
      scheduled: number;
      periodStart: string;
      message: string;
    }[]
  ).find((entry) => entry.serviceAgreementId === agreementGen);
  expect(shortfall).toBeDefined();
  expect(shortfall!.reason).toBe('BRANCH_DAY_AT_CAPACITY');
  expect(shortfall!.requested).toBe(1);
  expect(shortfall!.scheduled).toBe(0);
  expect(shortfall!.periodStart).toBe(FULL_DAY);
  expect(shortfall!.message).toContain(FULL_DAY);

  // Repeating the run changes nothing and says exactly the same thing. A
  // manager who clicks Generate twice on a full day gets one answer, not a
  // second visit and not a different explanation.
  const again = await request(http)
    .post('/api/visit-generation/confirm')
    .set(auth())
    .send({ ...FULL_WEEK, branchCode: BranchCode.COLOMBO, serviceAgreementIds: [agreementGen] });
  expect(again.status).toBe(200);
  expect(again.body.additions).toHaveLength(0);
  expect(again.body.removals).toHaveLength(0);
  expect(await loadOn(FULL_DAY)).toBe(capVisits);
  expect(
    (again.body.shortfalls as { serviceAgreementId: string; reason: string }[]).find(
      (entry) => entry.serviceAgreementId === agreementGen,
    )?.reason,
  ).toBe('BRANCH_DAY_AT_CAPACITY');
  // The cap held, and not only on the day these two writers were fighting over.
  await expectNoBranchDayOverItsCapacity();
}, 180_000);

const GEN_FIRST_WEEK = { from: '2029-04-23', to: '2029-04-29' };
const GEN_FIRST_DAY = GEN_FIRST_WEEK.from;

it('refuses the optimizer the last slot when a generation confirm took it first', async () => {
  const filler = await makeAgreement('gen-first-filler', GEN_FIRST_WEEK.from);
  const agreementOpt = await makeAgreement('gen-first-optimizer', GEN_FIRST_WEEK.from);
  const visitOpt = await makeMovableVisit(agreementOpt, GEN_FIRST_WEEK.to);
  const crewOpt = await makeCrew('gen-first-optimizer');
  const { runId, lease } = await makeLeasedRun(GEN_FIRST_WEEK);

  const capVisits = await capVisitsOn(GEN_FIRST_DAY);
  await fillDay(filler, GEN_FIRST_DAY, capVisits - 1);

  const agreementGen = await makeSingleDayAgreement(
    'gen-first-generation',
    GEN_FIRST_WEEK.from,
    Weekday.MONDAY,
  );

  // Generation goes first this time, and the one free slot is genuinely free
  // when it reads the day — so it plans the visit and the day reaches its cap.
  const confirmed = await request(http)
    .post('/api/visit-generation/confirm')
    .set(auth())
    .send({
      ...GEN_FIRST_WEEK,
      branchCode: BranchCode.COLOMBO,
      serviceAgreementIds: [agreementGen],
    });
  expect(confirmed.status).toBe(200);
  expect(confirmed.body.additions).toHaveLength(1);
  expect(
    (confirmed.body.shortfalls as { serviceAgreementId: string }[]).some(
      (entry) => entry.serviceAgreementId === agreementGen,
    ),
  ).toBe(false);
  expect(await loadOn(GEN_FIRST_DAY)).toBe(capVisits);

  // The optimizer now wants the slot that has gone. Its own cap check refuses
  // the move and leaves the visit where it was, rather than taking the day
  // one over.
  const optimizerResult = await persistMoveTo(runId, lease, visitOpt, crewOpt, GEN_FIRST_DAY);
  expect(await loadOn(GEN_FIRST_DAY)).toBe(capVisits);
  const optVisit = await prisma.generatedVisit.findUniqueOrThrow({ where: { id: visitOpt.id } });
  expect(optVisit.visitDate.toISOString().slice(0, 10)).toBe(GEN_FIRST_WEEK.to);
  // A refused move still staffs the visit on the day it already had, so the
  // run itself reports it scheduled — the assertion that matters is where it
  // landed, checked above.
  expect(optimizerResult.scheduled).toBe(1);
  // The cap held, and not only on the day these two writers were fighting over.
  await expectNoBranchDayOverItsCapacity();
}, 180_000);

const SPREAD_WEEK = { from: '2029-04-30', to: '2029-05-06' };
const SPREAD_DAY = SPREAD_WEEK.from;

it('plans the visit on the alternative day rather than leaving it unplanned, when there is one', async () => {
  const filler = await makeAgreement('spread-filler', SPREAD_WEEK.from);
  const capVisits = await capVisitsOn(SPREAD_DAY);
  await fillDay(filler, SPREAD_DAY, capVisits);
  expect(await loadOn(SPREAD_DAY)).toBe(capVisits);

  // The mirror of the test above, and the reason it is here: "no compliant
  // destination" has to mean no destination, not merely a full preference.
  // The same full Monday, the same agreement — except that this one is also
  // allowed on Tuesday, and so it is planned rather than dropped.
  const site = await prisma.serviceSite.create({
    data: {
      customerId,
      name: `Cross Writer Site spread-generation ${suffix}`,
      branchId,
      branchCode: BranchCode.COLOMBO,
      operatingHours: {
        create: ALL_WEEKDAYS.map((day) => ({
          weekday: day,
          opensAtMinute: 8 * 60,
          closesAtMinute: 17 * 60,
          provenance: DataProvenance.MANAGER_CONFIRMED,
        })),
      },
    },
  });
  const agreementGen = await prisma.serviceAgreement.create({
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
      startDate: at(SPREAD_WEEK.from),
      dayRules: {
        create: [
          { weekday: Weekday.MONDAY, kind: DayRuleKind.ALLOWED },
          { weekday: Weekday.TUESDAY, kind: DayRuleKind.ALLOWED },
          { weekday: Weekday.MONDAY, kind: DayRuleKind.PREFERRED },
        ],
      },
    },
  });
  agreementIds.push(agreementGen.id);

  const confirmed = await request(http)
    .post('/api/visit-generation/confirm')
    .set(auth())
    .send({
      ...SPREAD_WEEK,
      branchCode: BranchCode.COLOMBO,
      serviceAgreementIds: [agreementGen.id],
    });

  expect(confirmed.status).toBe(200);
  expect(confirmed.body.additions).toHaveLength(1);
  expect(
    (confirmed.body.shortfalls as { serviceAgreementId: string }[]).some(
      (entry) => entry.serviceAgreementId === agreementGen.id,
    ),
  ).toBe(false);

  const planned = await prisma.generatedVisit.findMany({
    where: { serviceAgreementId: agreementGen.id },
    select: { visitDate: true },
  });
  expect(planned).toHaveLength(1);
  // Tuesday, not the full Monday it would have preferred.
  expect(planned[0].visitDate.toISOString().slice(0, 10)).toBe('2029-05-01');
  // And the full day is untouched: the guard moved its own work, it did not
  // make room by shifting somebody else's.
  expect(await loadOn(SPREAD_DAY)).toBe(capVisits);
  // The cap held, and not only on the day these two writers were fighting over.
  await expectNoBranchDayOverItsCapacity();
}, 180_000);

const PROTECTED_WEEK = { from: '2029-05-07', to: '2029-05-13' };
const PROTECTED_DAY = PROTECTED_WEEK.from;

it('never sheds a locked, hand-adjusted visit off a day that is over its cap', async () => {
  // The other half of the rule. Leaving new work unplanned when a day is full
  // is only safe if it can never reach for work the day already has: a
  // requirement whose visit is already in the calendar is existing work, and
  // dropping it would not leave something unplanned, it would delete
  // something a customer already has.
  const agreementGen = await makeSingleDayAgreement(
    'protected-generation',
    PROTECTED_WEEK.from,
    Weekday.MONDAY,
  );

  const first = await request(http)
    .post('/api/visit-generation/confirm')
    .set(auth())
    .send({
      ...PROTECTED_WEEK,
      branchCode: BranchCode.COLOMBO,
      serviceAgreementIds: [agreementGen],
    });
  expect(first.status).toBe(200);
  const planted = await prisma.generatedVisit.findFirstOrThrow({
    where: { serviceAgreementId: agreementGen },
  });
  expect(planted.visitDate.toISOString().slice(0, 10)).toBe(PROTECTED_DAY);

  // A manager then locks it and moves it by hand — the strongest protection
  // a visit carries short of publication.
  await prisma.generatedVisit.update({
    where: { id: planted.id },
    data: {
      isManuallyAdjusted: true,
      manuallyAdjustedAt: new Date(),
      lockedAt: new Date(),
      lockReason: 'Customer asked for this crew on this day',
    },
  });

  // And the day is then pushed well past its cap by work from elsewhere, so
  // the guard has every reason to want something off it.
  const capVisits = await capVisitsOn(PROTECTED_DAY);
  const filler = await makeAgreement('protected-filler', PROTECTED_WEEK.from);
  await fillDay(filler, PROTECTED_DAY, capVisits + 1);
  expect(await loadOn(PROTECTED_DAY)).toBeGreaterThan(capVisits);

  const again = await request(http)
    .post('/api/visit-generation/confirm')
    .set(auth())
    .send({
      ...PROTECTED_WEEK,
      branchCode: BranchCode.COLOMBO,
      serviceAgreementIds: [agreementGen],
    });
  expect(again.status).toBe(200);

  // Untouched: same row, same day, still locked. Not removed, and not turned
  // into a shortfall claiming it could not be placed.
  const after = await prisma.generatedVisit.findUniqueOrThrow({ where: { id: planted.id } });
  expect(after.visitDate.toISOString().slice(0, 10)).toBe(PROTECTED_DAY);
  expect(after.lockedAt).not.toBeNull();
  expect(after.isManuallyAdjusted).toBe(true);
  expect(again.body.removals).toHaveLength(0);
  expect(
    (again.body.shortfalls as { serviceAgreementId: string }[]).some(
      (entry) => entry.serviceAgreementId === agreementGen,
    ),
  ).toBe(false);

  // The day is over its cap and says so, which is the honest answer when
  // everything on it is work nobody may move.
  expect(
    (again.body.loadWarnings as { date: string }[]).some(
      (warning) => warning.date === PROTECTED_DAY,
    ),
  ).toBe(true);
}, 180_000);

const HEAVIER_WEEK = { from: '2029-05-14', to: '2029-05-20' };
const HEAVIER_DAY = HEAVIER_WEEK.from;

it('will not grow an existing unprotected visit past the day it stands on', async () => {
  // The guard may not shed work the calendar already holds — but "already
  // holds" has to mean a real commitment, not merely a row. A PENDING visit
  // nobody has touched is the generator's own output; `planGeneration` is
  // free to update, move or remove it. Treating it as untouchable reopened
  // the over-cap path from the other side: the requirement grows, the guard
  // preserves it because a row exists, the plan becomes an *update*, and
  // `assertTheDaysStillHaveRoom` deliberately does not weigh updates.
  const agreementGen = await makeSingleDayAgreement(
    'heavier-generation',
    HEAVIER_WEEK.from,
    Weekday.MONDAY,
  );

  const first = await request(http)
    .post('/api/visit-generation/confirm')
    .set(auth())
    .send({ ...HEAVIER_WEEK, branchCode: BranchCode.COLOMBO, serviceAgreementIds: [agreementGen] });
  expect(first.status).toBe(200);
  const planted = await prisma.generatedVisit.findFirstOrThrow({
    where: { serviceAgreementId: agreementGen },
  });
  expect(planted.visitDate.toISOString().slice(0, 10)).toBe(HEAVIER_DAY);
  // Untouched by anyone: the generator's own work, not a commitment.
  expect(planted.status).toBe(VisitStatus.PENDING);
  expect(planted.isManuallyAdjusted).toBe(false);
  expect(planted.lockedAt).toBeNull();

  // Fill the rest of the day, so it sits exactly on its cap with this visit.
  const capVisits = await capVisitsOn(HEAVIER_DAY);
  const filler = await makeAgreement('heavier-filler', HEAVIER_WEEK.from);
  await fillDay(filler, HEAVIER_DAY, capVisits - 1);
  expect(await loadOn(HEAVIER_DAY)).toBe(capVisits);

  // The agreement now wants three times the work on that same day.
  await prisma.serviceAgreement.update({
    where: { id: agreementGen },
    data: { durationMinutes: REFERENCE_VISIT_MINUTES * 3 },
  });

  const again = await request(http)
    .post('/api/visit-generation/confirm')
    .set(auth())
    .send({ ...HEAVIER_WEEK, branchCode: BranchCode.COLOMBO, serviceAgreementIds: [agreementGen] });
  expect([200, 409]).toContain(again.status);

  // Whatever it decided, it may not have left the day carrying more than the
  // branch can do. Growing a visit in place is as much a way over the cap as
  // adding one.
  await expectNoBranchDayOverItsCapacity();

  if (again.status === 200) {
    const onTheDay = (
      await prisma.generatedVisit.findMany({
        where: { serviceAgreementId: agreementGen },
        select: { durationMinutes: true, visitDate: true },
      })
    ).filter((visit) => visit.visitDate.toISOString().slice(0, 10) === HEAVIER_DAY);

    // Exactly two outcomes are acceptable, and "grew it anyway" is neither.
    if (onTheDay.length === 0) {
      // Left unplanned, and named rather than dropped in silence.
      expect(again.body.removals).toHaveLength(1);
      expect(
        (again.body.shortfalls as { serviceAgreementId: string; reason: string }[]).some(
          (entry) =>
            entry.serviceAgreementId === agreementGen &&
            entry.reason === 'BRANCH_DAY_AT_CAPACITY',
        ),
      ).toBe(true);
    } else {
      // Or kept at the size the day can carry — never grown past it.
      expect(onTheDay).toHaveLength(1);
      expect(onTheDay[0].durationMinutes).toBe(REFERENCE_VISIT_MINUTES);
    }

    // And it settles there. Leaving work unplanned can mean removing a row
    // the generator owns, so the run after it must not put the same visit
    // back and start the calendar oscillating.
    const third = await request(http)
      .post('/api/visit-generation/confirm')
      .set(auth())
      .send({
        ...HEAVIER_WEEK,
        branchCode: BranchCode.COLOMBO,
        serviceAgreementIds: [agreementGen],
      });
    expect(third.status).toBe(200);
    expect(third.body.additions).toHaveLength(0);
    expect(third.body.removals).toHaveLength(0);
    expect(third.body.updates).toHaveLength(0);
    await expectNoBranchDayOverItsCapacity();
  }
}, 180_000);

const RECONCILE_WEEK = { from: '2029-05-21', to: '2029-05-27' };
const RECONCILE_DAY = RECONCILE_WEEK.from;

it('publishes one authoritative outcome for a period two different things went wrong in', async () => {
  // Three visits a week promised, and exactly one weekday allowed to hold
  // them: planning alone can only place one, and reports the other two. Then
  // the one day it could use turns out to be full, so that one is left
  // unplanned too. The honest total is nought of three.
  //
  // Reported as two rows it is worse than useless: "3 requested, 1 scheduled"
  // beside "1 requested, 0 scheduled", two different denominators for one
  // promise, and neither of them saying nought of three.
  const capVisits = await capVisitsOn(RECONCILE_DAY);
  const filler = await makeAgreement('reconcile-filler', RECONCILE_WEEK.from);
  await fillDay(filler, RECONCILE_DAY, capVisits);
  expect(await loadOn(RECONCILE_DAY)).toBe(capVisits);

  const agreementGen = await makeSingleDayAgreement(
    'reconcile-generation',
    RECONCILE_WEEK.from,
    Weekday.MONDAY,
    { frequencyCount: 3 },
  );

  const confirmed = await request(http)
    .post('/api/visit-generation/confirm')
    .set(auth())
    .send({
      ...RECONCILE_WEEK,
      branchCode: BranchCode.COLOMBO,
      serviceAgreementIds: [agreementGen],
    });
  expect(confirmed.status).toBe(200);
  expect(confirmed.body.additions).toHaveLength(0);

  const mine = (
    confirmed.body.shortfalls as {
      serviceAgreementId: string;
      periodStart: string;
      requested: number;
      scheduled: number;
      reason: string;
      reasons: string[];
      message: string;
    }[]
  ).filter((entry) => entry.serviceAgreementId === agreementGen);

  // One row for the period, not one per thing that went wrong.
  expect(mine).toHaveLength(1);
  // The denominator is the agreement's promise, and the numerator is what
  // survived every stage — not what survived one of them.
  expect(mine[0].requested).toBe(3);
  expect(mine[0].scheduled).toBe(0);
  // Both causes are still on the record, modelled rather than duplicated.
  expect(mine[0].reasons).toContain('NOT_ENOUGH_ALLOWED_DAYS');
  expect(mine[0].reasons).toContain('BRANCH_DAY_AT_CAPACITY');
  expect(mine[0].reason).toBe(mine[0].reasons[0]);

  await expectNoBranchDayOverItsCapacity();
}, 180_000);

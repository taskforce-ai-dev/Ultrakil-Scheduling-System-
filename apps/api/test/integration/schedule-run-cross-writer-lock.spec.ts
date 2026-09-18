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

  if (confirmResponse.status === 200) {
    expect(genVisits).toHaveLength(1);
  }
}, 180_000);

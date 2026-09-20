/**
 * The daily cap has to survive the optimizer, not only generation.
 *
 * Generation enforces `VISIT_GENERATION_DAILY_CAP` across every agreement at
 * once, and a manager reading the calendar straight after a generation sees a
 * month whose busiest day sits at the cap. One solve over part of that month
 * then moved eight visits off one day onto another and left a twenty-job day
 * on the board — the original complaint, alive in the other half of the
 * system, because the solver is never told the cap and the persistence
 * transaction that commits its moves never checked the day it was moving on
 * to.
 *
 * These tests run the real thing end to end: generate a range, solve the same
 * range with the real solver, and count the branch-days. The counting basis is
 * the one generation's own warning uses — every visit standing on that
 * branch-day that is not cancelled, whatever agreement it belongs to.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AvailabilityKind,
  BranchCode,
  DataProvenance,
  DayRuleKind,
  FrequencyUnit,
  PrismaClient,
  UserRole,
  VisitStatus,
  Weekday,
} from '@prisma/client';
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
  email: `cap-admin-${suffix}@ultrakil.test`,
  password: 'cap-admin-password',
};

/**
 * A week no other suite touches, and one nothing else in the database has any
 * work in. The cap is a property of a whole branch-day, so a window sharing
 * its days with another suite's fixture would be measuring that suite too.
 * 2028-05-08 is a Monday.
 */
const RANGE = { from: '2028-05-08', to: '2028-05-14' };
const DAYS = [
  '2028-05-08',
  '2028-05-09',
  '2028-05-10',
  '2028-05-11',
  '2028-05-12',
  '2028-05-13',
  '2028-05-14',
];

/**
 * Sixty weekly agreements over seven days: enough that generation has to
 * spread them, few enough that it leaves every day short of the cap. Both
 * halves matter — a calendar already at the cap everywhere would prove the
 * backstop refuses moves without proving it still allows the legitimate ones.
 */
const AGREEMENTS = 60;

/**
 * Five crews' worth of staff, so the optimizer is never crew-constrained —
 * only two of them are left available (see `beforeAll`'s pinning below), so
 * the branch's own real, resource-derived capacity stays small and
 * deterministic; the rest exist purely so a variety of employees, not a
 * headcount, is what the optimizer has to choose from.
 */
const CREWS = 5;

/**
 * One crew-hour: the fixture's own agreements are all this size, so a
 * visit's crew-minutes cost is exactly one unit of it, and the cap reads as a
 * plain visit count.
 */
const REFERENCE_VISIT_MINUTES = 60;

/**
 * The branch-day cap this suite actually measures against — real, per-branch
 * capacity ({@link BranchDayCapacityService}), not the flat constant it
 * replaced. Set once real capacity is pinned deterministic, near the top of
 * `beforeAll` below.
 */
let CAP_VISITS: number;

let app: INestApplication;
let http: string;
let adminToken: string;
let runs: ScheduleRunService;
let customerId: string;
let jobTypeId: string;
let branchId: string;
const agreementIds: string[] = [];
const employeeIds: string[] = [];
/** Cleared in `afterAll`: leave rows pinning capacity for employees this suite does not own. */
const pinnedAvailabilityIds: string[] = [];

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const ALL_WEEKDAYS = [
  Weekday.MONDAY,
  Weekday.TUESDAY,
  Weekday.WEDNESDAY,
  Weekday.THURSDAY,
  Weekday.FRIDAY,
  Weekday.SATURDAY,
  Weekday.SUNDAY,
];

/** Every visit standing on a COLOMBO day in the range, by date. */
async function loadByDay(): Promise<Map<string, number>> {
  const visits = await prisma.generatedVisit.findMany({
    where: {
      branchCode: BranchCode.COLOMBO,
      visitDate: {
        gte: new Date(`${RANGE.from}T00:00:00.000Z`),
        lte: new Date(`${RANGE.to}T00:00:00.000Z`),
      },
      // The same basis generation counts a day on: cancelled work occupies no
      // part of a day, everything else does.
      status: { not: VisitStatus.CANCELLED },
    },
    select: { visitDate: true },
  });

  const byDay = new Map<string, number>(DAYS.map((date) => [date, 0]));
  for (const visit of visits) {
    const date = visit.visitDate.toISOString().slice(0, 10);
    byDay.set(date, (byDay.get(date) ?? 0) + 1);
  }
  return byDay;
}

/** Where this suite's own visits stand, so a move can be recognised as one. */
async function datesByVisit(): Promise<Map<string, string>> {
  const visits = await prisma.generatedVisit.findMany({
    where: { serviceAgreementId: { in: agreementIds } },
    select: { id: true, visitDate: true },
  });
  return new Map(
    visits.map((visit) => [visit.id, visit.visitDate.toISOString().slice(0, 10)]),
  );
}

/**
 * What the ledger counted, from outside the service that builds it.
 *
 * `lockAndReadDailyLoad` is private, and rightly so: nothing but the
 * persistence transaction has any business building a ledger. But the "not cancelled" half
 * of its counting basis is invisible from out here — the solve below never
 * cancels anything, so a build with that filter deleted passes every other
 * assertion in this file. This shape is the narrowest reach that can tell the
 * difference, and it is typed rather than `any` so a change to the method's
 * signature still breaks the suite.
 */
type DailyLoadReader = {
  lockAndReadDailyLoad(
    tx: PrismaClient,
    proposals: {
      branchCode: BranchCode;
      visitDate: Date;
      proposedVisit?: { visitDate: Date };
      crewMinutes: number;
    }[],
  ): Promise<{
    minutesOn(branchCode: BranchCode, date: string): number;
    admitsMoveOnto(branchCode: BranchCode, date: string, crewMinutes: number): boolean;
  }>;
};

const capReader = (service: ScheduleRunService): DailyLoadReader =>
  service as unknown as DailyLoadReader;

const shape = (byDay: Map<string, number>): string =>
  DAYS.map((date) => `${date.slice(5)}=${byDay.get(date) ?? 0}`).join(' ');

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    // A plain value carries no @Processor metadata, so BullMQ registers no
    // worker and the run these tests create is solved inline, once.
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
      fullName: 'Cap Admin',
      role: UserRole.ADMIN,
      passwordHash: await AuthService.hashPassword(ADMIN.password),
    },
    update: { role: UserRole.ADMIN, isActive: true },
  });
  const login = await request(http)
    .post('/api/auth/login')
    .send({ email: ADMIN.email, password: ADMIN.password });
  expect(login.status).toBe(200);
  adminToken = login.body.accessToken as string;

  for (let index = 0; index < CREWS; index += 1) {
    const supervisor = await prisma.employee.create({
      data: {
        sourceKey: `cap-sup-${index}-${suffix}`,
        fullName: `Cap Supervisor ${index} ${suffix}`,
        gradeLabel: 'PMS',
        isPmsGrade: true,
        branchId: branch.id,
        branchCode: BranchCode.COLOMBO,
        canUsePublicTransport: true,
      },
    });
    const technician = await prisma.employee.create({
      data: {
        sourceKey: `cap-tech-${index}-${suffix}`,
        fullName: `Cap Technician ${index} ${suffix}`,
        gradeLabel: 'Junior PMT',
        branchId: branch.id,
        branchCode: BranchCode.COLOMBO,
        canUsePublicTransport: true,
      },
    });
    employeeIds.push(supervisor.id, technician.id);
  }

  // Real, resource-derived capacity now governs this branch-day exactly as
  // it does in production, so it has to be pinned deterministic the same
  // way `branch-day-cap-lock.spec.ts` already pins COLOMBO's: every active
  // COLOMBO employee this shared database has, whoever created it, except
  // one PMS supervisor and one technician of this suite's own, goes on
  // leave for the whole window these tests touch. That leaves exactly two
  // available employees, so `capacityFor` reads a small, known number
  // instead of whatever headcount this suite's own five crews — or another
  // suite's leftovers — would otherwise add up to.
  const colomboEmployees = await prisma.employee.findMany({
    where: { branchCode: BranchCode.COLOMBO, isActive: true },
    select: { id: true },
  });
  const keepIds = new Set(employeeIds.slice(0, 2));
  const toPin = colomboEmployees.filter((employee) => !keepIds.has(employee.id));
  if (toPin.length > 0) {
    const pinned = await prisma.employeeAvailability.createManyAndReturn({
      data: toPin.map((employee) => ({
        employeeId: employee.id,
        startDate: new Date(`${RANGE.from}T00:00:00.000Z`),
        endDate: new Date('2028-05-15T00:00:00.000Z'),
        kind: AvailabilityKind.LEAVE,
        reason: 'schedule-run-daily-cap.spec.ts: pinned for a deterministic capacity',
      })),
      select: { id: true },
    });
    pinnedAvailabilityIds.push(...pinned.map((row) => row.id));
  }

  const capacity = await app
    .get(BranchDayCapacityService)
    .capacityFor(BranchCode.COLOMBO, RANGE.from);
  CAP_VISITS = capacity.capacityMinutes / REFERENCE_VISIT_MINUTES;

  // One crew-hour each, so the cap reads as a plain visit count.
  const jobType = await prisma.jobType.create({
    data: {
      code: `CAP_${suffix}`,
      name: 'Cap Treatment',
      defaultCrewSize: 1,
      defaultDurationMinutes: 60,
    },
  });
  jobTypeId = jobType.id;

  const customer = await prisma.customer.create({
    data: {
      name: `Cap Client ${suffix}`,
      branchId: branch.id,
      branchCode: BranchCode.COLOMBO,
    },
  });
  customerId = customer.id;

  for (let index = 0; index < AGREEMENTS; index += 1) {
    const site = await prisma.serviceSite.create({
      data: {
        customerId,
        name: `Cap Site ${index} ${suffix}`,
        branchId: branch.id,
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
        branchId: branch.id,
        branchCode: BranchCode.COLOMBO,
        frequencyCount: 1,
        frequencyUnit: FrequencyUnit.WEEK,
        frequencyInterval: 1,
        crewSize: 1,
        durationMinutes: 60,
        startDate: new Date(`${RANGE.from}T00:00:00.000Z`),
        // Every weekday allowed, so the solver has a whole week of legal days
        // to move a visit to and generation has a whole week to spread over.
        dayRules: {
          create: ALL_WEEKDAYS.map((weekday) => ({
            weekday,
            kind: DayRuleKind.ALLOWED,
          })),
        },
      },
    });
    agreementIds.push(agreement.id);
  }
}, 300_000);

afterAll(async () => {
  if (pinnedAvailabilityIds.length > 0) {
    await prisma.employeeAvailability.deleteMany({
      where: { id: { in: pinnedAvailabilityIds } },
    });
  }
  // This database is shared with every other integration suite, and sixty
  // stray agreements would quietly change their counts. Dependants first and
  // by hand: the schema does cascade, but a suite leaning on that has no way
  // of noticing the day it stops being true.
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
  if (employeeIds.length > 0) {
    await prisma.employee.deleteMany({ where: { id: { in: employeeIds } } });
  }
  if (jobTypeId) {
    await prisma.jobType.delete({ where: { id: jobTypeId } }).catch(() => undefined);
  }
  await prisma.scheduleRun.deleteMany({
    where: {
      rangeStart: new Date(`${RANGE.from}T00:00:00.000Z`),
      rangeEnd: new Date(`${RANGE.to}T00:00:00.000Z`),
    },
  });
  await prisma.user.deleteMany({ where: { email: ADMIN.email } });
  await prisma.$disconnect();
  await app.close();
}, 120_000);

describe('a generated week, then one solve over it', () => {
  let before: Map<string, number>;
  let after: Map<string, number>;
  let datesBefore: Map<string, string>;
  let datesAfter: Map<string, string>;

  beforeAll(async () => {
    const generated = await request(http)
      .post('/api/visit-generation/confirm')
      .set(auth(adminToken))
      .send({ ...RANGE, serviceAgreementIds: agreementIds });
    expect(generated.status).toBe(200);

    before = await loadByDay();
    datesBefore = await datesByVisit();

    const created = await request(http)
      .post('/api/schedule-runs')
      .set(auth(adminToken))
      .send({ ...RANGE, branchCode: BranchCode.COLOMBO, timeLimitSeconds: 5 });
    expect(created.status).toBe(201);
    await runs.execute(created.body.id as string, { timeLimitSeconds: 5 });

    after = await loadByDay();
    datesAfter = await datesByVisit();

    // Printed on purpose: when this suite fails, the shape of the two
    // calendars is the whole diagnosis.
    console.log(`before solve: ${shape(before)}`);
    console.log(`after  solve: ${shape(after)}`);
  }, 300_000);

  it('generates a week no day of which is over the cap', () => {
    for (const date of DAYS) {
      expect(before.get(date) ?? 0).toBeLessThanOrEqual(CAP_VISITS);
    }
    // A week that never came near the cap would pass the test below for the
    // wrong reason, so prove the fixture actually loads the days.
    expect(Math.max(...before.values())).toBeGreaterThan(
      CAP_VISITS / 2,
    );
  });

  it('leaves no day over the cap after the solve', () => {
    const over = DAYS.filter(
      (date) => (after.get(date) ?? 0) > CAP_VISITS,
    ).map((date) => `${date} carries ${after.get(date)}`);

    expect(over).toEqual([]);
  });

  it('never makes a day heavier than the cap allows, whatever it started at', () => {
    for (const date of DAYS) {
      const started = before.get(date) ?? 0;
      const ended = after.get(date) ?? 0;
      // Either the day ends inside the cap, or it ends no heavier than it
      // began. A day only ever gets worse by having work moved on to it.
      expect(
        ended <= CAP_VISITS || ended <= started,
      ).toBe(true);
    }
  });

  it('still moves the visits that have somewhere to go', () => {
    const moved = [...datesBefore.entries()].filter(
      ([id, date]) => datesAfter.get(id) !== date,
    );

    // The backstop refuses a move on to a full day. Refusing every move would
    // satisfy the cap and destroy the optimizer, so this is the other half of
    // the promise: days with room still receive work.
    expect(moved.length).toBeGreaterThan(0);
  });

  it('keeps every visit, moved or not, somewhere in the range', async () => {
    const visits = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: { in: agreementIds } },
      select: { id: true, visitDate: true, status: true },
    });

    // A refused move must not lose the visit. Every one is still there, still
    // inside the run's range, and none is left in limbo.
    expect(visits).toHaveLength(datesBefore.size);
    for (const visit of visits) {
      const date = visit.visitDate.toISOString().slice(0, 10);
      expect(DAYS).toContain(date);
      expect([VisitStatus.PENDING, VisitStatus.SCHEDULED, VisitStatus.UNASSIGNED]).toContain(
        visit.status,
      );
    }
  });
});

/**
 * The counting basis, pinned.
 *
 * The suite above proves the cap holds; it cannot prove *what* the cap counts.
 * Every day it measures is built out of live visits, so `readDailyLoad` could
 * drop `status: { not: CANCELLED }` and nothing above would notice. This day
 * is built to notice: it carries exactly the cap in rows, one of them
 * cancelled, so the documented basis reads it as one short of full and lets a
 * move on to it through, while a basis that counted cancelled work would call
 * it full and refuse. Cancelled work occupies no part of a day — that is the
 * rule, and this is where it is held.
 */
describe('a branch-day at the cap, one of its visits cancelled', () => {
  /**
   * The Monday after the run's range, so the calendar the tests above measured
   * is untouched and generation never put anything here itself.
   */
  const DAY = '2028-05-15';
  const dayAt = new Date(`${DAY}T00:00:00.000Z`);

  beforeAll(async () => {
    // One visit per agreement, because the basis is cross-agreement: the day
    // is full on the crew-minutes standing on it, not on whose they are.
    for (let index = 0; index < CAP_VISITS; index += 1) {
      await prisma.generatedVisit.create({
        data: {
          serviceAgreementId: agreementIds[index],
          branchId,
          branchCode: BranchCode.COLOMBO,
          visitDate: dayAt,
          windowStartMinute: 8 * 60,
          windowEndMinute: 17 * 60,
          durationMinutes: REFERENCE_VISIT_MINUTES,
          requiredCrewSize: 1,
          // Exactly one of them called off. The day is at the cap in rows and
          // one short of it in work.
          status: index === 0 ? VisitStatus.CANCELLED : VisitStatus.PENDING,
        },
      });
    }
  }, 120_000);

  it('admits a move on to it, because the cancelled visit occupies no part of the day', async () => {
    const rows = await prisma.generatedVisit.count({
      where: { branchCode: BranchCode.COLOMBO, visitDate: dayAt },
    });
    // If this is not the cap, the fixture is not the day the test describes.
    expect(rows).toBe(CAP_VISITS);

    const ledger = await capReader(runs).lockAndReadDailyLoad(prisma, [
      {
        branchCode: BranchCode.COLOMBO,
        visitDate: new Date(`${RANGE.to}T00:00:00.000Z`),
        proposedVisit: { visitDate: dayAt },
        crewMinutes: REFERENCE_VISIT_MINUTES,
      },
    ]);

    expect(ledger.minutesOn(BranchCode.COLOMBO, DAY)).toBe(
      (CAP_VISITS - 1) * REFERENCE_VISIT_MINUTES,
    );
    expect(
      ledger.admitsMoveOnto(BranchCode.COLOMBO, DAY, REFERENCE_VISIT_MINUTES),
    ).toBe(true);
  });
});

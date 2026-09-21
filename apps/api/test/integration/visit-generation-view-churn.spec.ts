/**
 * The same weeks, planned from the week view and from the month view.
 *
 * Measured on a fresh database: an ISO week generated, then the month grid
 * that contains it, then the same ISO week again — and the third run offered
 * two additions and two removals for work nobody had touched. The month's
 * load guard had moved two weekly visits using the month's fuller picture of
 * each day; the week run saw those days as emptier than they are and wanted
 * the visits back.
 *
 * The reason is a gap between two sets. A run's `existing` set is what it may
 * propose changing, and a PENDING visit whose period the run did not plan — a
 * monthly visit met from a week view — is rightly not in it. The guard's
 * `standing` set is what the run will leave exactly where it is, and that same
 * visit was not in that either. So it counted nowhere, and the two views
 * disagreed about how full a Monday was.
 *
 * The book of work here is the smallest one that shows it: a cap of two, two
 * monthly agreements and one weekly agreement that all want the same Monday,
 * and a fortnightly agreement whose fortnight neither view holds whole.
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
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';

const prisma = new PrismaClient();

const suffix = Math.random().toString(36).slice(2, 8);
const ADMIN = {
  email: `churn-admin-${suffix}@ultrakil.test`,
  password: 'churn-admin-password',
};

const CAP = 2;

/**
 * June 2026. Its grid is 1 June to 5 July — the month begins on a Monday, so
 * the grid is exactly five whole ISO weeks — and the first of those weeks is
 * the week view's own range. Two views, the same Monday.
 */
const WEEK = { from: '2026-06-01', to: '2026-06-07' };
/**
 * The second week of the same grid. The fortnightly agreement's fortnight runs
 * 8-21 June, so the month run plans a visit into this week that a week view
 * cannot see the period of — a PENDING visit standing in a week view, which is
 * the exact shape the churn came from.
 */
const WEEK2 = { from: '2026-06-08', to: '2026-06-14' };
const GRID = { from: '2026-06-01', to: '2026-07-05' };

/**
 * Ids in the order the load guard takes agreements in, so which visit it moves
 * is the test's decision rather than the database's. The weekly agreement
 * sorts first and is therefore the one moved off the crowded Monday.
 */
const tail = `${Math.random().toString(16).slice(2)}${'0'.repeat(12)}`.slice(0, 12);
const uid = (rank: number) => `${String(rank).padStart(8, '0')}-0000-4000-8000-${tail}`;
const WEEKLY = uid(1);
const MONTHLY_A = uid(2);
const MONTHLY_B = uid(3);
const FORTNIGHTLY = uid(4);
const AGREEMENTS = [WEEKLY, MONTHLY_A, MONTHLY_B, FORTNIGHTLY];

let app: INestApplication;
let http: string;
let adminToken: string;
let customerId: string;
let jobTypeId: string;
let churnSupervisorId: string;
let churnTechnicianId: string;

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

interface Impact {
  additions: { visitDate: string; serviceAgreementId: string }[];
  updates: unknown[];
  removals: { visitDate: string; serviceAgreementId: string }[];
  unchangedCount: number;
  loadWarnings: { date: string; plannedCount: number }[];
}

const generate = (path: 'preview' | 'confirm', range: { from: string; to: string }) =>
  request(http)
    .post(`/api/visit-generation/${path}`)
    .set(auth(adminToken))
    .send({ ...range, branchCode: BranchCode.KANDY, serviceAgreementIds: AGREEMENTS });

async function run(path: 'preview' | 'confirm', range: { from: string; to: string }) {
  const response = await generate(path, range);
  expect(response.status).toBe(200);
  return response.body as Impact;
}

/**
 * No day over the cap — asserted after every confirm, not only at the end.
 *
 * A calendar that breaches the cap in the middle and is tidied by a later run
 * is not the promise: each run leaves the calendar it was given in order, and
 * a single check at the end cannot tell the two apart.
 */
async function expectNoDayOverTheCap(): Promise<void> {
  const perDay = new Map<string, number>();
  for (const visit of await visitsNow()) {
    perDay.set(visit.date, (perDay.get(visit.date) ?? 0) + 1);
  }
  expect([...perDay.entries()].filter(([, count]) => count > CAP)).toEqual([]);
}

async function visitsNow(): Promise<{ agreement: string; date: string }[]> {
  const rows = await prisma.generatedVisit.findMany({
    where: { serviceAgreementId: { in: AGREEMENTS } },
    select: { serviceAgreementId: true, visitDate: true },
    orderBy: [{ visitDate: 'asc' }, { serviceAgreementId: 'asc' }],
  });
  return rows.map((row) => ({
    agreement: row.serviceAgreementId,
    date: row.visitDate.toISOString().slice(0, 10),
  }));
}

beforeAll(async () => {
  // Set before the module is built: the employee-workday length is read from
  // the environment when configuration loads. Capacity is now computed per
  // branch-day from real headcount, not a flat constant — two available
  // employees (KANDY's own F Kumara, plus one PMS-grade employee this suite
  // adds below) at sixty minutes each reproduces the same CAP * 60
  // crew-minute figure this suite's arithmetic is built around.
  process.env.VISIT_GENERATION_EMPLOYEE_WORKDAY_MINUTES = '60';

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
  const branch = await prisma.branch.upsert({
    where: { code: BranchCode.KANDY },
    create: { code: BranchCode.KANDY, name: 'KANDY Branch' },
    update: {},
  });

  // KANDY's own real workforce (as of this database) has nobody PMS-grade —
  // deliberately, elsewhere: the "Kandy problem" other suites rely on to
  // prove a branch with no PMS supervisor cannot be staffed at all. This
  // suite is about week/month view consistency, not that gap, so it adds its
  // own people rather than disturbing the shared fixture other tests depend
  // on.
  //
  // Both of them, and that is the point of the pair. The arithmetic here
  // needs exactly `CAP` available employees at sixty minutes each, and this
  // used to count on one of KANDY's own being there to make up the second.
  // It is not reliably there — a freshly migrated database has no imported
  // workforce at all — which left the branch at one employee and a real cap
  // of one visit while every number in this file assumed two. That was
  // invisible while the load guard would place a third visit on a day it
  // knew was full; now that such work is left unplanned, a fixture has to own
  // the capacity its own arithmetic claims.
  const churnSupervisor = await prisma.employee.create({
    data: {
      sourceKey: `view-churn-supervisor-${suffix}`,
      fullName: `View Churn Supervisor ${suffix}`,
      gradeLabel: 'PMS',
      isPmsGrade: true,
      branchId: branch.id,
      branchCode: BranchCode.KANDY,
    },
  });
  churnSupervisorId = churnSupervisor.id;

  const churnTechnician = await prisma.employee.create({
    data: {
      sourceKey: `view-churn-technician-${suffix}`,
      fullName: `View Churn Technician ${suffix}`,
      gradeLabel: 'TECH',
      isPmsGrade: false,
      branchId: branch.id,
      branchCode: BranchCode.KANDY,
    },
  });
  churnTechnicianId = churnTechnician.id;

  // A cap of two is only a cap if nothing else is on these days. This database
  // is shared with every other integration suite, so say so loudly rather than
  // failing later on an arithmetic nobody can reproduce.
  const foreign = await prisma.generatedVisit.count({
    where: {
      branchCode: BranchCode.KANDY,
      visitDate: {
        gte: new Date(`${GRID.from}T00:00:00.000Z`),
        lte: new Date(`${GRID.to}T00:00:00.000Z`),
      },
      serviceAgreementId: { notIn: AGREEMENTS },
    },
  });
  expect(foreign).toBe(0);

  await prisma.user.upsert({
    where: { email: ADMIN.email },
    create: {
      email: ADMIN.email,
      fullName: 'Churn Admin',
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

  const jobType = await prisma.jobType.create({
    data: {
      code: `CHURN_${suffix}`,
      name: 'Churn Treatment',
      defaultCrewSize: 1,
      defaultDurationMinutes: 60,
    },
  });
  jobTypeId = jobType.id;

  const customer = await prisma.customer.create({
    data: {
      name: `Churn Client ${suffix}`,
      branchId: branch.id,
      branchCode: BranchCode.KANDY,
    },
  });
  customerId = customer.id;

  const cadences = [
    { id: WEEKLY, unit: FrequencyUnit.WEEK, interval: 1, days: [Weekday.MONDAY, Weekday.TUESDAY] },
    { id: MONTHLY_A, unit: FrequencyUnit.MONTH, interval: 1, days: [Weekday.MONDAY] },
    { id: MONTHLY_B, unit: FrequencyUnit.MONTH, interval: 1, days: [Weekday.MONDAY] },
    {
      id: FORTNIGHTLY,
      unit: FrequencyUnit.WEEK,
      interval: 2,
      days: [Weekday.MONDAY, Weekday.TUESDAY],
    },
  ];

  for (const [index, cadence] of cadences.entries()) {
    const site = await prisma.serviceSite.create({
      data: {
        customerId,
        name: `Churn Site ${index} ${suffix}`,
        branchId: branch.id,
        branchCode: BranchCode.KANDY,
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

    await prisma.serviceAgreement.create({
      data: {
        id: cadence.id,
        customerId,
        serviceSiteId: site.id,
        jobTypeId,
        branchId: branch.id,
        branchCode: BranchCode.KANDY,
        frequencyCount: 1,
        frequencyUnit: cadence.unit,
        frequencyInterval: cadence.interval,
        crewSize: 1,
        durationMinutes: 60,
        // A Monday, so every cadence's periods are counted from the same day.
        startDate: new Date('2026-01-05T00:00:00.000Z'),
        dayRules: {
          create: cadence.days.map((weekday) => ({ weekday, kind: DayRuleKind.ALLOWED })),
        },
      },
    });
  }
}, 180_000);

afterAll(async () => {
  // This suite's own generated visits, cleared so the branch-days it used are
  // free for whatever runs after it. Generation now leaves work unplanned
  // rather than placing it on a day already at its cap, so a shared calendar
  // that every suite adds to and nobody clears eventually has no room left in
  // it for anybody.
  await prisma.generatedVisit.deleteMany({ where: { serviceAgreement: { jobTypeId } } });
  await prisma.generatedVisit.deleteMany({
    where: { serviceAgreementId: { in: AGREEMENTS } },
  });
  await prisma.serviceAgreement.deleteMany({ where: { id: { in: AGREEMENTS } } });
  if (customerId) {
    const siteIds = (
      await prisma.serviceSite.findMany({ where: { customerId }, select: { id: true } })
    ).map((site) => site.id);
    if (siteIds.length > 0) {
      await prisma.siteOperatingHours.deleteMany({
        where: { serviceSiteId: { in: siteIds } },
      });
      await prisma.serviceSite.deleteMany({ where: { id: { in: siteIds } } });
    }
    await prisma.customer.delete({ where: { id: customerId } });
  }
  if (jobTypeId) await prisma.jobType.delete({ where: { id: jobTypeId } }).catch(() => undefined);
  if (churnSupervisorId) {
    await prisma.employee.delete({ where: { id: churnSupervisorId } }).catch(() => undefined);
  }
  if (churnTechnicianId) {
    await prisma.employee.delete({ where: { id: churnTechnicianId } }).catch(() => undefined);
  }
  await prisma.user.deleteMany({ where: { email: ADMIN.email } });
  await prisma.$disconnect();
  await app.close();
});

describe('the week view and the month view over the same Monday', () => {
  it('settles after one pass each way, and neither view then wants a change', async () => {
    // Week view first: it holds one whole ISO week, so it plans the weekly
    // agreement and leaves the month and the fortnight to a run that can see
    // them whole.
    const firstWeek = await run('confirm', WEEK);
    expect(firstWeek.additions).toHaveLength(1);
    expect(firstWeek.additions[0].visitDate).toBe('2026-06-01');
    await expectNoDayOverTheCap();

    // Month view: now the two monthly agreements want that same Monday, which
    // puts three visits on a day the branch plans two for. The guard moves the
    // weekly visit — the one whose period holds another allowed day — to the
    // Tuesday.
    const month = await run('confirm', GRID);
    expect(month.removals.map((removal) => removal.visitDate)).toEqual(['2026-06-01']);
    expect(
      month.additions.some(
        (addition) =>
          addition.serviceAgreementId === WEEKLY && addition.visitDate === '2026-06-02',
      ),
    ).toBe(true);

    await expectNoDayOverTheCap();

    const afterMonth = await visitsNow();
    expect(afterMonth.filter((visit) => visit.date === '2026-06-01')).toHaveLength(2);
    expect(
      afterMonth.find((visit) => visit.agreement === WEEKLY && visit.date === '2026-06-02'),
    ).toBeDefined();

    // The measurement that started this: the same ISO week, previewed again.
    // The monthly visits on that Monday are not this run's to judge, and they
    // are just as certainly not gone — so the guard has to count them.
    const weekAgain = await run('preview', WEEK);
    expect(weekAgain.additions).toHaveLength(0);
    expect(weekAgain.removals).toHaveLength(0);
    expect(weekAgain.updates).toHaveLength(0);

    // And the other way round: confirming the week changes nothing, and the
    // month view then agrees with it.
    const weekConfirmed = await run('confirm', WEEK);
    expect(weekConfirmed.additions).toHaveLength(0);
    expect(weekConfirmed.removals).toHaveLength(0);
    expect(weekConfirmed.updates).toHaveLength(0);
    await expectNoDayOverTheCap();

    const monthAgain = await run('preview', GRID);
    expect(monthAgain.additions).toHaveLength(0);
    expect(monthAgain.removals).toHaveLength(0);
    expect(monthAgain.updates).toHaveLength(0);

    // A second cycle, a week further on. The month run planned the
    // fortnightly agreement's 8-21 June fortnight into this week, and a week
    // view holds no whole fortnight — so that visit is PENDING, is not this
    // run's to judge, and is exactly the kind the guard used to count nowhere.
    const secondWeek = await run('preview', WEEK2);
    expect(secondWeek.additions).toHaveLength(0);
    expect(secondWeek.removals).toHaveLength(0);
    expect(secondWeek.updates).toHaveLength(0);

    const secondWeekConfirmed = await run('confirm', WEEK2);
    expect(secondWeekConfirmed.additions).toHaveLength(0);
    expect(secondWeekConfirmed.removals).toHaveLength(0);
    expect(secondWeekConfirmed.updates).toHaveLength(0);
    await expectNoDayOverTheCap();

    // And the month still agrees with it afterwards.
    const monthAfterSecondWeek = await run('preview', GRID);
    expect(monthAfterSecondWeek.additions).toHaveLength(0);
    expect(monthAfterSecondWeek.removals).toHaveLength(0);
    expect(monthAfterSecondWeek.updates).toHaveLength(0);

    // Nothing was bought with an over-full day, and nothing was left silent.
    await expectNoDayOverTheCap();
  }, 180_000);

  it('warns about a day its own protected work leaves over the cap, and adds nothing beside it', async () => {
    // Three visits of one agreement on one Monday, all the manager's own, in
    // a week this range holds whole — so the run plans that period and the
    // requirement it plans lands on one of those very slots.
    //
    // That requirement *is* the protected visit. Treating it as an ordinary
    // plan let the guard move it to the Tuesday: a fourth visit appeared
    // there, the three protected ones never budged, and the Monday was read
    // as one place emptier than it is. It finished the run carrying three
    // against a cap of two, and said nothing.
    const day = '2026-06-22';
    const branch = await prisma.branch.findUniqueOrThrow({
      where: { code: BranchCode.KANDY },
    });
    const occupancyOn = (date: string) =>
      prisma.generatedVisit.count({
        where: {
          branchCode: BranchCode.KANDY,
          visitDate: new Date(`${date}T00:00:00.000Z`),
          status: { not: 'CANCELLED' },
        },
      });

    await prisma.generatedVisit.deleteMany({
      where: { serviceAgreementId: { in: AGREEMENTS } },
    });

    try {
      await prisma.generatedVisit.createMany({
        data: [0, 1, 2].map((index) => ({
          serviceAgreementId: WEEKLY,
          branchId: branch.id,
          branchCode: BranchCode.KANDY,
          visitDate: new Date(`${day}T00:00:00.000Z`),
          // The first shares the slot the run plans for this week; the other
          // two are the manager's extra calls that day.
          windowStartMinute: 8 * 60 + index * 60,
          windowEndMinute: 17 * 60,
          durationMinutes: 60,
          requiredCrewSize: 1,
          isManuallyAdjusted: true,
        })),
      });

      const preview = await run('preview', GRID);

      // The count the manager is shown is the count the day really carries.
      const warning = preview.loadWarnings.find((entry) => entry.date === day);
      expect(warning).toBeDefined();
      expect(warning?.plannedCount).toBe(3);

      // And nothing of this agreement's is planned elsewhere in that week to
      // stand in for work that never moved.
      expect(
        preview.additions.filter(
          (addition) =>
            addition.serviceAgreementId === WEEKLY &&
            addition.visitDate >= day &&
            addition.visitDate <= '2026-06-28',
        ),
      ).toEqual([]);

      await run('confirm', GRID);
      expect(await occupancyOn(day)).toBe(3);
      // Nothing of this agreement's was created beside the work that never
      // moved. Another agreement's visit may well have been spread onto the
      // Tuesday — that is the guard doing its job — but the day the protected
      // visits sit on is not emptier for it.
      expect(
        await prisma.generatedVisit.count({
          where: {
            serviceAgreementId: WEEKLY,
            visitDate: {
              gte: new Date('2026-06-22T00:00:00.000Z'),
              lte: new Date('2026-06-28T00:00:00.000Z'),
            },
          },
        }),
      ).toBe(3);

      // Idempotent: asking for the same range again still has nothing to do.
      const again = await run('preview', GRID);
      expect(again.additions).toHaveLength(0);
      expect(again.removals).toHaveLength(0);
      expect(again.updates).toHaveLength(0);
      expect(again.loadWarnings.find((entry) => entry.date === day)?.plannedCount).toBe(3);
    } finally {
      await prisma.generatedVisit.deleteMany({
        where: { serviceAgreementId: { in: AGREEMENTS } },
      });
    }
  }, 180_000);

  it('says nothing about an over-full day outside the range it was asked about', async () => {
    // Standing work used to be read over the whole calendar months the range
    // touches, and every protected or out-of-scope visit in them was kept. The
    // guard then warned about every over-cap day it could see, so a manager
    // generating one week was shown a warning for a day two weeks later that
    // this view cannot act on at all.
    const crowded = '2026-06-15';
    const branch = await prisma.branch.findUniqueOrThrow({
      where: { code: BranchCode.KANDY },
    });

    try {
      await prisma.generatedVisit.createMany({
        data: [MONTHLY_A, MONTHLY_B, FORTNIGHTLY].map((serviceAgreementId, index) => ({
          serviceAgreementId,
          branchId: branch.id,
          branchCode: BranchCode.KANDY,
          visitDate: new Date(`${crowded}T00:00:00.000Z`),
          windowStartMinute: 8 * 60 + index * 60,
          windowEndMinute: 17 * 60,
          durationMinutes: 60,
          requiredCrewSize: 1,
          // Manager's own work, so it stands whatever any run decides — the
          // case the old read kept deliberately.
          isManuallyAdjusted: true,
        })),
      });

      const week = await run('preview', WEEK);

      expect(week.loadWarnings.map((warning) => warning.date)).not.toContain(crowded);
      expect(
        week.loadWarnings.filter(
          (warning) => warning.date < WEEK.from || warning.date > WEEK.to,
        ),
      ).toEqual([]);
    } finally {
      await prisma.generatedVisit.deleteMany({
        where: {
          serviceAgreementId: { in: AGREEMENTS },
          visitDate: new Date(`${crowded}T00:00:00.000Z`),
        },
      });
    }
  }, 180_000);
});

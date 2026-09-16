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
  // Set before the module is built: the cap is read from the environment when
  // configuration loads, and twelve a day would need a fixture nobody can read.
  process.env.VISIT_GENERATION_DAILY_CAP = String(CAP);

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

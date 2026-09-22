/**
 * A month shaped like the workbook's own.
 *
 * Staging showed the defect plainly: 192 visits in week one of a month
 * against 48, 60, 74 and 25 in weeks two to five, with 134 of 146 monthly
 * visits falling on days 1-6 and single days carrying 28. The workbook's July
 * plan for the same book of work is 159 visits over 28 days, never more than
 * twelve on a day, spread across all five weeks and all seven weekdays.
 *
 * This builds a synthetic book of the same shape — every name invented — and
 * asserts the properties that were false before: no day over the cap, every
 * week of the month carrying work, every booked date hit exactly, and a
 * second run with nothing to do.
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
  VisitPlacement,
  Weekday,
} from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { DEFAULT_DAILY_VISIT_CAP } from '../../src/config/constants';

const prisma = new PrismaClient();

const suffix = Math.random().toString(36).slice(2, 8);
const ADMIN = {
  email: `spread-admin-${suffix}@ultrakil.test`,
  password: 'spread-admin-password',
};

/** Three whole months, starting on a Wednesday the way a real run would. */
const HORIZON = { from: '2026-07-01', to: '2026-09-30' };

const MONTHLY_AGREEMENTS = 45;
const WEEKLY_AGREEMENTS = 20;

let app: INestApplication;
let http: string;
let adminToken: string;
let customerId: string;
let jobTypeId: string;
const agreementIds: string[] = [];

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

/** The three months before the horizon, which is what the workbook records. */
const HISTORY_MONTHS = ['2026-04', '2026-05', '2026-06'];

function isoDate(month: string, day: number): string {
  return `${month}-${String(day).padStart(2, '0')}`;
}

/** True when that day exists in that month. */
function realDate(month: string, day: number): boolean {
  const date = new Date(`${isoDate(month, day)}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.getUTCDate() === day;
}

/** Which week of the month a date falls in, 1 to 5. */
function weekOfMonth(date: string): number {
  return Math.floor((Number.parseInt(date.slice(8, 10), 10) - 1) / 7) + 1;
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
  const branch = await prisma.branch.upsert({
    where: { code: BranchCode.COLOMBO },
    create: { code: BranchCode.COLOMBO, name: 'COLOMBO Branch' },
    update: {},
  });

  await prisma.user.upsert({
    where: { email: ADMIN.email },
    create: {
      email: ADMIN.email,
      fullName: 'Spread Admin',
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
      code: `SPREAD_${suffix}`,
      name: 'Synthetic Treatment',
      defaultCrewSize: 2,
      defaultDurationMinutes: 90,
    },
  });
  jobTypeId = jobType.id;

  const customer = await prisma.customer.create({
    data: {
      name: `Synthetic Client ${suffix}`,
      branchId: branch.id,
      branchCode: BranchCode.COLOMBO,
    },
  });
  customerId = customer.id;

  // Forty-five monthly agreements, their booked days walked right across the
  // month, plus twenty weekly and fortnightly ones. Built through Prisma
  // rather than the API: sixty-five round trips would say nothing extra about
  // placement and would dominate the run time.
  for (let index = 0; index < MONTHLY_AGREEMENTS + WEEKLY_AGREEMENTS; index += 1) {
    const isMonthly = index < MONTHLY_AGREEMENTS;
    const site = await prisma.serviceSite.create({
      data: {
        customerId,
        name: `Synthetic Site ${index} ${suffix}`,
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

    // Monthly agreements are served on a day that moves across the month with
    // the index, which is what the workbook's own month columns look like.
    const anchorDay = (index % 28) + 1;
    // Every third one has July itself booked as well, so the horizon holds a
    // mix of months the workbook has already committed and months it has not.
    const months = isMonthly
      ? [...HISTORY_MONTHS, ...(index % 3 === 0 ? ['2026-07'] : [])]
      : [];
    const bookedDates = months
      .filter((month) => realDate(month, anchorDay))
      .map((month) => isoDate(month, anchorDay));

    const agreement = await prisma.serviceAgreement.create({
      data: {
        customerId,
        serviceSiteId: site.id,
        jobTypeId,
        branchId: branch.id,
        branchCode: BranchCode.COLOMBO,
        frequencyCount: 1,
        frequencyUnit: isMonthly ? FrequencyUnit.MONTH : FrequencyUnit.WEEK,
        frequencyInterval: isMonthly ? 1 : (index % 2) + 1,
        crewSize: 2,
        durationMinutes: 90,
        startDate: new Date('2026-07-01T00:00:00.000Z'),
        dayRules: {
          create: ALL_WEEKDAYS.map((weekday) => ({
            weekday,
            kind: DayRuleKind.ALLOWED,
          })),
        },
        bookings: {
          create: bookedDates.map((date) => ({
            bookedDate: new Date(`${date}T00:00:00.000Z`),
            provenance: DataProvenance.SOURCE,
          })),
        },
      },
    });
    agreementIds.push(agreement.id);
  }
}, 180_000);

afterAll(async () => {
  // This suite's own generated visits, cleared so the branch-days it used are
  // free for whatever runs after it. Generation now leaves work unplanned
  // rather than placing it on a day already at its cap, so a shared calendar
  // that every suite adds to and nobody clears eventually has no room left in
  // it for anybody.
  await prisma.generatedVisit.deleteMany({ where: { serviceAgreement: { jobTypeId } } });
  // This database is shared with the other integration suites, and a stray
  // book of sixty-five active agreements would quietly change their counts.
  // Dependants first and by hand: the schema does cascade a customer's sites
  // and their hours away, but a suite that leans on that has no way of
  // noticing the day it stops being true.
  if (agreementIds.length > 0) {
    await prisma.generatedVisit.deleteMany({
      where: { serviceAgreementId: { in: agreementIds } },
    });
    await prisma.serviceAgreement.deleteMany({ where: { id: { in: agreementIds } } });
  }
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
    // Not swallowed. A cleanup that fails quietly leaks into every suite that
    // runs after it, and the counts it breaks look like someone else's bug.
    await prisma.customer.delete({ where: { id: customerId } });
  }
  if (jobTypeId) await prisma.jobType.delete({ where: { id: jobTypeId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { email: ADMIN.email } });
  await prisma.$disconnect();
  await app.close();
});

const generate = (path: 'preview' | 'confirm') =>
  request(http)
    .post(`/api/visit-generation/${path}`)
    .set(auth(adminToken))
    .send({ ...HORIZON, serviceAgreementIds: agreementIds });

describe('a July-shaped book of work', () => {
  let visits: { visitDate: string; placement: VisitPlacement; serviceAgreementId: string }[] = [];

  beforeAll(async () => {
    const confirmed = await generate('confirm');
    expect(confirmed.status).toBe(200);

    visits = (
      await prisma.generatedVisit.findMany({
        where: { serviceAgreementId: { in: agreementIds } },
        select: { visitDate: true, placement: true, serviceAgreementId: true },
        orderBy: { visitDate: 'asc' },
      })
    ).map((visit) => ({
      visitDate: visit.visitDate.toISOString().slice(0, 10),
      placement: visit.placement,
      serviceAgreementId: visit.serviceAgreementId,
    }));
    expect(visits.length).toBeGreaterThan(0);
  }, 180_000);

  it('never puts more than the daily cap on one branch-day', () => {
    const perDay = new Map<string, number>();
    for (const visit of visits) {
      perDay.set(visit.visitDate, (perDay.get(visit.visitDate) ?? 0) + 1);
    }

    const busiest = Math.max(...perDay.values());
    expect(busiest).toBeLessThanOrEqual(DEFAULT_DAILY_VISIT_CAP);
  });

  it('carries work in every week of every month, not only the first', () => {
    for (const month of ['2026-07', '2026-08', '2026-09']) {
      const inMonth = visits.filter((visit) => visit.visitDate.startsWith(month));
      const weeks = new Set(inMonth.map((visit) => weekOfMonth(visit.visitDate)));

      // Weeks one to four are whole; the fifth is a stub of one to three days.
      expect([...weeks].sort()).toEqual(expect.arrayContaining([1, 2, 3, 4]));
      const firstWeek = inMonth.filter((visit) => weekOfMonth(visit.visitDate) === 1);
      // The defect put four visits in five in week one. Half is still generous.
      expect(firstWeek.length).toBeLessThan(inMonth.length / 2);
    }
  });

  it('uses more than a handful of weekdays', () => {
    const weekdays = new Set(
      visits.map((visit) => new Date(`${visit.visitDate}T00:00:00.000Z`).getUTCDay()),
    );

    expect(weekdays.size).toBeGreaterThanOrEqual(5);
  });

  it('hits every booked date inside the horizon exactly', async () => {
    const bookings = await prisma.serviceAgreementBooking.findMany({
      where: {
        serviceAgreementId: { in: agreementIds },
        bookedDate: {
          gte: new Date(`${HORIZON.from}T00:00:00.000Z`),
          lte: new Date(`${HORIZON.to}T00:00:00.000Z`),
        },
      },
    });

    // The fixture books July for every third monthly agreement, so this is a
    // real assertion rather than an empty loop.
    expect(bookings.length).toBeGreaterThanOrEqual(10);

    for (const booking of bookings) {
      const date = booking.bookedDate.toISOString().slice(0, 10);
      const matching = visits.filter(
        (visit) =>
          visit.serviceAgreementId === booking.serviceAgreementId &&
          visit.visitDate === date,
      );
      expect(matching).toHaveLength(1);
      expect(matching[0].placement).toBe(VisitPlacement.BOOKED);
    }
  });

  it('anchors the monthly agreements rather than taking day one', () => {
    const anchored = visits.filter(
      (visit) => visit.placement === VisitPlacement.ANCHORED,
    );

    expect(anchored.length).toBeGreaterThan(0);
    const onDaysOneToSix = visits.filter(
      (visit) => Number.parseInt(visit.visitDate.slice(8, 10), 10) <= 6,
    );
    // The staging defect put 134 of 146 monthly visits on days 1-6.
    expect(onDaysOneToSix.length).toBeLessThan(visits.length / 2);
  });

  it('has nothing to add or remove on a second run', async () => {
    const second = await generate('preview');

    expect(second.status).toBe(200);
    expect(second.body.additions).toHaveLength(0);
    expect(second.body.removals).toHaveLength(0);
    expect(second.body.updates).toHaveLength(0);
  }, 180_000);
});

/**
 * A new agreement's own visits used to only exist once a manager separately
 * pressed Generate Visits. The Technical Director's review named this
 * directly: `AgreementsService.create()` did not invoke a scoped plan, so
 * registering a new client still did not automatically accommodate its
 * visits. `POST /service-agreements` now triggers a scoped generation for
 * the agreement it just created, through the same `confirm` a manager's own
 * click already uses — so it inherits every existing protection rather than
 * needing new ones.
 *
 * Every case here drives the real HTTP endpoints over a real database: the
 * property under test is what actually lands in `generated_visits`
 * immediately after the POST response, with no second call in between.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { BranchCode, PrismaClient, UserRole, Weekday } from '@prisma/client';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';

const prisma = new PrismaClient();
const suffix = Math.random().toString(36).slice(2, 8);
const ADMIN = {
  email: `auto-agreement-${suffix}@ultrakil.test`,
  password: 'auto-agreement-password',
};

let app: INestApplication;
let http: string;
let token: string;
let customerId: string;
let siteId: string;
let jobTypeId: string;
const auth = () => ({ Authorization: `Bearer ${token}` });
/** The service reads the real clock, so every date is relative to it. */
const TODAY = new Date().toISOString().slice(0, 10);

const createdAgreementIds: string[] = [];

async function createAgreement(overrides: Record<string, unknown> = {}) {
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
      startDate: TODAY,
      durationMinutes: 60,
      crewSize: 1,
      ...overrides,
    });
  expect(res.status).toBe(201);
  createdAgreementIds.push(res.body.id);
  return res.body;
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
      fullName: 'Automatic Agreement Planning Admin',
      role: UserRole.ADMIN,
      passwordHash: await AuthService.hashPassword(ADMIN.password),
    },
    update: { role: UserRole.ADMIN, isActive: true },
  });
  const login = await request(http)
    .post('/api/auth/login')
    .send({ email: ADMIN.email, password: ADMIN.password });
  token = login.body.accessToken as string;

  const jobType = await request(http)
    .post('/api/job-types')
    .set(auth())
    .send({ code: `AUTOGEN_${suffix}`, name: 'Automatic Planning Job', defaultCrewSize: 1 });
  jobTypeId = jobType.body.id;

  const customer = await request(http)
    .post('/api/customers')
    .set(auth())
    .send({ name: `Automatic Planning Client ${suffix}`, branchCode: BranchCode.COLOMBO });
  customerId = customer.body.id;

  const site = await request(http)
    .post(`/api/customers/${customerId}/sites`)
    .set(auth())
    .send({
      name: `Automatic Planning Site ${suffix}`,
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
  await prisma.generatedVisit.deleteMany({
    where: { serviceAgreementId: { in: createdAgreementIds } },
  });
  await prisma.serviceAgreement.deleteMany({ where: { id: { in: createdAgreementIds } } });
  await prisma.siteOperatingHours.deleteMany({ where: { serviceSiteId: siteId } });
  await prisma.serviceSite.deleteMany({ where: { customerId } });
  await prisma.customer.delete({ where: { id: customerId } });
  await prisma.jobType.deleteMany({ where: { code: `AUTOGEN_${suffix}` } });
  await prisma.user.deleteMany({ where: { email: ADMIN.email } });
  await prisma.$disconnect();
  await app.close();
}, 120_000);

it('generates a new agreement\'s own visits immediately, with no separate Generate Visits call', async () => {
  const agreement = await createAgreement();

  const visits = await prisma.generatedVisit.findMany({
    where: { serviceAgreementId: agreement.id },
  });
  // A weekly agreement over the rolling twelve-month onboarding horizon plans
  // most of a year of occurrences — nothing here called `/confirm` or
  // `/preview` itself. Bounded well below 52 because the site opens only two
  // weekdays and the load guard may spread some weeks.
  expect(visits.length).toBeGreaterThanOrEqual(40);
});

it('plans the full rolling twelve months, not a first-look month', async () => {
  const agreement = await createAgreement({ notes: 'full-horizon' });

  const visits = await prisma.generatedVisit.findMany({
    where: { serviceAgreementId: agreement.id },
    orderBy: { visitDate: 'desc' },
    take: 1,
  });

  // The regression this guards: onboarding used to plan 30 days, leaving a new
  // agreement a different shape from every existing one until a nightly sweep
  // happened to catch it up.
  const furthest = visits[0].visitDate.toISOString().slice(0, 10);
  const sixMonthsOut = new Date(Date.now() + 182 * 86_400_000).toISOString().slice(0, 10);
  expect(furthest > sixMonthsOut).toBe(true);
  expect(agreement.onboardingPlan.to > sixMonthsOut).toBe(true);
}, 120_000);

it('returns what the automatic plan actually did, rather than only logging it', async () => {
  const agreement = await createAgreement({ notes: 'reports-outcome' });

  const plan = agreement.onboardingPlan;
  expect(plan).toBeDefined();
  expect(['PLANNED', 'PLANNED_WITH_SHORTFALLS']).toContain(plan.status);
  expect(plan.from).toBe(TODAY);
  expect(plan.message).toBeNull();

  // The count is the plan's own, not re-derived from the database by the
  // caller — a manager reading the response must be able to trust it.
  const visits = await prisma.generatedVisit.count({
    where: { serviceAgreementId: agreement.id },
  });
  expect(plan.visitsPlanned).toBe(visits);
}, 120_000);

it('stops the horizon at the agreement\'s own end date', async () => {
  const endDate = new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10);
  const agreement = await createAgreement({ notes: 'bounded', endDate });

  // Planning past the work the customer has actually bought would be an
  // invention, not a horizon.
  expect(agreement.onboardingPlan.to).toBe(endDate);

  const beyond = await prisma.generatedVisit.count({
    where: {
      serviceAgreementId: agreement.id,
      visitDate: { gt: new Date(`${endDate}T00:00:00.000Z`) },
    },
  });
  expect(beyond).toBe(0);
}, 120_000);

it('never touches another agreement\'s hand-adjusted visit while automatically planning a new one', async () => {
  const existing = await createAgreement({ notes: 'existing' });
  const existingVisitsBefore = await prisma.generatedVisit.findMany({
    where: { serviceAgreementId: existing.id },
    orderBy: { visitDate: 'asc' },
  });
  expect(existingVisitsBefore.length).toBeGreaterThan(0);

  // One of the existing agreement's own visits is a manager's own decision —
  // hand-adjusted, and therefore untouchable no matter what a new,
  // automatically-planned neighbour wants the same day.
  const protectedBeforeNewAgreement = await prisma.generatedVisit.update({
    where: { id: existingVisitsBefore[0].id },
    data: { isManuallyAdjusted: true },
  });

  // A second agreement, same site, same allowed/preferred days — every
  // incentive to want the identical days the first agreement already holds.
  await createAgreement({ notes: 'new-neighbour' });

  const stillProtected = await prisma.generatedVisit.findUniqueOrThrow({
    where: { id: protectedBeforeNewAgreement.id },
  });
  expect(stillProtected.visitDate.getTime()).toBe(
    protectedBeforeNewAgreement.visitDate.getTime(),
  );
  expect(stillProtected.updatedAt.getTime()).toBe(
    protectedBeforeNewAgreement.updatedAt.getTime(),
  );

  const existingVisitsAfter = await prisma.generatedVisit.findMany({
    where: { serviceAgreementId: existing.id },
  });
  // Not merely the one protected visit — none of the first agreement's own
  // visits were added to or removed by planning the second agreement.
  expect(existingVisitsAfter.length).toBe(existingVisitsBefore.length);
  expect(new Set(existingVisitsAfter.map((visit) => visit.id))).toEqual(
    new Set(existingVisitsBefore.map((visit) => visit.id)),
  );
}, 60_000);

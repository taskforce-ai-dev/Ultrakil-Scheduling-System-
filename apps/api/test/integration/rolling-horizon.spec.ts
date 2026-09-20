/**
 * `POST /visit-generation/extend-horizons` — the rolling 12-month horizon
 * the Technical Director review asked for: an agreement with no end date
 * should stay planned a year ahead on its own, rather than only as far as
 * whichever range a manager last asked to generate.
 *
 * Every case here drives the real endpoint, over a real database, because
 * the property under test is what actually ends up in `generated_visits` —
 * a unit test on the date arithmetic alone would not catch the guard,
 * booking or protection paths this reuses from ordinary `confirm`.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BranchCode, PrismaClient, UserRole, VisitStatus, Weekday } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';

const prisma = new PrismaClient();
const suffix = Math.random().toString(36).slice(2, 8);
const ADMIN = {
  email: `rolling-horizon-${suffix}@ultrakil.test`,
  password: 'rolling-horizon-password',
};

let app: INestApplication;
let http: string;
let token: string;
let customerId: string;
let siteId: string;
let jobTypeId: string;
const auth = () => ({ Authorization: `Bearer ${token}` });
const at = (date: string) => new Date(`${date}T00:00:00.000Z`);
const addDays = (date: string, days: number) =>
  new Date(at(date).getTime() + days * 86_400_000).toISOString().slice(0, 10);
/**
 * The service reads the real clock (`new Date()`), not an injectable one, so
 * every date here has to be relative to the real "today" the test actually
 * runs on, not a fixed fictional date.
 */
const TODAY = new Date().toISOString().slice(0, 10);

async function createAgreement(overrides: Record<string, unknown> = {}) {
  const res = await request(http)
    .post('/api/service-agreements')
    .set(auth())
    .send({
      serviceSiteId: siteId,
      jobTypeId,
      frequencyCount: 1,
      frequencyUnit: 'WEEK',
      allowedDays: [Weekday.WEDNESDAY],
      startDate: TODAY,
      durationMinutes: 60,
      crewSize: 1,
      ...overrides,
    });
  expect(res.status).toBe(201);
  // Agreement creation now automatically plans a scoped onboarding horizon
  // (the review's "automatic new-agreement planning" ask) — this suite is
  // about `extend-horizons` specifically, so its own fixtures start from the
  // same blank slate they always have; the automatic side effect is proven
  // separately in `automatic-agreement-planning.spec.ts`.
  await prisma.generatedVisit.deleteMany({ where: { serviceAgreementId: res.body.id } });
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
      fullName: 'Rolling Horizon Admin',
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
    .send({ code: `ROLLING_${suffix}`, name: 'Rolling Horizon Job', defaultCrewSize: 1 });
  jobTypeId = jobType.body.id;

  const customer = await request(http)
    .post('/api/customers')
    .set(auth())
    .send({ name: `Rolling Horizon Client ${suffix}`, branchCode: BranchCode.COLOMBO });
  customerId = customer.body.id;

  const site = await request(http)
    .post(`/api/customers/${customerId}/sites`)
    .set(auth())
    .send({
      name: `Rolling Horizon Site ${suffix}`,
      branchCode: BranchCode.COLOMBO,
      operatingHours: [Weekday.WEDNESDAY].map((weekday) => ({
        weekday,
        opensAtMinute: 540,
        closesAtMinute: 1020,
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
  await prisma.jobType.deleteMany({ where: { code: `ROLLING_${suffix}` } });
  await prisma.scheduleRun.deleteMany({ where: { requestedByUserId: undefined } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { email: ADMIN.email } });
  await prisma.$disconnect();
  await app.close();
}, 120_000);

it('extends an open-ended agreement toward a rolling year, and leaves a dated one at its own end', async () => {
  const open = await createAgreement({ startDate: TODAY });
  const datedEnd = addDays(TODAY, 40);
  const dated = await createAgreement({ startDate: TODAY, endDate: datedEnd });

  // Scoped to this test's own two agreements. The shared integration
  // database holds plenty of other open-ended agreements other suites never
  // clean up — nothing was ever unscoped enough to notice before this
  // endpoint existed, and an unscoped call here would plan a year of visits
  // for every one of them.
  const response = await request(http)
    .post('/api/visit-generation/extend-horizons')
    .set(auth())
    .send({ serviceAgreementIds: [open.id, dated.id] });
  expect(response.status).toBe(200);
  expect(response.body.today).toBeDefined();
  const extendedIds = response.body.agreementsExtended.map(
    (row: { serviceAgreementId: string }) => row.serviceAgreementId,
  );
  expect(extendedIds).toContain(open.id);
  // The dated agreement is not part of this operation at all — the same as
  // it would not be part of a second, later call either.
  expect(extendedIds).not.toContain(dated.id);

  const openVisits = await prisma.generatedVisit.findMany({
    where: { serviceAgreementId: open.id },
    orderBy: { visitDate: 'asc' },
  });
  const datedVisits = await prisma.generatedVisit.findMany({
    where: { serviceAgreementId: dated.id },
    orderBy: { visitDate: 'asc' },
  });

  expect(openVisits.length).toBeGreaterThan(40);
  // Planned close to a year out — comfortably past the dated agreement's own
  // end, which is the point of the comparison below.
  const lastOpenDate = openVisits[openVisits.length - 1].visitDate.toISOString().slice(0, 10);
  expect(lastOpenDate > datedEnd).toBe(true);

  // The dated agreement stopped at its own end date, exactly as ordinary
  // generation already guarantees — this call did not touch it at all.
  for (const visit of datedVisits) {
    expect(visit.visitDate.toISOString().slice(0, 10) <= datedEnd).toBe(true);
  }
}, 180_000);

it('is idempotent: a second call finds nothing left to do', async () => {
  const agreement = await createAgreement({ startDate: TODAY });
  const scope = { serviceAgreementIds: [agreement.id] };

  const first = await request(http)
    .post('/api/visit-generation/extend-horizons')
    .set(auth())
    .send(scope);
  expect(first.status).toBe(200);
  const firstIds = first.body.agreementsExtended.map(
    (row: { serviceAgreementId: string }) => row.serviceAgreementId,
  );
  expect(firstIds).toContain(agreement.id);
  const visitsAfterFirst = await prisma.generatedVisit.count({
    where: { serviceAgreementId: agreement.id },
  });

  const second = await request(http)
    .post('/api/visit-generation/extend-horizons')
    .set(auth())
    .send(scope);
  expect(second.status).toBe(200);
  const secondIds = second.body.agreementsExtended.map(
    (row: { serviceAgreementId: string }) => row.serviceAgreementId,
  );
  expect(secondIds).not.toContain(agreement.id);

  const visitsAfterSecond = await prisma.generatedVisit.count({
    where: { serviceAgreementId: agreement.id },
  });
  expect(visitsAfterSecond).toBe(visitsAfterFirst);
}, 180_000);

it('leaves an agreement whose start is still further out than the rolling target alone', async () => {
  const farFuture = addDays(TODAY, 400);
  const agreement = await createAgreement({ startDate: farFuture });

  const response = await request(http)
    .post('/api/visit-generation/extend-horizons')
    .set(auth())
    .send({ serviceAgreementIds: [agreement.id] });
  expect(response.status).toBe(200);
  const extendedIds = response.body.agreementsExtended.map(
    (row: { serviceAgreementId: string }) => row.serviceAgreementId,
  );
  expect(extendedIds).not.toContain(agreement.id);

  const visits = await prisma.generatedVisit.count({
    where: { serviceAgreementId: agreement.id },
  });
  expect(visits).toBe(0);
}, 180_000);

it('never moves a locked visit while extending the rest of the horizon', async () => {
  const agreement = await createAgreement({ startDate: TODAY });
  const scope = { serviceAgreementIds: [agreement.id] };
  await request(http).post('/api/visit-generation/extend-horizons').set(auth()).send(scope);

  const visits = await prisma.generatedVisit.findMany({
    where: { serviceAgreementId: agreement.id },
    orderBy: { visitDate: 'asc' },
  });
  const toLock = await prisma.generatedVisit.update({
    where: { id: visits[0].id },
    data: { lockedAt: new Date(), lockedByUserId: null, lockReason: 'kept for the test' },
  });

  // Calling again must not so much as touch the locked visit's revision,
  // let alone its date.
  await request(http).post('/api/visit-generation/extend-horizons').set(auth()).send(scope);

  const after = await prisma.generatedVisit.findUniqueOrThrow({ where: { id: toLock.id } });
  expect(after.updatedAt.getTime()).toBe(toLock.updatedAt.getTime());
  expect(after.visitDate.getTime()).toBe(toLock.visitDate.getTime());
  expect(after.status).not.toBe(VisitStatus.CANCELLED);
}, 180_000);

it('reports an empty failures list when nothing goes wrong', async () => {
  const agreement = await createAgreement({ startDate: TODAY });
  const response = await request(http)
    .post('/api/visit-generation/extend-horizons')
    .set(auth())
    .send({ serviceAgreementIds: [agreement.id] });
  expect(response.status).toBe(200);
  // One agreement's own conflict must never abort the rest of a company-wide
  // sweep — extendRollingHorizons now collects failures instead of throwing.
  // The happy path this test drives has none.
  expect(response.body.failures).toEqual([]);
}, 180_000);

// Deliberately not exercised here with a live, unscoped call: this suite
// shares one database with every other integration file's own open-ended
// fixtures (visit-generation.spec.ts's alone number in the hundreds and
// are never cleaned up — unique naming was enough to keep them out of
// each other's way until this endpoint could sweep all of them at once),
// and an unscoped call for real would plan a year of visits for every one
// of them, breaking suites that never expected a sweep to touch their
// fixtures. Omitting `scope` only skips the two `where`-clause filters the
// tests above already exercise with real values; nothing else in
// `extendRollingHorizons` branches on whether they were given.

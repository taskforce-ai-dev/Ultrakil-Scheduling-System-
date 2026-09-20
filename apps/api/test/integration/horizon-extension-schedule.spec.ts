/**
 * The rolling 12-month horizon, actually scheduled.
 *
 * `rolling-horizon.spec.ts` already proves what `extendRollingHorizons`
 * itself does — idempotent, never touches a locked visit, stops a dated
 * agreement at its own end. What it does not cover, because it drives the
 * HTTP endpoint directly, is the new wiring this branch adds: that a
 * self-hosted deployment registers a real repeatable job on boot, and that
 * the queue's own processor is what actually calls the service when that
 * job runs — not a person remembering to press a button.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { BranchCode, PrismaClient, UserRole, Weekday } from '@prisma/client';
import { Queue } from 'bullmq';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { QUEUE_HORIZON_EXTENSION } from '../../src/queue/queue.constants';
import {
  HorizonExtensionProcessor,
  HORIZON_EXTENSION_JOB,
} from '../../src/scheduling/visit-generation/horizon-extension.processor';
import { VisitGenerationService } from '../../src/scheduling/visit-generation/visit-generation.service';

const prisma = new PrismaClient();
const suffix = Math.random().toString(36).slice(2, 8);
const ADMIN = {
  email: `horizon-schedule-${suffix}@ultrakil.test`,
  password: 'horizon-schedule-password',
};

let app: INestApplication;
let http: string;
let token: string;
let customerId: string;
let siteId: string;
let jobTypeId: string;
const auth = () => ({ Authorization: `Bearer ${token}` });
const TODAY = new Date().toISOString().slice(0, 10);

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
      fullName: 'Horizon Schedule Admin',
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
    .send({ code: `HZNSCHED_${suffix}`, name: 'Horizon Schedule Job', defaultCrewSize: 1 });
  jobTypeId = jobType.body.id;

  const customer = await request(http)
    .post('/api/customers')
    .set(auth())
    .send({ name: `Horizon Schedule Client ${suffix}`, branchCode: BranchCode.COLOMBO });
  customerId = customer.body.id;

  const site = await request(http)
    .post(`/api/customers/${customerId}/sites`)
    .set(auth())
    .send({
      name: `Horizon Schedule Site ${suffix}`,
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
  await prisma.jobType.deleteMany({ where: { code: `HZNSCHED_${suffix}` } });
  await prisma.user.deleteMany({ where: { email: ADMIN.email } });
  await prisma.$disconnect();
  await app.close();
}, 120_000);

async function createOpenEndedAgreement(): Promise<string> {
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
    });
  expect(res.status).toBe(201);
  // Automatic onboarding generation (a separate, already-proven feature)
  // otherwise gives this agreement a month's head start before the sweep
  // itself is asked to extend it — clear it so the sweep's own effect is
  // what this test measures.
  await prisma.generatedVisit.deleteMany({ where: { serviceAgreementId: res.body.id } });
  return res.body.id as string;
}

it('registers a real repeatable job when the app starts — not merely a callable endpoint', async () => {
  const queue = app.get<Queue>(getQueueToken(QUEUE_HORIZON_EXTENSION));
  const repeatable = await queue.getRepeatableJobs();
  const sweep = repeatable.find((job) => job.name === HORIZON_EXTENSION_JOB);
  expect(sweep).toBeDefined();
  expect(sweep?.pattern).toBe('0 3 * * *');
});

it("the queue's own processor extends an open-ended agreement's real horizon, not just the service function directly", async () => {
  const agreementId = await createOpenEndedAgreement();
  const before = await prisma.generatedVisit.count({ where: { serviceAgreementId: agreementId } });
  expect(before).toBe(0);

  // Driven through the processor BullMQ itself would invoke when the
  // repeatable job fires — proving the glue between the queue and
  // VisitGenerationService, not re-proving extendRollingHorizons's own
  // behaviour, which rolling-horizon.spec.ts already covers. Scoped to this
  // test's own agreement: the real repeatable job sweeps the whole company
  // (proven by the processor defaulting to `{}` scope when BullMQ calls it
  // with no job data override), but this shared integration database
  // already carries 1000+ other suites' own open-ended agreements, and
  // sweeping all of them here would only prove this test's own patience.
  await app.get(HorizonExtensionProcessor).process({
    data: { scope: { serviceAgreementIds: [agreementId] } },
  } as never);

  const after = await prisma.generatedVisit.findMany({
    where: { serviceAgreementId: agreementId },
  });
  expect(after.length).toBeGreaterThan(40);
  const lastDate = after[after.length - 1].visitDate.toISOString().slice(0, 10);
  expect(lastDate > TODAY).toBe(true);
}, 60_000);

it('two sweeps that happen to overlap queue behind the same agreement/branch-day locks rather than double-planning', async () => {
  const agreementId = await createOpenEndedAgreement();

  const processor = app.get(HorizonExtensionProcessor);
  const scopedJob = { data: { scope: { serviceAgreementIds: [agreementId] } } } as never;
  await Promise.all([processor.process(scopedJob), processor.process(scopedJob)]);

  const visits = await prisma.generatedVisit.findMany({
    where: { serviceAgreementId: agreementId },
  });
  expect(visits.length).toBeGreaterThan(40);
  // Not merely "some visits exist" but exactly one per date: the second,
  // overlapping sweep found nothing left to add once the first had run.
  const dates = visits.map((visit) => visit.visitDate.getTime());
  expect(new Set(dates).size).toBe(dates.length);

  // A generation-service instance driven independently confirms the same
  // idempotent-to-a-third-call property the endpoint-level test already
  // proves, now reached through the scheduled path's own actor.
  const thirdPass = await app.get(VisitGenerationService).extendRollingHorizons(
    { id: 'irrelevant', email: 'irrelevant@test', fullName: 'irrelevant', role: UserRole.ADMIN },
    { serviceAgreementIds: [agreementId] },
  );
  expect(thirdPass.agreementsExtended).toEqual([]);
}, 60_000);

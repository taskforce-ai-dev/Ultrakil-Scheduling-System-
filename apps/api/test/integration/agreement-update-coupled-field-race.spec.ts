/**
 * Two gaps the Technical Director's review found in `AgreementsService`
 * after the pre-lock stale-snapshot fix (`agreement-update-stale-snapshot.spec.ts`):
 *
 * 1. `update()` re-reads the agreement under lock and derives every field an
 *    edit did not itself carry from that fresh row, but the coupled checks
 *    (`assertDayRules`, `assertServiceWindow`, `assertDateRange`,
 *    `assertSatisfiable`) still only ever ran once, before the transaction,
 *    against the *pre-lock* composition. Two edits can each be satisfiable in
 *    isolation against the row as it stood when each was submitted, and still
 *    combine into an agreement that can never produce a visit — a service
 *    window one edit narrows, landing under a duration a concurrent edit grew,
 *    with neither edit ever seeing the other's half. `update()` now re-runs
 *    every one of those checks against the composition it is actually about
 *    to write, after the lock.
 *
 * 2. `changeStatus()` already re-reads and re-checks status under its lock —
 *    fixed alongside `update()`'s stale snapshot — but never had a
 *    forced-interleaving test proving the archive-versus-ACTIVE race it was
 *    written for. This adds it: a concurrent archive must win against a
 *    same-moment "set ACTIVE" that only looks like a no-op because its own
 *    unlocked pre-transaction read still saw the agreement as ACTIVE.
 *
 * Both interleavings are forced the same way as the sibling spec: a third
 * connection holds the agreement row with `FOR UPDATE`, both racing requests
 * are let through to their own unlocked reads and then queued behind that
 * hold in a known order, and only then is the hold released.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BranchCode, PrismaClient, UserRole, Weekday } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { ScheduleRunProcessor } from '../../src/scheduling/optimizer/schedule-run.processor';

const prisma = new PrismaClient();
const other = new PrismaClient();
const suffix = Math.random().toString(36).slice(2, 8);
const ADMIN = {
  email: `coupled-race-${suffix}@ultrakil.test`,
  password: 'coupled-race-password',
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let app: INestApplication;
let http: string;
let token: string;
let customerId: string;
let siteId: string;
let jobTypeId: string;
const auth = () => ({ Authorization: `Bearer ${token}` });

async function blockedCount(fragment: string): Promise<number> {
  const rows = await prisma.$queryRaw<{ blocked: bigint }[]>`
    SELECT count(*) AS blocked
    FROM pg_stat_activity
    WHERE wait_event_type = 'Lock' AND query ILIKE ${'%' + fragment + '%'}
  `;
  return Number(rows[0]?.blocked ?? 0);
}

async function waitUntilBlockedCountIsAtLeast(fragment: string, atLeast: number): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if ((await blockedCount(fragment)) >= atLeast) return;
    await sleep(100);
  }
  throw new Error(`Fewer than ${atLeast} ever blocked on ${fragment}.`);
}

/** Holds an agreement row with `FOR UPDATE` until told to release it. */
function holdRow(agreementId: string) {
  let release: () => void = () => undefined;
  let acquired: () => void = () => undefined;
  const isHeld = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const mayRelease = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = other.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT id FROM service_agreements WHERE id = ${agreementId}::uuid FOR UPDATE`;
      acquired();
      await mayRelease;
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
  return { isHeld, release, holder };
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

  await prisma.$connect();
  await other.$connect();
  await prisma.branch.upsert({
    where: { code: BranchCode.COLOMBO },
    create: { code: BranchCode.COLOMBO, name: 'COLOMBO Branch' },
    update: {},
  });
  await prisma.user.upsert({
    where: { email: ADMIN.email },
    create: {
      email: ADMIN.email,
      fullName: 'Coupled Race Admin',
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
    .send({ code: `COUPLED_${suffix}`, name: 'Coupled Race Job', defaultCrewSize: 1 });
  jobTypeId = jobType.body.id;

  const customer = await request(http)
    .post('/api/customers')
    .set(auth())
    .send({ name: `Coupled Race Client ${suffix}`, branchCode: BranchCode.COLOMBO });
  customerId = customer.body.id;

  const site = await request(http)
    .post(`/api/customers/${customerId}/sites`)
    .set(auth())
    .send({
      name: `Coupled Race Site ${suffix}`,
      branchCode: BranchCode.COLOMBO,
      // A narrow, two-hour Monday window: just wide enough for the smaller of
      // the two colliding compositions below, and no other day at all — so
      // there is exactly one way for either edit to succeed, and it is not
      // the combination the race should produce.
      operatingHours: [
        { weekday: Weekday.MONDAY, opensAtMinute: 480, closesAtMinute: 600 },
      ],
    });
  siteId = site.body.id;
}, 300_000);

afterAll(async () => {
  const agreements = await prisma.serviceAgreement.findMany({
    where: { customerId },
    select: { id: true },
  });
  const ids = agreements.map((a) => a.id);
  await prisma.serviceAgreementDayRule.deleteMany({ where: { serviceAgreementId: { in: ids } } });
  await prisma.serviceAgreementVersion.deleteMany({ where: { serviceAgreementId: { in: ids } } });
  await prisma.serviceAgreement.deleteMany({ where: { id: { in: ids } } });
  await prisma.siteOperatingHours.deleteMany({ where: { serviceSiteId: siteId } });
  await prisma.serviceSite.deleteMany({ where: { customerId } });
  await prisma.customer.delete({ where: { id: customerId } });
  await prisma.jobType.deleteMany({ where: { code: `COUPLED_${suffix}` } });
  await prisma.user.deleteMany({ where: { email: ADMIN.email } });
  await prisma.$disconnect();
  await other.$disconnect();
  await app.close();
}, 120_000);

it('refuses a write that combines two edits each satisfiable alone into one that is not', async () => {
  const created = await request(http)
    .post('/api/service-agreements')
    .set(auth())
    .send({
      serviceSiteId: siteId,
      jobTypeId,
      frequencyCount: 1,
      frequencyUnit: 'WEEK',
      allowedDays: [Weekday.MONDAY],
      startDate: '2026-01-05',
      durationMinutes: 60,
      crewSize: 1,
      // The full two-hour site window, comfortably wider than the duration.
      serviceWindowStartMinute: 480,
      serviceWindowEndMinute: 600,
    });
  expect(created.status).toBe(201);
  const agreementId = created.body.id as string;

  const { isHeld, release, holder } = holdRow(agreementId);
  await isHeld;

  // Edit A: narrows the window to sixty minutes — exactly the current
  // duration, so alone it is still satisfiable. Its own unlocked pre-lock
  // read and validation happen now, then it queues for the row first.
  let errorA: unknown;
  const editA = request(http)
    .patch(`/api/service-agreements/${agreementId}`)
    .set(auth())
    .send({ serviceWindowStartMinute: 480, serviceWindowEndMinute: 540 })
    .then((response) => response)
    .catch((error: unknown) => {
      errorA = error;
      return { status: -1, body: {} } as unknown as request.Response;
    });
  await waitUntilBlockedCountIsAtLeast('service_agreements', 1);

  // Edit B: grows the duration to ninety minutes, never touching the window.
  // Against the row as it stood when B was submitted — still the full
  // sixty-to-two-hundred-minute window — ninety minutes fits, so B's own
  // pre-lock check also passes. It queues second, behind A.
  let errorB: unknown;
  const editB = request(http)
    .patch(`/api/service-agreements/${agreementId}`)
    .set(auth())
    .send({ durationMinutes: 90 })
    .then((response) => response)
    .catch((error: unknown) => {
      errorB = error;
      return { status: -1, body: {} } as unknown as request.Response;
    });
  await waitUntilBlockedCountIsAtLeast('service_agreements', 2);
  release();

  const [responseA, responseB] = await Promise.all([editA, editB, holder]);

  expect(errorA).toBeUndefined();
  expect(errorB).toBeUndefined();
  // A queued first and raced nothing: it commits.
  expect(responseA.status).toBe(200);
  // B queued second. By the time its lock resolves, the row it must combine
  // its ninety-minute duration with is A's sixty-minute window — a
  // combination that fits no visit at all. The old code derived B's write
  // from the fresh row but never re-validated the combination, and would
  // have written duration 90 under a 60-minute window. Fixed, B is refused.
  expect(responseB.status).toBe(422);
  expect(responseB.body.code).toBe('AGREEMENT_UNSATISFIABLE');

  const final = await prisma.serviceAgreement.findUniqueOrThrow({ where: { id: agreementId } });
  expect(final.durationMinutes).toBe(60);
  expect(final.serviceWindowStartMinute).toBe(480);
  expect(final.serviceWindowEndMinute).toBe(540);
}, 180_000);

it('changeStatus() refuses to reactivate over a concurrent archive', async () => {
  const created = await request(http)
    .post('/api/service-agreements')
    .set(auth())
    .send({
      serviceSiteId: siteId,
      jobTypeId,
      frequencyCount: 1,
      frequencyUnit: 'WEEK',
      allowedDays: [Weekday.MONDAY],
      startDate: '2026-01-05',
      durationMinutes: 60,
      crewSize: 1,
      serviceWindowStartMinute: 480,
      serviceWindowEndMinute: 600,
    });
  expect(created.status).toBe(201);
  const agreementId = created.body.id as string;
  expect(created.body.status).toBe('ACTIVE');

  const { isHeld, release, holder } = holdRow(agreementId);
  await isHeld;

  // The archive: its own unlocked pre-transaction read sees ACTIVE (archiving
  // out of ACTIVE is always allowed), then it queues for the row first.
  let archiveError: unknown;
  const archive = request(http)
    .post(`/api/service-agreements/${agreementId}/status`)
    .set(auth())
    .send({ status: 'ARCHIVED', reason: 'Racing archive' })
    .then((response) => response)
    .catch((error: unknown) => {
      archiveError = error;
      return { status: -1, body: {} } as unknown as request.Response;
    });
  await waitUntilBlockedCountIsAtLeast('service_agreements', 1);

  // "Set ACTIVE": a no-op against the row as it stood when this request's own
  // unlocked pre-transaction read happened — still ACTIVE — so nothing about
  // this request alone looks like a problem. It queues second, behind the
  // archive.
  let reactivateError: unknown;
  const setActive = request(http)
    .post(`/api/service-agreements/${agreementId}/status`)
    .set(auth())
    .send({ status: 'ACTIVE' })
    .then((response) => response)
    .catch((error: unknown) => {
      reactivateError = error;
      return { status: -1, body: {} } as unknown as request.Response;
    });
  await waitUntilBlockedCountIsAtLeast('service_agreements', 2);
  release();

  const [archiveResponse, setActiveResponse] = await Promise.all([archive, setActive, holder]);

  expect(archiveError).toBeUndefined();
  expect(reactivateError).toBeUndefined();
  expect(archiveResponse.status).toBe(200);
  expect(archiveResponse.body.status).toBe('ARCHIVED');
  // Without the lock-and-reread fix, this request's write is unconditional —
  // `status: ACTIVE` — and would silently revive the row the archive just
  // committed. Fixed, it re-reads under the lock, finds ARCHIVED, and refuses.
  expect(setActiveResponse.status).toBe(409);
  expect(setActiveResponse.body.code).toBe('AGREEMENT_ARCHIVED');

  const final = await prisma.serviceAgreement.findUniqueOrThrow({ where: { id: agreementId } });
  expect(final.status).toBe('ARCHIVED');
}, 180_000);

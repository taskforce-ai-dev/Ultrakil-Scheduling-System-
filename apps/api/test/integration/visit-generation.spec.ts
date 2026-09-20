/**
 * ULK-C04 API tests.
 *
 * Generation's whole promise is that it never loses manager-controlled work,
 * and that promise only holds across real transactions against real rows —
 * which visits already exist, which are locked, what a second run does to a
 * calendar the first one built. None of that is observable from a unit test.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  BranchCode,
  PrismaClient,
  UserRole,
  VisitStatus,
  Weekday,
} from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { AuditService } from '../../src/audit/audit.service';
import { AuthService } from '../../src/auth/auth.service';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PublishingService } from '../../src/scheduling/optimizer/publishing.service';
import { BranchDayCapacityService } from '../../src/scheduling/visit-generation/branch-day-capacity.service';
import { VisitGenerationService } from '../../src/scheduling/visit-generation/visit-generation.service';
import {
  confirmAgreementProvenance,
  confirmRunVehicleBranches,
} from './confirm-provenance';

const prisma = new PrismaClient();

const suffix = Math.random().toString(36).slice(2, 8);
const ADMIN = { email: `c04-admin-${suffix}@ultrakil.test`, password: 'c04-admin-password' };
const MANAGER = { email: `c04-mgr-${suffix}@ultrakil.test`, password: 'c04-manager-password' };

let app: INestApplication;
let http: string;
let adminToken: string;
let managerToken: string;
let jobTypeId: string;
let siteId: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** 2026-09-07 is a Monday, so weeks line up with the calendar. */
const HORIZON = { from: '2026-09-07', to: '2026-10-04' }; // four whole weeks

async function login(email: string, password: string): Promise<string> {
  const res = await request(http).post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

/**
 * `createAgreement`'s own default duration and crew size, unless overridden:
 * ninety minutes, two crew — a hundred and eighty crew-minutes per visit,
 * which is what a cap expressed as "N visits" below actually has to be N of.
 */
const DEFAULT_AGREEMENT_CREW_MINUTES = 90 * 2;

async function createAgreement(overrides: Record<string, unknown> = {}) {
  const res = await request(http)
    .post('/api/service-agreements')
    .set(auth(adminToken))
    .send({
      serviceSiteId: siteId,
      jobTypeId,
      frequencyCount: 1,
      frequencyUnit: 'WEEK',
      allowedDays: [Weekday.WEDNESDAY],
      startDate: '2026-09-07',
      durationMinutes: 90,
      crewSize: 2,
      ...overrides,
    });
  expect(res.status).toBe(201);
  // Agreement creation now automatically plans a scoped onboarding horizon
  // (the review's "automatic new-agreement planning" ask). This suite is
  // about `preview`/`confirm` themselves, so its fixtures start from the
  // same blank slate they always have; the automatic side effect has its
  // own coverage in `automatic-agreement-planning.spec.ts`.
  await prisma.generatedVisit.deleteMany({ where: { serviceAgreementId: res.body.id } });
  return res.body;
}

/**
 * A `BranchDayCapacityService` stand-in that reports the same fixed
 * capacity for whatever branch-day it is asked about, regardless of real
 * workforce data. The shared integration database can carry other suites'
 * own leftover employees on a branch these tests use (confirmed: COLOMBO
 * and KANDY both already do), which would make the real, resource-derived
 * capacity path answer with whatever headcount happens to be lying around
 * rather than the exact figure a cap-breach test needs to control.
 */
function fixedCapacity(minutes: number): BranchDayCapacityService {
  return {
    capacitiesFor: async (branchDays: { branchCode: BranchCode; date: string }[]) =>
      new Map(
        branchDays.map(({ branchCode, date }) => [
          `${branchCode}|${date}`,
          { branchCode, date, capacityMinutes: minutes, reason: null },
        ]),
      ),
    // The feasibility pass asks the same service what each branch-day can
    // actually do. This fixture is about a deliberately loosened *cap*, not
    // about starving the branch, so it reports a pool comfortably able to
    // perform whatever the fixture plans.
    workforcesFor: async (branchDays: { branchCode: BranchCode; date: string }[]) =>
      new Map(
        branchDays.map(({ branchCode, date }) => [
          `${branchCode}|${date}`,
          {
            totalEmployeeCount: 99,
            availableEmployeeCount: 99,
            availablePmsCount: 99,
            skillHolderCounts: new Map<string, number>(),
            activeVehicleCount: 99,
            driverCapableVehicleCount: 99,
            publicTransportCapableCount: 99,
          },
        ]),
      ),
  } as unknown as BranchDayCapacityService;
}

const preview = (body: Record<string, unknown> = {}) =>
  request(http)
    .post('/api/visit-generation/preview')
    .set(auth(adminToken))
    .send({ ...HORIZON, ...body });

const confirm = (body: Record<string, unknown> = {}) =>
  request(http)
    .post('/api/visit-generation/confirm')
    .set(auth(adminToken))
    .send({ ...HORIZON, ...body });

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
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
  for (const code of [BranchCode.COLOMBO, BranchCode.KANDY]) {
    await prisma.branch.upsert({
      where: { code },
      create: { code, name: `${code} Branch` },
      update: {},
    });
  }
  for (const [creds, role] of [
    [ADMIN, UserRole.ADMIN],
    [MANAGER, UserRole.MANAGER],
  ] as const) {
    await prisma.user.upsert({
      where: { email: creds.email },
      create: {
        email: creds.email,
        fullName: `C04 ${role}`,
        role,
        passwordHash: await AuthService.hashPassword(creds.password),
      },
      update: { role, isActive: true },
    });
  }
  adminToken = await login(ADMIN.email, ADMIN.password);
  managerToken = await login(MANAGER.email, MANAGER.password);

  const jobType = await request(http)
    .post('/api/job-types')
    .set(auth(adminToken))
    .send({ code: `C04_${suffix}`, name: 'C04 Job', defaultCrewSize: 2 });
  jobTypeId = jobType.body.id;

  const customer = await request(http)
    .post('/api/customers')
    .set(auth(adminToken))
    .send({ name: `C04 Customer ${suffix}`, branchCode: BranchCode.COLOMBO });

  const site = await request(http)
    .post(`/api/customers/${customer.body.id}/sites`)
    .set(auth(adminToken))
    .send({
      name: `C04 Site ${suffix}`,
      operatingHours: [
        Weekday.MONDAY,
        Weekday.TUESDAY,
        Weekday.WEDNESDAY,
        Weekday.THURSDAY,
        Weekday.FRIDAY,
      ].map((weekday) => ({ weekday, opensAtMinute: 540, closesAtMinute: 1020 })),
    });
  siteId = site.body.id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: [ADMIN.email, MANAGER.email] } } });
  await prisma.$disconnect();
  await app.close();
});

describe('authorization', () => {
  it('refuses an anonymous caller', async () => {
    const res = await request(http).post('/api/visit-generation/preview').send(HORIZON);

    expect(res.status).toBe(401);
  });

  it('lets a manager preview but not confirm', async () => {
    const canPreview = await request(http)
      .post('/api/visit-generation/preview')
      .set(auth(managerToken))
      .send(HORIZON);
    expect(canPreview.status).toBe(200);

    const cannotConfirm = await request(http)
      .post('/api/visit-generation/confirm')
      .set(auth(managerToken))
      .send(HORIZON);
    expect(cannotConfirm.status).toBe(403);
    expect(cannotConfirm.body.code).toBe('INSUFFICIENT_ROLE');
  });
});

describe('the horizon', () => {
  it('refuses a range that ends before it starts', async () => {
    const res = await preview({ from: '2026-10-04', to: '2026-09-07' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AGREEMENT_DATES_INVALID');
  });

  it('refuses a range longer than a year', async () => {
    const res = await preview({ from: '2026-01-01', to: '2027-06-01' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('at most a year');
  });

  it('never places a visit outside the horizon', async () => {
    const agreement = await createAgreement();
    const res = await preview({ serviceAgreementIds: [agreement.id] });

    for (const visit of res.body.additions) {
      expect(visit.visitDate >= HORIZON.from).toBe(true);
      expect(visit.visitDate <= HORIZON.to).toBe(true);
    }
  });
});

describe('preview writes nothing', () => {
  it('proposes visits without creating them', async () => {
    const agreement = await createAgreement();

    const res = await preview({ serviceAgreementIds: [agreement.id] });
    expect(res.status).toBe(200);
    expect(res.body.isPreview).toBe(true);
    expect(res.body.additions.length).toBeGreaterThan(0);
    expect(res.body.scheduleRunId).toBeNull();

    const stored = await prisma.generatedVisit.count({
      where: { serviceAgreementId: agreement.id },
    });
    expect(stored).toBe(0);
  });
});

describe('generation and idempotency', () => {
  it('creates one visit a week across four weeks', async () => {
    const agreement = await createAgreement();

    const res = await confirm({ serviceAgreementIds: [agreement.id] });
    expect(res.status).toBe(200);
    expect(res.body.additions).toHaveLength(4);
    expect(res.body.scheduleRunId).toBeTruthy();

    const stored = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: agreement.id },
      orderBy: { visitDate: 'asc' },
    });
    expect(stored).toHaveLength(4);
    // Every one a Wednesday, the only allowed day.
    for (const visit of stored) expect(visit.visitDate.getUTCDay()).toBe(3);
  });

  it('the same request twice creates no duplicates', async () => {
    const agreement = await createAgreement();

    await confirm({ serviceAgreementIds: [agreement.id] });
    const second = await confirm({ serviceAgreementIds: [agreement.id] });

    expect(second.body.additions).toEqual([]);
    expect(second.body.updates).toEqual([]);
    expect(second.body.removals).toEqual([]);
    expect(second.body.unchangedCount).toBe(4);

    const stored = await prisma.generatedVisit.count({
      where: { serviceAgreementId: agreement.id },
    });
    expect(stored).toBe(4);
  });

  it('records the agreement and its version on every visit', async () => {
    const agreement = await createAgreement();
    await confirm({ serviceAgreementIds: [agreement.id] });

    const visits = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: agreement.id },
      include: { agreementVersion: true },
    });

    for (const visit of visits) {
      expect(visit.serviceAgreementId).toBe(agreement.id);
      // Without this a schedule stops being explainable the moment the
      // agreement changes.
      expect(visit.agreementVersion?.versionNumber).toBe(1);
    }
  });

  it('generates monthly recurrence across a month boundary', async () => {
    const agreement = await createAgreement({
      frequencyCount: 1,
      frequencyUnit: 'MONTH',
      allowedDays: [Weekday.WEDNESDAY],
    });

    const res = await confirm({
      serviceAgreementIds: [agreement.id],
      from: '2026-09-01',
      to: '2026-11-30',
    });

    const months = new Set(res.body.additions.map((v: { visitDate: string }) => v.visitDate.slice(0, 7)));
    expect(months.size).toBeGreaterThanOrEqual(3);
  });

  it('honours a fortnightly cycle', async () => {
    const agreement = await createAgreement({
      frequencyCount: 1,
      frequencyUnit: 'WEEK',
      frequencyInterval: 2,
      allowedDays: [Weekday.WEDNESDAY],
    });

    const res = await confirm({ serviceAgreementIds: [agreement.id] });

    // Four weeks is two fortnights.
    expect(res.body.additions).toHaveLength(2);
  });
});

describe('agreement rules are respected', () => {
  it('generates nothing for a paused agreement', async () => {
    const agreement = await createAgreement();
    await request(http)
      .post(`/api/service-agreements/${agreement.id}/status`)
      .set(auth(adminToken))
      .send({ status: 'PAUSED' });

    const res = await confirm({ serviceAgreementIds: [agreement.id] });

    expect(res.body.agreementsConsidered).toBe(0);
    expect(res.body.additions).toEqual([]);
  });

  it('stops at the agreement end date', async () => {
    const agreement = await createAgreement({ endDate: '2026-09-20' });

    const res = await preview({ serviceAgreementIds: [agreement.id] });

    for (const visit of res.body.additions) {
      expect(visit.visitDate <= '2026-09-20').toBe(true);
    }
  });

  it('uses a preferred day when it can and an allowed day when it cannot', async () => {
    const agreement = await createAgreement({
      frequencyCount: 2,
      allowedDays: [Weekday.MONDAY, Weekday.WEDNESDAY],
      preferredDays: [Weekday.WEDNESDAY],
    });

    const res = await preview({ serviceAgreementIds: [agreement.id] });

    const preferred = res.body.additions.filter((v: { isPreferredDay: boolean }) => v.isPreferredDay);
    const merelyAllowed = res.body.additions.filter(
      (v: { isPreferredDay: boolean }) => !v.isPreferredDay,
    );
    // Two a week over four weeks: one Wednesday (preferred) and one Monday.
    expect(preferred.length).toBe(4);
    expect(merelyAllowed.length).toBe(4);
  });

  it('reports a period that cannot hold its promised visits', async () => {
    const agreement = await createAgreement({
      frequencyCount: 3,
      allowedDays: [Weekday.WEDNESDAY],
    });

    const res = await preview({ serviceAgreementIds: [agreement.id] });

    expect(res.body.shortfalls.length).toBeGreaterThan(0);
    expect(res.body.shortfalls[0]).toMatchObject({ requested: 3, scheduled: 1 });
    expect(res.body.shortfalls[0].customerName).toContain('C04 Customer');
  });

  it('filters by branch', async () => {
    const agreement = await createAgreement();

    const kandy = await preview({
      serviceAgreementIds: [agreement.id],
      branchCode: BranchCode.KANDY,
    });
    expect(kandy.body.agreementsConsidered).toBe(0);

    const colombo = await preview({
      serviceAgreementIds: [agreement.id],
      branchCode: BranchCode.COLOMBO,
    });
    expect(colombo.body.agreementsConsidered).toBe(1);
  });
});

describe('regeneration never loses manager-controlled work', () => {
  it.each(
    ['update', 'removal'].flatMap((operation) =>
      ['publication', 'draft', 'revision'].map((change) => ({
        operation,
        change,
      })),
    ),
  )(
    'aborts a stale generation $operation after $change without applying any of its plan',
    async ({ operation, change }) => {
      const agreement = await createAgreement({ crewSize: 1 });
      const dto = { ...HORIZON, serviceAgreementIds: [agreement.id] };
      await confirm({ serviceAgreementIds: [agreement.id] });
      const [visit] = await prisma.generatedVisit.findMany({
        where: { serviceAgreementId: agreement.id },
        orderBy: { id: 'desc' },
      });
      await request(http)
        .patch(`/api/service-agreements/${agreement.id}`)
        .set(auth(adminToken))
        .send(
          operation === 'update'
            ? { durationMinutes: 120 }
            : { allowedDays: [Weekday.FRIDAY], preferredDays: [] },
        )
        .expect(200);
      const impact = await app.get(VisitGenerationService).preview(dto);
      expect(
        operation === 'update' ? impact.updates : impact.removals,
      ).toHaveLength(4);
      for (const entry of [...impact.updates, ...impact.removals]) {
        expect(entry).not.toHaveProperty('expectedUpdatedAt');
        expect(entry).not.toHaveProperty('updatedAt');
      }
      const planned = barrier();
      const resume = barrier();
      const client = new Proxy(prisma, {
        get(target, key) {
          if (key === '$transaction')
            return async (
              work: Parameters<PrismaService['$transaction']>[0],
            ) => {
              planned.release();
              await resume.promise;
              return target.$transaction(work);
            };
          return Reflect.get(target, key);
        },
      }) as unknown as PrismaService;
      const generation = new VisitGenerationService(
        client,
        app.get(AuditService),
        app.get(ConfigService),
        app.get(BranchDayCapacityService),
      );
      const actor = await prisma.user.findUniqueOrThrow({
        where: { email: ADMIN.email },
      });
      const pending = generation.confirm(dto, actor).then(
        () => undefined,
        (error: unknown) => error,
      );
      let employeeId: string | undefined;
      try {
        await planned.promise;
        if (change === 'revision') {
          // Still unprotected and unassigned: only its exact revision changed.
          await prisma.generatedVisit.update({
            where: { id: visit.id },
            data: { requiredCrewSize: 3 },
          });
        } else {
          const employee = await prisma.employee.create({
            data: {
              employeeCode: `c04-race-${operation}-${suffix}`,
              sourceKey: `c04-race-${operation}-${suffix}`,
              gradeLabel: 'PMS',
              fullName: 'Generation race crew',
              branchId: visit.branchId,
              branchCode: visit.branchCode,
              isPmsGrade: true,
              canUsePublicTransport: true,
            },
          });
          employeeId = employee.id;
          const run = await prisma.scheduleRun.create({
            data: {
              status: 'SUCCEEDED',
              rangeStart: new Date(HORIZON.from),
              rangeEnd: new Date(HORIZON.to),
              // Publication blocks a run that scheduled nothing, so this
              // hand-built run states the one assignment it stands for.
              visitsConsidered: 1,
              visitsScheduled: 1,
              visitsUnassigned: 0,
            },
          });
          await prisma.assignment.create({
            data: {
              generatedVisitId: visit.id,
              branchId: visit.branchId,
              branchCode: visit.branchCode,
              status: 'DRAFT',
              scheduleRunId: run.id,
              plannedStart: new Date(visit.visitDate.getTime() + 540 * 60_000),
              plannedEnd: new Date(visit.visitDate.getTime() + 630 * 60_000),
              crewMembers: {
                create: {
                  employeeId: employee.id,
                  role: 'SUPERVISOR',
                  isPmsSupervisor: true,
                },
              },
            },
          });
          // Leave the visit timestamp/status unchanged: the assignment/history
          // recheck must protect it even independently of the revision fence.
          if (change === 'publication') {
            // The subject here is regeneration, not provenance: state the
            // fixture as confirmed fact so publishing needs no acknowledgement.
            await confirmAgreementProvenance(prisma, agreement.id);
            await confirmRunVehicleBranches(prisma, run.id);
            await app.get(PublishingService).publish(run.id, null, actor);
          }
        }
        const visitsBefore = await prisma.generatedVisit.findMany({
          where: { serviceAgreementId: agreement.id },
          orderBy: { id: 'asc' },
        });
        const assignmentBefore = await prisma.assignment.findMany({
          where: { generatedVisitId: visit.id },
          include: { crewMembers: true },
          orderBy: { id: 'asc' },
        });
        const outboxBefore = await prisma.assignmentNotificationOutbox.findMany(
          {
            where: { assignment: { generatedVisitId: visit.id } },
            orderBy: { id: 'asc' },
          },
        );
        expect(outboxBefore).toHaveLength(change === 'publication' ? 1 : 0);
        const runsBefore = await prisma.scheduleRun.count();
        const auditsBefore = await prisma.auditEvent.count({
          where: { action: 'visit_generation.confirmed' },
        });
        resume.release();
        expect(await pending).toMatchObject({ code: 'RESOURCE_CONFLICT' });
        expect(
          await prisma.generatedVisit.findMany({
            where: { serviceAgreementId: agreement.id },
            orderBy: { id: 'asc' },
          }),
        ).toEqual(visitsBefore);
        expect(
          await prisma.assignment.findMany({
            where: { generatedVisitId: visit.id },
            include: { crewMembers: true },
            orderBy: { id: 'asc' },
          }),
        ).toEqual(assignmentBefore);
        expect(
          await prisma.assignmentNotificationOutbox.findMany({
            where: { assignment: { generatedVisitId: visit.id } },
            orderBy: { id: 'asc' },
          }),
        ).toEqual(outboxBefore);
        expect(await prisma.scheduleRun.count()).toBe(runsBefore);
        expect(
          await prisma.auditEvent.count({
            where: { action: 'visit_generation.confirmed' },
          }),
        ).toBe(auditsBefore);
      } finally {
        resume.release();
        await pending;
        await prisma.serviceAgreement.delete({ where: { id: agreement.id } });
        if (employeeId)
          await prisma.employee.delete({ where: { id: employeeId } });
      }
    },
  );

  it.each([VisitStatus.PENDING, VisitStatus.UNASSIGNED])('updates an untouched %s visit when the agreement changes', async (status) => {
    const agreement = await createAgreement();
    await confirm({ serviceAgreementIds: [agreement.id] });
    await prisma.generatedVisit.updateMany({ where: { serviceAgreementId: agreement.id }, data: { status } });

    await request(http)
      .patch(`/api/service-agreements/${agreement.id}`)
      .set(auth(adminToken))
      .send({ crewSize: 5 });

    const res = await confirm({ serviceAgreementIds: [agreement.id] });

    expect(res.body.updates).toHaveLength(4);
    expect(res.body.updates[0].changes).toContainEqual({
      field: 'requiredCrewSize',
      from: '2',
      to: '5',
    });

    const stored = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: agreement.id },
    });
    for (const visit of stored) expect(visit.requiredCrewSize).toBe(5);
  });

  it('leaves a locked visit alone and reports it', async () => {
    const agreement = await createAgreement();
    await confirm({ serviceAgreementIds: [agreement.id] });

    const [locked] = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: agreement.id },
      orderBy: { visitDate: 'asc' },
      take: 1,
    });
    await prisma.generatedVisit.update({
      where: { id: locked.id },
      data: { lockedAt: new Date(), lockReason: 'Customer confirmed this date' },
    });

    await request(http)
      .patch(`/api/service-agreements/${agreement.id}`)
      .set(auth(adminToken))
      .send({ crewSize: 7 });

    const res = await confirm({ serviceAgreementIds: [agreement.id] });

    expect(res.body.protectedVisits).toContainEqual(
      expect.objectContaining({ visitId: locked.id, protection: 'LOCKED', wouldHave: 'UPDATE' }),
    );

    const after = await prisma.generatedVisit.findUniqueOrThrow({ where: { id: locked.id } });
    expect(after.requiredCrewSize).toBe(2); // untouched
  });

  it('leaves a hand-edited visit alone', async () => {
    const agreement = await createAgreement();
    await confirm({ serviceAgreementIds: [agreement.id] });

    const [edited] = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: agreement.id },
      take: 1,
    });
    await prisma.generatedVisit.update({
      where: { id: edited.id },
      data: { isManuallyAdjusted: true, manuallyAdjustedAt: new Date() },
    });

    await request(http)
      .patch(`/api/service-agreements/${agreement.id}`)
      .set(auth(adminToken))
      .send({ durationMinutes: 200 });

    const res = await confirm({ serviceAgreementIds: [agreement.id] });

    expect(res.body.protectedVisits).toContainEqual(
      expect.objectContaining({ visitId: edited.id, protection: 'MANUALLY_ADJUSTED' }),
    );
    const after = await prisma.generatedVisit.findUniqueOrThrow({ where: { id: edited.id } });
    expect(after.durationMinutes).toBe(90);
  });

  it('will not remove a scheduled visit the agreement no longer wants', async () => {
    const agreement = await createAgreement();
    await confirm({ serviceAgreementIds: [agreement.id] });

    const [kept] = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: agreement.id },
      orderBy: { visitDate: 'desc' },
      take: 1,
    });
    await prisma.generatedVisit.update({
      where: { id: kept.id },
      data: { status: VisitStatus.SCHEDULED },
    });

    // End the agreement before its last visit, so that week genuinely asks
    // for nothing. A weekday change would not do it: the week still wants one
    // visit, and this protected one is now the visit it gets.
    await request(http)
      .patch(`/api/service-agreements/${agreement.id}`)
      .set(auth(adminToken))
      .send({ endDate: '2026-09-15' });

    const res = await confirm({ serviceAgreementIds: [agreement.id] });

    expect(res.body.protectedVisits).toContainEqual(
      expect.objectContaining({
        visitId: kept.id,
        protection: 'ALREADY_SCHEDULED',
        wouldHave: 'REMOVE',
      }),
    );

    const survivor = await prisma.generatedVisit.findUnique({ where: { id: kept.id } });
    expect(survivor).not.toBeNull();
  });

  it('says which day a protected visit would have moved to when the weekday changes', async () => {
    // The visit is pinned, so the week is not re-planned around it and there
    // is no duplicate. But the agreement no longer allows the day it sits on,
    // and reporting that as "unchanged" is how a stale visit stays for ever.
    const agreement = await createAgreement();
    await confirm({ serviceAgreementIds: [agreement.id] });
    await prisma.generatedVisit.updateMany({
      where: { serviceAgreementId: agreement.id },
      data: { lockedAt: new Date(), lockReason: 'held for the customer' },
    });

    await request(http)
      .patch(`/api/service-agreements/${agreement.id}`)
      .set(auth(adminToken))
      .send({ allowedDays: [Weekday.FRIDAY], preferredDays: [] })
      .expect(200);

    const impact = await preview({ serviceAgreementIds: [agreement.id] });

    expect(impact.body.additions).toHaveLength(0);
    expect(impact.body.removals).toHaveLength(0);
    expect(impact.body.protectedVisits).toHaveLength(4);

    for (const entry of impact.body.protectedVisits) {
      expect(entry.wouldHave).toBe('UPDATE');
      const move = entry.changes.find(
        (change: { field: string }) => change.field === 'visitDate',
      );
      expect(move.from).toBe(entry.visitDate);
      // Wednesday as it stands; Friday is where the agreement now points.
      expect(new Date(`${move.to}T00:00:00.000Z`).getUTCDay()).toBe(5);
    }
  });

  it('still wants a visit for the period a cancelled one was meant to cover', async () => {
    // A cancelled visit is protected — it is never removed — but it stands
    // for no work. Letting it satisfy its week left the customer with a
    // cancellation where a visit was due, and the run reported nothing to do.
    const agreement = await createAgreement();
    await confirm({ serviceAgreementIds: [agreement.id] });
    await prisma.generatedVisit.updateMany({
      where: { serviceAgreementId: agreement.id },
      data: { status: VisitStatus.CANCELLED },
    });

    await request(http)
      .patch(`/api/service-agreements/${agreement.id}`)
      .set(auth(adminToken))
      .send({ allowedDays: [Weekday.FRIDAY], preferredDays: [] })
      .expect(200);

    const impact = await preview({ serviceAgreementIds: [agreement.id] });

    expect(impact.body.additions).toHaveLength(4);
    // And the cancelled rows are still nobody's to delete.
    expect(impact.body.removals).toHaveLength(0);
    expect(
      impact.body.protectedVisits.filter(
        (entry: { protection: string; wouldHave: string }) =>
          entry.protection === 'CANCELLED' && entry.wouldHave === 'REMOVE',
      ),
    ).toHaveLength(4);
  });

  it.each([VisitStatus.PENDING, VisitStatus.UNASSIGNED])('removes an untouched %s visit the agreement no longer wants, having said so', async (status) => {
    const agreement = await createAgreement();
    await confirm({ serviceAgreementIds: [agreement.id] });
    await prisma.generatedVisit.updateMany({ where: { serviceAgreementId: agreement.id }, data: { status } });

    const before = await prisma.generatedVisit.count({
      where: { serviceAgreementId: agreement.id },
    });
    expect(before).toBe(4);

    await request(http)
      .patch(`/api/service-agreements/${agreement.id}`)
      .set(auth(adminToken))
      .send({ allowedDays: [Weekday.FRIDAY], preferredDays: [] });

    // Preview announces the removals first; confirm then applies them.
    const announced = await preview({ serviceAgreementIds: [agreement.id] });
    expect(announced.body.removals).toHaveLength(4);

    await confirm({ serviceAgreementIds: [agreement.id] });

    const remaining = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: agreement.id },
    });
    expect(remaining).toHaveLength(4);
    for (const visit of remaining) expect(visit.visitDate.getUTCDay()).toBe(5); // Friday
  });
});

describe('a site with no recorded opening hours', () => {
  it('schedules anyway and flags the visit, rather than refusing', async () => {
    // The master schedule workbook has no opening-hours column, so imported
    // sites arrive with none. Reading that as "never open" refused to schedule
    // work UltraKIL demonstrably performs — 0 visits and a wall of shortfalls.
    const customer = await request(http)
      .post('/api/customers')
      .set(auth(adminToken))
      .send({ name: `C04 No-Hours ${suffix}`, branchCode: BranchCode.COLOMBO });

    const site = await request(http)
      .post(`/api/customers/${customer.body.id}/sites`)
      .set(auth(adminToken))
      .send({ name: `C04 No-Hours Site ${suffix}`, operatingHours: [] });

    const agreement = await createAgreement({ serviceSiteId: site.body.id });

    const res = await confirm({ serviceAgreementIds: [agreement.id] });

    expect(res.body.additions).toHaveLength(4);
    expect(res.body.shortfalls).toEqual([]);
    // Placed on the assumed working day, and said so.
    expect(res.body.additions[0]).toMatchObject({
      windowStartMinute: 8 * 60,
      windowEndMinute: 17 * 60,
    });

    const listed = await request(http)
      .get('/api/visits')
      .set(auth(adminToken))
      .query({ serviceAgreementId: agreement.id });
    expect(listed.body.items[0].hoursUnconfirmed).toBe(true);

    // Empty actual hours stay empty. The generated rows make the 08:00–17:00
    // fallback explicit instead of quietly turning it into a site fact.
    expect(await prisma.siteOperatingHours.count({ where: { serviceSiteId: site.body.id } })).toBe(0);
    expect(await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: agreement.id },
      select: { windowProvenance: true },
    })).toEqual([
      { windowProvenance: 'DEFAULTED' },
      { windowProvenance: 'DEFAULTED' },
      { windowProvenance: 'DEFAULTED' },
      { windowProvenance: 'DEFAULTED' },
    ]);
  });

});

describe('where a generated visit\'s window came from', () => {
  // The publication gate asks a manager to acknowledge source data nobody
  // confirmed. Stamping every visit with recorded hours as DERIVED made it ask
  // about hours a manager had typed in by hand, quoting the 08:00-17:00
  // fallback that was not in use.
  it('records manager-entered site hours as confirmed, so publication does not query them', async () => {
    const agreement = await createAgreement({});

    await confirm({ serviceAgreementIds: [agreement.id] });

    const visits = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: agreement.id },
      select: { windowProvenance: true },
    });
    expect(visits.length).toBeGreaterThan(0);
    expect(visits.every((visit) => visit.windowProvenance === 'MANAGER_CONFIRMED')).toBe(true);
  });

  it('records imported hours as imported rather than promoting them to confirmed', async () => {
    const customer = await request(http)
      .post('/api/customers')
      .set(auth(adminToken))
      .send({ name: `C04 Imported Hours ${suffix}`, branchCode: BranchCode.COLOMBO });
    const site = await request(http)
      .post(`/api/customers/${customer.body.id}/sites`)
      .set(auth(adminToken))
      .send({
        name: `C04 Imported Hours Site ${suffix}`,
        operatingHours: [
          Weekday.MONDAY,
          Weekday.TUESDAY,
          Weekday.WEDNESDAY,
          Weekday.THURSDAY,
          Weekday.FRIDAY,
        ].map((weekday) => ({ weekday, opensAtMinute: 540, closesAtMinute: 1020 })),
      });
    // What the importer leaves behind: hours nobody has confirmed.
    await prisma.siteOperatingHours.updateMany({
      where: { serviceSiteId: site.body.id },
      data: { provenance: 'SOURCE' },
    });

    const agreement = await createAgreement({ serviceSiteId: site.body.id });
    await confirm({ serviceAgreementIds: [agreement.id] });

    const visits = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: agreement.id },
      select: { windowProvenance: true },
    });
    expect(visits.length).toBeGreaterThan(0);
    expect(visits.every((visit) => visit.windowProvenance === 'SOURCE')).toBe(true);
  });

  it('treats an explicit agreement window with no site hours as manager-stated, not defaulted', async () => {
    const customer = await request(http)
      .post('/api/customers')
      .set(auth(adminToken))
      .send({ name: `C04 Agreement Window ${suffix}`, branchCode: BranchCode.COLOMBO });
    const site = await request(http)
      .post(`/api/customers/${customer.body.id}/sites`)
      .set(auth(adminToken))
      .send({ name: `C04 Agreement Window Site ${suffix}`, operatingHours: [] });

    const agreement = await createAgreement({
      serviceSiteId: site.body.id,
      serviceWindowStartMinute: 10 * 60,
      serviceWindowEndMinute: 15 * 60,
    });
    await confirm({ serviceAgreementIds: [agreement.id] });

    const visits = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: agreement.id },
      select: { windowProvenance: true, windowStartMinute: true, windowEndMinute: true },
    });
    expect(visits.length).toBeGreaterThan(0);
    expect(visits.every((visit) => visit.windowProvenance === 'MANAGER_CONFIRMED')).toBe(true);
    expect(visits[0]).toMatchObject({ windowStartMinute: 600, windowEndMinute: 900 });
  });
});

/**
 * The defect this branch made routine.
 *
 * A visit is matched by agreement, date and start time, so a period re-planned
 * onto another day is one addition and one removal. Fine for a visit the
 * generator owns. For a protected one the removal is refused and the addition
 * goes ahead anyway, and the customer has two visits where the agreement
 * promised one. Every monthly agreement moves off day one on the first run
 * after this release, so this is the ordinary case, not a corner.
 */
describe('a protected visit is never duplicated by its own replacement', () => {
  const protect = async (
    agreementId: string,
    data: Record<string, unknown>,
  ): Promise<void> => {
    await prisma.generatedVisit.updateMany({
      where: { serviceAgreementId: agreementId },
      data,
    });
  };

  it.each([
    ['locked', { lockedAt: new Date() }],
    ['adjusted by hand', { isManuallyAdjusted: true }],
    ['already scheduled', { status: VisitStatus.SCHEDULED }],
  ])('leaves a %s visit alone without adding its replacement', async (_label, data) => {
    const agreement = await createAgreement();
    await confirm({ serviceAgreementIds: [agreement.id] });
    const before = await prisma.generatedVisit.count({
      where: { serviceAgreementId: agreement.id },
    });
    expect(before).toBe(4);
    await protect(agreement.id, data);

    // The agreement's day moves. Every required date is now different.
    await request(http)
      .patch(`/api/service-agreements/${agreement.id}`)
      .set(auth(adminToken))
      .send({ allowedDays: [Weekday.FRIDAY], preferredDays: [] })
      .expect(200);

    const res = await preview({ serviceAgreementIds: [agreement.id] });

    expect(res.status).toBe(200);
    expect(res.body.additions).toHaveLength(0);
    expect(res.body.removals).toHaveLength(0);

    await confirm({ serviceAgreementIds: [agreement.id] });
    const after = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: agreement.id },
      select: { visitDate: true },
    });
    // Still four visits on the four Wednesdays, not eight across two weekdays.
    expect(after).toHaveLength(4);
    expect(
      after.every((visit) => visit.visitDate.getUTCDay() === 3),
    ).toBe(true);
  });

  it('regenerates a horizon of published week-one visits with nothing to add', async () => {
    // What the first run after this release meets: visits generated by the old
    // earliest-first rule, published, and an agreement that now anchors to the
    // middle of the month.
    const agreement = await createAgreement({
      frequencyCount: 1,
      frequencyUnit: 'MONTH',
      allowedDays: [
        Weekday.MONDAY,
        Weekday.TUESDAY,
        Weekday.WEDNESDAY,
        Weekday.THURSDAY,
        Weekday.FRIDAY,
      ],
      preferredDays: [],
    });
    const branch = await prisma.branch.findUniqueOrThrow({
      where: { code: BranchCode.COLOMBO },
    });
    // Three months of bookings on the 17th, so the anchor is mid-month.
    await prisma.serviceAgreementBooking.createMany({
      data: ['2026-06-17', '2026-07-17', '2026-08-17'].map((date) => ({
        serviceAgreementId: agreement.id,
        bookedDate: new Date(`${date}T00:00:00.000Z`),
        provenance: 'SOURCE' as const,
      })),
    });
    // The old rule's answer, published.
    await prisma.generatedVisit.create({
      data: {
        serviceAgreementId: agreement.id,
        branchId: branch.id,
        branchCode: BranchCode.COLOMBO,
        visitDate: new Date('2026-09-07T00:00:00.000Z'),
        windowStartMinute: 540,
        windowEndMinute: 1020,
        durationMinutes: 90,
        requiredCrewSize: 2,
        status: VisitStatus.SCHEDULED,
      },
    });

    // One whole month, so the run asks for exactly the one visit the published
    // row already covers.
    const res = await preview({
      from: '2026-09-01',
      to: '2026-09-30',
      serviceAgreementIds: [agreement.id],
    });

    expect(res.status).toBe(200);
    expect(res.body.additions).toHaveLength(0);
    expect(res.body.removals).toHaveLength(0);
  });
});

/**
 * The load guard's second blind spot: everything outside the run's own list.
 *
 * A run scoped to one agreement used to see every day as empty, anchor onto a
 * Monday already carrying twelve, and be moved straight off it again by the
 * next full run — placement flapping with whatever scope somebody happened to
 * generate under.
 */
describe('a scoped run and a full run reach the same calendar', () => {
  /** The service with a cap small enough for three agreements to breach. */
  const cappedAt = (cap: number) =>
    new VisitGenerationService(
      app.get(PrismaService),
      app.get(AuditService),
      { get: (key: string) =>
        key === 'visitGeneration.dailyCapacityMinutes' ? cap * DEFAULT_AGREEMENT_CREW_MINUTES : undefined,
      } as unknown as ConfigService,
      fixedCapacity(cap * DEFAULT_AGREEMENT_CREW_MINUTES),
    );

  it('does not move a visit back onto a full day just because the run was scoped', async () => {
    // A branch and a week of its own, cleared first. The guard now counts
    // every visit standing in the horizon — including whatever an earlier run
    // of this suite left in the shared database — so an assertion about the
    // cap biting has to own its slice of the calendar outright.
    const week = { from: '2027-03-01', to: '2027-03-07' };
    await prisma.generatedVisit.deleteMany({
      where: {
        branchCode: BranchCode.KANDY,
        visitDate: {
          gte: new Date(`${week.from}T00:00:00.000Z`),
          lte: new Date(`${week.to}T00:00:00.000Z`),
        },
      },
    });
    const customer = await request(http)
      .post('/api/customers')
      .set(auth(adminToken))
      .send({ name: `C04 Scope ${suffix}`, branchCode: BranchCode.KANDY });
    const site = await request(http)
      .post(`/api/customers/${customer.body.id}/sites`)
      .set(auth(adminToken))
      .send({
        name: `C04 Scope Site ${suffix}`,
        branchCode: BranchCode.KANDY,
        operatingHours: [Weekday.WEDNESDAY, Weekday.THURSDAY].map((weekday) => ({
          weekday,
          opensAtMinute: 540,
          closesAtMinute: 1020,
        })),
      });

    const agreements = [];
    for (let index = 0; index < 3; index += 1) {
      agreements.push(
        await createAgreement({
          serviceSiteId: site.body.id,
          allowedDays: [Weekday.WEDNESDAY, Weekday.THURSDAY],
          preferredDays: [],
        }),
      );
    }
    const ids = agreements.map((agreement) => agreement.id);
    const generation = cappedAt(2);
    const actor = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN.email } });

    await generation.confirm({ ...week, serviceAgreementIds: ids }, actor);
    const spread = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: { in: ids } },
      select: { serviceAgreementId: true, visitDate: true },
      orderBy: { serviceAgreementId: 'asc' },
    });
    expect(spread).toHaveLength(3);
    // The cap bit: not all three sit on the same day.
    expect(new Set(spread.map((visit) => visit.visitDate.toISOString())).size).toBe(2);

    // Each agreement previewed alone. Before, the one the guard had moved was
    // proposed straight back onto the day it was moved off.
    for (const id of ids) {
      const scoped = await generation.preview({ ...week, serviceAgreementIds: [id] });
      expect({
        id,
        additions: scoped.additions.length,
        removals: scoped.removals.length,
        updates: scoped.updates.length,
      }).toEqual({ id, additions: 0, removals: 0, updates: 0 });
    }

    // And the full run still has nothing to do either.
    const full = await generation.preview({ ...week, serviceAgreementIds: ids });
    expect(full.additions).toHaveLength(0);
    expect(full.removals).toHaveLength(0);
    expect(full.updates).toHaveLength(0);
  });
});

describe('a new agreement, generated on its own, never moves another agreement\'s visit', () => {
  /** Small enough that one existing visit already fills the day. */
  const cappedAtOne = () =>
    new VisitGenerationService(
      app.get(PrismaService),
      app.get(AuditService),
      { get: (key: string) =>
        key === 'visitGeneration.dailyCapacityMinutes' ? DEFAULT_AGREEMENT_CREW_MINUTES : undefined,
      } as unknown as ConfigService,
      fixedCapacity(DEFAULT_AGREEMENT_CREW_MINUTES),
    );

  it("plans the new agreement's visits without touching the existing agreement's", async () => {
    const week = { from: '2027-05-03', to: '2027-05-09' }; // Monday-Sunday
    await prisma.generatedVisit.deleteMany({
      where: {
        branchCode: BranchCode.KANDY,
        visitDate: {
          gte: new Date(`${week.from}T00:00:00.000Z`),
          lte: new Date(`${week.to}T00:00:00.000Z`),
        },
      },
    });
    const customer = await request(http)
      .post('/api/customers')
      .set(auth(adminToken))
      .send({ name: `C04 New Agreement ${suffix}`, branchCode: BranchCode.KANDY });
    const site = await request(http)
      .post(`/api/customers/${customer.body.id}/sites`)
      .set(auth(adminToken))
      .send({
        name: `C04 New Agreement Site ${suffix}`,
        branchCode: BranchCode.KANDY,
        // Both agreements below allow the same two weekdays, so the new one
        // has somewhere else to go once the guard finds the first already
        // full — an agreement allowed only one day has no alternative to
        // spread to at all, which would prove nothing about not touching a
        // neighbour.
        operatingHours: [Weekday.WEDNESDAY, Weekday.THURSDAY].map((weekday) => ({
          weekday,
          opensAtMinute: 540,
          closesAtMinute: 1020,
        })),
      });

    const existing = await createAgreement({
      serviceSiteId: site.body.id,
      allowedDays: [Weekday.WEDNESDAY, Weekday.THURSDAY],
      preferredDays: [Weekday.WEDNESDAY],
    });
    const generation = cappedAtOne();
    const actor = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN.email } });

    // The existing agreement, generated and settled first — one visit, on
    // the branch-day's one and only slot at this cap.
    await generation.confirm({ ...week, serviceAgreementIds: [existing.id] }, actor);
    const before = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: existing.id },
    });
    expect(before).toHaveLength(1);

    // A brand-new agreement, over the same site and the same preferred day,
    // generated scoped to itself alone — the shape of "a manager just added
    // a customer".
    const created = await createAgreement({
      serviceSiteId: site.body.id,
      allowedDays: [Weekday.WEDNESDAY, Weekday.THURSDAY],
      preferredDays: [Weekday.WEDNESDAY],
    });
    await generation.confirm({ ...week, serviceAgreementIds: [created.id] }, actor);

    // The existing agreement's visit is exactly what it was — same id, same
    // date, same revision. A scoped run for someone else never moved it,
    // even though the new agreement wanted the identical day and the day
    // could hold only one.
    const after = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: existing.id },
    });
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id: before[0].id,
      visitDate: before[0].visitDate,
    });
    expect(after[0].updatedAt.getTime()).toBe(before[0].updatedAt.getTime());

    // The new agreement was still served — the guard found it somewhere
    // else, or it is honestly reported unassigned. Either is fine; the only
    // wrong outcome is a moved neighbour.
    const newVisits = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: created.id },
    });
    for (const visit of newVisits) {
      expect(visit.visitDate.getTime()).not.toBe(before[0].visitDate.getTime());
    }
  });
});

describe('a range that cuts a month in half', () => {
  /**
   * The portal's month view used to hand generation the calendar *grid* —
   * 2026-08-31 to 2026-10-04 for September. The August stub was planned as
   * though it were the month, and the August visit already published on the
   * 17th lay outside the range where neither the pinning nor the load guard
   * could see it. Two August visits, every time the button was pressed.
   */
  const grid = { from: '2026-08-31', to: '2026-10-04' };

  it('adds nothing to a month it can see only one day of', async () => {
    const agreement = await createAgreement({
      frequencyCount: 1,
      frequencyUnit: 'MONTH',
      allowedDays: [
        Weekday.MONDAY,
        Weekday.TUESDAY,
        Weekday.WEDNESDAY,
        Weekday.THURSDAY,
        Weekday.FRIDAY,
      ],
      preferredDays: [],
      startDate: '2026-01-05',
    });
    const branch = await prisma.branch.findUniqueOrThrow({
      where: { code: BranchCode.COLOMBO },
    });
    const published = await prisma.generatedVisit.create({
      data: {
        serviceAgreementId: agreement.id,
        branchId: branch.id,
        branchCode: BranchCode.COLOMBO,
        visitDate: new Date('2026-08-17T00:00:00.000Z'),
        windowStartMinute: 540,
        windowEndMinute: 1020,
        durationMinutes: 90,
        requiredCrewSize: 2,
        status: VisitStatus.SCHEDULED,
      },
    });

    try {
      const impact = await preview({ ...grid, serviceAgreementIds: [agreement.id] });

      const august = impact.body.additions.filter(
        (addition: { visitDate: string }) => addition.visitDate < '2026-09-01',
      );
      expect(august).toEqual([]);
      // September, which the range does hold whole, is still planned.
      expect(
        impact.body.additions.filter(
          (addition: { visitDate: string }) =>
            addition.visitDate >= '2026-09-01' && addition.visitDate <= '2026-09-30',
        ),
      ).toHaveLength(1);
      // And October, which it holds four days of, is left to the run that can
      // see it whole.
      expect(
        impact.body.additions.filter(
          (addition: { visitDate: string }) => addition.visitDate > '2026-09-30',
        ),
      ).toEqual([]);
      // The published visit is untouched and unproposed either way.
      expect(impact.body.removals).toEqual([]);
    } finally {
      // Cleaned up whatever the assertions did. A published August visit left
      // behind by a failing run is a fixture every later test has to work
      // around, and the first failure would cascade into several.
      await prisma.generatedVisit.delete({ where: { id: published.id } });
    }
  });
});

describe('the week view and the month view plan the same periods', () => {
  /**
   * The regression in full, end to end.
   *
   * Periods used to be phased from the run's own `from`, so the portal's two
   * views disagreed about which days belonged to which week: generate a weekly
   * Mon-Fri agreement from the week view and it took Monday; generate the same
   * agreement from the month view, whose range began on a Tuesday, and it took
   * Tuesday. One run undid the other for ever — or, where the Monday was
   * protected, the customer was given both.
   *
   * April 2027: the grid runs 2027-03-29 to 2027-05-02, whole Monday-to-Sunday
   * weeks with the whole calendar month inside them.
   */
  const monthView = { from: '2027-03-29', to: '2027-05-02' };
  const weekViews = [
    { from: '2027-03-29', to: '2027-04-04' },
    { from: '2027-04-05', to: '2027-04-11' },
    { from: '2027-04-12', to: '2027-04-18' },
    { from: '2027-04-19', to: '2027-04-25' },
    { from: '2027-04-26', to: '2027-05-02' },
  ];

  const weekdays = [
    Weekday.MONDAY,
    Weekday.TUESDAY,
    Weekday.WEDNESDAY,
    Weekday.THURSDAY,
    Weekday.FRIDAY,
  ];

  /**
   * Every cadence the importer actually produces, with how many periods the
   * month view still has left to plan once every week view has run.
   *
   * A week view holds a whole week and nothing longer, so it plans every week
   * of a weekly agreement and none of a fortnightly, monthly or quarterly one.
   * The grid holds two whole fortnights and the whole of April; it holds no
   * whole quarter, and says so instead of planning one.
   */
  const cadences = [
    { label: 'weekly', frequencyUnit: 'WEEK', frequencyInterval: 1, leftForTheMonth: 0 },
    { label: 'fortnightly', frequencyUnit: 'WEEK', frequencyInterval: 2, leftForTheMonth: 2 },
    { label: 'monthly', frequencyUnit: 'MONTH', frequencyInterval: 1, leftForTheMonth: 1 },
    { label: 'quarterly', frequencyUnit: 'MONTH', frequencyInterval: 3, leftForTheMonth: 0 },
  ] as const;

  const nothingToDo = (impact: {
    additions: unknown[];
    removals: unknown[];
    updates: unknown[];
  }) => ({
    additions: impact.additions.length,
    removals: impact.removals.length,
    updates: impact.updates.length,
  });

  describe.each(cadences)('a $label agreement', (cadence) => {
    let agreementId: string;

    beforeAll(async () => {
      const agreement = await createAgreement({
        frequencyCount: 1,
        frequencyUnit: cadence.frequencyUnit,
        frequencyInterval: cadence.frequencyInterval,
        allowedDays: weekdays,
        preferredDays: [],
        // Well clear of every other suite's horizon, and a Monday, so the
        // agreement's own week is an ISO week.
        startDate: '2027-01-04',
      });
      agreementId = agreement.id;
    });

    afterAll(async () => {
      await prisma.generatedVisit.deleteMany({
        where: { serviceAgreementId: agreementId },
      });
    });

    afterEach(async () => {
      await prisma.generatedVisit.deleteMany({
        where: { serviceAgreementId: agreementId },
      });
    });

    it('never undoes what the week views created, and settles after one month run', async () => {
      for (const week of weekViews) {
        await confirm({ ...week, serviceAgreementIds: [agreementId] });
      }

      const month = await preview({ ...monthView, serviceAgreementIds: [agreementId] });

      // The month view can hold periods no week view could — a fortnight, a
      // month — so it may still have work to add. What it must never do is
      // remove or rewrite what the week views put in the calendar.
      expect(month.body.removals).toEqual([]);
      expect(month.body.updates).toEqual([]);
      expect(month.body.additions).toHaveLength(cadence.leftForTheMonth);

      await confirm({ ...monthView, serviceAgreementIds: [agreementId] });

      // And with both views run, neither has anything left to say.
      const again = await preview({ ...monthView, serviceAgreementIds: [agreementId] });
      expect(nothingToDo(again.body)).toEqual({ additions: 0, removals: 0, updates: 0 });

      for (const week of weekViews) {
        const settled = await preview({ ...week, serviceAgreementIds: [agreementId] });
        expect(nothingToDo(settled.body)).toEqual({
          additions: 0,
          removals: 0,
          updates: 0,
        });
      }
    });

    it('has nothing left to do when the week views follow the month view', async () => {
      await confirm({ ...monthView, serviceAgreementIds: [agreementId] });

      for (const week of weekViews) {
        const second = await preview({ ...week, serviceAgreementIds: [agreementId] });
        expect(nothingToDo(second.body)).toEqual({
          additions: 0,
          removals: 0,
          updates: 0,
        });
      }
    });
  });

  it('keeps a fortnightly agreement on a fourteen-day cadence across two month runs', async () => {
    // The month view is the only one that holds a whole fortnight, so two
    // consecutive months are what a fortnightly agreement is actually built
    // from. Phased from each run's own start they reset every month.
    const agreement = await createAgreement({
      frequencyCount: 1,
      frequencyUnit: 'WEEK',
      frequencyInterval: 2,
      allowedDays: [Weekday.MONDAY],
      preferredDays: [],
      startDate: '2027-01-04',
    });

    try {
      await confirm({ ...monthView, serviceAgreementIds: [agreement.id] });
      // May 2027's grid: 2027-04-26 to 2027-06-06.
      await confirm({
        from: '2027-04-26',
        to: '2027-06-06',
        serviceAgreementIds: [agreement.id],
      });

      const stored = await prisma.generatedVisit.findMany({
        where: { serviceAgreementId: agreement.id },
        orderBy: { visitDate: 'asc' },
        select: { visitDate: true },
      });
      const dates = stored.map((visit) => visit.visitDate.toISOString().slice(0, 10));

      expect(dates.length).toBeGreaterThan(2);
      const gaps = dates
        .slice(1)
        .map(
          (date, index) =>
            (new Date(`${date}T00:00:00Z`).getTime() -
              new Date(`${dates[index]}T00:00:00Z`).getTime()) /
            (24 * 60 * 60 * 1000),
        );
      expect([...new Set(gaps)]).toEqual([14]);
    } finally {
      await prisma.generatedVisit.deleteMany({
        where: { serviceAgreementId: agreement.id },
      });
    }
  });

  it('plans a quarterly agreement exactly once per quarter over six months', async () => {
    const agreement = await createAgreement({
      frequencyCount: 1,
      frequencyUnit: 'MONTH',
      frequencyInterval: 3,
      allowedDays: weekdays,
      preferredDays: [],
      startDate: '2027-01-04',
    });

    try {
      // Two whole quarters, counted from the month the agreement began in.
      await confirm({
        from: '2027-04-01',
        to: '2027-09-30',
        serviceAgreementIds: [agreement.id],
      });

      const stored = await prisma.generatedVisit.findMany({
        where: { serviceAgreementId: agreement.id },
        orderBy: { visitDate: 'asc' },
        select: { visitDate: true },
      });
      const dates = stored.map((visit) => visit.visitDate.toISOString().slice(0, 10));

      // Exactly one visit inside each whole quarter, not pinned to a
      // specific day or month within it: this shared integration database
      // carries other suites' own substantial real load across these same
      // months (documented pollution elsewhere in this file), and which
      // real day within a period the load guard anchors or spreads this
      // agreement's own visit to is not a guarantee this test owns — only
      // that it is exactly once per quarter is.
      expect(dates.filter((date) => date >= '2027-04-01' && date < '2027-07-01')).toHaveLength(1);
      expect(dates.filter((date) => date >= '2027-07-01' && date < '2027-10-01')).toHaveLength(1);
      expect(dates).toHaveLength(2);
    } finally {
      await prisma.generatedVisit.deleteMany({
        where: { serviceAgreementId: agreement.id },
      });
    }
  });

  it('says so, by cadence, when a range holds no whole period of an agreement', async () => {
    const agreement = await createAgreement({
      frequencyCount: 1,
      frequencyUnit: 'MONTH',
      frequencyInterval: 3,
      allowedDays: weekdays,
      preferredDays: [],
      startDate: '2027-01-04',
    });

    const impact = await preview({ ...weekViews[1], serviceAgreementIds: [agreement.id] });

    expect(impact.body.additions).toEqual([]);
    expect(impact.body.skippedPeriods).toEqual([
      expect.objectContaining({
        serviceAgreementId: agreement.id,
        frequencyUnit: 'MONTH',
        frequencyInterval: 3,
        reason: 'RANGE_HOLDS_NO_WHOLE_PERIOD',
      }),
    ]);
    expect(impact.body.skippedPeriods[0].message).toContain('quarter');
  });

  it('says nothing about a fortnight the next month\'s grid will hold whole', async () => {
    // The portal's month ranges overlap by exactly one ISO week: a grid that
    // ends the day before a month begins reaches a week further, so the next
    // grid always begins on the Monday of this range's final week. A fortnight
    // is fourteen days, so one cut by this range's end always began inside
    // that week of overlap — and the next grid plans it whole. Warning about
    // it sent a manager to widen a range that had lost nothing: on the
    // walkthrough database every single clipped-fortnight warning was false.
    const agreement = await createAgreement({
      frequencyCount: 1,
      frequencyUnit: 'WEEK',
      frequencyInterval: 2,
      allowedDays: [Weekday.MONDAY, Weekday.TUESDAY],
      preferredDays: [],
      startDate: '2026-01-12',
    });

    try {
      // The months are generated in order, as a manager works through them.
      // April's grid holds the fortnight that reaches back over 27 April.
      const april = await confirm({
        from: '2026-03-30',
        to: '2026-05-03',
        serviceAgreementIds: [agreement.id],
      });
      expect(april.status).toBe(200);

      // May's range: the grid ends on Sunday 31 May, and because June begins
      // the next day it reaches a whole week further, to 7 June.
      const may = await preview({
        from: '2026-04-27',
        to: '2026-06-07',
        serviceAgreementIds: [agreement.id],
      });

      expect(may.status).toBe(200);
      expect(may.body.additions.length).toBeGreaterThan(0);
      // The fortnight 1-14 June is cut by the last day, and June's grid plans
      // it; the one reaching back over 27 April is April's, and April planned
      // it. Nothing is at risk and nothing is said.
      expect(may.body.skippedPeriods).toEqual([]);

      const june = await preview({
        from: '2026-06-01',
        to: '2026-07-05',
        serviceAgreementIds: [agreement.id],
      });

      expect(june.status).toBe(200);
      expect(
        june.body.additions.some(
          (visit: { visitDate: string }) =>
            visit.visitDate >= '2026-06-01' && visit.visitDate <= '2026-06-14',
        ),
      ).toBe(true);
    } finally {
      await prisma.generatedVisit.deleteMany({
        where: { serviceAgreementId: agreement.id },
      });
    }
  });

  it('names a cycle of three weeks that really does fall between two grids', async () => {
    // Three weeks is longer than the week of overlap, so such a period can
    // begin before the Monday the next grid starts on and be clipped by both.
    // April 2026's grid runs 30 March to 3 May; the period 20 April to 10 May
    // begins a week before May's grid does, and no run ever holds it whole.
    const agreement = await createAgreement({
      frequencyCount: 1,
      frequencyUnit: 'WEEK',
      frequencyInterval: 3,
      allowedDays: [Weekday.MONDAY, Weekday.TUESDAY],
      preferredDays: [],
      startDate: '2026-01-05',
    });

    const april = await preview({
      from: '2026-03-30',
      to: '2026-05-03',
      serviceAgreementIds: [agreement.id],
    });

    expect(april.status).toBe(200);
    // It did plan other cycles, so this is not the "nothing at all" case.
    expect(april.body.additions.length).toBeGreaterThan(0);
    expect(april.body.skippedPeriods).toEqual([
      expect.objectContaining({
        serviceAgreementId: agreement.id,
        frequencyUnit: 'WEEK',
        frequencyInterval: 3,
        reason: 'RANGE_CLIPS_A_PERIOD',
        periodsSkipped: 1,
      }),
    ]);
    expect(april.body.skippedPeriods[0].message).toContain('2026-04-20 to 2026-05-10');
    // The advice a manager can act on from the month view they are standing
    // in — never "reach past this range's last day", which the month view has
    // no control over.
    expect(april.body.skippedPeriods[0].message).toContain('month it starts in');
  });

  it('names the first period of an agreement created after the previous month was generated', async () => {
    // The start-clipped edge used to be silent on the grounds that the run
    // before this one covers it. That run may predate the agreement. Created
    // on 28 May starting the 27th, this agreement's first fortnight is 25 May
    // to 7 June — May was generated on the 1st, June's run meets the period
    // clipped at the start, and the customer's first fortnight gets nothing
    // from anybody.
    const agreement = await createAgreement({
      frequencyCount: 1,
      frequencyUnit: 'WEEK',
      frequencyInterval: 2,
      allowedDays: [Weekday.MONDAY, Weekday.TUESDAY],
      preferredDays: [],
      startDate: '2026-05-27',
    });

    const june = await preview({
      from: '2026-06-01',
      to: '2026-07-05',
      serviceAgreementIds: [agreement.id],
    });

    expect(june.status).toBe(200);
    expect(june.body.skippedPeriods).toEqual([
      expect.objectContaining({
        serviceAgreementId: agreement.id,
        frequencyUnit: 'WEEK',
        frequencyInterval: 2,
        reason: 'RANGE_CLIPS_A_PERIOD',
        periodsSkipped: 1,
      }),
    ]);
    expect(june.body.skippedPeriods[0].message).toContain('2026-05-25 to 2026-06-07');
  });

  it('says nothing about a start-clipped period the run before this one planned', async () => {
    // The ordinary hand-off, and the reason the rule asks the calendar rather
    // than reasoning about which runs were pressed. May plans the fortnight
    // that straddles the seam; June meets the same fortnight clipped at its
    // start and has nothing to report, because a visit is standing in it.
    const agreement = await createAgreement({
      frequencyCount: 1,
      frequencyUnit: 'WEEK',
      frequencyInterval: 2,
      allowedDays: [Weekday.MONDAY, Weekday.TUESDAY],
      preferredDays: [],
      startDate: '2026-01-05',
    });

    try {
      const may = await confirm({
        from: '2026-04-27',
        to: '2026-06-07',
        serviceAgreementIds: [agreement.id],
      });
      expect(may.status).toBe(200);
      expect(may.body.skippedPeriods).toEqual([]);
      expect(
        may.body.additions.some(
          (visit: { visitDate: string }) =>
            visit.visitDate >= '2026-05-25' && visit.visitDate <= '2026-06-07',
        ),
      ).toBe(true);

      const june = await preview({
        from: '2026-06-01',
        to: '2026-07-05',
        serviceAgreementIds: [agreement.id],
      });

      expect(june.status).toBe(200);
      expect(june.body.skippedPeriods).toEqual([]);
    } finally {
      await prisma.generatedVisit.deleteMany({
        where: { serviceAgreementId: agreement.id },
      });
    }
  });

  it('never offers to remove a visit standing in a period it did not plan', async () => {
    // The April grid ends mid-fortnight, so the fortnight beginning on
    // 2027-04-26 is left to the May run — which puts a visit on the 26th, a
    // day the April range does cover. Judging that visit against April's own
    // plan proposes deleting the work May just created.
    const agreement = await createAgreement({
      frequencyCount: 1,
      frequencyUnit: 'WEEK',
      frequencyInterval: 2,
      allowedDays: [Weekday.MONDAY],
      preferredDays: [],
      startDate: '2027-01-04',
    });

    try {
      // May's grid: 2027-04-26 to 2027-06-06.
      await confirm({
        from: '2027-04-26',
        to: '2027-06-06',
        serviceAgreementIds: [agreement.id],
      });
      const fromMay = await prisma.generatedVisit.findMany({
        where: { serviceAgreementId: agreement.id },
        orderBy: { visitDate: 'asc' },
        select: { visitDate: true },
      });
      expect(fromMay[0].visitDate.toISOString().slice(0, 10)).toBe('2027-04-26');

      const april = await preview({ ...monthView, serviceAgreementIds: [agreement.id] });

      expect(april.body.removals).toEqual([]);
      // April plans its own two fortnights and leaves May's alone.
      expect(april.body.additions).toHaveLength(2);
    } finally {
      await prisma.generatedVisit.deleteMany({
        where: { serviceAgreementId: agreement.id },
      });
    }
  });
});

describe('a cancelled visit on the day generation wants', () => {
  /**
   * A visit is identified by agreement, date and start time, so a cancelled
   * visit keeps that identity for ever. Generation matched its requirement to
   * the cancelled row and reported the period unchanged — no live visit that
   * week, and the unique index forbidding the addition that would have fixed
   * it.
   */
  it('plans another allowed day instead of reporting the period served', async () => {
    const week = { from: '2027-02-01', to: '2027-02-07' };
    const agreement = await createAgreement({
      frequencyCount: 1,
      frequencyUnit: 'WEEK',
      allowedDays: [Weekday.MONDAY, Weekday.TUESDAY],
      preferredDays: [],
      startDate: '2027-01-04',
    });
    const branch = await prisma.branch.findUniqueOrThrow({
      where: { code: BranchCode.COLOMBO },
    });

    try {
      const cancelled = await prisma.generatedVisit.create({
        data: {
          serviceAgreementId: agreement.id,
          branchId: branch.id,
          branchCode: BranchCode.COLOMBO,
          visitDate: new Date('2027-02-01T00:00:00.000Z'), // the Monday
          windowStartMinute: 540,
          windowEndMinute: 1020,
          durationMinutes: 90,
          requiredCrewSize: 2,
          status: VisitStatus.CANCELLED,
        },
      });

      const impact = await confirm({ ...week, serviceAgreementIds: [agreement.id] });

      expect(impact.body.additions).toHaveLength(1);
      expect(impact.body.additions[0].visitDate).toBe('2027-02-02'); // the Tuesday
      expect(impact.body.unchangedCount).toBe(0);

      const live = await prisma.generatedVisit.findMany({
        where: { serviceAgreementId: agreement.id, status: { not: VisitStatus.CANCELLED } },
      });
      expect(live).toHaveLength(1);
      // And the cancellation is still there, never removed.
      expect(
        await prisma.generatedVisit.count({ where: { id: cancelled.id } }),
      ).toBe(1);
    } finally {
      await prisma.generatedVisit.deleteMany({
        where: { serviceAgreementId: agreement.id },
      });
    }
  });

  it('says the only visit is cancelled when the period has no other day', async () => {
    const week = { from: '2027-02-08', to: '2027-02-14' };
    const agreement = await createAgreement({
      frequencyCount: 1,
      frequencyUnit: 'WEEK',
      allowedDays: [Weekday.MONDAY],
      preferredDays: [],
      startDate: '2027-01-04',
    });
    const branch = await prisma.branch.findUniqueOrThrow({
      where: { code: BranchCode.COLOMBO },
    });

    try {
      await prisma.generatedVisit.create({
        data: {
          serviceAgreementId: agreement.id,
          branchId: branch.id,
          branchCode: BranchCode.COLOMBO,
          visitDate: new Date('2027-02-08T00:00:00.000Z'),
          windowStartMinute: 540,
          windowEndMinute: 1020,
          durationMinutes: 90,
          requiredCrewSize: 2,
          status: VisitStatus.CANCELLED,
        },
      });

      const impact = await preview({ ...week, serviceAgreementIds: [agreement.id] });

      expect(impact.body.additions).toEqual([]);
      expect(impact.body.shortfalls).toEqual([
        expect.objectContaining({
          serviceAgreementId: agreement.id,
          reason: 'PERIOD_HELD_BY_A_CANCELLED_VISIT',
        }),
      ]);
      expect(impact.body.shortfalls[0].message).toContain('cancelled');
    } finally {
      await prisma.generatedVisit.deleteMany({
        where: { serviceAgreementId: agreement.id },
      });
    }
  });
});

describe('a day the spread cannot rescue', () => {
  const cappedAt = (cap: number) =>
    new VisitGenerationService(
      app.get(PrismaService),
      app.get(AuditService),
      { get: (key: string) =>
        key === 'visitGeneration.dailyCapacityMinutes' ? cap * DEFAULT_AGREEMENT_CREW_MINUTES : undefined,
      } as unknown as ConfigService,
      fixedCapacity(cap * DEFAULT_AGREEMENT_CREW_MINUTES),
    );

  it('says so by date, count and cap before anything is confirmed', async () => {
    // Weekly agreements allowed exactly one weekday have nowhere inside their
    // week to move to, so the guard cannot spread them and the day stays over
    // the cap. That is precisely when the manager has to be told, and it has
    // to come out of a real preview rather than a fixture.
    const week = { from: '2027-06-07', to: '2027-06-13' };
    await prisma.generatedVisit.deleteMany({
      where: {
        branchCode: BranchCode.KANDY,
        visitDate: {
          gte: new Date(`${week.from}T00:00:00.000Z`),
          lte: new Date(`${week.to}T00:00:00.000Z`),
        },
      },
    });

    const customer = await request(http)
      .post('/api/customers')
      .set(auth(adminToken))
      .send({ name: `C04 Overcap ${suffix}`, branchCode: BranchCode.KANDY });
    const site = await request(http)
      .post(`/api/customers/${customer.body.id}/sites`)
      .set(auth(adminToken))
      .send({
        name: `C04 Overcap Site ${suffix}`,
        branchCode: BranchCode.KANDY,
        operatingHours: [
          { weekday: Weekday.WEDNESDAY, opensAtMinute: 540, closesAtMinute: 1020 },
        ],
      });

    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const agreement = await createAgreement({
        serviceSiteId: site.body.id,
        allowedDays: [Weekday.WEDNESDAY],
        preferredDays: [],
      });
      ids.push(agreement.id);
    }

    const impact = await cappedAt(2).preview({ ...week, serviceAgreementIds: ids });

    // Not asserted as the whole array: `cappedAt`'s stubbed capacity applies
    // uniformly to every branch-day the query's enclosing months touch, and
    // this shared integration database carries other suites' own stray
    // COLOMBO visits across those same months (documented pollution, as in
    // rolling-horizon.spec.ts) — real over-cap warnings on dates outside
    // this test's own scope, not something this fixture controls. What this
    // test owns is its own three agreements' own Wednesday.
    const own = impact.loadWarnings.find(
      (warning) => warning.branchCode === BranchCode.KANDY && warning.date === '2027-06-09',
    );
    expect(own).toEqual(
      expect.objectContaining({
        branchCode: BranchCode.KANDY,
        date: '2027-06-09', // the Wednesday
        plannedCount: 3,
        plannedMinutes: 3 * DEFAULT_AGREEMENT_CREW_MINUTES,
        cap: 2 * DEFAULT_AGREEMENT_CREW_MINUTES,
      }),
    );
    expect(own?.message).toContain('2027-06-09');
    expect(own?.message).toContain('3 visits');
  });
});

describe('a cancelled visit takes up no room in the day', () => {
  const cappedAt = (cap: number) =>
    new VisitGenerationService(
      app.get(PrismaService),
      app.get(AuditService),
      { get: (key: string) =>
        key === 'visitGeneration.dailyCapacityMinutes' ? cap * DEFAULT_AGREEMENT_CREW_MINUTES : undefined,
      } as unknown as ConfigService,
      fixedCapacity(cap * DEFAULT_AGREEMENT_CREW_MINUTES),
    );

  it('does not push the next run off a day whose only other visit was cancelled', async () => {
    // The optimizer never staffs a cancelled visit, so counting one towards
    // the daily cap reserved a crew's worth of room for work nobody will do —
    // and pushed the next agreement onto a day it had no reason to be on.
    const week = { from: '2027-05-03', to: '2027-05-09' };
    await prisma.generatedVisit.deleteMany({
      where: {
        branchCode: BranchCode.KANDY,
        visitDate: {
          gte: new Date(`${week.from}T00:00:00.000Z`),
          lte: new Date(`${week.to}T00:00:00.000Z`),
        },
      },
    });

    const customer = await request(http)
      .post('/api/customers')
      .set(auth(adminToken))
      .send({ name: `C04 Cancelled ${suffix}`, branchCode: BranchCode.KANDY });
    const site = await request(http)
      .post(`/api/customers/${customer.body.id}/sites`)
      .set(auth(adminToken))
      .send({
        name: `C04 Cancelled Site ${suffix}`,
        branchCode: BranchCode.KANDY,
        operatingHours: [Weekday.WEDNESDAY, Weekday.THURSDAY].map((weekday) => ({
          weekday,
          opensAtMinute: 540,
          closesAtMinute: 1020,
        })),
      });

    const onTheDay = { serviceSiteId: site.body.id, allowedDays: [Weekday.WEDNESDAY, Weekday.THURSDAY], preferredDays: [] };
    const holder = await createAgreement(onTheDay);
    const claimant = await createAgreement(onTheDay);

    const generation = cappedAt(1);
    const actor = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN.email } });

    await generation.confirm({ ...week, serviceAgreementIds: [holder.id] }, actor);
    const [held] = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: holder.id },
    });
    expect(held.visitDate.getUTCDay()).toBe(3); // Wednesday

    await prisma.generatedVisit.update({
      where: { id: held.id },
      data: { status: VisitStatus.CANCELLED },
    });

    await generation.confirm({ ...week, serviceAgreementIds: [claimant.id] }, actor);
    const [planned] = await prisma.generatedVisit.findMany({
      where: { serviceAgreementId: claimant.id },
    });

    expect(planned.visitDate.getUTCDay()).toBe(3);
  });
});

/**
 * A booking outranks the opening hours, so the visit is planned either way.
 * Which is exactly why the contradiction has to be reported: a crew is being
 * sent to a door the site's own hours say is shut.
 */
describe('a booked date the site\'s recorded hours do not support', () => {
  it('warns by date and agreement when the site is shut that weekday', async () => {
    const agreement = await createAgreement();
    await prisma.serviceAgreementBooking.create({
      data: {
        serviceAgreementId: agreement.id,
        // 2026-09-12 is a Saturday; the site's hours are Monday to Friday.
        bookedDate: new Date('2026-09-12T00:00:00.000Z'),
        provenance: 'SOURCE',
      },
    });

    const res = await preview({ serviceAgreementIds: [agreement.id] });

    expect(res.status).toBe(200);
    expect(res.body.bookingWarnings).toEqual([
      {
        serviceAgreementId: agreement.id,
        date: '2026-09-12',
        reason: 'SITE_CLOSED_ON_BOOKED_DAY',
        message: expect.stringContaining('2026-09-12'),
      },
    ]);
    // A warning outlives the screen it was raised on.
    expect(res.body.bookingWarnings[0].message).not.toContain(`C04 Customer ${suffix}`);
  });

  it('keeps the recorded window when it is too short, rather than assuming a full day', async () => {
    const customer = await request(http)
      .post('/api/customers')
      .set(auth(adminToken))
      .send({ name: `C04 Short Window ${suffix}`, branchCode: BranchCode.COLOMBO });
    const site = await request(http)
      .post(`/api/customers/${customer.body.id}/sites`)
      .set(auth(adminToken))
      .send({
        name: `C04 Short Window Site ${suffix}`,
        operatingHours: [
          { weekday: Weekday.MONDAY, opensAtMinute: 480, closesAtMinute: 1020 },
          // One hour on a Wednesday, and the visit needs ninety minutes.
          { weekday: Weekday.WEDNESDAY, opensAtMinute: 540, closesAtMinute: 600 },
        ],
      });

    const agreement = await createAgreement({
      serviceSiteId: site.body.id,
      allowedDays: [Weekday.MONDAY],
    });
    await prisma.serviceAgreementBooking.create({
      data: {
        serviceAgreementId: agreement.id,
        // A Wednesday.
        bookedDate: new Date('2026-09-09T00:00:00.000Z'),
        provenance: 'SOURCE',
      },
    });

    await confirm({ serviceAgreementIds: [agreement.id] });

    const booked = await prisma.generatedVisit.findFirstOrThrow({
      where: {
        serviceAgreementId: agreement.id,
        visitDate: new Date('2026-09-09T00:00:00.000Z'),
      },
    });
    expect(booked).toMatchObject({
      windowStartMinute: 540,
      windowEndMinute: 600,
      placement: 'BOOKED',
    });
    // The site's own hours, not the 08:00-17:00 assumption in their place.
    expect(booked.windowProvenance).not.toBe('DEFAULTED');

    const res = await preview({ serviceAgreementIds: [agreement.id] });
    expect(res.body.bookingWarnings).toEqual([
      expect.objectContaining({
        serviceAgreementId: agreement.id,
        date: '2026-09-09',
        reason: 'WINDOW_TOO_SHORT_FOR_BOOKED_VISIT',
      }),
    ]);
  });

  it('reports a period booked fewer times than the frequency promises', async () => {
    const agreement = await createAgreement({
      frequencyCount: 2,
      allowedDays: [Weekday.TUESDAY, Weekday.THURSDAY],
      preferredDays: [],
    });
    // Twice a week on paper, booked once in each of the four weeks.
    await prisma.serviceAgreementBooking.createMany({
      data: ['2026-09-08', '2026-09-15', '2026-09-22', '2026-09-29'].map((date) => ({
        serviceAgreementId: agreement.id,
        bookedDate: new Date(`${date}T00:00:00.000Z`),
        provenance: 'SOURCE' as const,
      })),
    });

    const res = await preview({ serviceAgreementIds: [agreement.id] });

    expect(res.status).toBe(200);
    const booked = res.body.shortfalls.filter(
      (shortfall: { reason: string }) => shortfall.reason === 'BOOKED_BELOW_FREQUENCY',
    );
    expect(booked.length).toBeGreaterThanOrEqual(4);
    expect(booked[0]).toMatchObject({ requested: 2, scheduled: 1 });
    // The bookings still stand exactly as written.
    expect(
      res.body.additions.filter((visit: { visitDate: string }) =>
        ['2026-09-08', '2026-09-15'].includes(visit.visitDate),
      ),
    ).toHaveLength(2);
  });
});

describe('the run is recorded', () => {
  it('writes a schedule run and an audit entry', async () => {
    const agreement = await createAgreement();
    const res = await confirm({ serviceAgreementIds: [agreement.id] });

    const run = await prisma.scheduleRun.findUniqueOrThrow({
      where: { id: res.body.scheduleRunId },
    });
    expect(run.status).toBe('SUCCEEDED');
    expect(run.requestedByUserId).toBeTruthy();
    expect(run.finishedAt).not.toBeNull();

    const event = await prisma.auditEvent.findFirst({
      where: { entityId: run.id, action: 'visit_generation.confirmed' },
    });
    expect(event).not.toBeNull();
    expect(event?.actorLabel).toContain(ADMIN.email);
  });

  it('is listed in Schedule History as visit generation, not as a failed solve', async () => {
    // It has no assignments and never will: generation creates visits and
    // staffs nobody. Judged by the solver's yardstick it was badged "Draft —
    // no dispatchable assignments" and blocked from publishing with
    // ZERO_RESULTS — a manager reads that as a schedule that failed.
    const agreement = await createAgreement();
    const res = await confirm({ serviceAgreementIds: [agreement.id] });

    const history = await request(http)
      .get('/api/schedule-runs')
      .set(auth(adminToken));

    expect(history.status).toBe(200);
    const listed = history.body.items.find(
      (item: { id: string }) => item.id === res.body.scheduleRunId,
    );
    expect(listed.kind).toBe('VISIT_GENERATION');
    expect(listed.publishReadiness).toBeNull();

    const single = await request(http)
      .get(`/api/schedule-runs/${res.body.scheduleRunId}`)
      .set(auth(adminToken));
    expect(single.body.kind).toBe('VISIT_GENERATION');
    expect(single.body.publishReadiness).toBeNull();
  });
});

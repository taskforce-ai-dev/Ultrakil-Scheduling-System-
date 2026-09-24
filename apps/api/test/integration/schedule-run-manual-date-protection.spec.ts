import { randomUUID } from 'node:crypto';

import {
  BranchCode,
  DayRuleKind,
  FrequencyUnit,
  PrismaClient,
  ScheduleRunStatus,
  Weekday,
} from '@prisma/client';

import { AuditService } from '../../src/audit/audit.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { EligibilityService } from '../../src/scheduling/eligibility/eligibility.service';
import { ScheduleRunService } from '../../src/scheduling/optimizer/schedule-run.service';
import { SchedulerClient, SolveRequest, SolveResponse } from '../../src/scheduling/optimizer/scheduler.client';
import { BranchDayCapacityService } from '../../src/scheduling/visit-generation/branch-day-capacity.service';

const prisma = new PrismaClient();
const suffix = randomUUID().slice(0, 8);
const originalDate = new Date('2027-03-03T00:00:00.000Z');
const nextDate = new Date('2027-03-04T00:00:00.000Z');
let branchId: string;
let customerId: string;
let siteId: string;
let jobTypeId: string;
let agreementId: string;
let createdRunIds: string[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function twoVisits() {
  const [other, target] = await Promise.all([
    prisma.generatedVisit.create({
      data: {
        serviceAgreementId: agreementId,
        branchId,
        branchCode: BranchCode.COLOMBO,
        visitDate: originalDate,
        windowStartMinute: 540,
        windowEndMinute: 720,
        durationMinutes: 60,
        requiredCrewSize: 1,
      },
    }),
    prisma.generatedVisit.create({
      data: {
        serviceAgreementId: agreementId,
        branchId,
        branchCode: BranchCode.COLOMBO,
        visitDate: originalDate,
        windowStartMinute: 660,
        windowEndMinute: 840,
        durationMinutes: 60,
        requiredCrewSize: 1,
      },
    }),
  ]);
  const run = await prisma.scheduleRun.create({
    data: {
      status: ScheduleRunStatus.QUEUED,
      branchCode: BranchCode.COLOMBO,
      rangeStart: originalDate,
      rangeEnd: nextDate,
    },
  });
  createdRunIds.push(run.id);
  return { other, target, run };
}

function response(runId: string, otherId: string, targetId: string): SolveResponse {
  return {
    run_id: runId,
    status: 'OPTIMAL',
    solve_seconds: 0,
    objective_value: 0,
    visits_considered: 2,
    assignments: [
      {
        visit_id: otherId,
        employee_ids: [],
        vehicles: [],
        start_minute: 540,
        scheduled_date: '2027-03-03',
      },
      {
        visit_id: targetId,
        employee_ids: [],
        vehicles: [],
        start_minute: 660,
        scheduled_date: '2027-03-04',
      },
    ],
    unassigned: [],
  };
}

function service(solve: (request: SolveRequest) => Promise<SolveResponse>) {
  const eligibility = { evaluate: jest.fn(() => {
    throw new Error('Protected move must be rejected before eligibility or any write');
  }) };
  const runs = new ScheduleRunService(
    prisma as unknown as PrismaService,
    { solve } as unknown as SchedulerClient,
    eligibility as unknown as EligibilityService,
    {} as AuditService,
    {} as BranchDayCapacityService,
  );
  return { runs, eligibility };
}

async function expectNoScheduleWrites(otherId: string, targetId: string, runId: string) {
  const [other, target, assignments, reasons, run] = await Promise.all([
    prisma.generatedVisit.findUniqueOrThrow({ where: { id: otherId } }),
    prisma.generatedVisit.findUniqueOrThrow({ where: { id: targetId } }),
    prisma.assignment.count({ where: { generatedVisitId: { in: [otherId, targetId] } } }),
    prisma.visitUnassignedReason.count({ where: { generatedVisitId: { in: [otherId, targetId] } } }),
    prisma.scheduleRun.findUniqueOrThrow({ where: { id: runId } }),
  ]);
  expect(other.visitDate).toEqual(originalDate);
  expect(target.visitDate).toEqual(originalDate);
  expect(other.status).toBe('PENDING');
  expect(target.status).toBe('PENDING');
  expect(assignments).toBe(0);
  expect(reasons).toBe(0);
  expect(run).toMatchObject({
    status: ScheduleRunStatus.FAILED,
    errorCode: 'RESOURCE_CONFLICT',
    visitsScheduled: 0,
    visitsUnassigned: 0,
  });
}

beforeAll(async () => {
  await prisma.$connect();
  const branch = await prisma.branch.upsert({
    where: { code: BranchCode.COLOMBO },
    create: { code: BranchCode.COLOMBO, name: 'Colombo' },
    update: {},
  });
  branchId = branch.id;
  const customer = await prisma.customer.create({
    data: { name: `Manual Date Test ${suffix}`, branchId, branchCode: BranchCode.COLOMBO },
  });
  customerId = customer.id;
  const site = await prisma.serviceSite.create({
    data: {
      customerId,
      name: `Manual Date Site ${suffix}`,
      branchId,
      branchCode: BranchCode.COLOMBO,
      operatingHours: { create: [Weekday.WEDNESDAY, Weekday.THURSDAY].map((weekday) => ({
        weekday,
        opensAtMinute: 480,
        closesAtMinute: 1020,
      })) },
    },
  });
  siteId = site.id;
  const jobType = await prisma.jobType.create({
    data: { code: `DATE_LOCK_${suffix}`, name: 'Date lock test' },
  });
  jobTypeId = jobType.id;
  const agreement = await prisma.serviceAgreement.create({
    data: {
      customerId,
      serviceSiteId: siteId,
      jobTypeId,
      branchId,
      branchCode: BranchCode.COLOMBO,
      frequencyCount: 1,
      frequencyUnit: FrequencyUnit.WEEK,
      crewSize: 1,
      durationMinutes: 60,
      startDate: originalDate,
      dayRules: { create: [Weekday.WEDNESDAY, Weekday.THURSDAY].map((weekday) => ({
        weekday,
        kind: DayRuleKind.ALLOWED,
      })) },
    },
  });
  agreementId = agreement.id;
});

afterEach(async () => {
  await prisma.generatedVisit.deleteMany({ where: { serviceAgreementId: agreementId } });
  await prisma.scheduleRun.deleteMany({ where: { id: { in: createdRunIds } } });
  createdRunIds = [];
});

afterAll(async () => {
  if (agreementId) await prisma.serviceAgreement.delete({ where: { id: agreementId } });
  if (siteId) await prisma.serviceSite.delete({ where: { id: siteId } });
  if (customerId) await prisma.customer.delete({ where: { id: customerId } });
  if (jobTypeId) await prisma.jobType.delete({ where: { id: jobTypeId } });
  await prisma.$disconnect();
});

describe('schedule-run protected visit dates (PostgreSQL)', () => {
  it.each(['manual', 'visit-lock'] as const)(
    'pins the %s date and atomically rejects a malicious moved-date response',
    async (protection) => {
      const { other, target, run } = await twoVisits();
      await prisma.generatedVisit.update({
        where: { id: target.id },
        data: protection === 'manual'
          ? { isManuallyAdjusted: true }
          : { lockedAt: new Date() },
      });
      let request: SolveRequest | undefined;
      const { runs, eligibility } = service(async (received) => {
        request = received;
        return response(run.id, other.id, target.id);
      });

      await expect(runs.execute(run.id)).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
      const protectedSlots = request?.visits.find(
        (visit) => visit.id === target.id,
      )?.candidate_slots;
      expect(protectedSlots?.length).toBeGreaterThan(0);
      expect(protectedSlots?.every((slot) => slot.date === '2027-03-03')).toBe(true);
      expect(request?.visits.find((visit) => visit.id === other.id)?.candidate_slots?.length)
        .toBeGreaterThan(0);
      expect(eligibility.evaluate).not.toHaveBeenCalled();
      await expectNoScheduleWrites(other.id, target.id, run.id);
    },
  );

  it.each(['manual', 'visit-lock'] as const)(
    'rejects a newly %s protected date despite an unchanged visit revision',
    async (protection) => {
      const { other, target, run } = await twoVisits();
      const started = deferred<void>();
      const release = deferred<void>();
      const { runs, eligibility } = service(async () => {
        started.resolve();
        await release.promise;
        return response(run.id, other.id, target.id);
      });
      const pending = runs.execute(run.id).then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await started.promise;
        await prisma.generatedVisit.update({
          where: { id: target.id },
          data: {
            ...(protection === 'manual'
              ? { isManuallyAdjusted: true }
              : { lockedAt: new Date() }),
            updatedAt: target.updatedAt,
          },
        });
        release.resolve();
        expect(await pending).toMatchObject({ code: 'RESOURCE_CONFLICT' });
        expect(eligibility.evaluate).not.toHaveBeenCalled();
        await expectNoScheduleWrites(other.id, target.id, run.id);
      } finally {
        release.resolve();
        await pending;
      }
    },
  );
});

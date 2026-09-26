/**
 * The replenishment state machine against a real PostgreSQL, including the
 * two races ULK-C13 names: two replenishers on the same branch-day, and a
 * day whose demand changes after it was resolved.
 *
 * The claim is the interesting part. It is a unique index and a single
 * `INSERT ... ON CONFLICT`, not a status read followed by a write, and the
 * only way to show that actually holds is to run two of them at once against
 * a real database — which is what `races the same day` does, on two
 * independent connections.
 *
 * Staffing is stubbed through the port rather than solved, so these tests
 * need no Python scheduler and no Redis: a failure here is about the state
 * machine, not about a dependency that did not start. The solver's own
 * behaviour is covered by the optimizer suites.
 */
import {
  AgreementStatus,
  AssignmentStatus,
  BranchCode,
  CrewRole,
  DayCoverageState,
  FrequencyUnit,
  PrismaClient,
  VisitStatus,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../../src/audit/audit.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  type DayStaffingPort,
  type StaffedDay,
  DayCoverageService,
} from '../../src/scheduling/day-coverage/day-coverage.service';
import { assertTestDatabaseUrl } from '../support/test-database';

assertTestDatabaseUrl(process.env.DATABASE_URL);

const prisma = new PrismaClient();
const asService = prisma as unknown as PrismaService;

const DAY = '2026-11-20';
const DAY_DATE = new Date(`${DAY}T00:00:00.000Z`);
const BRANCH = BranchCode.COLOMBO;
const tag = `c13w-${randomUUID().slice(0, 8)}`;

let branchId: string;
let jobTypeId: string;
let customerId: string;
let siteId: string;
let vehicleId: string;
let driverId: string;

/** A staffing port that returns whatever the test tells it to. */
class StubStaffing implements DayStaffingPort {
  staffed: StaffedDay = { scheduleRunId: '', assignments: [], succeeded: true };
  publishable = false;
  published: string[] = [];
  calls = 0;

  async staffDay(): Promise<StaffedDay> {
    this.calls += 1;
    return this.staffed;
  }

  async isPublishableWithoutManager(): Promise<boolean> {
    return this.publishable;
  }

  async publish(scheduleRunId: string): Promise<void> {
    this.published.push(scheduleRunId);
  }
}

let staffing: StubStaffing;
let service: DayCoverageService;

async function makeAgreement(): Promise<string> {
  const agreement = await prisma.serviceAgreement.create({
    data: {
      customerId,
      serviceSiteId: siteId,
      jobTypeId,
      branchId,
      branchCode: BRANCH,
      frequencyCount: 1,
      frequencyUnit: FrequencyUnit.MONTH,
      crewSize: 1,
      durationMinutes: 60,
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      status: AgreementStatus.ACTIVE,
    },
  });
  return agreement.id;
}

let windowSlot = 480;

async function makeVisit(serviceAgreementId: string): Promise<string> {
  // (serviceAgreementId, visitDate, windowStartMinute) is unique, so two
  // visits for one agreement on one day need different slots.
  windowSlot += 15;
  const visit = await prisma.generatedVisit.create({
    data: {
      serviceAgreementId,
      branchId,
      branchCode: BRANCH,
      visitDate: DAY_DATE,
      windowStartMinute: windowSlot,
      windowEndMinute: 1020,
      durationMinutes: 60,
      requiredCrewSize: 1,
      status: VisitStatus.PENDING,
    },
  });
  return visit.id;
}

async function makeRun(): Promise<string> {
  const run = await prisma.scheduleRun.create({
    data: { rangeStart: DAY_DATE, rangeEnd: DAY_DATE, branchCode: BRANCH },
  });
  return run.id;
}

/** A well-formed assignment for `visitId`: one vehicle, an authorised driver. */
function goodAssignment(visitId: string) {
  return {
    id: randomUUID(),
    generatedVisitId: visitId,
    crewEmployeeIds: [driverId],
    vehicleIds: [vehicleId],
  };
}

async function coverageRow() {
  return prisma.dayCoverage.findUnique({
    where: {
      branchCode_coverageDate: { branchCode: BRANCH, coverageDate: DAY_DATE },
    },
    include: { shortfalls: true },
  });
}

async function clearDay() {
  await prisma.dayCoverage.deleteMany({ where: { coverageDate: DAY_DATE } });
  await prisma.assignment.deleteMany({
    where: { generatedVisit: { visitDate: DAY_DATE } },
  });
  await prisma.generatedVisit.deleteMany({ where: { visitDate: DAY_DATE } });
  await prisma.serviceAgreement.deleteMany({ where: { customerId } });
}

beforeAll(async () => {
  const branch = await prisma.branch.upsert({
    where: { code: BRANCH },
    create: { code: BRANCH, name: 'Colombo' },
    update: {},
  });
  branchId = branch.id;

  jobTypeId = (
    await prisma.jobType.create({
      data: { code: `${tag}-JOB`, name: 'Worker fixture job' },
    })
  ).id;
  customerId = (
    await prisma.customer.create({
      data: { name: `${tag} customer`, branchId, branchCode: BRANCH },
    })
  ).id;
  siteId = (
    await prisma.serviceSite.create({
      data: { customerId, name: `${tag} site`, branchId, branchCode: BRANCH },
    })
  ).id;
  driverId = (
    await prisma.employee.create({
      data: {
        fullName: `${tag} driver`,
        sourceKey: `${tag}-driver`,
        gradeLabel: 'TECHNICIAN',
        branchId,
        branchCode: BRANCH,
      },
    })
  ).id;
  vehicleId = (
    await prisma.vehicle.create({
      data: {
        code: `${tag}-VAN`,
        label: `${tag} van`,
        seatCapacity: 4,
        branchId,
      },
    })
  ).id;
  await prisma.vehicleAuthorization.create({
    data: { employeeId: driverId, vehicleId },
  });
});

beforeEach(async () => {
  await clearDay();
  windowSlot = 480;
  staffing = new StubStaffing();
  service = new DayCoverageService(
    asService,
    new AuditService(asService),
    staffing,
  );
});

afterAll(async () => {
  await clearDay();
  await prisma.vehicleAuthorization.deleteMany({ where: { vehicleId } });
  await prisma.vehicle.deleteMany({ where: { id: vehicleId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.employee.deleteMany({ where: { sourceKey: { startsWith: tag } } });
  await prisma.jobType.deleteMany({ where: { id: jobTypeId } });
  await prisma.$disconnect();
});

describe('prepareDay', () => {
  it('records NOTHING_DUE for a quiet day without calling the solver', async () => {
    const outcome = await service.prepareDay(BRANCH, DAY);

    expect(outcome.state).toBe(DayCoverageState.NOTHING_DUE);
    expect(staffing.calls).toBe(0);
    const row = await coverageRow();
    expect(row?.state).toBe(DayCoverageState.NOTHING_DUE);
    // A resolved day always carries the fingerprints it was resolved against,
    // or reconciliation has nothing to compare and can never call it stale.
    expect(row?.demandDigest).toEqual(expect.any(String));
    expect(row?.supplyDigest).toEqual(expect.any(String));
  });

  // The approved policy on today's data: everything is prepared, nothing is
  // published, because no provenance is confirmed.
  it('prepares and waits for a manager when the gate is not READY', async () => {
    const visitId = await makeVisit(await makeAgreement());
    staffing.staffed = {
      scheduleRunId: await makeRun(),
      assignments: [goodAssignment(visitId)],
      succeeded: true,
    };
    staffing.publishable = false;

    const outcome = await service.prepareDay(BRANCH, DAY);

    expect(outcome.state).toBe(DayCoverageState.PREPARED_AWAITING_MANAGER);
    expect(staffing.published).toEqual([]);
    expect(outcome.visitsDue).toBe(1);
    expect(outcome.visitsStaffed).toBe(1);
  });

  it('publishes only when the existing gate says it may', async () => {
    const visitId = await makeVisit(await makeAgreement());
    const runId = await makeRun();
    staffing.staffed = {
      scheduleRunId: runId,
      assignments: [goodAssignment(visitId)],
      succeeded: true,
    };
    staffing.publishable = true;

    const outcome = await service.prepareDay(BRANCH, DAY);

    expect(outcome.state).toBe(DayCoverageState.COVERED_PUBLISHED);
    expect(staffing.published).toEqual([runId]);
  });

  // All-or-nothing, end to end: one unsatisfiable visit and the whole day is
  // withheld, including the visit that was fine.
  it('withholds the entire day and records reasons when one visit falls short', async () => {
    const agreementId = await makeAgreement();
    const good = await makeVisit(agreementId);
    const bad = await makeVisit(agreementId);
    staffing.staffed = {
      scheduleRunId: await makeRun(),
      assignments: [
        goodAssignment(good),
        { ...goodAssignment(bad), vehicleIds: [] },
      ],
      succeeded: true,
    };
    staffing.publishable = true; // even so, nothing may publish

    const outcome = await service.prepareDay(BRANCH, DAY);

    expect(outcome.state).toBe(DayCoverageState.SHORTFALL);
    expect(staffing.published).toEqual([]);

    const row = await coverageRow();
    expect(row?.shortfalls).toHaveLength(1);
    expect(row?.shortfalls[0]).toMatchObject({
      generatedVisitId: bad,
      reasonCode: 'NO_VEHICLE',
    });
  });

  it('reports a due visit the run never staffed', async () => {
    const agreementId = await makeAgreement();
    const staffedVisit = await makeVisit(agreementId);
    const ignored = await makeVisit(agreementId);
    staffing.staffed = {
      scheduleRunId: await makeRun(),
      assignments: [goodAssignment(staffedVisit)],
      succeeded: true,
    };

    const outcome = await service.prepareDay(BRANCH, DAY);

    expect(outcome.state).toBe(DayCoverageState.SHORTFALL);
    const row = await coverageRow();
    expect(row?.shortfalls).toEqual([
      expect.objectContaining({ generatedVisitId: ignored, reasonCode: 'NOT_STAFFED' }),
    ]);
  });

  it('records FAILED when the run itself did not finish', async () => {
    await makeVisit(await makeAgreement());
    staffing.staffed = {
      scheduleRunId: await makeRun(),
      assignments: [],
      succeeded: false,
    };

    const outcome = await service.prepareDay(BRANCH, DAY);

    expect(outcome.state).toBe(DayCoverageState.FAILED);
    expect(staffing.published).toEqual([]);
  });

  it('drops stale reasons when a day that fell short is prepared again', async () => {
    const agreementId = await makeAgreement();
    const visitId = await makeVisit(agreementId);
    staffing.staffed = {
      scheduleRunId: await makeRun(),
      assignments: [{ ...goodAssignment(visitId), vehicleIds: [] }],
      succeeded: true,
    };
    await service.prepareDay(BRANCH, DAY);
    expect((await coverageRow())?.shortfalls).toHaveLength(1);

    // Reconciliation is what makes a resolved day eligible again.
    await prisma.dayCoverage.updateMany({
      where: { coverageDate: DAY_DATE },
      data: { state: DayCoverageState.STALE },
    });
    staffing.staffed = {
      scheduleRunId: await makeRun(),
      assignments: [goodAssignment(visitId)],
      succeeded: true,
    };
    await service.prepareDay(BRANCH, DAY);

    const row = await coverageRow();
    expect(row?.state).toBe(DayCoverageState.PREPARED_AWAITING_MANAGER);
    expect(row?.shortfalls).toEqual([]);
  });
});

describe('the claim', () => {
  it('does not re-prepare a day it has already resolved', async () => {
    const visitId = await makeVisit(await makeAgreement());
    staffing.staffed = {
      scheduleRunId: await makeRun(),
      assignments: [goodAssignment(visitId)],
      succeeded: true,
    };

    const first = await service.prepareDay(BRANCH, DAY);
    const second = await service.prepareDay(BRANCH, DAY);

    expect(first.skipped).toBeUndefined();
    expect(first.state).toBe(DayCoverageState.PREPARED_AWAITING_MANAGER);
    expect(second.skipped).toBe('ALREADY_CLAIMED');
    // The day was solved once, not twice.
    expect(staffing.calls).toBe(1);
  });

  it('stands aside from a day another attempt is still working on', async () => {
    await prisma.dayCoverage.create({
      data: {
        branchCode: BRANCH,
        coverageDate: DAY_DATE,
        state: DayCoverageState.IN_PROGRESS,
        claimExpiresAt: new Date(Date.now() + 600_000),
      },
    });

    const outcome = await service.prepareDay(BRANCH, DAY);

    expect(outcome.skipped).toBe('ALREADY_CLAIMED');
    expect(staffing.calls).toBe(0);
  });

  it('re-prepares a day reconciliation marked STALE', async () => {
    const visitId = await makeVisit(await makeAgreement());
    staffing.staffed = {
      scheduleRunId: await makeRun(),
      assignments: [goodAssignment(visitId)],
      succeeded: true,
    };
    await service.prepareDay(BRANCH, DAY);
    await prisma.dayCoverage.updateMany({
      where: { coverageDate: DAY_DATE },
      data: { state: DayCoverageState.STALE },
    });

    const again = await service.prepareDay(BRANCH, DAY);

    expect(again.skipped).toBeUndefined();
    expect(again.state).toBe(DayCoverageState.PREPARED_AWAITING_MANAGER);
  });

  it('takes over a claim whose holder died', async () => {
    await prisma.dayCoverage.create({
      data: {
        branchCode: BRANCH,
        coverageDate: DAY_DATE,
        state: DayCoverageState.IN_PROGRESS,
        claimExpiresAt: new Date(Date.now() - 1000),
      },
    });

    const retry = await service.prepareDay(BRANCH, DAY);

    expect(retry.skipped).toBeUndefined();
    expect((await coverageRow())?.attempt).toBeGreaterThanOrEqual(1);
  });

  // The forced race. Two services on two independent connections, started
  // together, contending for the same branch-day.
  it('races the same day on two connections and lets exactly one through', async () => {
    const visitId = await makeVisit(await makeAgreement());

    const otherPrisma = new PrismaClient();
    const otherAsService = otherPrisma as unknown as PrismaService;
    const otherStaffing = new StubStaffing();
    const other = new DayCoverageService(
      otherAsService,
      new AuditService(otherAsService),
      otherStaffing,
    );

    staffing.staffed = {
      scheduleRunId: await makeRun(),
      assignments: [goodAssignment(visitId)],
      succeeded: true,
    };
    otherStaffing.staffed = {
      scheduleRunId: await makeRun(),
      assignments: [goodAssignment(visitId)],
      succeeded: true,
    };

    try {
      const [a, b] = await Promise.all([
        service.prepareDay(BRANCH, DAY),
        other.prepareDay(BRANCH, DAY),
      ]);

      const skipped = [a, b].filter((o) => o.skipped === 'ALREADY_CLAIMED');
      expect(skipped).toHaveLength(1);

      // And exactly one of them did the work.
      expect(staffing.calls + otherStaffing.calls).toBe(1);

      // One row, one outcome. The unique index is the mutual exclusion.
      const rows = await prisma.dayCoverage.findMany({
        where: { coverageDate: DAY_DATE },
      });
      expect(rows).toHaveLength(1);
    } finally {
      await otherPrisma.$disconnect();
    }
  });
});

describe('reconcile', () => {
  const now = new Date(`${DAY}T06:00:00.000Z`);

  async function resolveDay(): Promise<void> {
    const visitId = await makeVisit(await makeAgreement());
    staffing.staffed = {
      scheduleRunId: await makeRun(),
      assignments: [goodAssignment(visitId)],
      succeeded: true,
    };
    await service.prepareDay(BRANCH, DAY);
  }

  it('leaves an unchanged day alone', async () => {
    await resolveDay();

    await expect(service.reconcile({ now, zone: 'UTC' })).resolves.toEqual([]);
    expect((await coverageRow())?.state).toBe(
      DayCoverageState.PREPARED_AWAITING_MANAGER,
    );
  });

  // Correction 2, the case an id-only digest cannot see: demand arrives and
  // generation has not run, so there is no visit to notice.
  it('marks a day STALE when a new agreement appears with no visit yet', async () => {
    await resolveDay();
    await makeAgreement();

    const drifted = await service.reconcile({ now, zone: 'UTC' });

    expect(drifted).toEqual([
      expect.objectContaining({ coverageDate: DAY, drift: 'DEMAND_CHANGED' }),
    ]);
    expect((await coverageRow())?.state).toBe(DayCoverageState.STALE);
  });

  // The other case: the ids are identical, the work is not.
  it('marks a day STALE when a visit on it is edited in place', async () => {
    await resolveDay();
    await prisma.generatedVisit.updateMany({
      where: { visitDate: DAY_DATE },
      data: { durationMinutes: 120 },
    });

    const drifted = await service.reconcile({ now, zone: 'UTC' });

    expect(drifted).toEqual([
      expect.objectContaining({ drift: 'SUPPLY_CHANGED' }),
    ]);
  });

  it('marks a day STALE when an assignment on it changes status', async () => {
    await resolveDay();
    const visit = await prisma.generatedVisit.findFirstOrThrow({
      where: { visitDate: DAY_DATE },
    });
    const assignment = await prisma.assignment.create({
      data: {
        generatedVisitId: visit.id,
        branchId,
        branchCode: BRANCH,
        status: AssignmentStatus.DRAFT,
        plannedStart: new Date(`${DAY}T02:30:00.000Z`),
        plannedEnd: new Date(`${DAY}T03:30:00.000Z`),
        crewMembers: { create: [{ employeeId: driverId, role: CrewRole.TECHNICIAN }] },
      },
    });

    // The day was resolved before this assignment existed.
    const drifted = await service.reconcile({ now, zone: 'UTC' });
    expect(drifted).toEqual([expect.objectContaining({ drift: 'SUPPLY_CHANGED' })]);

    await prisma.assignment.delete({ where: { id: assignment.id } });
  });

  it('leaves an unfinished day alone rather than calling it stale', async () => {
    await prisma.dayCoverage.create({
      data: {
        branchCode: BRANCH,
        coverageDate: DAY_DATE,
        state: DayCoverageState.IN_PROGRESS,
        claimExpiresAt: new Date(Date.now() + 600_000),
      },
    });

    await expect(service.reconcile({ now, zone: 'UTC' })).resolves.toEqual([]);
    expect((await coverageRow())?.state).toBe(DayCoverageState.IN_PROGRESS);
  });
});

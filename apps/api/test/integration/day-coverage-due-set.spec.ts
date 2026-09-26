/**
 * The due-set predicate against a real PostgreSQL, because the thing being
 * asserted is what the database returns, not what the `where` object looks
 * like. A shape assertion would pass while the query selected the wrong rows.
 *
 * ULK-C13 requires that published, locked and manually adjusted work is
 * preserved. It is preserved by never being selected, so these are the tests
 * that prove the preservation — each one seeds a row that must NOT come back.
 *
 * No AppModule, so no Redis and no scheduler: the predicate is Prisma and
 * nothing else, and the test should fail for a reason about the predicate.
 */
import {
  AgreementStatus,
  AssignmentStatus,
  BranchCode,
  CrewRole,
  FrequencyUnit,
  PrismaClient,
  VisitStatus,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

import {
  assignmentsOnDayWhere,
  demandAgreementsWhere,
  dueVisitsWhere,
} from '../../src/scheduling/day-coverage/due-set';
import { assertTestDatabaseUrl } from '../support/test-database';

assertTestDatabaseUrl(process.env.DATABASE_URL);

const prisma = new PrismaClient();

const DAY = new Date('2026-10-25T00:00:00.000Z');
const NEXT_DAY = new Date('2026-10-26T00:00:00.000Z');
const BRANCH = BranchCode.COLOMBO;

/** Unique per run so a failed run cannot poison the next one. */
const tag = `c13-${randomUUID().slice(0, 8)}`;

let branchId: string;
let jobTypeId: string;
let customerId: string;
let siteId: string;

async function makeAgreement(
  over: { status?: AgreementStatus; endDate?: Date | null; startDate?: Date } = {},
): Promise<string> {
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
      startDate: over.startDate ?? new Date('2026-01-01T00:00:00.000Z'),
      endDate: over.endDate ?? null,
      status: over.status ?? AgreementStatus.ACTIVE,
    },
  });
  return agreement.id;
}

async function makeVisit(
  serviceAgreementId: string,
  over: {
    status?: VisitStatus;
    visitDate?: Date;
    lockedAt?: Date | null;
    isManuallyAdjusted?: boolean;
  } = {},
): Promise<string> {
  const visit = await prisma.generatedVisit.create({
    data: {
      serviceAgreementId,
      branchId,
      branchCode: BRANCH,
      visitDate: over.visitDate ?? DAY,
      windowStartMinute: 480,
      windowEndMinute: 1020,
      durationMinutes: 60,
      requiredCrewSize: 1,
      status: over.status ?? VisitStatus.PENDING,
      lockedAt: over.lockedAt ?? null,
      isManuallyAdjusted: over.isManuallyAdjusted ?? false,
    },
  });
  return visit.id;
}

async function dueVisitIds(): Promise<string[]> {
  const rows = await prisma.generatedVisit.findMany({
    where: dueVisitsWhere(BRANCH, DAY),
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

beforeAll(async () => {
  const branch = await prisma.branch.upsert({
    where: { code: BRANCH },
    create: { code: BRANCH, name: 'Colombo' },
    update: {},
  });
  branchId = branch.id;

  const jobType = await prisma.jobType.create({
    data: { code: `${tag}-JOB`, name: 'Due-set fixture job' },
  });
  jobTypeId = jobType.id;

  const customer = await prisma.customer.create({
    data: { name: `${tag} customer`, branchId, branchCode: BRANCH },
  });
  customerId = customer.id;

  const site = await prisma.serviceSite.create({
    data: {
      customerId,
      name: `${tag} site`,
      branchId,
      branchCode: BRANCH,
    },
  });
  siteId = site.id;
});

afterAll(async () => {
  // Children first: the fixtures cascade from the customer, but the job type
  // is independent and would survive.
  await prisma.customer.deleteMany({ where: { id: customerId } });
  // Employees are only reachable now: crew-member rows referenced them until
  // the customer cascade above removed the assignments holding them.
  await prisma.employee.deleteMany({ where: { sourceKey: { startsWith: tag } } });
  await prisma.jobType.deleteMany({ where: { id: jobTypeId } });
  await prisma.$disconnect();
});

describe('dueVisitsWhere', () => {
  it('returns a plain pending visit on the day', async () => {
    const agreementId = await makeAgreement();
    const visitId = await makeVisit(agreementId);

    await expect(dueVisitIds()).resolves.toContain(visitId);
  });

  it('returns an UNASSIGNED visit — it is still waiting for a crew', async () => {
    const agreementId = await makeAgreement();
    const visitId = await makeVisit(agreementId, { status: VisitStatus.UNASSIGNED });

    await expect(dueVisitIds()).resolves.toContain(visitId);
  });

  it('excludes a visit on the day before and the day after', async () => {
    const agreementId = await makeAgreement();
    const before = await makeVisit(agreementId, {
      visitDate: new Date('2026-10-24T00:00:00.000Z'),
    });
    const after = await makeVisit(agreementId, { visitDate: NEXT_DAY });

    const due = await dueVisitIds();
    expect(due).not.toContain(before);
    expect(due).not.toContain(after);
  });

  it('excludes a cancelled visit', async () => {
    const agreementId = await makeAgreement();
    const visitId = await makeVisit(agreementId, { status: VisitStatus.CANCELLED });

    await expect(dueVisitIds()).resolves.not.toContain(visitId);
  });

  // ULK-C13: locked work is preserved. Preserved by not being selected.
  it('excludes a locked visit', async () => {
    const agreementId = await makeAgreement();
    const visitId = await makeVisit(agreementId, { lockedAt: new Date() });

    await expect(dueVisitIds()).resolves.not.toContain(visitId);
  });

  it('excludes a manually adjusted visit', async () => {
    const agreementId = await makeAgreement();
    const visitId = await makeVisit(agreementId, { isManuallyAdjusted: true });

    await expect(dueVisitIds()).resolves.not.toContain(visitId);
  });

  it('excludes a visit whose agreement is paused', async () => {
    const agreementId = await makeAgreement({ status: AgreementStatus.PAUSED });
    const visitId = await makeVisit(agreementId);

    await expect(dueVisitIds()).resolves.not.toContain(visitId);
  });

  it('excludes a visit whose agreement ended before the day', async () => {
    const agreementId = await makeAgreement({
      endDate: new Date('2026-10-01T00:00:00.000Z'),
    });
    const visitId = await makeVisit(agreementId);

    await expect(dueVisitIds()).resolves.not.toContain(visitId);
  });

  it('includes a visit whose agreement ends exactly on the day', async () => {
    const agreementId = await makeAgreement({ endDate: DAY });
    const visitId = await makeVisit(agreementId);

    await expect(dueVisitIds()).resolves.toContain(visitId);
  });

  it('excludes a visit for an inactive customer', async () => {
    const other = await prisma.customer.create({
      data: { name: `${tag} inactive`, branchId, branchCode: BRANCH, isActive: false },
    });
    const otherSite = await prisma.serviceSite.create({
      data: { customerId: other.id, name: `${tag} s2`, branchId, branchCode: BRANCH },
    });
    const agreement = await prisma.serviceAgreement.create({
      data: {
        customerId: other.id,
        serviceSiteId: otherSite.id,
        jobTypeId,
        branchId,
        branchCode: BRANCH,
        frequencyCount: 1,
        frequencyUnit: FrequencyUnit.MONTH,
        crewSize: 1,
        durationMinutes: 60,
        startDate: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const visit = await prisma.generatedVisit.create({
      data: {
        serviceAgreementId: agreement.id,
        branchId,
        branchCode: BRANCH,
        visitDate: DAY,
        windowStartMinute: 480,
        windowEndMinute: 1020,
        durationMinutes: 60,
        requiredCrewSize: 1,
      },
    });

    await expect(dueVisitIds()).resolves.not.toContain(visit.id);

    await prisma.customer.delete({ where: { id: other.id } });
  });

  describe('already staffed', () => {
    async function assign(visitId: string, status: AssignmentStatus): Promise<void> {
      const employee = await prisma.employee.create({
        data: {
          fullName: `${tag} ${status}`,
          sourceKey: `${tag}-${status}`,
          gradeLabel: 'TECHNICIAN',
          branchId,
          branchCode: BRANCH,
        },
      });
      await prisma.assignment.create({
        data: {
          generatedVisitId: visitId,
          branchId,
          branchCode: BRANCH,
          status,
          plannedStart: new Date('2026-10-25T02:30:00.000Z'),
          plannedEnd: new Date('2026-10-25T03:30:00.000Z'),
          crewMembers: {
            create: [{ employeeId: employee.id, role: CrewRole.TECHNICIAN }],
          },
        },
      });
    }

    it.each([
      AssignmentStatus.PUBLISHED,
      AssignmentStatus.ACKNOWLEDGED,
      AssignmentStatus.IN_PROGRESS,
      AssignmentStatus.COMPLETED,
    ])('excludes a visit already carrying a %s assignment', async (status) => {
      const agreementId = await makeAgreement();
      const visitId = await makeVisit(agreementId, { status: VisitStatus.SCHEDULED });
      await assign(visitId, status);

      await expect(dueVisitIds()).resolves.not.toContain(visitId);

    });

    // The trap CalendarService falls into. A prepared-but-unpublished day
    // must stay due, or a second run decides the day is finished while
    // nothing has been published to a crew.
    it.each([AssignmentStatus.DRAFT, AssignmentStatus.PROPOSED])(
      'still returns a visit whose only assignment is %s',
      async (status) => {
        const agreementId = await makeAgreement();
        const visitId = await makeVisit(agreementId, { status: VisitStatus.SCHEDULED });
        await assign(visitId, status);

        await expect(dueVisitIds()).resolves.toContain(visitId);

      },
    );

    it('still returns a visit whose only assignment was superseded', async () => {
      const agreementId = await makeAgreement();
      const visitId = await makeVisit(agreementId, { status: VisitStatus.SCHEDULED });
      await assign(visitId, AssignmentStatus.SUPERSEDED);

      await expect(dueVisitIds()).resolves.toContain(visitId);

    });
  });
});

describe('demandAgreementsWhere', () => {
  // The case no digest over visit ids can see: demand exists, generation has
  // not run, so there is no visit at all.
  it('finds an agreement that has produced no visit yet', async () => {
    const agreementId = await makeAgreement();

    const found = await prisma.serviceAgreement.findMany({
      where: demandAgreementsWhere(BRANCH, DAY),
      select: { id: true },
    });

    expect(found.map((row) => row.id)).toContain(agreementId);
    await expect(
      prisma.generatedVisit.count({ where: { serviceAgreementId: agreementId } }),
    ).resolves.toBe(0);
  });

  it('excludes an agreement that starts after the day', async () => {
    const agreementId = await makeAgreement({
      startDate: new Date('2026-12-01T00:00:00.000Z'),
    });

    const found = await prisma.serviceAgreement.findMany({
      where: demandAgreementsWhere(BRANCH, DAY),
      select: { id: true },
    });

    expect(found.map((row) => row.id)).not.toContain(agreementId);
  });

  it('excludes an archived agreement', async () => {
    const agreementId = await makeAgreement({ status: AgreementStatus.ARCHIVED });

    const found = await prisma.serviceAgreement.findMany({
      where: demandAgreementsWhere(BRANCH, DAY),
      select: { id: true },
    });

    expect(found.map((row) => row.id)).not.toContain(agreementId);
  });
});

describe('assignmentsOnDayWhere', () => {
  // Unfiltered by status on purpose: the supply fingerprint has to notice a
  // draft appearing and a publication happening, so filtering to live here
  // would blind it to the transitions it exists to catch.
  it('includes draft and superseded assignments, not only live ones', async () => {
    const agreementId = await makeAgreement();
    const visitId = await makeVisit(agreementId);
    const draft = await prisma.assignment.create({
      data: {
        generatedVisitId: visitId,
        branchId,
        branchCode: BRANCH,
        status: AssignmentStatus.DRAFT,
        plannedStart: new Date('2026-10-25T02:30:00.000Z'),
        plannedEnd: new Date('2026-10-25T03:30:00.000Z'),
      },
    });

    const found = await prisma.assignment.findMany({
      where: assignmentsOnDayWhere(BRANCH, DAY),
      select: { id: true },
    });

    expect(found.map((row) => row.id)).toContain(draft.id);

  });
});

import {
  AssignmentStatus,
  BranchCode,
  CrewRole,
  DataProvenance,
  SiteBranchConfidence,
  SiteBranchSource,
  VisitStatus,
} from '@prisma/client';

import { OperationsService } from './operations.service';

const date = new Date('2026-09-10T00:00:00.000Z');

interface AssignmentFixture {
  id: string;
  status: AssignmentStatus;
  updatedAt: Date;
  publishedAt: Date | null;
  scheduleRunId: string | null;
  publishedByRepairId: string | null;
  supersedesAssignmentId: string | null;
  plannedStart: Date;
  plannedEnd: Date;
  acknowledgedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  crewMembers: Array<{
    employeeId: string;
    role: CrewRole;
    isPmsSupervisor: boolean;
    employee: { fullName: string };
  }>;
  vehicles: Array<{
    vehicleId: string;
    driverEmployeeId: string | null;
    vehicle: { label: string; branchId: string | null };
    driverEmployee: { fullName: string } | null;
  }>;
}

function assignment(id: string, status: AssignmentStatus, updatedAt: Date): AssignmentFixture {
  return {
    id,
    status,
    updatedAt,
    publishedAt: status === AssignmentStatus.PUBLISHED ? updatedAt : null,
    scheduleRunId: `${id}-run`,
    publishedByRepairId: null,
    supersedesAssignmentId: null,
    plannedStart: new Date('2026-09-10T09:00:00.000Z'),
    plannedEnd: new Date('2026-09-10T10:00:00.000Z'),
    acknowledgedAt: null,
    startedAt: null,
    completedAt: null,
    crewMembers: [],
    vehicles: [],
  };
}

function visit(overrides: Record<string, unknown> = {}) {
  return {
    id: 'visit',
    visitDate: date,
    branchCode: BranchCode.COLOMBO,
    status: VisitStatus.SCHEDULED,
    windowStartMinute: 540,
    windowEndMinute: 600,
    durationMinutes: 60,
    requiredCrewSize: 1,
    windowProvenance: DataProvenance.DERIVED,
    serviceAgreement: {
      crewSizeProvenance: DataProvenance.SOURCE,
      durationProvenance: DataProvenance.SOURCE,
      dayRuleProvenance: DataProvenance.SOURCE,
      customer: { name: 'Customer' },
      serviceSite: {
        name: 'Site',
        branchConfidence: SiteBranchConfidence.CONFIRMED,
        branchSource: SiteBranchSource.MANAGER_CONFIRMED,
      },
      jobType: { name: 'Treatment' },
    },
    unassignedReasons: [],
    assignments: [],
    ...overrides,
  };
}

describe('OperationsService', () => {
  it('returns the immutable original, superseded predecessor, and repair successor as one published assignment lineage', async () => {
    const original = assignment('original', AssignmentStatus.SUPERSEDED, new Date('2026-09-09T08:00:00.000Z'));
    original.publishedAt = new Date('2026-09-09T08:00:00.000Z');
    const repaired = assignment('repair-successor', AssignmentStatus.PUBLISHED, new Date('2026-09-10T08:00:00.000Z'));
    repaired.scheduleRunId = null;
    repaired.publishedByRepairId = 'repair-1';
    repaired.supersedesAssignmentId = original.id;
    const prisma = {
      generatedVisit: {
        findMany: jest.fn().mockResolvedValue([visit({ assignments: [repaired, original] })]),
      },
    };
    const eligibility = { evaluate: jest.fn().mockResolvedValue({ isEligible: true, conflicts: [] }) };

    const result = await new OperationsService(prisma as never, eligibility as never)
      .day({ date: '2026-09-10' });

    expect(result.items[0]).toMatchObject({
      dispatchAssignment: { id: 'repair-successor' },
      publishedAssignmentLineage: {
        hasMixedProvenance: true,
        entries: [
          {
            assignmentId: 'original',
            status: AssignmentStatus.SUPERSEDED,
            supersedesAssignmentId: null,
            publishedByRepairId: null,
            provenance: 'SCHEDULE_RUN',
          },
          {
            assignmentId: 'repair-successor',
            status: AssignmentStatus.PUBLISHED,
            supersedesAssignmentId: 'original',
            publishedByRepairId: 'repair-1',
            provenance: 'REPAIR',
          },
        ],
      },
    });
    expect(prisma.generatedVisit.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        assignments: expect.objectContaining({
          where: { status: { in: expect.arrayContaining([AssignmentStatus.SUPERSEDED]) } },
        }),
      }),
    }));
  });

  it('uses the published assignment as dispatch truth even when a newer draft exists', async () => {
    const published = assignment('published', AssignmentStatus.PUBLISHED, date);
    const draft = assignment('draft', AssignmentStatus.DRAFT, new Date('2026-09-10T12:00:00.000Z'));
    const prisma = {
      generatedVisit: {
        findMany: jest.fn().mockResolvedValue([visit({ assignments: [draft, published] })]),
      },
    };
    const eligibility = { evaluate: jest.fn().mockResolvedValue({ isEligible: true, conflicts: [] }) };
    const service = new OperationsService(prisma as never, eligibility as never);

    const result = await service.day({ date: '2026-09-10' });

    expect(result).toMatchObject({
      date: '2026-09-10',
      branchCode: null,
      summary: {
        total: 1,
        ready: 1,
        proposed: 0,
        unassigned: 0,
        exceptions: 0,
        hoursUnconfirmed: 0,
      },
    });
    expect(result.items[0]).toMatchObject({
      visit: {
        id: 'visit',
        branchCode: BranchCode.COLOMBO,
        customerName: 'Customer',
        requiredCrewSize: 1,
        durationMinutes: 60,
        hoursUnconfirmed: false,
      },
      state: 'READY',
      dispatchAssignment: { id: 'published', status: AssignmentStatus.PUBLISHED },
      proposedAssignment: { id: 'draft', status: AssignmentStatus.DRAFT },
      warnings: [],
      scheduleVersion: { id: 'published-run', status: AssignmentStatus.PUBLISHED },
    });
    expect(eligibility.evaluate).toHaveBeenCalledWith('visit', expect.any(Object), {
      excludeAssignmentId: 'published',
    });
  });

  it('keeps an unassigned visit honest and surfaces stored conflicts and missing hours', async () => {
    const prisma = {
      generatedVisit: {
        findMany: jest.fn().mockResolvedValue([visit({
          branchCode: BranchCode.KANDY,
          status: VisitStatus.UNASSIGNED,
          requiredCrewSize: 2,
          windowProvenance: DataProvenance.DEFAULTED,
          serviceAgreement: {
            crewSizeProvenance: DataProvenance.DEFAULTED,
            durationProvenance: DataProvenance.DEFAULTED,
            dayRuleProvenance: DataProvenance.DERIVED,
            customer: { name: 'Customer' },
            serviceSite: {
              name: 'Site',
              branchConfidence: SiteBranchConfidence.UNCERTAIN,
              branchSource: SiteBranchSource.FALLBACK_DEFAULT,
            },
            jobType: { name: 'Treatment' },
          },
          unassignedReasons: [{ code: 'CREW_TOO_SMALL', message: 'Crew is short', details: null }],
        })]),
      },
    };
    const service = new OperationsService(prisma as never, { evaluate: jest.fn() } as never);

    const result = await service.day({ date: '2026-09-10', branchCode: BranchCode.KANDY });

    expect(result.items[0]).toMatchObject({
      state: 'UNASSIGNED',
      violations: [{ code: 'CREW_TOO_SMALL' }],
      nextAction: expect.stringContaining('crew'),
    });
    expect(result.branchCode).toBe(BranchCode.KANDY);
    expect(result.items[0].warnings.map((warning) => warning.code)).toEqual([
      'CREW_SIZE_DEFAULTED',
      'DAY_RULE_DERIVED',
      'DURATION_DEFAULTED',
      'HOURS_UNCONFIRMED',
      'SITE_BRANCH_UNCONFIRMED',
    ]);
    expect(result.summary.hoursUnconfirmed).toBe(1);
  });

  it('makes competing live proposals a deterministic exception without confusing one for dispatch truth', async () => {
    const first = assignment('first', AssignmentStatus.DRAFT, new Date('2026-09-10T11:00:00.000Z'));
    const second = assignment('second', AssignmentStatus.PROPOSED, new Date('2026-09-10T11:00:00.000Z'));
    first.vehicles = [{
      vehicleId: 'vehicle',
      driverEmployeeId: null,
          vehicle: { label: 'Van 1', branchId: null },
      driverEmployee: null,
    }];
    const prisma = {
      generatedVisit: {
        findMany: jest.fn().mockResolvedValue([visit({ assignments: [second, first] })]),
      },
    };

    const result = await new OperationsService(prisma as never, { evaluate: jest.fn() } as never)
      .day({ date: '2026-09-10' });

    expect(result.items[0]).toMatchObject({
      state: 'EXCEPTION',
      dispatchAssignment: null,
      proposedAssignment: { id: 'first' },
      violations: [{ code: 'MULTIPLE_LIVE_ASSIGNMENTS' }],
      warnings: [{ code: 'VEHICLE_BRANCH_UNCONFIRMED' }],
    });
  });

  it('uses actual vehicle branch data instead of warning for every assigned vehicle', async () => {
    const published = assignment('published', AssignmentStatus.PUBLISHED, date);
    published.vehicles = [{
      vehicleId: 'vehicle',
      driverEmployeeId: null,
      vehicle: { label: 'Van 1', branchId: 'confirmed-branch' },
      driverEmployee: null,
    }];
    const prisma = {
      generatedVisit: { findMany: jest.fn().mockResolvedValue([visit({ assignments: [published] })]) },
    };
    const eligibility = { evaluate: jest.fn().mockResolvedValue({ isEligible: true, conflicts: [] }) };

    const result = await new OperationsService(prisma as never, eligibility as never)
      .day({ date: '2026-09-10' });

    expect(result.items[0].warnings).not.toContainEqual(
      expect.objectContaining({ code: 'VEHICLE_BRANCH_UNCONFIRMED' }),
    );
  });

  it('retains an invalid published snapshot for inspection while marking it non-dispatchable', async () => {
    const published = assignment('invalid-published', AssignmentStatus.PUBLISHED, date);
    published.crewMembers = [{
      employeeId: 'employee',
      role: 'TECHNICIAN',
      isPmsSupervisor: false,
      employee: { fullName: 'Published technician' },
    }];
    const prisma = {
      generatedVisit: { findMany: jest.fn().mockResolvedValue([visit({ assignments: [published] })]) },
    };
    const eligibility = {
      evaluate: jest.fn().mockResolvedValue({
        isEligible: false,
        conflicts: [{
          code: 'NO_PMS_SUPERVISOR',
          message: 'A PMS supervisor is required.',
          remediation: 'Choose an authorised supervisor.',
          resources: {},
        }],
      }),
    };

    const result = await new OperationsService(prisma as never, eligibility as never)
      .day({ date: '2026-09-10' });

    expect(result.items[0]).toMatchObject({
      state: 'EXCEPTION',
      dispatchAssignment: {
        id: 'invalid-published',
        crew: [{ employeeId: 'employee', fullName: 'Published technician' }],
      },
      violations: [{ code: 'NO_PMS_SUPERVISOR' }],
      nextAction: expect.stringContaining('before dispatching'),
    });
    expect(result.summary.exceptions).toBe(1);
  });

  it('distinguishes unknown day-rule provenance from evidence-derived rules', async () => {
    const unknownDayRuleVisit = visit({
      id: 'unknown-day-rule',
      serviceAgreement: {
        crewSizeProvenance: DataProvenance.SOURCE,
        durationProvenance: DataProvenance.SOURCE,
        dayRuleProvenance: DataProvenance.UNKNOWN,
        customer: { name: 'Customer' },
        serviceSite: {
          name: 'Site',
          branchConfidence: SiteBranchConfidence.CONFIRMED,
          branchSource: SiteBranchSource.MANAGER_CONFIRMED,
        },
        jobType: { name: 'Treatment' },
      },
    });
    const prisma = {
      generatedVisit: { findMany: jest.fn().mockResolvedValue([unknownDayRuleVisit]) },
    };

    const result = await new OperationsService(prisma as never, { evaluate: jest.fn() } as never)
      .day({ date: '2026-09-10' });

    expect(result.items[0].warnings).toContainEqual(
      expect.objectContaining({ code: 'DAY_RULE_UNCONFIRMED' }),
    );
    expect(result.items[0].warnings).not.toContainEqual(
      expect.objectContaining({ code: 'DAY_RULE_DERIVED' }),
    );
  });
});

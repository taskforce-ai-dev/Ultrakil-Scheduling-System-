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
  scheduleRunId: string;
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
  it('uses the published assignment as dispatch truth even when a newer draft exists', async () => {
    const published = assignment('published', AssignmentStatus.PUBLISHED, date);
    const draft = assignment('draft', AssignmentStatus.DRAFT, new Date('2026-09-10T12:00:00.000Z'));
    const prisma = {
      assignment: { findMany: jest.fn().mockResolvedValue([]) },
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
      assignment: { findMany: jest.fn().mockResolvedValue([]) },
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
      assignment: { findMany: jest.fn().mockResolvedValue([]) },
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
      assignment: { findMany: jest.fn().mockResolvedValue([]) },
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
      assignment: { findMany: jest.fn().mockResolvedValue([]) },
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
      assignment: { findMany: jest.fn().mockResolvedValue([]) },
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

interface LineageRowFixture {
  id: string;
  generatedVisitId: string;
  status: AssignmentStatus;
  supersedesAssignmentId: string | null;
  publishedByRepairId: string | null;
  scheduleRunId: string | null;
  publishedAt: Date | null;
  updatedAt: Date;
}

let lineageClock = 0;

function lineageRow(id: string, overrides: Partial<LineageRowFixture> = {}): LineageRowFixture {
  lineageClock += 1;
  const at = new Date(date.getTime() + lineageClock * 60_000);
  return {
    id,
    generatedVisitId: 'visit',
    status: AssignmentStatus.SUPERSEDED,
    supersedesAssignmentId: null,
    publishedByRepairId: null,
    scheduleRunId: `${id}-run`,
    publishedAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function serviceFor(visits: unknown[], lineage: LineageRowFixture[]) {
  const prisma = {
    assignment: { findMany: jest.fn().mockResolvedValue(lineage) },
    generatedVisit: { findMany: jest.fn().mockResolvedValue(visits) },
  };
  const eligibility = { evaluate: jest.fn().mockResolvedValue({ isEligible: true, conflicts: [] }) };
  return {
    prisma,
    eligibility,
    service: new OperationsService(prisma as never, eligibility as never),
  };
}

describe('OperationsService published-assignment lineage', () => {
  beforeEach(() => {
    lineageClock = 0;
  });

  it('orders the published chain from predecessor to successor and marks the current version', async () => {
    const current = assignment('v3', AssignmentStatus.PUBLISHED, date);
    const rows = [
      lineageRow('v1'),
      lineageRow('v2', { supersedesAssignmentId: 'v1' }),
      lineageRow('v3', { status: AssignmentStatus.PUBLISHED, supersedesAssignmentId: 'v2' }),
    ];
    // Deliberately shuffled: the order must come from the lineage links, not
    // from the order the database happened to return rows in.
    const { service } = serviceFor([visit({ assignments: [current] })], [rows[2], rows[0], rows[1]]);

    const lineage = (await service.day({ date: '2026-09-10' })).items[0].publishedAssignmentLineage;

    expect(lineage.entries.map((entry) => entry.assignmentId)).toEqual(['v1', 'v2', 'v3']);
    expect(lineage.entries.map((entry) => entry.supersedesAssignmentId)).toEqual([null, 'v1', 'v2']);
    expect(lineage.entries.map((entry) => entry.supersededByAssignmentId)).toEqual(['v2', 'v3', null]);
    expect(lineage.entries.map((entry) => entry.isCurrent)).toEqual([false, false, true]);
    expect(lineage).toMatchObject({
      totalCount: 3,
      truncated: false,
      omittedCount: 0,
      currentAssignmentId: 'v3',
      withdrawn: false,
    });
  });

  it('distinguishes a repair successor from an ordinary schedule-run version', async () => {
    const current = assignment('repaired', AssignmentStatus.PUBLISHED, date);
    const rows = [
      lineageRow('from-run'),
      lineageRow('hand-published', { supersedesAssignmentId: 'from-run', scheduleRunId: null }),
      lineageRow('repaired', {
        status: AssignmentStatus.PUBLISHED,
        supersedesAssignmentId: 'hand-published',
        publishedByRepairId: 'repair-1',
      }),
    ];
    const { service } = serviceFor([visit({ assignments: [current] })], rows);

    const lineage = (await service.day({ date: '2026-09-10' })).items[0].publishedAssignmentLineage;

    expect(lineage.entries.map((entry) => entry.provenance)).toEqual([
      'SCHEDULE_RUN',
      'MANUAL_PUBLISH',
      'REPAIR',
    ]);
    expect(lineage.entries[2].publishedByRepairId).toBe('repair-1');
    expect(lineage.entries[0].publishedByRepairId).toBeNull();
    expect(lineage.hasMixedProvenance).toBe(true);
  });

  it('returns an empty chain for a visit with no published history', async () => {
    const draft = assignment('draft', AssignmentStatus.DRAFT, date);
    const { service } = serviceFor([visit({ assignments: [draft] })], []);

    const lineage = (await service.day({ date: '2026-09-10' })).items[0].publishedAssignmentLineage;

    expect(lineage).toEqual({
      entries: [],
      totalCount: 0,
      truncated: false,
      omittedCount: 0,
      currentAssignmentId: null,
      withdrawn: false,
      hasMixedProvenance: false,
    });
  });

  it('truncates a long correction history to the newest versions and reports the truncation', async () => {
    const total = 13;
    const rows = Array.from({ length: total }, (_, index) => lineageRow(`v${index + 1}`, {
      supersedesAssignmentId: index === 0 ? null : `v${index}`,
      status: index === total - 1 ? AssignmentStatus.PUBLISHED : AssignmentStatus.SUPERSEDED,
    }));
    const current = assignment(`v${total}`, AssignmentStatus.PUBLISHED, date);
    const { service } = serviceFor([visit({ assignments: [current] })], rows);

    const lineage = (await service.day({ date: '2026-09-10' })).items[0].publishedAssignmentLineage;

    expect(lineage.entries).toHaveLength(10);
    expect(lineage.entries[0].assignmentId).toBe('v4');
    expect(lineage.entries[9].assignmentId).toBe('v13');
    expect(lineage).toMatchObject({
      totalCount: 13,
      truncated: true,
      omittedCount: 3,
      currentAssignmentId: 'v13',
    });
  });

  it('keeps a broken or cyclic chain intact without dropping rows or looping', async () => {
    const current = assignment('orphan', AssignmentStatus.PUBLISHED, date);
    const rows = [
      // The predecessor was never published for this visit: a broken link is
      // not a reason to drop the row from an audit trail.
      lineageRow('orphan', { status: AssignmentStatus.PUBLISHED, supersedesAssignmentId: 'never-published' }),
      lineageRow('cycle-a', { supersedesAssignmentId: 'cycle-b' }),
      lineageRow('cycle-b', { supersedesAssignmentId: 'cycle-a' }),
    ];
    const { service } = serviceFor([visit({ assignments: [current] })], rows);

    const lineage = (await service.day({ date: '2026-09-10' })).items[0].publishedAssignmentLineage;

    expect([...lineage.entries.map((entry) => entry.assignmentId)].sort()).toEqual([
      'cycle-a',
      'cycle-b',
      'orphan',
    ]);
    expect(lineage.totalCount).toBe(3);
    expect(new Set(lineage.entries.map((entry) => entry.assignmentId)).size).toBe(3);
  });

  it('reports withdrawn published work rather than inventing a current version', async () => {
    const rows = [
      lineageRow('withdrawn-v1'),
      lineageRow('withdrawn-v2', { supersedesAssignmentId: 'withdrawn-v1' }),
    ];
    const { service } = serviceFor([visit({ status: VisitStatus.UNASSIGNED, assignments: [] })], rows);

    const item = (await service.day({ date: '2026-09-10' })).items[0];

    expect(item.state).toBe('UNASSIGNED');
    expect(item.publishedAssignmentLineage).toMatchObject({
      totalCount: 2,
      currentAssignmentId: null,
      withdrawn: true,
    });
  });

  it('leaves dispatch selection, operation state and the multiple-live violation unchanged when superseded rows exist', async () => {
    const published = assignment('published', AssignmentStatus.PUBLISHED, date);
    const draft = assignment('draft', AssignmentStatus.DRAFT, new Date('2026-09-10T12:00:00.000Z'));
    const rows = [
      lineageRow('retired'),
      lineageRow('published', { status: AssignmentStatus.PUBLISHED, supersedesAssignmentId: 'retired' }),
    ];
    const { service, eligibility } = serviceFor([visit({ assignments: [draft, published] })], rows);

    const item = (await service.day({ date: '2026-09-10' })).items[0];

    expect(item.state).toBe('READY');
    expect(item.dispatchAssignment).toMatchObject({ id: 'published', status: AssignmentStatus.PUBLISHED });
    expect(item.proposedAssignment).toMatchObject({ id: 'draft', status: AssignmentStatus.DRAFT });
    expect(item.violations).toEqual([]);
    expect(item.scheduleVersion).toMatchObject({ id: 'published-run', status: AssignmentStatus.PUBLISHED });
    expect(eligibility.evaluate).toHaveBeenCalledWith('visit', expect.any(Object), {
      excludeAssignmentId: 'published',
    });
  });

  it('reads the whole day of lineage in one query instead of one query per visit', async () => {
    const first = visit({ id: 'visit', assignments: [] });
    const second = visit({ id: 'other-visit', assignments: [] });
    const rows = [
      lineageRow('a', { generatedVisitId: 'visit' }),
      lineageRow('b', { generatedVisitId: 'other-visit' }),
    ];
    const { service, prisma } = serviceFor([first, second], rows);

    const result = await service.day({ date: '2026-09-10' });

    expect(prisma.assignment.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.generatedVisit.findMany).toHaveBeenCalledTimes(1);
    expect(result.items[0].publishedAssignmentLineage.entries.map((entry) => entry.assignmentId)).toEqual(['a']);
    expect(result.items[1].publishedAssignmentLineage.entries.map((entry) => entry.assignmentId)).toEqual(['b']);
  });
});

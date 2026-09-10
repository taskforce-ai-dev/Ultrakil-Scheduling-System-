import { AssignmentStatus, BranchCode, VisitStatus } from '@prisma/client';

import { OperationsService } from './operations.service';

const date = new Date('2026-09-10T00:00:00.000Z');

function assignment(id: string, status: AssignmentStatus, updatedAt: Date) {
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

describe('OperationsService', () => {
  it('uses the published assignment as dispatch truth even when a newer draft exists', async () => {
    const published = assignment('published', AssignmentStatus.PUBLISHED, date);
    const draft = assignment('draft', AssignmentStatus.DRAFT, new Date('2026-09-10T12:00:00.000Z'));
    const prisma = {
      generatedVisit: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'visit', visitDate: date, branchCode: BranchCode.COLOMBO,
          status: VisitStatus.SCHEDULED, windowStartMinute: 540, windowEndMinute: 600,
          requiredCrewSize: 1,
          serviceAgreement: {
            customer: { name: 'Customer' }, serviceSite: { name: 'Site', _count: { operatingHours: 1 } },
            jobType: { name: 'Treatment' },
          },
          unassignedReasons: [], assignments: [draft, published],
        }]),
      },
    };
    const eligibility = { evaluate: jest.fn().mockResolvedValue({ isEligible: true, conflicts: [] }) };
    const service = new OperationsService(prisma as never, eligibility as never);

    const result = await service.day({ date: '2026-09-10' });

    expect(result.items[0]).toMatchObject({
      state: 'READY',
      dispatch: { assignmentId: 'published', status: AssignmentStatus.PUBLISHED },
      proposed: { assignmentId: 'draft', status: AssignmentStatus.DRAFT },
      scheduleVersion: { scheduleRunId: 'published-run' },
    });
    expect(eligibility.evaluate).toHaveBeenCalledWith('visit', expect.any(Object), {
      excludeAssignmentId: 'published',
    });
  });

  it('keeps an unassigned visit honest and surfaces stored conflicts and missing hours', async () => {
    const prisma = {
      generatedVisit: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'visit', visitDate: date, branchCode: BranchCode.KANDY,
          status: VisitStatus.UNASSIGNED, windowStartMinute: 540, windowEndMinute: 600,
          requiredCrewSize: 2,
          serviceAgreement: {
            customer: { name: 'Customer' }, serviceSite: { name: 'Site', _count: { operatingHours: 0 } },
            jobType: { name: 'Treatment' },
          },
          assignments: [],
          unassignedReasons: [{ code: 'CREW_TOO_SMALL', message: 'Crew is short', details: null }],
        }]),
      },
    };
    const service = new OperationsService(prisma as never, { evaluate: jest.fn() } as never);

    const result = await service.day({ date: '2026-09-10', branchCode: BranchCode.KANDY });

    expect(result.items[0]).toMatchObject({
      state: 'UNASSIGNED',
      violations: [{ code: 'CREW_TOO_SMALL' }],
      sourceWarnings: [{ code: 'HOURS_UNCONFIRMED' }],
      nextAction: expect.stringContaining('crew'),
    });
  });

  it('makes competing live proposals a deterministic exception without confusing one for dispatch truth', async () => {
    const first = assignment('first', AssignmentStatus.DRAFT, new Date('2026-09-10T11:00:00.000Z')) as any;
    const second = assignment('second', AssignmentStatus.PROPOSED, new Date('2026-09-10T11:00:00.000Z'));
    first.vehicles = [{
      vehicleId: 'vehicle',
      driverEmployeeId: null,
      vehicle: { label: 'Van 1' },
      driverEmployee: null,
    }];
    const prisma = {
      generatedVisit: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'visit', visitDate: date, branchCode: BranchCode.COLOMBO,
          status: VisitStatus.SCHEDULED, windowStartMinute: 540, windowEndMinute: 600,
          requiredCrewSize: 1,
          serviceAgreement: {
            customer: { name: 'Customer' }, serviceSite: { name: 'Site', _count: { operatingHours: 1 } },
            jobType: { name: 'Treatment' },
          },
          unassignedReasons: [], assignments: [second, first],
        }]),
      },
    };

    const result = await new OperationsService(prisma as never, { evaluate: jest.fn() } as never)
      .day({ date: '2026-09-10' });

    expect(result.items[0]).toMatchObject({
      state: 'EXCEPTION',
      dispatch: null,
      proposed: { assignmentId: 'first' },
      violations: [{ code: 'MULTIPLE_LIVE_ASSIGNMENTS' }],
      sourceWarnings: [{ code: 'VEHICLE_BRANCH_UNCONFIRMED' }],
    });
  });
});

import { ConfigService } from '@nestjs/config';
import {
  AssignmentStatus,
  BranchCode,
  CrewRole,
  DeploymentType,
} from '@prisma/client';

import { PrismaService } from '../../src/prisma/prisma.service';
import { SchedulerClient } from '../../src/scheduling/optimizer/scheduler.client';
import {
  PlannerSourceAssignment,
  PublishedAssignmentRepairPlannerAdapter,
} from '../../src/scheduling/repair/published-assignment-repair-planner.adapter';

const visitDate = new Date('2027-03-03T00:00:00.000Z');
const replacementEmployeeId = 'repair-solver-new-supervisor';

function target(startMinute: number, durationMinutes: number): PlannerSourceAssignment {
  return {
    id: 'repair-solver-published-source',
    generatedVisitId: 'repair-solver-visit',
    branchCode: BranchCode.COLOMBO,
    status: AssignmentStatus.PUBLISHED,
    plannedStart: new Date(visitDate.getTime() + startMinute * 60_000),
    plannedEnd: new Date(visitDate.getTime() + (startMinute + durationMinutes) * 60_000),
    updatedAt: visitDate,
    crewMembers: [{ employeeId: 'repair-solver-old-supervisor', role: CrewRole.SUPERVISOR, isPmsSupervisor: true }],
    vehicles: [],
    locks: [],
    generatedVisit: {
      id: 'repair-solver-visit',
      branchCode: BranchCode.COLOMBO,
      visitDate,
      windowStartMinute: startMinute,
      windowEndMinute: startMinute + durationMinutes,
      durationMinutes,
      requiredCrewSize: 1,
      serviceAgreementId: 'repair-solver-agreement',
      serviceAgreement: { serviceSiteId: 'repair-solver-site', requiredSkills: [] },
    },
  };
}

function adapter(reservations: Array<{
  id: string;
  plannedStart: Date;
  plannedEnd: Date;
  generatedVisit: {
    serviceAgreement: { serviceSiteId: string };
  };
  crewMembers: Array<{ employeeId: string }>;
  vehicles: Array<{ vehicleId: string }>;
}> = []): PublishedAssignmentRepairPlannerAdapter {
  const prisma = {
    employee: { findMany: async () => [{
      id: replacementEmployeeId,
      branchCode: BranchCode.COLOMBO,
      isPmsGrade: true,
      deploymentType: DeploymentType.MOBILE,
      canUsePublicTransport: true,
      skills: [], vehicleAuthorizations: [], permanentAssignments: [], availability: [],
    }] },
    vehicle: { findMany: async () => [] },
    assignment: { findMany: async () => reservations },
  } as unknown as PrismaService;
  const config = {
    getOrThrow: () => process.env.SCHEDULER_BASE_URL ?? 'http://127.0.0.1:8000',
    get: () => process.env.SCHEDULER_API_TOKEN,
  } as unknown as ConfigService;
  return new PublishedAssignmentRepairPlannerAdapter(prisma, new SchedulerClient(config));
}

describe('repair adapter through the real Python scheduler', () => {
  it.each([
    ['ordinary fixed window', 540, 60],
    ['fixed window ending at next midnight', 1350, 90],
  ])('staffs a repair target at its %s', async (_name, startMinute, durationMinutes) => {
    const result = await adapter().solve([target(startMinute, durationMinutes)], ['repair-solver-published-source']);

    expect(result.response.assignments).toEqual([
      expect.objectContaining({
        visit_id: 'repair-solver-visit',
        employee_ids: [replacementEmployeeId],
        scheduled_date: '2027-03-03',
        start_minute: startMinute,
      }),
    ]);
    expect(result.response.unassigned).toEqual([]);
  });

  it('keeps a reservation ending next midnight occupied rather than freeing its employee', async () => {
    const result = await adapter([{
      id: 'other-published-assignment',
      plannedStart: new Date('2027-03-03T23:00:00.000Z'),
      plannedEnd: new Date('2027-03-04T00:00:00.000Z'),
      generatedVisit: {
        serviceAgreement: { serviceSiteId: 'other-repair-site' },
      },
      crewMembers: [{ employeeId: replacementEmployeeId }],
      vehicles: [],
    }]).solve([target(1350, 90)], ['repair-solver-published-source']);

    expect(result.response.assignments).toEqual([]);
    expect(result.response.unassigned).toEqual([
      expect.objectContaining({ visit_id: 'repair-solver-visit' }),
    ]);
  });

  it('stages same-day repairs within the customer window instead of manufacturing a shortage at opening time', async () => {
    const first = target(480, 60);
    first.id = 'repair-solver-source-a';
    first.generatedVisitId = 'repair-solver-visit-a';
    first.generatedVisit = {
      ...first.generatedVisit,
      id: first.generatedVisitId,
      windowEndMinute: 660,
      serviceAgreementId: 'repair-solver-agreement-a',
      serviceAgreement: {
        serviceSiteId: 'repair-solver-site-a',
        requiredSkills: [],
      },
    };
    const second = target(480, 60);
    second.id = 'repair-solver-source-b';
    second.generatedVisitId = 'repair-solver-visit-b';
    second.generatedVisit = {
      ...second.generatedVisit,
      id: second.generatedVisitId,
      windowEndMinute: 660,
      serviceAgreementId: 'repair-solver-agreement-b',
      serviceAgreement: {
        serviceSiteId: 'repair-solver-site-b',
        requiredSkills: [],
      },
    };

    const result = await adapter().solve(
      [first, second],
      [first.id, second.id],
    );

    expect(result.response.unassigned).toEqual([]);
    expect(result.response.assignments).toHaveLength(2);
    expect(
      result.response.assignments.map((assignment) => assignment.start_minute).sort(),
    ).toEqual([480, 600]);
  });

  it('preserves an off-grid published start when it remains legal', async () => {
    const source = target(555, 60);
    source.generatedVisit.windowStartMinute = 480;
    source.generatedVisit.windowEndMinute = 1020;

    const result = await adapter().solve([source], [source.id]);

    expect(result.response.unassigned).toEqual([]);
    expect(result.response.assignments).toEqual([
      expect.objectContaining({
        visit_id: source.generatedVisitId,
        scheduled_date: '2027-03-03',
        start_minute: 555,
      }),
    ]);
  });
});

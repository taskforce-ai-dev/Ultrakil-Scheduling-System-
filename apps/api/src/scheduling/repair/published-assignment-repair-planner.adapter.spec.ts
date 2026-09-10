import {
  AssignmentStatus,
  BranchCode,
  CrewRole,
  DeploymentType,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { SchedulerClient, SolveResponse } from '../optimizer/scheduler.client';
import {
  PlannerSourceAssignment,
  PublishedAssignmentRepairPlannerAdapter,
} from './published-assignment-repair-planner.adapter';

const firstSourceId = '11111111-1111-4111-8111-111111111111';
const secondSourceId = '22222222-2222-4222-8222-222222222222';

function target(id: string, visitId: string): PlannerSourceAssignment {
  return {
    id,
    generatedVisitId: visitId,
    branchCode: BranchCode.COLOMBO,
    status: AssignmentStatus.PUBLISHED,
    plannedStart: new Date('2027-03-03T09:00:00.000Z'),
    plannedEnd: new Date('2027-03-03T10:00:00.000Z'),
    updatedAt: new Date('2027-02-28T09:00:00.000Z'),
    crewMembers: [
      {
        employeeId: 'crew-old',
        role: CrewRole.SUPERVISOR,
        isPmsSupervisor: true,
      },
    ],
    vehicles: [],
    locks: [],
    generatedVisit: {
      id: visitId,
      branchCode: BranchCode.COLOMBO,
      visitDate: new Date('2027-03-03T00:00:00.000Z'),
      windowStartMinute: 480,
      windowEndMinute: 1020,
      durationMinutes: 60,
      requiredCrewSize: 1,
      serviceAgreementId: 'agreement',
      serviceAgreement: { serviceSiteId: 'site', requiredSkills: [] },
    },
  };
}

describe('PublishedAssignmentRepairPlannerAdapter', () => {
  it('sends the whole batch once with non-target reservations and exact predecessor exclusions', async () => {
    const answer: SolveResponse = {
      run_id: 'ignored-in-assertion',
      status: 'FEASIBLE',
      assignments: [],
      unassigned: [],
      solve_seconds: 0,
      objective_value: 0,
      visits_considered: 2,
    };
    const prisma = {
      employee: {
        findMany: jest.fn(async () => [
          {
            id: 'employee-b',
            branchCode: BranchCode.COLOMBO,
            isPmsGrade: true,
            deploymentType: DeploymentType.MOBILE,
            canUsePublicTransport: true,
            skills: [],
            vehicleAuthorizations: [],
            permanentAssignments: [],
            availability: [],
          },
        ]),
      },
      vehicle: { findMany: jest.fn(async () => []) },
      assignment: {
        findMany: jest.fn(async () => [
          {
            id: 'non-target',
            plannedStart: new Date('2027-03-03T08:00:00.000Z'),
            plannedEnd: new Date('2027-03-03T09:00:00.000Z'),
            crewMembers: [{ employeeId: 'reserved-employee' }],
            vehicles: [{ vehicleId: 'reserved-vehicle' }],
          },
        ]),
      },
    };
    const scheduler = { solve: jest.fn(async (request) => ({ ...answer, run_id: request.run_id })) };
    const adapter = new PublishedAssignmentRepairPlannerAdapter(
      prisma as unknown as PrismaService,
      scheduler as unknown as SchedulerClient,
    );

    await adapter.solve(
      [target(secondSourceId, 'visit-2'), target(firstSourceId, 'visit-1')],
      [secondSourceId, firstSourceId],
    );

    expect(scheduler.solve).toHaveBeenCalledTimes(1);
    expect(scheduler.solve).toHaveBeenCalledWith(
      expect.objectContaining({
        visits: [
          expect.objectContaining({ id: 'visit-1', candidate_slots: [] }),
          expect.objectContaining({ id: 'visit-2', candidate_slots: [] }),
        ],
        reservations: [
          {
            assignment_id: 'non-target',
            scheduled_date: '2027-03-03',
            start_minute: 480,
            end_minute: 540,
            employee_ids: ['reserved-employee'],
            vehicle_ids: ['reserved-vehicle'],
          },
        ],
        excluded_reservation_assignment_ids: [firstSourceId, secondSourceId],
        existing: [
          expect.objectContaining({ visit_id: 'visit-1' }),
          expect.objectContaining({ visit_id: 'visit-2' }),
        ],
      }),
      expect.any(Number),
    );
    expect(prisma.assignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { notIn: [firstSourceId, secondSourceId] },
          status: {
            in: [
              AssignmentStatus.PUBLISHED,
              AssignmentStatus.ACKNOWLEDGED,
              AssignmentStatus.IN_PROGRESS,
            ],
          },
        }),
      }),
    );
  });

  it('sanitizes scheduler failures behind a stable planner error code', async () => {
    const prisma = {
      employee: { findMany: jest.fn(async () => []) },
      vehicle: { findMany: jest.fn(async () => []) },
      assignment: { findMany: jest.fn(async () => []) },
    };
    const scheduler = {
      solve: jest.fn(async () => {
        throw new Error('connect ECONNREFUSED http://scheduler.internal:8000');
      }),
    };
    const adapter = new PublishedAssignmentRepairPlannerAdapter(
      prisma as unknown as PrismaService,
      scheduler as unknown as SchedulerClient,
    );

    const failure = adapter.solve(
      [target(firstSourceId, 'visit-1')],
      [firstSourceId],
    );

    await expect(failure).rejects.toMatchObject({
      code: 'REPAIR_PLANNER_UNAVAILABLE',
    });
    await expect(failure).rejects.not.toMatchObject({
      message: expect.stringContaining('scheduler.internal'),
    });
  });
});

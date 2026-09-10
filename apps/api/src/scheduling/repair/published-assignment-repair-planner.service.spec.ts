import {
  AssignmentRepairAction,
  AssignmentStatus,
  BranchCode,
  CrewRole,
  LockScope,
  VisitStatus,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { Conflict } from '../eligibility/conflict-codes';
import { EligibilityService } from '../eligibility/eligibility.service';
import {
  PublishedAssignmentRepairPlannerAdapter,
  RepairPlannerSolveResult,
} from './published-assignment-repair-planner.adapter';
import { PublishedAssignmentRepairPlannerService } from './published-assignment-repair-planner.service';
import {
  PublishedAssignmentRepairPreview,
  PublishedAssignmentRepairService,
} from './published-assignment-repair.service';

const sourceId = '11111111-1111-4111-8111-111111111111';
const visitId = '22222222-2222-4222-8222-222222222222';
const employeeId = '33333333-3333-4333-8333-333333333333';

const originalConflict: Conflict = {
  code: 'CREW_CANNOT_TRAVEL',
  message: 'The published crew cannot reach this visit safely.',
  remediation: 'Choose a vehicle or a public-transport-capable crew.',
  resources: { visitId, employeeIds: [employeeId], assignmentIds: [sourceId] },
};

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: sourceId,
    generatedVisitId: visitId,
    branchCode: BranchCode.COLOMBO,
    status: AssignmentStatus.PUBLISHED,
    plannedStart: new Date('2027-03-03T09:00:00.000Z'),
    plannedEnd: new Date('2027-03-03T10:00:00.000Z'),
    updatedAt: new Date('2027-02-28T09:00:00.000Z'),
    crewMembers: [
      { employeeId, role: CrewRole.SUPERVISOR, isPmsSupervisor: true },
    ],
    vehicles: [],
    locks: [] as Array<{ scope: LockScope; reason: string | null }>,
    generatedVisit: {
      id: visitId,
      branchCode: BranchCode.COLOMBO,
      visitDate: new Date('2027-03-03T00:00:00.000Z'),
      windowStartMinute: 480,
      windowEndMinute: 1020,
      durationMinutes: 60,
      requiredCrewSize: 1,
      status: VisitStatus.SCHEDULED,
      serviceAgreementId: '44444444-4444-4444-8444-444444444444',
      serviceAgreement: {
        serviceSiteId: '55555555-5555-4555-8555-555555555555',
        requiredSkills: [],
      },
    },
    ...overrides,
  };
}

function fixture(row = source()) {
  const writes = {
    create: jest.fn(() => {
      throw new Error('planner must not write');
    }),
    update: jest.fn(() => {
      throw new Error('planner must not write');
    }),
    deleteMany: jest.fn(() => {
      throw new Error('planner must not write');
    }),
  };
  const prisma = {
    assignment: { findMany: jest.fn(async () => [row]), ...writes },
  };
  const eligibility = {
    evaluate: jest.fn(async () => ({ isEligible: false, conflicts: [originalConflict] })),
  };
  const solveResult: RepairPlannerSolveResult = {
    response: {
      run_id: 'repair-plan-run',
      status: 'OPTIMAL',
      assignments: [
        {
          visit_id: visitId,
          employee_ids: [employeeId],
          vehicles: [],
          start_minute: 600,
          scheduled_date: '2027-03-03',
        },
      ],
      unassigned: [],
      solve_seconds: 0.1,
      objective_value: 1,
      visits_considered: 1,
    },
    pmsEmployeeIds: new Set([employeeId]),
  };
  const adapter = { solve: jest.fn(async () => solveResult) };
  const preview: PublishedAssignmentRepairPreview = {
    planHash: 'a'.repeat(64),
    isValid: true,
    items: [
      {
        sourceAssignmentId: sourceId,
        visitId,
        action: AssignmentRepairAction.REPLACED,
        sourceFingerprint: 'b'.repeat(64),
        isValid: true,
        conflicts: [],
        timeScope: 'FUTURE',
      },
    ],
  };
  const repairs = { preview: jest.fn(async (_input: unknown) => preview) };
  const service = new PublishedAssignmentRepairPlannerService(
    prisma as unknown as PrismaService,
    eligibility as unknown as EligibilityService,
    adapter as unknown as PublishedAssignmentRepairPlannerAdapter,
    repairs as unknown as PublishedAssignmentRepairService,
  );
  return { service, prisma, eligibility, adapter, repairs, preview, writes };
}

describe('PublishedAssignmentRepairPlannerService', () => {
  it('plans one replacement, returns apply-ready hashes, and performs zero writes', async () => {
    const f = fixture();

    await expect(f.service.plan({ sourceAssignmentIds: [sourceId] })).resolves.toEqual({
      operations: [
        {
          sourceAssignmentId: sourceId,
          action: AssignmentRepairAction.REPLACED,
          replacement: {
            plannedStartMinute: 600,
            plannedEndMinute: 660,
            crew: [{ employeeId, role: CrewRole.SUPERVISOR }],
            vehicles: [],
          },
        },
      ],
      sourceFingerprints: [
        { sourceAssignmentId: sourceId, fingerprint: 'b'.repeat(64) },
      ],
      ...f.preview,
    });
    expect(f.adapter.solve).toHaveBeenCalledTimes(1);
    expect(f.repairs.preview).toHaveBeenCalledWith({
      operations: expect.any(Array),
    });
    expect(f.writes.create).not.toHaveBeenCalled();
    expect(f.writes.update).not.toHaveBeenCalled();
    expect(f.writes.deleteMany).not.toHaveBeenCalled();
  });

  it('turns a locked invalid source into a structured withdrawal without solving', async () => {
    const f = fixture(
      source({ locks: [{ scope: LockScope.FULL, reason: 'Manager decision' }] }),
    );
    f.repairs.preview.mockResolvedValue({
      ...f.preview,
      items: f.preview.items.map((item) => ({
        ...item,
        action: AssignmentRepairAction.WITHDRAWN,
      })),
    });

    const plan = await f.service.plan({ sourceAssignmentIds: [sourceId] });

    expect(f.adapter.solve).not.toHaveBeenCalled();
    expect(plan.operations).toEqual([
      expect.objectContaining({
        sourceAssignmentId: sourceId,
        action: AssignmentRepairAction.WITHDRAWN,
        unassignedReasons: [
          expect.objectContaining({ code: 'ASSIGNMENT_LOCKED' }),
          expect.objectContaining({ code: 'CREW_CANNOT_TRAVEL' }),
        ],
      }),
    ]);
  });

  it('rejects an assignment that already passes current hard rules', async () => {
    const f = fixture();
    f.eligibility.evaluate.mockResolvedValue({ isEligible: true, conflicts: [] });

    await expect(f.service.plan({ sourceAssignmentIds: [sourceId] })).rejects.toMatchObject({
      code: 'REPAIR_TARGET_ALREADY_VALID',
    });
    expect(f.adapter.solve).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'non-published',
      row: source({ status: AssignmentStatus.ACKNOWLEDGED }),
      input: { sourceAssignmentIds: [sourceId] },
      code: 'RESOURCE_CONFLICT',
    },
    {
      name: 'historical',
      row: source({
        generatedVisit: {
          ...source().generatedVisit,
          visitDate: new Date('2020-01-01T00:00:00.000Z'),
        },
      }),
      input: { sourceAssignmentIds: [sourceId] },
      code: 'RESOURCE_CONFLICT',
    },
  ])('rejects a $name target before solving', async ({ row, input, code }) => {
    const f = fixture(row);

    await expect(f.service.plan(input)).rejects.toMatchObject({ code });
    expect(f.adapter.solve).not.toHaveBeenCalled();
  });

  it('requires explicit acknowledgement before planning a current-day target', async () => {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Colombo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const f = fixture(
      source({
        generatedVisit: {
          ...source().generatedVisit,
          visitDate: new Date(`${today}T00:00:00.000Z`),
        },
      }),
    );

    await expect(f.service.plan({ sourceAssignmentIds: [sourceId] })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(f.adapter.solve).not.toHaveBeenCalled();
  });

  it('rejects a visit unless every current published sibling is an explicit target', async () => {
    const f = fixture();
    f.prisma.assignment.findMany
      .mockResolvedValueOnce([source()])
      .mockResolvedValueOnce([
        source(),
        source({ id: '66666666-6666-4666-8666-666666666666' }),
      ]);

    await expect(f.service.plan({ sourceAssignmentIds: [sourceId] })).rejects.toMatchObject({
      code: 'RESOURCE_CONFLICT',
    });
    expect(f.adapter.solve).not.toHaveBeenCalled();
  });

  it('withdraws every explicitly selected predecessor when a visit has multiple published siblings', async () => {
    const siblingId = '66666666-6666-4666-8666-666666666666';
    const first = source();
    const sibling = source({ id: siblingId });
    const f = fixture(first);
    f.prisma.assignment.findMany
      .mockResolvedValueOnce([first, sibling])
      .mockResolvedValueOnce([first, sibling]);
    f.repairs.preview.mockResolvedValue({
      ...f.preview,
      items: [sourceId, siblingId].map((id) => ({
        ...f.preview.items[0],
        sourceAssignmentId: id,
        action: AssignmentRepairAction.WITHDRAWN,
      })),
    });

    const plan = await f.service.plan({
      sourceAssignmentIds: [siblingId, sourceId],
    });

    expect(f.adapter.solve).not.toHaveBeenCalled();
    expect(plan.operations).toHaveLength(2);
    expect(plan.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceAssignmentId: sourceId,
          action: AssignmentRepairAction.WITHDRAWN,
          unassignedReasons: expect.arrayContaining([
            expect.objectContaining({ code: 'MULTIPLE_PUBLISHED_ASSIGNMENTS' }),
          ]),
        }),
        expect.objectContaining({
          sourceAssignmentId: siblingId,
          action: AssignmentRepairAction.WITHDRAWN,
        }),
      ]),
    );
  });

  it('maps a solver refusal to a structured withdrawal with stable fallback reason', async () => {
    const f = fixture();
    f.adapter.solve.mockResolvedValue({
      response: {
        run_id: 'repair-plan-run',
        status: 'INFEASIBLE',
        assignments: [],
        unassigned: [
          {
            visit_id: visitId,
            reason_codes: [],
            message: '',
          },
        ],
        solve_seconds: 0.1,
        objective_value: 0,
        visits_considered: 1,
      },
      pmsEmployeeIds: new Set(),
    });
    f.repairs.preview.mockResolvedValue({
      ...f.preview,
      items: f.preview.items.map((item) => ({
        ...item,
        action: AssignmentRepairAction.WITHDRAWN,
      })),
    });

    const plan = await f.service.plan({ sourceAssignmentIds: [sourceId] });

    expect(plan.operations).toEqual([
      expect.objectContaining({
        action: AssignmentRepairAction.WITHDRAWN,
        unassignedReasons: [
          expect.objectContaining({ code: 'NO_FEASIBLE_CREW' }),
        ],
      }),
    ]);
  });

  it('assigns deterministic roles with a PMS employee first regardless of solver order', async () => {
    const technicianId = '00000000-0000-4000-8000-000000000001';
    const supervisorId = '99999999-9999-4999-8999-999999999999';
    const f = fixture();
    f.adapter.solve.mockResolvedValue({
      response: {
        run_id: 'repair-plan-run',
        status: 'FEASIBLE',
        assignments: [
          {
            visit_id: visitId,
            employee_ids: [technicianId, supervisorId],
            vehicles: [],
            start_minute: 600,
            scheduled_date: '2027-03-03',
          },
        ],
        unassigned: [],
        solve_seconds: 0.1,
        objective_value: 1,
        visits_considered: 1,
      },
      pmsEmployeeIds: new Set([supervisorId]),
    });

    const plan = await f.service.plan({ sourceAssignmentIds: [sourceId] });

    expect(plan.operations[0].replacement?.crew).toEqual([
      { employeeId: supervisorId, role: CrewRole.SUPERVISOR },
      { employeeId: technicianId, role: CrewRole.TECHNICIAN },
    ]);
  });

  it('rejects a solver proposal that fails the existing repair preview', async () => {
    const f = fixture();
    f.repairs.preview.mockResolvedValue({
      ...f.preview,
      isValid: false,
      items: f.preview.items.map((item) => ({
        ...item,
        isValid: false,
        conflicts: [originalConflict],
      })),
    });

    await expect(f.service.plan({ sourceAssignmentIds: [sourceId] })).rejects.toMatchObject({
      code: 'ASSIGNMENT_NOT_ELIGIBLE',
    });
  });
});

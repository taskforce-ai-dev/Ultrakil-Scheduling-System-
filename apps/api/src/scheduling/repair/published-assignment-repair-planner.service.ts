import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AssignmentRepairAction,
  AssignmentStatus,
  CrewRole,
} from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { Conflict, sortConflicts } from '../eligibility/conflict-codes';
import { EligibilityService } from '../eligibility/eligibility.service';
import {
  PlannerSourceAssignment,
  PublishedAssignmentRepairPlannerAdapter,
  RepairPlannerSolveResult,
} from './published-assignment-repair-planner.adapter';
import {
  PublishedAssignmentRepairOperation,
  PublishedAssignmentRepairPreview,
  PublishedAssignmentRepairService,
  repairTimeScope,
} from './published-assignment-repair.service';

const PLANNER_SOURCE_INCLUDE = {
  crewMembers: {
    select: { employeeId: true, role: true, isPmsSupervisor: true },
  },
  vehicles: { select: { vehicleId: true, driverEmployeeId: true } },
  locks: {
    where: { releasedAt: null },
    select: { scope: true, reason: true },
  },
  generatedVisit: {
    select: {
      id: true,
      branchCode: true,
      visitDate: true,
      windowStartMinute: true,
      windowEndMinute: true,
      durationMinutes: true,
      requiredCrewSize: true,
      serviceAgreementId: true,
      serviceAgreement: {
        select: {
          serviceSiteId: true,
          requiredSkills: { select: { skillCode: true } },
        },
      },
    },
  },
} as const;

export interface PublishedAssignmentRepairPlanInput {
  sourceAssignmentIds: string[];
  acknowledgeCurrentDay?: boolean;
}

export interface PublishedAssignmentRepairPlan extends PublishedAssignmentRepairPreview {
  operations: PublishedAssignmentRepairOperation[];
  sourceFingerprints: Array<{
    sourceAssignmentId: string;
    fingerprint: string;
  }>;
}

@Injectable()
export class PublishedAssignmentRepairPlannerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: EligibilityService,
    private readonly adapter: PublishedAssignmentRepairPlannerAdapter,
    private readonly repairs: PublishedAssignmentRepairService,
  ) {}

  async plan(input: PublishedAssignmentRepairPlanInput): Promise<PublishedAssignmentRepairPlan> {
    const sourceIds = [...(input.sourceAssignmentIds ?? [])].sort();
    if (sourceIds.length < 1 || sourceIds.length > 100) {
      throw validationFailed('A repair plan must contain between 1 and 100 source assignments.');
    }
    if (new Set(sourceIds).size !== sourceIds.length) {
      throw validationFailed('A source assignment may appear only once in a repair plan.');
    }

    const rows = (await this.prisma.assignment.findMany({
      where: { id: { in: sourceIds } },
      include: PLANNER_SOURCE_INCLUDE,
      orderBy: { id: 'asc' },
    })) as unknown as PlannerSourceAssignment[];
    if (rows.length !== sourceIds.length) {
      throw new AppException(
        'RESOURCE_CONFLICT',
        'One or more published assignments no longer exist. Refresh the repair findings.',
        HttpStatus.CONFLICT,
      );
    }

    const publishedSiblings = await this.prisma.assignment.findMany({
      where: {
        generatedVisitId: {
          in: [...new Set(rows.map((source) => source.generatedVisitId))],
        },
        status: AssignmentStatus.PUBLISHED,
      },
      select: { id: true, generatedVisitId: true },
      orderBy: { id: 'asc' },
    });
    const selected = new Set(sourceIds);
    const omittedSibling = publishedSiblings.find((sibling) => !selected.has(sibling.id));
    if (omittedSibling) {
      throw new AppException(
        'RESOURCE_CONFLICT',
        'Every current published assignment for an affected visit must be an explicit repair target.',
        HttpStatus.CONFLICT,
        {
          generatedVisitId: omittedSibling.generatedVisitId,
          omittedAssignmentId: omittedSibling.id,
        },
      );
    }

    for (const source of rows) {
      if (source.status !== AssignmentStatus.PUBLISHED) {
        throw new AppException(
          'RESOURCE_CONFLICT',
          `Assignment "${source.id}" is not published and cannot be planned for automatic repair.`,
          HttpStatus.CONFLICT,
          { assignmentId: source.id, status: source.status },
        );
      }
      const timeScope = repairTimeScope(source.generatedVisit.visitDate);
      if (timeScope === 'HISTORICAL') {
        throw new AppException(
          'RESOURCE_CONFLICT',
          'Historical published assignments are evidence and cannot be repaired automatically.',
          HttpStatus.CONFLICT,
          { assignmentId: source.id, timeScope },
        );
      }
      if (timeScope === 'CURRENT_DAY' && input.acknowledgeCurrentDay !== true) {
        throw validationFailed(
          'Current-day repair planning requires explicit acknowledgeCurrentDay confirmation.',
        );
      }
    }

    const evaluated = await Promise.all(
      rows.map(async (source) => ({
        source,
        conflicts: sortConflicts(
          (
            await this.eligibility.evaluate(
              source.generatedVisitId,
              sourceProposal(source),
              { excludeAssignmentId: source.id },
            )
          ).conflicts,
        ),
      })),
    );
    const valid = evaluated.find(({ conflicts }) => conflicts.length === 0);
    if (valid) {
      throw new AppException(
        'REPAIR_TARGET_ALREADY_VALID',
        'Automatic repair accepts only published assignments that currently violate a hard rule.',
        HttpStatus.CONFLICT,
        { assignmentId: valid.source.id },
      );
    }

    const sourcesPerVisit = new Map<string, number>();
    for (const source of rows) {
      sourcesPerVisit.set(
        source.generatedVisitId,
        (sourcesPerVisit.get(source.generatedVisitId) ?? 0) + 1,
      );
    }
    const lockedOrAmbiguous = evaluated.filter(
      ({ source }) =>
        source.locks.length > 0 || (sourcesPerVisit.get(source.generatedVisitId) ?? 0) > 1,
    );
    const solvable = evaluated
      .filter(
        ({ source }) =>
          source.locks.length === 0 &&
          (sourcesPerVisit.get(source.generatedVisitId) ?? 0) === 1,
      )
      .map(({ source }) => source);
    const solved = solvable.length > 0
      ? await this.adapter.solve(solvable, sourceIds)
      : undefined;
    const operations = [
      ...lockedOrAmbiguous.map(({ source, conflicts }) =>
        protectedWithdrawal(
          source,
          conflicts,
          (sourcesPerVisit.get(source.generatedVisitId) ?? 0) > 1,
        ),
      ),
      ...mapSolverOperations(solvable, solved),
    ].sort((left, right) => left.sourceAssignmentId.localeCompare(right.sourceAssignmentId));

    const preview = await this.repairs.preview({ operations });
    if (!preview.isValid) {
      throw new AppException(
        'ASSIGNMENT_NOT_ELIGIBLE',
        'The scheduler proposal did not pass final published-repair validation.',
        HttpStatus.CONFLICT,
        { items: preview.items },
      );
    }
    return {
      operations,
      sourceFingerprints: preview.items.map((item) => ({
        sourceAssignmentId: item.sourceAssignmentId,
        fingerprint: item.sourceFingerprint,
      })),
      ...preview,
    };
  }
}

function mapSolverOperations(
  sources: PlannerSourceAssignment[],
  solved: RepairPlannerSolveResult | undefined,
): PublishedAssignmentRepairOperation[] {
  if (sources.length === 0) return [];
  if (!solved) throw invalidSolverResponse('The scheduler returned no repair result.');
  const byVisit = new Map(sources.map((source) => [source.generatedVisitId, source]));
  const operations = new Map<string, PublishedAssignmentRepairOperation>();

  for (const assignment of solved.response.assignments) {
    const source = byVisit.get(assignment.visit_id);
    if (!source) throw invalidSolverResponse('The scheduler returned an unknown repair visit.');
    if (operations.has(source.id)) {
      throw invalidSolverResponse('The scheduler returned multiple outcomes for one repair visit.');
    }
    if (assignment.scheduled_date !== dateOnly(source.generatedVisit.visitDate)) {
      throw invalidSolverResponse('A published repair cannot move its generated visit to another day.');
    }
    const employeeIds = [...assignment.employee_ids].sort((left, right) => {
      const pmsDifference = Number(solved.pmsEmployeeIds.has(right)) - Number(solved.pmsEmployeeIds.has(left));
      return pmsDifference || left.localeCompare(right);
    });
    operations.set(source.id, {
      sourceAssignmentId: source.id,
      action: AssignmentRepairAction.REPLACED,
      replacement: {
        plannedStartMinute: assignment.start_minute,
        plannedEndMinute: assignment.start_minute + source.generatedVisit.durationMinutes,
        crew: employeeIds.map((employeeId, index) => ({
          employeeId,
          role: index === 0 ? CrewRole.SUPERVISOR : CrewRole.TECHNICIAN,
        })),
        vehicles: [...assignment.vehicles]
          .sort((left, right) => left.vehicle_id.localeCompare(right.vehicle_id))
          .map((entry) => ({
            vehicleId: entry.vehicle_id,
            driverEmployeeId: entry.driver_employee_id,
          })),
      },
    });
  }

  for (const unassigned of solved.response.unassigned) {
    const source = byVisit.get(unassigned.visit_id);
    if (!source) throw invalidSolverResponse('The scheduler returned an unknown repair visit.');
    if (operations.has(source.id)) {
      throw invalidSolverResponse('The scheduler returned multiple outcomes for one repair visit.');
    }
    const codes = unassigned.reason_codes.length > 0
      ? [...unassigned.reason_codes].sort()
      : ['NO_FEASIBLE_CREW'];
    operations.set(source.id, {
      sourceAssignmentId: source.id,
      action: AssignmentRepairAction.WITHDRAWN,
      unassignedReasons: codes.map((code) => ({
        code,
        message:
          unassigned.reason_messages?.[code] ??
          unassigned.message ??
          'No feasible crew and vehicle combination was found.',
      })),
    });
  }

  for (const source of sources) {
    if (operations.has(source.id)) continue;
    operations.set(source.id, {
      sourceAssignmentId: source.id,
      action: AssignmentRepairAction.WITHDRAWN,
      unassignedReasons: [
        {
          code: 'NO_FEASIBLE_CREW',
          message: 'No feasible crew and vehicle combination was found.',
        },
      ],
    });
  }
  return [...operations.values()];
}

function protectedWithdrawal(
  source: PlannerSourceAssignment,
  conflicts: Conflict[],
  hasPublishedSiblings: boolean,
): PublishedAssignmentRepairOperation {
  const lock = source.locks[0];
  const dispositionReasons = [
    ...(lock
      ? [
          {
            code: 'ASSIGNMENT_LOCKED',
            message: lock.reason
              ? `The published assignment is protected by a manager lock: ${lock.reason}`
              : 'The published assignment is protected by a manager lock.',
            details: { scope: lock.scope, reason: lock.reason },
          },
        ]
      : []),
    ...(hasPublishedSiblings
      ? [
          {
            code: 'MULTIPLE_PUBLISHED_ASSIGNMENTS',
            message:
              'This visit has multiple current published assignments; each predecessor is withdrawn explicitly.',
          },
        ]
      : []),
  ];
  return {
    sourceAssignmentId: source.id,
    action: AssignmentRepairAction.WITHDRAWN,
    unassignedReasons: [
      ...dispositionReasons,
      ...conflicts.map((conflict) => ({
        code: conflict.code,
        message: conflict.message,
        details: {
          remediation: conflict.remediation,
          resources: conflict.resources,
        },
      })),
    ],
  };
}

function sourceProposal(source: PlannerSourceAssignment) {
  const visitStart = source.generatedVisit.visitDate.getTime();
  return {
    plannedStartMinute: Math.round((source.plannedStart.getTime() - visitStart) / 60_000),
    plannedEndMinute: Math.round((source.plannedEnd.getTime() - visitStart) / 60_000),
    crew: source.crewMembers.map((member) => ({
      employeeId: member.employeeId,
      role: member.role,
    })),
    vehicles: source.vehicles.map((vehicle) => ({
      vehicleId: vehicle.vehicleId,
      driverEmployeeId: vehicle.driverEmployeeId ?? null,
    })),
  };
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function validationFailed(message: string): AppException {
  return new AppException('VALIDATION_FAILED', message, HttpStatus.UNPROCESSABLE_ENTITY);
}

function invalidSolverResponse(message: string): AppException {
  return new AppException('RESOURCE_CONFLICT', message, HttpStatus.CONFLICT);
}

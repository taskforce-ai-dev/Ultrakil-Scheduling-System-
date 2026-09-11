import { randomUUID } from 'node:crypto';

import {
  AssignmentStatus,
  BranchCode,
  CrewRole,
  DeploymentType,
  LockScope,
} from '@prisma/client';
import { HttpStatus, Injectable } from '@nestjs/common';

import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SchedulerClient,
  SolveRequest,
  SolveResponse,
} from '../optimizer/scheduler.client';

const REPAIR_SOLVER_SECONDS = 20;
const REPAIR_SOLVER_TRANSPORT_SECONDS = 5;
const RESERVATION_STATUSES = [
  AssignmentStatus.DRAFT,
  AssignmentStatus.PROPOSED,
  AssignmentStatus.PUBLISHED,
  AssignmentStatus.ACKNOWLEDGED,
  AssignmentStatus.IN_PROGRESS,
];

export interface PlannerSourceAssignment {
  id: string;
  generatedVisitId: string;
  branchCode: BranchCode;
  status: AssignmentStatus;
  plannedStart: Date;
  plannedEnd: Date;
  updatedAt: Date;
  crewMembers: Array<{
    employeeId: string;
    role: CrewRole;
    isPmsSupervisor: boolean;
  }>;
  vehicles: Array<{ vehicleId: string; driverEmployeeId?: string | null }>;
  locks: Array<{ scope: LockScope; reason: string | null }>;
  generatedVisit: {
    id: string;
    branchCode: BranchCode;
    visitDate: Date;
    windowStartMinute: number;
    windowEndMinute: number;
    durationMinutes: number;
    requiredCrewSize: number;
    serviceAgreementId: string;
    serviceAgreement: {
      serviceSiteId: string;
      requiredSkills: Array<{ skillCode: string }>;
    };
  };
}

export interface RepairPlannerSolveResult {
  response: SolveResponse;
  pmsEmployeeIds: Set<string>;
}

@Injectable()
export class PublishedAssignmentRepairPlannerAdapter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: SchedulerClient,
  ) {}

  async solve(
    targets: PlannerSourceAssignment[],
    allSourceAssignmentIds: string[],
  ): Promise<RepairPlannerSolveResult> {
    const orderedTargets = [...targets].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const excludedIds = [...allSourceAssignmentIds].sort();
    const branches = [
      ...new Set(
        orderedTargets.map((target) => target.generatedVisit.branchCode),
      ),
    ].sort();
    const rangeStart = new Date(
      Math.min(
        ...orderedTargets.map((target) =>
          target.generatedVisit.visitDate.getTime(),
        ),
      ),
    );
    const lastDate = new Date(
      Math.max(
        ...orderedTargets.map((target) =>
          target.generatedVisit.visitDate.getTime(),
        ),
      ),
    );
    const rangeEndExclusive = new Date(lastDate);
    rangeEndExclusive.setUTCDate(rangeEndExclusive.getUTCDate() + 1);

    const [employees, vehicles, reservations] = await Promise.all([
      this.prisma.employee.findMany({
        where: { isActive: true, branchCode: { in: branches } },
        include: {
          skills: { select: { skillCode: true } },
          vehicleAuthorizations: { select: { vehicleId: true } },
          permanentAssignments: { select: { serviceSiteId: true } },
          availability: { select: { startDate: true, endDate: true } },
        },
        orderBy: { id: 'asc' },
      }),
      this.prisma.vehicle.findMany({
        where: { isActive: true },
        include: { branch: { select: { code: true } } },
        orderBy: { id: 'asc' },
      }),
      this.prisma.assignment.findMany({
        where: {
          id: { notIn: excludedIds },
          status: { in: RESERVATION_STATUSES },
          plannedStart: { lt: rangeEndExclusive },
          plannedEnd: { gt: rangeStart },
        },
        select: {
          id: true,
          plannedStart: true,
          plannedEnd: true,
          crewMembers: { select: { employeeId: true } },
          vehicles: { select: { vehicleId: true } },
        },
        orderBy: { id: 'asc' },
      }),
    ]);

    const runId = randomUUID();
    const request: SolveRequest = {
      run_id: runId,
      visits: orderedTargets.map((source) => ({
        id: source.generatedVisitId,
        branch_code: source.generatedVisit.branchCode,
        visit_date: dateOnly(source.generatedVisit.visitDate),
        window_start_minute: source.generatedVisit.windowStartMinute,
        window_end_minute: source.generatedVisit.windowEndMinute,
        duration_minutes: source.generatedVisit.durationMinutes,
        required_crew_size: source.generatedVisit.requiredCrewSize,
        required_skill_codes:
          source.generatedVisit.serviceAgreement.requiredSkills
            .map((entry) => entry.skillCode)
            .sort(),
        service_site_id: source.generatedVisit.serviceAgreement.serviceSiteId,
        service_agreement_id: source.generatedVisit.serviceAgreementId,
        is_preferred_day: false,
        candidate_slots: [],
        occupied_start_keys: [],
      })),
      employees: employees.map((employee) => ({
        id: employee.id,
        branch_code: employee.branchCode,
        is_pms_grade: employee.isPmsGrade,
        is_permanently_stationed:
          employee.deploymentType === DeploymentType.PERMANENTLY_STATIONED,
        permanent_site_ids: employee.permanentAssignments
          .map((entry) => entry.serviceSiteId)
          .sort(),
        skill_codes: employee.skills.map((entry) => entry.skillCode).sort(),
        authorized_vehicle_ids: employee.vehicleAuthorizations
          .map((entry) => entry.vehicleId)
          .sort(),
        can_use_public_transport: employee.canUsePublicTransport,
        unavailable_dates: expandUnavailableDates(employee.availability),
      })),
      vehicles: vehicles.map((vehicle) => ({
        id: vehicle.id,
        branch_code: vehicle.branch?.code ?? null,
        seat_capacity: vehicle.seatCapacity,
      })),
      locks: [],
      existing: orderedTargets.map((source) => ({
        visit_id: source.generatedVisitId,
        employee_ids: source.crewMembers
          .map((entry) => entry.employeeId)
          .sort(),
        vehicle_ids: source.vehicles.map((entry) => entry.vehicleId).sort(),
      })),
      reservations: reservations.map((assignment) => ({
        assignment_id: assignment.id,
        scheduled_date: dateOnly(assignment.plannedStart),
        start_minute: minuteOfDay(assignment.plannedStart),
        end_minute: minuteOfDay(assignment.plannedEnd),
        employee_ids: assignment.crewMembers
          .map((entry) => entry.employeeId)
          .sort(),
        vehicle_ids: assignment.vehicles.map((entry) => entry.vehicleId).sort(),
      })),
      excluded_reservation_assignment_ids: excludedIds,
      time_limit_seconds: REPAIR_SOLVER_SECONDS,
    };

    const solveDays = new Set(
      orderedTargets.map((target) => dateOnly(target.generatedVisit.visitDate)),
    ).size;
    const timeoutMs =
      (REPAIR_SOLVER_SECONDS * solveDays + REPAIR_SOLVER_TRANSPORT_SECONDS) *
      1000;
    let response: SolveResponse;
    try {
      response = await this.scheduler.solve(request, timeoutMs);
    } catch {
      throw new AppException(
        'REPAIR_PLANNER_UNAVAILABLE',
        'The automatic repair planner is temporarily unavailable. Try again before applying any repair.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (response.run_id !== runId) {
      throw invalidSolverResponse(
        'The scheduler returned a result for a different repair plan.',
      );
    }
    return {
      response,
      pmsEmployeeIds: new Set(
        employees
          .filter((employee) => employee.isPmsGrade)
          .map((employee) => employee.id),
      ),
    };
  }
}

function invalidSolverResponse(message: string): AppException {
  return new AppException('RESOURCE_CONFLICT', message, HttpStatus.CONFLICT);
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function minuteOfDay(value: Date): number {
  return value.getUTCHours() * 60 + value.getUTCMinutes();
}

function expandUnavailableDates(
  ranges: Array<{ startDate: Date; endDate: Date }>,
): string[] {
  const dates = new Set<string>();
  for (const range of ranges) {
    const cursor = new Date(range.startDate);
    while (cursor <= range.endDate) {
      dates.add(dateOnly(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }
  return [...dates].sort();
}

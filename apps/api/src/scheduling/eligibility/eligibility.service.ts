import { HttpStatus, Injectable } from '@nestjs/common';
import { AssignmentStatus, BranchCode, Prisma } from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AssignmentProposal,
  EligibilityContext,
  EligibilityResult,
  EmployeeFacts,
  VehicleFacts,
  evaluateAssignment,
} from './rules';

/** Assignments that actually hold a resource. A cancelled one frees it again. */
const LIVE_ASSIGNMENT_STATUSES: AssignmentStatus[] = [
  AssignmentStatus.DRAFT,
  AssignmentStatus.PROPOSED,
  AssignmentStatus.PUBLISHED,
  AssignmentStatus.ACKNOWLEDGED,
  AssignmentStatus.IN_PROGRESS,
];

/** Minutes from midnight, in the same UTC terms the visit window uses. */
function minuteOfDay(moment: Date): number {
  return moment.getUTCHours() * 60 + moment.getUTCMinutes();
}

/**
 * Gathers the facts a decision needs, then hands them to the pure engine.
 *
 * The split matters: every judgement lives in `rules.ts` and is unit-tested
 * without a database, while everything here is loading. If a rule ever appears
 * in this file, the guarantee that the same input yields the same result has
 * quietly been broken.
 */
@Injectable()
export class EligibilityService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Builds the context for one visit.
   *
   * `excludeAssignmentId` is the visit's own current assignment: re-checking a
   * crew must not report them as double-booked against themselves.
   */
  async buildContext(
    visitId: string,
    proposal: AssignmentProposal,
    options: { excludeAssignmentId?: string } = {},
  ): Promise<EligibilityContext> {
    const visit = await this.prisma.generatedVisit.findUnique({
      where: { id: visitId },
      include: {
        serviceAgreement: {
          include: {
            customer: { select: { name: true } },
            serviceSite: { select: { id: true, name: true } },
            requiredSkills: { select: { skillCode: true } },
          },
        },
        assignments: {
          where: { status: { in: LIVE_ASSIGNMENT_STATUSES } },
          include: { locks: { where: { releasedAt: null } } },
        },
      },
    });

    if (!visit) {
      throw new AppException(
        'RESOURCE_NOT_FOUND',
        `Visit "${visitId}" was not found. Refresh the calendar — it may have been removed by a regeneration.`,
        HttpStatus.NOT_FOUND,
        { visitId },
      );
    }

    const employeeIds = [...new Set(proposal.crew.map((member) => member.employeeId))];
    const vehicleIds = [...new Set(proposal.vehicles.map((entry) => entry.vehicleId))];

    const [employees, vehicles, pmsCount] = await Promise.all([
      this.loadEmployees(employeeIds, visit.visitDate, options.excludeAssignmentId),
      this.loadVehicles(vehicleIds, visit.visitDate, options.excludeAssignmentId),
      this.prisma.employee.count({
        where: { branchCode: visit.branchCode, isPmsGrade: true, isActive: true },
      }),
    ]);

    const lock = visit.assignments
      .flatMap((assignment) =>
        assignment.locks.map((entry) => ({
          assignmentId: assignment.id,
          scope: entry.scope as string,
          reason: entry.reason,
        })),
      )
      .find((entry) => entry.assignmentId !== options.excludeAssignmentId);

    return {
      visit: {
        id: visit.id,
        branchCode: visit.branchCode,
        visitDate: visit.visitDate.toISOString().slice(0, 10),
        windowStartMinute: visit.windowStartMinute,
        windowEndMinute: visit.windowEndMinute,
        durationMinutes: visit.durationMinutes,
        requiredCrewSize: visit.requiredCrewSize,
        serviceSiteId: visit.serviceAgreement.serviceSite.id,
        siteName: visit.serviceAgreement.serviceSite.name,
        customerName: visit.serviceAgreement.customer.name,
        requiredSkillCodes: visit.serviceAgreement.requiredSkills
          .map((skill) => skill.skillCode)
          .sort(),
        status: visit.status,
      },
      employees,
      vehicles,
      branchHasPmsSupervisor: pmsCount > 0,
      existingLock: lock ?? null,
    };
  }

  async evaluate(
    visitId: string,
    proposal: AssignmentProposal,
    options: { excludeAssignmentId?: string } = {},
  ): Promise<EligibilityResult> {
    const context = await this.buildContext(visitId, proposal, options);
    return evaluateAssignment(proposal, context);
  }

  private async loadEmployees(
    ids: string[],
    visitDate: Date,
    excludeAssignmentId?: string,
  ): Promise<EmployeeFacts[]> {
    if (ids.length === 0) return [];

    const employees = await this.prisma.employee.findMany({
      where: { id: { in: ids } },
      include: {
        skills: { select: { skillCode: true } },
        vehicleAuthorizations: { select: { vehicleId: true } },
        availability: {
          where: { startDate: { lte: visitDate }, endDate: { gte: visitDate } },
          select: { kind: true },
        },
        permanentAssignments: {
          where: {
            effectiveFrom: { lte: visitDate },
            OR: [{ effectiveTo: null }, { effectiveTo: { gte: visitDate } }],
          },
          select: { serviceSiteId: true },
        },
        crewMemberships: {
          where: {
            assignment: {
              status: { in: LIVE_ASSIGNMENT_STATUSES },
              generatedVisit: { visitDate },
              ...(excludeAssignmentId ? { id: { not: excludeAssignmentId } } : {}),
            },
          },
          select: {
            assignment: { select: { id: true, plannedStart: true, plannedEnd: true } },
          },
        },
      },
      // Sorted so the engine sees a stable order whatever the database returns.
      orderBy: { id: 'asc' },
    });

    return employees.map((employee) => ({
      id: employee.id,
      fullName: employee.fullName,
      branchCode: employee.branchCode,
      isActive: employee.isActive,
      isPmsGrade: employee.isPmsGrade,
      deploymentType: employee.deploymentType,
      permanentSiteIds: employee.permanentAssignments
        .map((entry) => entry.serviceSiteId)
        .sort(),
      skillCodes: employee.skills.map((skill) => skill.skillCode).sort(),
      authorizedVehicleIds: employee.vehicleAuthorizations
        .map((entry) => entry.vehicleId)
        .sort(),
      unavailableReason: employee.availability[0]?.kind ?? null,
      busy: employee.crewMemberships
        .map((entry) => ({
          assignmentId: entry.assignment.id,
          startMinute: minuteOfDay(entry.assignment.plannedStart),
          endMinute: minuteOfDay(entry.assignment.plannedEnd),
        }))
        .sort((left, right) => left.startMinute - right.startMinute),
    }));
  }

  private async loadVehicles(
    ids: string[],
    visitDate: Date,
    excludeAssignmentId?: string,
  ): Promise<VehicleFacts[]> {
    if (ids.length === 0) return [];

    const vehicles = await this.prisma.vehicle.findMany({
      where: { id: { in: ids } },
      include: {
        branch: { select: { code: true } },
        assignmentVehicles: {
          where: {
            assignment: {
              status: { in: LIVE_ASSIGNMENT_STATUSES },
              generatedVisit: { visitDate },
              ...(excludeAssignmentId ? { id: { not: excludeAssignmentId } } : {}),
            },
          },
          select: {
            assignment: { select: { id: true, plannedStart: true, plannedEnd: true } },
          },
        },
      },
      orderBy: { id: 'asc' },
    });

    return vehicles.map((vehicle) => ({
      id: vehicle.id,
      label: vehicle.label,
      branchCode: vehicle.branch?.code ?? null,
      isActive: vehicle.isActive,
      seatCapacity: vehicle.seatCapacity,
      busy: vehicle.assignmentVehicles
        .map((entry) => ({
          assignmentId: entry.assignment.id,
          startMinute: minuteOfDay(entry.assignment.plannedStart),
          endMinute: minuteOfDay(entry.assignment.plannedEnd),
        }))
        .sort((left, right) => left.startMinute - right.startMinute),
    }));
  }

  /** Branches with no PMS-grade supervisor at all — the Kandy problem. */
  async branchesWithoutSupervisor(): Promise<BranchCode[]> {
    const counts = await this.prisma.employee.groupBy({
      by: ['branchCode'],
      where: { isPmsGrade: true, isActive: true },
      _count: { _all: true },
    });
    const staffed = new Set(counts.map((row) => row.branchCode));
    return Object.values(BranchCode).filter((code) => !staffed.has(code));
  }
}

/** Kept so the module's Prisma types stay reachable from tests. */
export type EligibilityWhere = Prisma.GeneratedVisitWhereInput;

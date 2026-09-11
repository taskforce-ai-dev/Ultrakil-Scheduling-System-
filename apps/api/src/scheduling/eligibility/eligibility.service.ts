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

interface EligibilityOptions {
  excludeAssignmentId?: string;
  /** A repair batch replaces all of these reservations atomically. */
  excludeAssignmentIds?: string[];
  /** Evaluate a solver's proposed move without changing the stored visit. */
  proposedVisit?: {
    visitDate: Date;
    windowStartMinute: number;
    windowEndMinute: number;
    durationMinutes?: number;
    requiredCrewSize?: number;
  };
}

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
    options: EligibilityOptions = {},
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<EligibilityContext> {
    const visit = await client.generatedVisit.findUnique({
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
    const timing = options.proposedVisit ?? visit;
    const excludedAssignmentIds =
      options.excludeAssignmentIds ??
      (options.excludeAssignmentId ? [options.excludeAssignmentId] : []);

    const [employees, vehicles, pmsCount] = await Promise.all([
      this.loadEmployees(client, employeeIds, timing.visitDate, excludedAssignmentIds),
      this.loadVehicles(client, vehicleIds, timing.visitDate, excludedAssignmentIds),
      client.employee.count({
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
      .find((entry) => !excludedAssignmentIds.includes(entry.assignmentId));

    return {
      visit: {
        id: visit.id,
        branchCode: visit.branchCode,
        visitDate: timing.visitDate.toISOString().slice(0, 10),
        windowStartMinute: timing.windowStartMinute,
        windowEndMinute: timing.windowEndMinute,
        durationMinutes: options.proposedVisit?.durationMinutes ?? visit.durationMinutes,
        requiredCrewSize: options.proposedVisit?.requiredCrewSize ?? visit.requiredCrewSize,
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
    options: EligibilityOptions = {},
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<EligibilityResult> {
    // A schedule batch supplies its transaction so subsequent proposals see
    // earlier accepted replacements and all retained/external assignments.
    const context = await this.buildContext(visitId, proposal, options, client);
    return evaluateAssignment(proposal, context);
  }

  private async loadEmployees(
    client: Prisma.TransactionClient,
    ids: string[],
    visitDate: Date,
    excludeAssignmentIds: string[] = [],
  ): Promise<EmployeeFacts[]> {
    if (ids.length === 0) return [];

    const employees = await client.employee.findMany({
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
              ...assignmentExclusion(excludeAssignmentIds),
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
      canUsePublicTransport: employee.canUsePublicTransport,
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
    client: Prisma.TransactionClient,
    ids: string[],
    visitDate: Date,
    excludeAssignmentIds: string[] = [],
  ): Promise<VehicleFacts[]> {
    if (ids.length === 0) return [];

    const vehicles = await client.vehicle.findMany({
      where: { id: { in: ids } },
      include: {
        branch: { select: { code: true } },
        assignmentVehicles: {
          where: {
            assignment: {
              status: { in: LIVE_ASSIGNMENT_STATUSES },
              generatedVisit: { visitDate },
              ...assignmentExclusion(excludeAssignmentIds),
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

function assignmentExclusion(ids: string[]) {
  if (ids.length === 0) return {};
  return ids.length === 1
    ? { id: { not: ids[0] } }
    : { id: { notIn: [...ids].sort() } };
}

import { HttpStatus, Injectable } from '@nestjs/common';
import { AssignmentStatus, BranchCode, DeploymentType, Prisma } from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AssignmentCandidatesDto,
  AssignmentCandidateReasonCode,
  AssignmentCandidateWindowDto,
} from './dto';
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

  /** Loads and judges individual candidate availability, not crew feasibility. */
  async candidates(
    visitId: string,
    dto: AssignmentCandidateWindowDto,
    excludeAssignmentId?: string,
  ): Promise<AssignmentCandidatesDto> {
    const visit = await this.prisma.generatedVisit.findUnique({
      where: { id: visitId },
      include: { serviceAgreement: { select: { serviceSiteId: true } } },
    });
    if (!visit) {
      throw new AppException('RESOURCE_NOT_FOUND', `Visit "${visitId}" was not found. Refresh the calendar — it may have been removed by a regeneration.`, HttpStatus.NOT_FOUND, { visitId });
    }
    const assignment = {
      status: { in: LIVE_ASSIGNMENT_STATUSES },
      generatedVisit: { visitDate: visit.visitDate },
      ...(excludeAssignmentId ? { id: { not: excludeAssignmentId } } : {}),
    };
    const [employees, vehicles] = await Promise.all([
      this.prisma.employee.findMany({
        where: { isActive: true, branchCode: visit.branchCode },
        include: {
          availability: { where: { startDate: { lte: visit.visitDate }, endDate: { gte: visit.visitDate } }, select: { kind: true }, orderBy: [{ startDate: 'asc' }, { endDate: 'asc' }, { id: 'asc' }] },
          permanentAssignments: { where: { effectiveFrom: { lte: visit.visitDate }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: visit.visitDate } }] }, select: { serviceSiteId: true } },
          crewMemberships: { where: { assignment }, select: { assignment: { select: { id: true, plannedStart: true, plannedEnd: true } } } },
        },
      }),
      this.prisma.vehicle.findMany({
        where: { isActive: true, OR: [{ branch: { is: { code: visit.branchCode } } }, { branchId: null }] },
        include: { assignmentVehicles: { where: { assignment }, select: { assignment: { select: { id: true, plannedStart: true, plannedEnd: true } } } } },
      }),
    ]);
    const minutes = (time: Date) => Math.round((time.getTime() - visit.visitDate.getTime()) / 60_000);
    const overlaps = (booking: { plannedStart: Date; plannedEnd: Date }) => dto.plannedStartMinute < minutes(booking.plannedEnd) && minutes(booking.plannedStart) < dto.plannedEndMinute;
    const bookedMessage = (booking: { plannedStart: Date; plannedEnd: Date }) => {
      const show = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
      return `Booked ${show(minutes(booking.plannedStart))}–${show(minutes(booking.plannedEnd))}`;
    };
    const employeeCandidates = employees.map((employee) => {
      const booking = employee.crewMemberships.map((member) => member.assignment).filter(overlaps).sort((left, right) => left.plannedStart.getTime() - right.plannedStart.getTime() || left.id.localeCompare(right.id))[0];
      const reason = employee.availability[0]
        ? { code: AssignmentCandidateReasonCode.EMPLOYEE_UNAVAILABLE, message: `Unavailable (${employee.availability[0].kind})` }
        : employee.deploymentType === DeploymentType.PERMANENTLY_STATIONED && !employee.permanentAssignments.some((entry) => entry.serviceSiteId === visit.serviceAgreement.serviceSiteId)
          ? { code: AssignmentCandidateReasonCode.EMPLOYEE_PERMANENTLY_STATIONED, message: 'Permanently stationed elsewhere' }
          : booking ? { code: AssignmentCandidateReasonCode.EMPLOYEE_DOUBLE_BOOKED, message: bookedMessage(booking) } : null;
      return { employeeId: employee.id, displayName: employee.fullName, isPmsGrade: employee.isPmsGrade, isAvailable: !reason, unavailableReason: reason };
    });
    const vehicleCandidates = vehicles.map((vehicle) => {
      const booking = vehicle.assignmentVehicles.map((entry) => entry.assignment).filter(overlaps).sort((left, right) => left.plannedStart.getTime() - right.plannedStart.getTime() || left.id.localeCompare(right.id))[0];
      const reason = booking ? { code: AssignmentCandidateReasonCode.VEHICLE_DOUBLE_BOOKED, message: bookedMessage(booking) } : null;
      return { vehicleId: vehicle.id, displayName: vehicle.label, seatCapacity: vehicle.seatCapacity, isAvailable: !reason, unavailableReason: reason };
    });
    const compare = <T extends { isAvailable: boolean }>(name: (item: T) => string, id: (item: T) => string) => (left: T, right: T) => Number(right.isAvailable) - Number(left.isAvailable) || name(left).localeCompare(name(right)) || id(left).localeCompare(id(right));
    return {
      employees: employeeCandidates.sort(compare((item) => item.displayName, (item) => item.employeeId)),
      vehicles: vehicleCandidates.sort(compare((item) => item.displayName, (item) => item.vehicleId)),
    };
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

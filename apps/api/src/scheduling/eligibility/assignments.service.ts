import { HttpStatus, Injectable } from '@nestjs/common';
import { AssignmentStatus, CrewRole, Prisma, VisitStatus } from '@prisma/client';

import { AuditService } from '../../audit/audit.service';
import { AuthenticatedUser } from '../../auth/auth.types';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { assertScheduleSnapshot, assertUnpublishedVisit, lockScheduleVisits } from '../optimizer/schedule-visit-lock';
import { Conflict } from './conflict-codes';
import {
  AssignCrewDto,
  AssignmentDto,
  ConflictDto,
  EligibilityResultDto,
  EmployeeAssignmentDto,
  EmployeeAssignmentQueryDto,
  UnassignedVisitDto,
} from './dto';
import { EligibilityService } from './eligibility.service';
import { AssignmentProposal } from './rules';

const LIVE_STATUSES: AssignmentStatus[] = [
  AssignmentStatus.DRAFT,
  AssignmentStatus.PROPOSED,
  AssignmentStatus.PUBLISHED,
  AssignmentStatus.ACKNOWLEDGED,
  AssignmentStatus.IN_PROGRESS,
];

/** States descended from a published assignment and therefore still visible
 * to the employee who was told about the job. */
const EMPLOYEE_ASSIGNMENT_STATUSES: AssignmentStatus[] = [
  AssignmentStatus.PUBLISHED,
  AssignmentStatus.ACKNOWLEDGED,
  AssignmentStatus.IN_PROGRESS,
  AssignmentStatus.COMPLETED,
];

const ASSIGNMENT_INCLUDE = {
  crewMembers: { include: { employee: { select: { fullName: true } } } },
  vehicles: {
    include: {
      vehicle: { select: { label: true } },
      driverEmployee: { select: { fullName: true } },
    },
  },
  locks: { where: { releasedAt: null } },
} satisfies Prisma.AssignmentInclude;

type AssignmentWithRelations = Prisma.AssignmentGetPayload<{
  include: typeof ASSIGNMENT_INCLUDE;
}>;

/** Combines a date-only visit date with a minute-of-day, in UTC. */
function at(visitDate: Date, minute: number): Date {
  return new Date(visitDate.getTime() + minute * 60_000);
}

/**
 * Putting crews on visits — and refusing to, when the rules say so.
 *
 * Every write goes through the eligibility engine. There is deliberately no
 * "force" flag and no second path that skips the check: the task's acceptance
 * criterion is that standard API mutations cannot bypass it, and an escape
 * hatch is exactly how an infeasible assignment ends up looking scheduled.
 *
 * A refusal is a working outcome, not an error to swallow. The conflicts are
 * written to the visit's Unassigned queue *and* returned to the caller, so the
 * work is visible whether the manager is looking at this screen or the queue.
 */
@Injectable()
export class AssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: EligibilityService,
    private readonly audit: AuditService,
  ) {}

  /** Judges a proposal and writes nothing at all. */
  async check(
    visitId: string,
    dto: AssignCrewDto,
  ): Promise<EligibilityResultDto> {
    // A dry-run must obey the same publication boundary as assign(), rather
    // than promise an eligible replacement that the write path must refuse.
    const replaceable = await assertUnpublishedVisit(this.prisma, visitId);
    if (replaceable.length > 1) {
      throw new AppException(
        'RESOURCE_CONFLICT',
        'This visit has multiple assignments. Refresh and resolve the conflicting schedule before changing its crew.',
        HttpStatus.CONFLICT,
        { visitId },
      );
    }
    const result = await this.eligibility.evaluate(visitId, toProposal(dto), {
      excludeAssignmentId: replaceable[0]?.id,
    });
    return {
      isEligible: result.isEligible,
      conflicts: result.conflicts.map(toConflictDto),
    };
  }

  /**
   * Assigns a crew, or refuses with every reason.
   *
   * Replaces any existing crew for the visit — a visit has one assignment, and
   * "change the crew" is the same operation as "set the crew".
   */
  async assign(visitId: string, dto: AssignCrewDto, actor: AuthenticatedUser) {
    const proposal = toProposal(dto);
    const snapshot = await this.prisma.assignment.findFirst({
      where: { generatedVisitId: visitId, status: { in: LIVE_STATUSES } },
      include: ASSIGNMENT_INCLUDE,
    });
    const saved = await this.prisma.$transaction(async (tx) => {
      await lockScheduleVisits(tx, [visitId]);
      await assertScheduleSnapshot(tx, visitId, snapshot?.id);
      const existing = await tx.assignment.findFirst({
        where: { generatedVisitId: visitId, status: { in: LIVE_STATUSES } },
        include: ASSIGNMENT_INCLUDE,
      });
      const result = await this.eligibility.evaluate(visitId, proposal, {
        excludeAssignmentId: existing?.id,
      });
      if (!result.isEligible) {
        // Commit refusal reasons before returning the error to the caller.
        // A refused replacement leaves the existing crew and queue untouched.
        if (!existing)
          await this.recordUnassigned(tx, visitId, result.conflicts);
        return {
          kind: 'rejected' as const,
          conflicts: result.conflicts,
          hadAssignment: existing !== null,
        };
      }
      const visit = await tx.generatedVisit.findUniqueOrThrow({
        where: { id: visitId },
        select: { visitDate: true, branchId: true, branchCode: true },
      });
      const employees = await tx.employee.findMany({
        where: { id: { in: proposal.crew.map((member) => member.employeeId) } },
        select: { id: true, isPmsGrade: true },
      });
      const pmsById = new Map(employees.map((row) => [row.id, row.isPmsGrade]));
      if (existing) {
        await this.deleteDraft(tx, visitId, existing.id);
      }

      const assignment = await tx.assignment.create({
        data: {
          generatedVisitId: visitId,
          branchId: visit.branchId,
          branchCode: visit.branchCode,
          status: AssignmentStatus.DRAFT,
          plannedStart: at(visit.visitDate, proposal.plannedStartMinute),
          plannedEnd: at(visit.visitDate, proposal.plannedEndMinute),
          crewMembers: {
            create: proposal.crew.map((member) => ({
              employeeId: member.employeeId,
              role: member.role,
              // Denormalised so history stays truthful if a grade changes later.
              isPmsSupervisor: pmsById.get(member.employeeId) ?? false,
            })),
          },
          vehicles: {
            create: proposal.vehicles.map((entry) => ({
              vehicleId: entry.vehicleId,
              driverEmployeeId: entry.driverEmployeeId,
            })),
          },
        },
        include: ASSIGNMENT_INCLUDE,
      });

      // The visit is staffed, so it is no longer in the queue.
      await tx.visitUnassignedReason.deleteMany({
        where: { generatedVisitId: visitId },
      });
      await tx.generatedVisit.update({
        where: { id: visitId },
        data: { status: VisitStatus.SCHEDULED },
      });

      await this.audit.record(
        {
          entityType: 'Assignment',
          entityId: assignment.id,
          action: existing ? 'assignment.replaced' : 'assignment.created',
          actor,
          before: existing,
          after: { ...assignment, reason: dto.reason ?? null },
        },
        tx,
      );

      return { kind: 'assigned' as const, assignment };
    });

    if (saved.kind === 'rejected') {
      const tail = saved.hadAssignment
        ? 'The crew already on this visit has been left as it is.'
        : 'The visit has been listed in the Unassigned queue with every reason.';
      throw new AppException(
        'ASSIGNMENT_NOT_ELIGIBLE',
        saved.conflicts.length === 1
          ? saved.conflicts[0].message
          : `This crew cannot take the visit — ${saved.conflicts.length} rules are not met. ${tail}`,
        HttpStatus.CONFLICT,
        { conflicts: saved.conflicts.map(toConflictDto) },
      );
    }
    return toAssignmentDto(saved.assignment);
  }

  /** Takes the crew off a visit and puts it back in the queue. */
  async unassign(visitId: string, actor: AuthenticatedUser) {
    const snapshot = await this.prisma.assignment.findFirst({
      where: { generatedVisitId: visitId, status: { in: LIVE_STATUSES } },
      include: ASSIGNMENT_INCLUDE,
    });

    await this.prisma.$transaction(async (tx) => {
      await lockScheduleVisits(tx, [visitId]);
      await assertScheduleSnapshot(tx, visitId, snapshot?.id);
      const existing = await tx.assignment.findFirst({
        where: { generatedVisitId: visitId, status: { in: LIVE_STATUSES } },
        include: ASSIGNMENT_INCLUDE,
      });
      if (!existing) {
        throw new AppException(
          'RESOURCE_NOT_FOUND',
          'This visit has no crew assigned, so there is nothing to remove.',
          HttpStatus.NOT_FOUND,
          { visitId },
        );
      }

      if (existing.locks.length > 0) {
        throw new AppException(
          'RESOURCE_CONFLICT',
          'A manager has pinned this crew. Release the lock before removing it.',
          HttpStatus.CONFLICT,
          { visitId, assignmentId: existing.id },
        );
      }

      await this.deleteDraft(tx, visitId, existing.id);
      await tx.generatedVisit.update({
        where: { id: visitId },
        data: { status: VisitStatus.UNASSIGNED },
      });
      await this.audit.record(
        {
          entityType: 'Assignment',
          entityId: existing.id,
          action: 'assignment.removed',
          actor,
          before: existing,
          after: null,
        },
        tx,
      );
    });
  }

  async get(visitId: string): Promise<AssignmentDto | null> {
    const assignment = await this.prisma.assignment.findFirst({
      where: { generatedVisitId: visitId, status: { in: LIVE_STATUSES } },
      include: ASSIGNMENT_INCLUDE,
    });
    return assignment ? toAssignmentDto(assignment) : null;
  }

  /**
   * The Unassigned queue: every visit that still needs a crew.
   *
   * Deliberately *not* "visits the engine refused". Before anyone has proposed
   * a crew there are no refusals to list, so that definition left a manager
   * staring at an empty page while several hundred visits sat unstaffed — the
   * exact work the queue exists to surface. A visit belongs here when it has
   * no live assignment, whether or not anybody has tried yet.
   *
   * `hasBeenChecked` keeps the two honest: false means nobody has proposed a
   * crew, so the empty conflict list is silence rather than a clean bill of
   * health. Pass `withConflictsOnly` to narrow to work already found to be
   * impossible.
   */
  async unassignedQueue(query: {
    page?: number;
    pageSize?: number;
    branchCode?: string;
    from?: string;
    to?: string;
    withConflictsOnly?: boolean;
    serviceAgreementId?: string;
  }) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;

    const where: Prisma.GeneratedVisitWhereInput = {
      assignments: { none: { status: { in: LIVE_STATUSES } } },
      // Finished and cancelled work is history; it needs nobody.
      status: { notIn: [VisitStatus.COMPLETED, VisitStatus.CANCELLED] },
      ...(query.withConflictsOnly ? { unassignedReasons: { some: {} } } : {}),
      ...(query.serviceAgreementId
        ? { serviceAgreementId: query.serviceAgreementId }
        : {}),
      ...(query.branchCode
        ? {
            branchCode:
              query.branchCode as Prisma.EnumBranchCodeFilter['equals'],
          }
        : {}),
      ...(query.from || query.to
        ? {
            visitDate: {
              ...(query.from
                ? { gte: new Date(`${query.from}T00:00:00.000Z`) }
                : {}),
              ...(query.to
                ? { lte: new Date(`${query.to}T00:00:00.000Z`) }
                : {}),
            },
          }
        : {}),
    };

    const [total, visits] = await Promise.all([
      this.prisma.generatedVisit.count({ where }),
      this.prisma.generatedVisit.findMany({
        where,
        include: {
          serviceAgreement: {
            include: {
              customer: { select: { name: true } },
              serviceSite: { select: { name: true } },
            },
          },
          unassignedReasons: { orderBy: { code: 'asc' } },
        },
        orderBy: [{ visitDate: 'asc' }, { windowStartMinute: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const items: UnassignedVisitDto[] = visits.map((visit) => ({
      visitId: visit.id,
      visitDate: visit.visitDate.toISOString().slice(0, 10),
      branchCode: visit.branchCode,
      customerName: visit.serviceAgreement.customer.name,
      siteName: visit.serviceAgreement.serviceSite.name,
      requiredCrewSize: visit.requiredCrewSize,
      hasBeenChecked: visit.unassignedReasons.length > 0,
      conflicts: visit.unassignedReasons.map((reason) => ({
        code: reason.code,
        message: reason.message,
        remediation:
          (reason.details as { remediation?: string } | null)?.remediation ??
          '',
        resources: normaliseResources(
          (reason.details as { resources?: Record<string, unknown> } | null)
            ?.resources,
        ),
      })),
      recordedAt:
        visit.unassignedReasons[0]?.createdAt.toISOString() ??
        visit.updatedAt.toISOString(),
    }));

    return { items, total, page, pageSize };
  }

  /**
   * Manager/admin view of one employee's published daily assignments.
   * A future worker app needs self-scope authorization before it can use this
   * read model. Published jobs stay visible through completion, dated by the
   * assignment's planned start rather than the mutable planning visit.
   */
  async employeeAssignments(
    employeeId: string,
    query: EmployeeAssignmentQueryDto,
  ) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;

    if (query.from && query.to && query.to < query.from) {
      throw new AppException(
        'VALIDATION_FAILED',
        '"to" must be on or after "from".',
        HttpStatus.BAD_REQUEST,
        { from: query.from, to: query.to },
      );
    }

    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true },
    });
    if (!employee) {
      throw new AppException(
        'RESOURCE_NOT_FOUND',
        `Employee "${employeeId}" was not found.`,
        HttpStatus.NOT_FOUND,
        { employeeId },
      );
    }

    const where: Prisma.AssignmentWhereInput = {
      status: { in: EMPLOYEE_ASSIGNMENT_STATUSES },
      scheduleRunId: { not: null },
      publishedAt: { not: null },
      crewMembers: { some: { employeeId } },
      ...(query.from || query.to
        ? {
            plannedStart: {
              ...(query.from
                ? { gte: new Date(`${query.from}T00:00:00.000Z`) }
                : {}),
              ...(query.to
                ? {
                    lt: new Date(
                      new Date(`${query.to}T00:00:00.000Z`).getTime() + 86_400_000,
                    ),
                  }
                : {}),
            },
          }
        : {}),
    };

    const [total, assignments] = await Promise.all([
      this.prisma.assignment.count({ where }),
      this.prisma.assignment.findMany({
        where,
        include: {
          crewMembers: ASSIGNMENT_INCLUDE.crewMembers,
          vehicles: ASSIGNMENT_INCLUDE.vehicles,
          generatedVisit: {
            include: {
              serviceAgreement: {
                include: {
                  customer: { select: { name: true } },
                  serviceSite: { select: { name: true } },
                  jobType: { select: { name: true } },
                },
              },
            },
          },
        },
        orderBy: [{ plannedStart: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const items: EmployeeAssignmentDto[] = assignments.map((assignment) => {
      const midnight = new Date(
        Date.UTC(
          assignment.plannedStart.getUTCFullYear(),
          assignment.plannedStart.getUTCMonth(),
          assignment.plannedStart.getUTCDate(),
        ),
      ).getTime();
      const minutes = (moment: Date) =>
        Math.round((moment.getTime() - midnight) / 60_000);
      const crew = assignment.crewMembers
        .map((member) => ({
          employeeId: member.employeeId,
          fullName: member.employee.fullName,
          role: member.role,
          isPmsSupervisor: member.isPmsSupervisor,
        }))
        .sort((left, right) =>
          left.fullName.localeCompare(right.fullName) || left.employeeId.localeCompare(right.employeeId),
        );
      // Membership and publication provenance are guaranteed by the query.
      const membership = crew.find((member) => member.employeeId === employeeId)!;
      const supervisor =
        crew.find((member) => member.isPmsSupervisor && member.role === CrewRole.SUPERVISOR) ??
        crew.find((member) => member.isPmsSupervisor);

      return {
        assignmentId: assignment.id,
        status: assignment.status,
        scheduleRunId: assignment.scheduleRunId!,
        visitId: assignment.generatedVisitId,
        visitDate: assignment.plannedStart.toISOString().slice(0, 10),
        plannedStartMinute: minutes(assignment.plannedStart),
        plannedEndMinute: minutes(assignment.plannedEnd),
        branchCode: assignment.branchCode,
        customerName: assignment.generatedVisit.serviceAgreement.customer.name,
        siteName: assignment.generatedVisit.serviceAgreement.serviceSite.name,
        jobTypeName: assignment.generatedVisit.serviceAgreement.jobType.name,
        instructions: assignment.generatedVisit.serviceAgreement.notes?.trim() || null,
        crew,
        supervisorEmployeeId: supervisor?.employeeId ?? null,
        supervisorName: supervisor?.fullName ?? null,
        vehicles: assignment.vehicles
          .map((entry) => ({
            vehicleId: entry.vehicleId,
            label: entry.vehicle.label,
            driverEmployeeId: entry.driverEmployeeId,
            driverName: entry.driverEmployee?.fullName ?? null,
          }))
          .sort((left, right) =>
            left.label.localeCompare(right.label) || left.vehicleId.localeCompare(right.vehicleId),
          ),
        role: membership.role,
        isPmsSupervisor: membership.isPmsSupervisor,
        publishedAt: assignment.publishedAt!.toISOString(),
        acknowledgedAt: assignment.acknowledgedAt?.toISOString() ?? null,
        startedAt: assignment.startedAt?.toISOString() ?? null,
        completedAt: assignment.completedAt?.toISOString() ?? null,
      };
    });

    return { items, total, page, pageSize };
  }

  /**
   * Replaces the visit's queue entry with the current reasons.
   *
   * Replaced rather than appended: a stale reason a manager has already fixed
   * is worse than no reason at all.
   */
  private async recordUnassigned(
    tx: Prisma.TransactionClient,
    visitId: string,
    conflicts: Conflict[],
  ) {
    // assign() holds the visit lock and has checked the expected empty snapshot.
    await tx.visitUnassignedReason.deleteMany({
      where: { generatedVisitId: visitId },
    });
    await tx.visitUnassignedReason.createMany({
      data: conflicts.map((conflict) => ({
        generatedVisitId: visitId,
        code: conflict.code,
        message: conflict.message,
        details: {
          remediation: conflict.remediation,
          resources: conflict.resources,
        } as unknown as Prisma.InputJsonValue,
      })),
    });
    await tx.generatedVisit.update({
      where: { id: visitId },
      data: { status: VisitStatus.UNASSIGNED },
    });
  }

  private async deleteDraft(
    tx: Prisma.TransactionClient,
    visitId: string,
    assignmentId: string,
  ) {
    const deleted = await tx.assignment.deleteMany({
      where: {
        id: assignmentId,
        status: { in: [AssignmentStatus.DRAFT, AssignmentStatus.PROPOSED] },
        publishedAt: null,
      },
    });
    if (deleted.count !== 1) {
      throw new AppException(
        'RESOURCE_CONFLICT',
        'The assignment changed. Refresh and try again.',
        HttpStatus.CONFLICT,
        { visitId, assignmentId },
      );
    }
  }
}

function toProposal(dto: AssignCrewDto): AssignmentProposal {
  return {
    plannedStartMinute: dto.plannedStartMinute,
    plannedEndMinute: dto.plannedEndMinute,
    crew: dto.crew.map((member) => ({
      employeeId: member.employeeId,
      role: member.role ?? CrewRole.TECHNICIAN,
    })),
    vehicles: (dto.vehicles ?? []).map((entry) => ({
      vehicleId: entry.vehicleId,
      driverEmployeeId: entry.driverEmployeeId ?? null,
    })),
  };
}

/**
 * The engine leaves unused resource lists off entirely; the published contract
 * spells every field out. Converting here keeps the engine's shape terse and
 * the API's shape predictable for a client.
 */
function toConflictDto(conflict: Conflict): ConflictDto {
  return {
    code: conflict.code,
    message: conflict.message,
    remediation: conflict.remediation,
    resources: normaliseResources(conflict.resources),
  };
}

function normaliseResources(raw: unknown) {
  const value = (raw ?? {}) as Record<string, unknown>;
  const list = (key: string) => (Array.isArray(value[key]) ? (value[key] as string[]) : []);
  return {
    visitId: typeof value.visitId === 'string' ? value.visitId : null,
    employeeIds: list('employeeIds'),
    vehicleIds: list('vehicleIds'),
    serviceSiteId: typeof value.serviceSiteId === 'string' ? value.serviceSiteId : null,
    skillCodes: list('skillCodes'),
    assignmentIds: list('assignmentIds'),
  };
}

function toAssignmentDto(assignment: AssignmentWithRelations): AssignmentDto {
  const midnight = new Date(
    Date.UTC(
      assignment.plannedStart.getUTCFullYear(),
      assignment.plannedStart.getUTCMonth(),
      assignment.plannedStart.getUTCDate(),
    ),
  ).getTime();
  const minutes = (moment: Date) => Math.round((moment.getTime() - midnight) / 60_000);

  return {
    id: assignment.id,
    generatedVisitId: assignment.generatedVisitId,
    status: assignment.status,
    branchCode: assignment.branchCode,
    plannedStartMinute: minutes(assignment.plannedStart),
    plannedEndMinute: minutes(assignment.plannedEnd),
    crew: assignment.crewMembers
      .map((member) => ({
        employeeId: member.employeeId,
        fullName: member.employee.fullName,
        role: member.role,
        isPmsSupervisor: member.isPmsSupervisor,
      }))
      .sort((left, right) => left.fullName.localeCompare(right.fullName)),
    vehicles: assignment.vehicles.map((entry) => ({
      vehicleId: entry.vehicleId,
      label: entry.vehicle.label,
      driverEmployeeId: entry.driverEmployeeId,
      driverName: entry.driverEmployee?.fullName ?? null,
    })),
    isLocked: assignment.locks.length > 0,
    createdAt: assignment.createdAt.toISOString(),
    updatedAt: assignment.updatedAt.toISOString(),
  };
}

import { HttpStatus, Injectable } from '@nestjs/common';
import { AssignmentStatus, CrewRole, Prisma, VisitStatus } from '@prisma/client';

import { AuditService } from '../../audit/audit.service';
import { AuthenticatedUser } from '../../auth/auth.types';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { Conflict } from './conflict-codes';
import {
  AssignCrewDto,
  AssignmentDto,
  ConflictDto,
  EligibilityResultDto,
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
  async check(visitId: string, dto: AssignCrewDto): Promise<EligibilityResultDto> {
    const result = await this.eligibility.evaluate(visitId, toProposal(dto));
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

    const existing = await this.prisma.assignment.findFirst({
      where: { generatedVisitId: visitId, status: { in: LIVE_STATUSES } },
      include: ASSIGNMENT_INCLUDE,
    });

    // A published assignment is what the crews were told. Changing one by hand
    // would rewrite a record people are working from; publish a new run
    // instead, which supersedes this one and keeps both.
    if (existing && existing.status === AssignmentStatus.PUBLISHED) {
      throw new AppException(
        'RESOURCE_CONFLICT',
        'This visit is on a published schedule and cannot be re-crewed by hand. Run the scheduler again and publish the new schedule — the published one is kept as a record.',
        HttpStatus.CONFLICT,
        { visitId, assignmentId: existing.id },
      );
    }

    const result = await this.eligibility.evaluate(visitId, proposal, {
      excludeAssignmentId: existing?.id,
    });

    if (!result.isEligible) {
      // A rejected *replacement* leaves the existing crew in place, so the
      // visit is still staffed and must not be dumped in the queue — doing so
      // would report work as unassigned while a crew is on its way to it.
      if (!existing) await this.recordUnassigned(visitId, result.conflicts);

      const tail = existing
        ? 'The crew already on this visit has been left as it is.'
        : 'The visit has been listed in the Unassigned queue with every reason.';

      throw new AppException(
        'ASSIGNMENT_NOT_ELIGIBLE',
        result.conflicts.length === 1
          ? result.conflicts[0].message
          : `This crew cannot take the visit — ${result.conflicts.length} rules are not met. ${tail}`,
        HttpStatus.CONFLICT,
        { conflicts: result.conflicts.map(toConflictDto) },
      );
    }

    const visit = await this.prisma.generatedVisit.findUniqueOrThrow({
      where: { id: visitId },
      select: { visitDate: true, branchId: true, branchCode: true },
    });

    const employees = await this.prisma.employee.findMany({
      where: { id: { in: proposal.crew.map((member) => member.employeeId) } },
      select: { id: true, isPmsGrade: true },
    });
    const pmsById = new Map(employees.map((row) => [row.id, row.isPmsGrade]));

    const saved = await this.prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.assignment.delete({ where: { id: existing.id } });
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
      await tx.visitUnassignedReason.deleteMany({ where: { generatedVisitId: visitId } });
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

      return assignment;
    });

    return toAssignmentDto(saved);
  }

  /** Takes the crew off a visit and puts it back in the queue. */
  async unassign(visitId: string, actor: AuthenticatedUser) {
    const existing = await this.prisma.assignment.findFirst({
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

    if (existing.status === AssignmentStatus.PUBLISHED) {
      throw new AppException(
        'RESOURCE_CONFLICT',
        'This crew is on a published schedule and cannot be removed. Publish a new schedule to replace it; the published one stays as a record.',
        HttpStatus.CONFLICT,
        { visitId, assignmentId: existing.id },
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

    await this.prisma.$transaction(async (tx) => {
      await tx.assignment.delete({ where: { id: existing.id } });
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
        ? { branchCode: query.branchCode as Prisma.EnumBranchCodeFilter['equals'] }
        : {}),
      ...(query.from || query.to
        ? {
            visitDate: {
              ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
              ...(query.to ? { lte: new Date(`${query.to}T00:00:00.000Z`) } : {}),
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
          (reason.details as { remediation?: string } | null)?.remediation ?? '',
        resources: normaliseResources(
          (reason.details as { resources?: Record<string, unknown> } | null)?.resources,
        ),
      })),
      recordedAt:
        visit.unassignedReasons[0]?.createdAt.toISOString() ?? visit.updatedAt.toISOString(),
    }));

    return { items, total, page, pageSize };
  }

  /**
   * Replaces the visit's queue entry with the current reasons.
   *
   * Replaced rather than appended: a stale reason a manager has already fixed
   * is worse than no reason at all.
   */
  private async recordUnassigned(visitId: string, conflicts: Conflict[]) {
    await this.prisma.$transaction(async (tx) => {
      await tx.visitUnassignedReason.deleteMany({ where: { generatedVisitId: visitId } });
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
    });
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

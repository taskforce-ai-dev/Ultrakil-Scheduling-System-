import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, VisitStatus } from '@prisma/client';

import { AuditService } from '../../audit/audit.service';
import { AuthenticatedUser } from '../../auth/auth.types';
import { describeFrequency } from '../../catalog/catalog.mapper';
import { parseDateOnly, toDateOnly } from '../../catalog/schedule-preview';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { protectionReasonFor } from '../visit-generation/plan';
import {
  AdjustVisitDto,
  LockVisitDto,
  VisitDetailDto,
  VisitDto,
  VisitQueryDto,
} from './dto';

const VISIT_INCLUDE = {
  serviceAgreement: {
    include: {
      customer: { select: { id: true, name: true } },
      serviceSite: { select: { id: true, name: true } },
      jobType: { select: { name: true } },
    },
  },
  agreementVersion: true,
  _count: { select: { assignments: true } },
} satisfies Prisma.GeneratedVisitInclude;

type VisitWithRelations = Prisma.GeneratedVisitGetPayload<{
  include: typeof VISIT_INCLUDE;
}>;

/**
 * Reading and hand-editing generated visits.
 *
 * Generation can produce a calendar, but the task is only met when a manager
 * can "later see exactly why each visit exists" — which needs the agreement
 * and the version behind it, not just a date. That is what `origin` carries.
 *
 * The write operations here are the other half of generation's protection
 * promise: locking and hand-editing are what make a visit the manager's, and
 * until something could set them the promise was theoretical.
 */
@Injectable()
export class VisitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: VisitQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 100;

    // Every agreement-side filter has to be merged into one object. Spreading
    // `serviceAgreement` more than once would silently drop all but the last,
    // so narrowing by customer *and* job type would quietly widen the result.
    const agreement: Prisma.ServiceAgreementWhereInput = {
      ...(query.serviceSiteId ? { serviceSiteId: query.serviceSiteId } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.jobTypeId ? { jobTypeId: query.jobTypeId } : {}),
      ...(query.search
        ? {
            OR: [
              { customer: { name: { contains: query.search, mode: 'insensitive' } } },
              { serviceSite: { name: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const where: Prisma.GeneratedVisitWhereInput = {
      ...(query.from || query.to
        ? {
            visitDate: {
              ...(query.from ? { gte: parseDateOnly(query.from) } : {}),
              ...(query.to ? { lte: parseDateOnly(query.to) } : {}),
            },
          }
        : {}),
      ...(query.branchCode ? { branchCode: query.branchCode } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.serviceAgreementId
        ? { serviceAgreementId: query.serviceAgreementId }
        : {}),
      ...(Object.keys(agreement).length > 0 ? { serviceAgreement: agreement } : {}),
      // Protection is several columns rather than one flag, so the filter has
      // to spell out the same rule the planner applies.
      ...(query.protectedOnly
        ? {
            OR: [
              { lockedAt: { not: null } },
              { isManuallyAdjusted: true },
              { status: { in: [VisitStatus.SCHEDULED, VisitStatus.COMPLETED, VisitStatus.CANCELLED] } },
              { assignments: { some: {} } },
            ],
          }
        : {}),
    };

    const [total, items] = await Promise.all([
      this.prisma.generatedVisit.count({ where }),
      this.prisma.generatedVisit.findMany({
        where,
        include: VISIT_INCLUDE,
        orderBy: [{ visitDate: 'asc' }, { windowStartMinute: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { items: items.map(toVisitDto), total, page, pageSize };
  }

  async get(id: string): Promise<VisitDetailDto> {
    const visit = await this.load(id);
    const agreement = visit.serviceAgreement;
    const snapshot = (visit.agreementVersion?.snapshot ?? null) as {
      allowedDays?: string[];
    } | null;

    return {
      ...toVisitDto(visit),
      origin: {
        serviceAgreementId: agreement.id,
        customerName: agreement.customer.name,
        siteName: agreement.serviceSite.name,
        jobTypeName: agreement.jobType.name,
        agreementVersionNumber: visit.agreementVersion?.versionNumber ?? null,
        frequencyLabel: describeFrequency(
          agreement.frequencyCount,
          agreement.frequencyUnit,
          agreement.frequencyInterval,
        ),
        // From the snapshot, not the agreement as it stands now — the whole
        // point is to explain the visit by the rules that produced it.
        allowedDaysAtGeneration: snapshot?.allowedDays ?? [],
        generatedAt: visit.createdAt.toISOString(),
        generatedByRunId: visit.generatedByRunId,
      },
    };
  }

  /**
   * A manager's hand edit.
   *
   * Marks the visit manually adjusted, which is what stops the next generation
   * run from putting it back. Without that flag the edit would survive only
   * until someone regenerated the horizon.
   */
  async adjust(id: string, dto: AdjustVisitDto, actor: AuthenticatedUser) {
    const before = await this.load(id);
    this.assertEditable(before);

    const windowStart = dto.windowStartMinute ?? before.windowStartMinute;
    const windowEnd = dto.windowEndMinute ?? before.windowEndMinute;
    if (windowEnd <= windowStart) {
      throw new AppException(
        'SERVICE_WINDOW_INVALID',
        `The visit window ends at ${formatMinute(windowEnd)}, which is not after it starts at ${formatMinute(windowStart)}.`,
        HttpStatus.BAD_REQUEST,
        { windowStart, windowEnd },
      );
    }

    const duration = dto.durationMinutes ?? before.durationMinutes;
    if (duration > windowEnd - windowStart) {
      throw new AppException(
        'SERVICE_WINDOW_INVALID',
        `A ${duration}-minute visit does not fit in a window of ${windowEnd - windowStart} minutes. Widen the window or shorten the visit.`,
        HttpStatus.BAD_REQUEST,
        { duration, windowMinutes: windowEnd - windowStart },
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const visit = await tx.generatedVisit.update({
        where: { id },
        data: {
          ...(dto.visitDate ? { visitDate: parseDateOnly(dto.visitDate) } : {}),
          windowStartMinute: windowStart,
          windowEndMinute: windowEnd,
          durationMinutes: duration,
          ...(dto.requiredCrewSize !== undefined
            ? { requiredCrewSize: dto.requiredCrewSize }
            : {}),
          isManuallyAdjusted: true,
          manuallyAdjustedAt: new Date(),
          manuallyAdjustedBy: actor.id,
        },
        include: VISIT_INCLUDE,
      });

      await this.audit.record(
        {
          entityType: 'GeneratedVisit',
          entityId: id,
          action: 'visit.adjusted',
          actor,
          before,
          after: { ...visit, reason: dto.reason ?? null },
        },
        tx,
      );

      return visit;
    });

    return toVisitDto(updated);
  }

  /** Pins a visit so regeneration cannot move it, whatever the agreement says. */
  async setLocked(
    id: string,
    locked: boolean,
    dto: LockVisitDto,
    actor: AuthenticatedUser,
  ) {
    const before = await this.load(id);

    const updated = await this.prisma.$transaction(async (tx) => {
      const visit = await tx.generatedVisit.update({
        where: { id },
        data: locked
          ? {
              lockedAt: new Date(),
              lockedByUserId: actor.id,
              lockReason: dto.reason?.trim() || null,
            }
          : { lockedAt: null, lockedByUserId: null, lockReason: null },
        include: VISIT_INCLUDE,
      });

      await this.audit.record(
        {
          entityType: 'GeneratedVisit',
          entityId: id,
          action: locked ? 'visit.locked' : 'visit.unlocked',
          actor,
          before,
          after: visit,
        },
        tx,
      );

      return visit;
    });

    return toVisitDto(updated);
  }

  /** A finished or cancelled visit is history; editing it would rewrite it. */
  private assertEditable(visit: VisitWithRelations): void {
    if (visit.status === VisitStatus.COMPLETED || visit.status === VisitStatus.CANCELLED) {
      throw new AppException(
        'RESOURCE_CONFLICT',
        `This visit is ${visit.status.toLowerCase()} and cannot be changed. It is a record of what happened.`,
        HttpStatus.CONFLICT,
        { visitId: visit.id, status: visit.status },
      );
    }
  }

  private async load(id: string): Promise<VisitWithRelations> {
    const visit = await this.prisma.generatedVisit.findUnique({
      where: { id },
      include: VISIT_INCLUDE,
    });

    if (!visit) {
      throw new AppException(
        'RESOURCE_NOT_FOUND',
        `Visit "${id}" was not found. Refresh the list — it may have been removed by a regeneration.`,
        HttpStatus.NOT_FOUND,
        { visitId: id },
      );
    }

    return visit;
  }
}

function toVisitDto(visit: VisitWithRelations): VisitDto {
  const protection = protectionReasonFor({
    id: visit.id,
    serviceAgreementId: visit.serviceAgreementId,
    visitDate: toDateOnly(visit.visitDate),
    windowStartMinute: visit.windowStartMinute,
    windowEndMinute: visit.windowEndMinute,
    durationMinutes: visit.durationMinutes,
    requiredCrewSize: visit.requiredCrewSize,
    status: visit.status,
    isManuallyAdjusted: visit.isManuallyAdjusted,
    isLocked: visit.lockedAt !== null,
    hasAssignments: visit._count.assignments > 0,
  });

  return {
    id: visit.id,
    visitDate: toDateOnly(visit.visitDate),
    windowStartMinute: visit.windowStartMinute,
    windowEndMinute: visit.windowEndMinute,
    durationMinutes: visit.durationMinutes,
    requiredCrewSize: visit.requiredCrewSize,
    status: visit.status,
    branchCode: visit.branchCode,
    serviceAgreementId: visit.serviceAgreementId,
    customerName: visit.serviceAgreement.customer.name,
    siteName: visit.serviceAgreement.serviceSite.name,
    jobTypeName: visit.serviceAgreement.jobType.name,
    isProtected: protection !== null,
    protectionReason: protection,
    isManuallyAdjusted: visit.isManuallyAdjusted,
    manuallyAdjustedAt: visit.manuallyAdjustedAt?.toISOString() ?? null,
    isLocked: visit.lockedAt !== null,
    lockReason: visit.lockReason,
    assignmentCount: visit._count.assignments,
    createdAt: visit.createdAt.toISOString(),
    updatedAt: visit.updatedAt.toISOString(),
  };
}

function formatMinute(minute: number): string {
  const hour = Math.floor(minute / 60);
  const rest = minute % 60;
  return `${String(hour).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AgreementStatus,
  DayRuleKind,
  Prisma,
  ScheduleRunStatus,
  ScheduleRunTrigger,
  VisitStatus,
} from '@prisma/client';

import { AuditService } from '../../audit/audit.service';
import { AuthenticatedUser } from '../../auth/auth.types';
import {
  computeSchedulePreview,
  parseDateOnly,
  toDateOnly,
} from '../../catalog/schedule-preview';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { GenerateVisitsDto, GenerationImpactDto } from './dto';
import {
  ExistingVisit,
  GenerationPlan,
  RequiredVisit,
  planGeneration,
} from './plan';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A run covering more than a year is almost certainly a mistyped date. */
const MAX_HORIZON_DAYS = 366;

const AGREEMENT_INCLUDE = {
  customer: { select: { name: true } },
  serviceSite: { select: { name: true, operatingHours: true } },
  dayRules: true,
} satisfies Prisma.ServiceAgreementInclude;

type AgreementForGeneration = Prisma.ServiceAgreementGetPayload<{
  include: typeof AGREEMENT_INCLUDE;
}>;

interface Shortfall {
  serviceAgreementId: string;
  customerName: string;
  siteName: string;
  periodStart: string;
  periodEnd: string;
  requested: number;
  scheduled: number;
  reason: string;
  message: string;
}

/**
 * Turns service agreements into dated visits.
 *
 * Two operations, deliberately separate: `preview` works out what would change
 * and writes nothing; `confirm` applies exactly that. A manager therefore never
 * discovers a change by finding it already made.
 *
 * Generation is idempotent. A visit is identified by its agreement, date and
 * start time, so running the same horizon twice produces the same calendar —
 * the second run reports everything as unchanged.
 */
@Injectable()
export class VisitGenerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  preview(dto: GenerateVisitsDto): Promise<GenerationImpactDto> {
    return this.build(dto, null);
  }

  confirm(dto: GenerateVisitsDto, actor: AuthenticatedUser): Promise<GenerationImpactDto> {
    return this.build(dto, actor);
  }

  /** Shared by preview and confirm, so the two can never disagree. */
  private async build(
    dto: GenerateVisitsDto,
    actor: AuthenticatedUser | null,
  ): Promise<GenerationImpactDto> {
    const from = this.assertDateRange(dto.from, dto.to);
    const to = parseDateOnly(dto.to);

    const agreements = await this.loadAgreements(dto, from, to);
    const { required, shortfalls } = this.requiredVisitsFor(agreements, dto.from, dto.to);
    const existing = await this.loadExistingVisits(agreements, from, to);

    const plan = planGeneration(required, existing);

    const names = new Map(
      agreements.map((agreement) => [
        agreement.id,
        { customerName: agreement.customer.name, siteName: agreement.serviceSite.name },
      ]),
    );

    let scheduleRunId: string | null = null;
    if (actor) scheduleRunId = await this.apply(plan, dto, from, to, actor);

    return this.toImpact(plan, shortfalls, names, {
      from: dto.from,
      to: dto.to,
      agreementsConsidered: agreements.length,
      isPreview: actor === null,
      scheduleRunId,
    });
  }

  private assertDateRange(from: string, to: string): Date {
    const start = parseDateOnly(from);
    const end = parseDateOnly(to);

    if (end < start) {
      throw new AppException(
        'AGREEMENT_DATES_INVALID',
        `The horizon ends on ${to}, before it starts on ${from}. Check the dates.`,
        HttpStatus.BAD_REQUEST,
        { from, to },
      );
    }

    const days = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
    if (days > MAX_HORIZON_DAYS) {
      throw new AppException(
        'VALIDATION_FAILED',
        `That horizon covers ${days} days. Generate at most a year at a time — a longer run is usually a mistyped date, and it would create tens of thousands of visits.`,
        HttpStatus.BAD_REQUEST,
        { from, to, days, maximumDays: MAX_HORIZON_DAYS },
      );
    }

    return start;
  }

  private async loadAgreements(
    dto: GenerateVisitsDto,
    from: Date,
    to: Date,
  ): Promise<AgreementForGeneration[]> {
    return this.prisma.serviceAgreement.findMany({
      where: {
        // Only active agreements generate work. A paused one keeps its past
        // visits but produces no new ones — that is what pausing means.
        status: AgreementStatus.ACTIVE,
        ...(dto.branchCode ? { branchCode: dto.branchCode } : {}),
        ...(dto.serviceAgreementIds?.length
          ? { id: { in: dto.serviceAgreementIds } }
          : {}),
        // In force at some point inside the horizon.
        startDate: { lte: to },
        OR: [{ endDate: null }, { endDate: { gte: from } }],
      },
      include: AGREEMENT_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Asks each agreement what it requires across the horizon.
   *
   * The date arithmetic is the same `computeSchedulePreview` the agreement
   * screens use, so what a manager saw when writing the agreement is exactly
   * what generation produces. One implementation, one set of rules.
   */
  private requiredVisitsFor(
    agreements: AgreementForGeneration[],
    from: string,
    to: string,
  ): { required: RequiredVisit[]; shortfalls: Shortfall[] } {
    const required: RequiredVisit[] = [];
    const shortfalls: Shortfall[] = [];

    const horizonDays =
      Math.round((parseDateOnly(to).getTime() - parseDateOnly(from).getTime()) / DAY_MS) + 1;
    const horizonWeeks = Math.max(1, Math.ceil(horizonDays / 7));

    for (const agreement of agreements) {
      const preview = computeSchedulePreview({
        frequencyCount: agreement.frequencyCount,
        frequencyUnit: agreement.frequencyUnit,
        frequencyInterval: agreement.frequencyInterval,
        allowedDays: agreement.dayRules
          .filter((rule) => rule.kind === DayRuleKind.ALLOWED)
          .map((rule) => rule.weekday),
        preferredDays: agreement.dayRules
          .filter((rule) => rule.kind === DayRuleKind.PREFERRED)
          .map((rule) => rule.weekday),
        startDate: toDateOnly(agreement.startDate),
        endDate: agreement.endDate ? toDateOnly(agreement.endDate) : null,
        siteWindows: agreement.serviceSite.operatingHours.map((hours) => ({
          weekday: hours.weekday,
          startMinute: hours.opensAtMinute,
          endMinute: hours.closesAtMinute,
        })),
        agreementWindowStartMinute: agreement.serviceWindowStartMinute,
        agreementWindowEndMinute: agreement.serviceWindowEndMinute,
        durationMinutes: agreement.durationMinutes,
        horizonWeeks,
        from,
      });

      for (const visit of preview.visits) {
        // The preview counts whole cycles, so its last one can run past the
        // horizon. Requiring those would create visits the manager did not ask
        // for, and the next run would then propose removing them.
        if (visit.date > to) continue;

        required.push({
          serviceAgreementId: agreement.id,
          visitDate: visit.date,
          windowStartMinute: visit.windowStartMinute,
          windowEndMinute: visit.windowEndMinute,
          durationMinutes: agreement.durationMinutes,
          requiredCrewSize: agreement.crewSize,
          branchCode: agreement.branchCode,
          agreementVersionId: null,
          isPreferredDay: visit.isPreferredDay,
        });
      }

      for (const shortfall of preview.shortfalls) {
        if (shortfall.periodStart > to) continue;
        shortfalls.push({
          serviceAgreementId: agreement.id,
          customerName: agreement.customer.name,
          siteName: agreement.serviceSite.name,
          ...shortfall,
        });
      }
    }

    return { required, shortfalls };
  }

  private async loadExistingVisits(
    agreements: AgreementForGeneration[],
    from: Date,
    to: Date,
  ): Promise<ExistingVisit[]> {
    if (agreements.length === 0) return [];

    const visits = await this.prisma.generatedVisit.findMany({
      where: {
        serviceAgreementId: { in: agreements.map((agreement) => agreement.id) },
        visitDate: { gte: from, lte: to },
      },
      include: { _count: { select: { assignments: true } } },
    });

    return visits.map((visit) => ({
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
    }));
  }

  /**
   * Writes the plan, in one transaction with the run that describes it.
   *
   * All or nothing: a half-applied generation would leave a calendar nobody
   * could explain, and the run record is the only account of what happened.
   */
  private async apply(
    plan: GenerationPlan,
    dto: GenerateVisitsDto,
    from: Date,
    to: Date,
    actor: AuthenticatedUser,
  ): Promise<string> {
    const branchIds = new Map(
      (await this.prisma.branch.findMany()).map((branch) => [branch.code, branch.id]),
    );
    const currentVersions = await this.currentVersionIds(plan);

    return this.prisma.$transaction(async (tx) => {
      const run = await tx.scheduleRun.create({
        data: {
          status: ScheduleRunStatus.RUNNING,
          trigger: ScheduleRunTrigger.MANUAL,
          branchCode: dto.branchCode ?? null,
          rangeStart: from,
          rangeEnd: to,
          requestedByUserId: actor.id,
          startedAt: new Date(),
        },
      });

      for (const addition of plan.additions) {
        const branchId = branchIds.get(addition.required.branchCode);
        if (!branchId) continue;

        await tx.generatedVisit.create({
          data: {
            serviceAgreementId: addition.required.serviceAgreementId,
            branchId,
            branchCode: addition.required.branchCode,
            visitDate: parseDateOnly(addition.required.visitDate),
            windowStartMinute: addition.required.windowStartMinute,
            windowEndMinute: addition.required.windowEndMinute,
            durationMinutes: addition.required.durationMinutes,
            requiredCrewSize: addition.required.requiredCrewSize,
            status: VisitStatus.PENDING,
            generatedByRunId: run.id,
            agreementVersionId:
              currentVersions.get(addition.required.serviceAgreementId) ?? null,
          },
        });
      }

      for (const update of plan.updates) {
        await tx.generatedVisit.update({
          where: { id: update.visitId },
          data: {
            windowEndMinute: update.required.windowEndMinute,
            durationMinutes: update.required.durationMinutes,
            requiredCrewSize: update.required.requiredCrewSize,
            generatedByRunId: run.id,
            agreementVersionId:
              currentVersions.get(update.required.serviceAgreementId) ?? null,
          },
        });
      }

      if (plan.removals.length > 0) {
        await tx.generatedVisit.deleteMany({
          where: { id: { in: plan.removals.map((removal) => removal.visitId) } },
        });
      }

      const finished = await tx.scheduleRun.update({
        where: { id: run.id },
        data: {
          status: ScheduleRunStatus.SUCCEEDED,
          finishedAt: new Date(),
          visitsConsidered:
            plan.additions.length +
            plan.updates.length +
            plan.removals.length +
            plan.protectedVisits.length +
            plan.unchangedCount,
        },
      });

      await this.audit.record(
        {
          entityType: 'ScheduleRun',
          entityId: run.id,
          action: 'visit_generation.confirmed',
          actor,
          after: {
            from: dto.from,
            to: dto.to,
            branchCode: dto.branchCode ?? null,
            added: plan.additions.length,
            updated: plan.updates.length,
            removed: plan.removals.length,
            protected: plan.protectedVisits.length,
            unchanged: plan.unchangedCount,
          },
        },
        tx,
      );

      return finished.id;
    });
  }

  /** The version each affected agreement is currently on. */
  private async currentVersionIds(plan: GenerationPlan): Promise<Map<string, string>> {
    const agreementIds = [
      ...new Set([
        ...plan.additions.map((a) => a.required.serviceAgreementId),
        ...plan.updates.map((u) => u.required.serviceAgreementId),
      ]),
    ];
    if (agreementIds.length === 0) return new Map();

    const agreements = await this.prisma.serviceAgreement.findMany({
      where: { id: { in: agreementIds } },
      select: { id: true, currentVersion: true },
    });

    const versions = await this.prisma.serviceAgreementVersion.findMany({
      where: {
        OR: agreements.map((agreement) => ({
          serviceAgreementId: agreement.id,
          versionNumber: agreement.currentVersion,
        })),
      },
      select: { id: true, serviceAgreementId: true },
    });

    return new Map(versions.map((v) => [v.serviceAgreementId, v.id]));
  }

  private toImpact(
    plan: GenerationPlan,
    shortfalls: Shortfall[],
    names: Map<string, { customerName: string; siteName: string }>,
    meta: {
      from: string;
      to: string;
      agreementsConsidered: number;
      isPreview: boolean;
      scheduleRunId: string | null;
    },
  ): GenerationImpactDto {
    const nameFor = (id: string) =>
      names.get(id) ?? { customerName: 'Unknown', siteName: 'Unknown' };

    const asText = (changes: { field: string; from: number | string; to: number | string }[]) =>
      changes.map((change) => ({
        field: change.field,
        from: String(change.from),
        to: String(change.to),
      }));

    return {
      from: meta.from,
      to: meta.to,
      agreementsConsidered: meta.agreementsConsidered,
      additions: plan.additions.map((addition) => ({
        ...addition.required,
        ...nameFor(addition.required.serviceAgreementId),
      })),
      updates: plan.updates.map((update) => ({
        visitId: update.visitId,
        ...update.required,
        ...nameFor(update.required.serviceAgreementId),
        changes: asText(update.changes),
      })),
      removals: plan.removals.map((removal) => ({
        ...removal,
        ...nameFor(removal.serviceAgreementId),
      })),
      protectedVisits: plan.protectedVisits.map((entry) => ({
        ...entry,
        ...nameFor(entry.serviceAgreementId),
        changes: entry.changes ? asText(entry.changes) : undefined,
      })),
      unchangedCount: plan.unchangedCount,
      shortfalls,
      isPreview: meta.isPreview,
      scheduleRunId: meta.scheduleRunId,
    };
  }
}

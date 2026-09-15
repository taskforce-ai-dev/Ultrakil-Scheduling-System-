import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AgreementStatus,
  DataProvenance,
  DayRuleKind,
  FrequencyUnit,
  Prisma,
  ScheduleRunStatus,
  ScheduleRunTrigger,
  VisitPlacement,
  VisitStatus,
} from '@prisma/client';

import { AuditService } from '../../audit/audit.service';
import { AuthenticatedUser } from '../../auth/auth.types';
import {
  PreviewBookingIssue,
  computeSchedulePreview,
  parseDateOnly,
  toDateOnly,
} from '../../catalog/schedule-preview';
import { AppException } from '../../common/errors/app.exception';
import { DEFAULT_DAILY_VISIT_CAP } from '../../config/constants';
import { PrismaService } from '../../prisma/prisma.service';
import { assertVisitRevision, lockScheduleVisits } from '../optimizer/schedule-visit-lock';
import { anchorDaysFrom } from './anchors';
import { GenerateVisitsDto, GenerationImpactDto } from './dto';
import {
  DailyLoadWarning,
  StandingVisit,
  applyDailyLoadGuard,
} from './load-guard';
import {
  ExistingVisit,
  GenerationPlan,
  RequiredVisit,
  planGeneration,
  protectionReasonFor,
} from './plan';
import { AgreementPeriodShape, honourProtectedDates } from './protected-periods';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A run covering more than a year is almost certainly a mistyped date. */
const MAX_HORIZON_DAYS = 366;

const AGREEMENT_INCLUDE = {
  customer: { select: { name: true } },
  serviceSite: { select: { name: true, operatingHours: true } },
  dayRules: true,
  // The dates already agreed with the customer. Ordered so the anchors read
  // from them are the same whichever run asks.
  bookings: { orderBy: { bookedDate: 'asc' } },
} satisfies Prisma.ServiceAgreementInclude;

type AgreementForGeneration = Prisma.ServiceAgreementGetPayload<{
  include: typeof AGREEMENT_INCLUDE;
}>;

/** A booked date the site's own hours do not support, named for a manager. */
interface BookingWarning {
  serviceAgreementId: string;
  date: string;
  reason: string;
  message: string;
}

/**
 * An agreement the range could plan nothing for, and why.
 *
 * Not a shortfall: nothing here is wrong with the agreement. The range simply
 * does not hold a whole quarter (or fortnight, or month) of it, and the run
 * that can see one will plan it. Reported because the alternative is a zero
 * indistinguishable from a calendar already in order.
 */
interface SkippedPeriods {
  serviceAgreementId: string;
  frequencyUnit: FrequencyUnit;
  frequencyInterval: number;
  periodsSkipped: number;
  reason: 'RANGE_HOLDS_NO_WHOLE_PERIOD';
  message: string;
}

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
    private readonly config: ConfigService,
  ) {}

  /** Most visits one branch's day may carry. Configurable; rarely configured. */
  private get dailyCap(): number {
    return this.config.get<number>('visitGeneration.dailyCap') ?? DEFAULT_DAILY_VISIT_CAP;
  }

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

    // What is already in the calendar, read over the whole calendar months the
    // horizon touches rather than the horizon itself. A run over 31 August to
    // 4 October has to see the August visit published on the 17th, or the
    // pinning and the load guard both read August as empty.
    const window = enclosingMonths(from, to);
    const around = await this.loadExistingVisits(agreements, window.from, window.to);

    const planned = this.requiredVisitsFor(agreements, dto.from, dto.to);

    // Only the run's own range is the run's to change, and within it only the
    // periods this run actually planned. A visit standing in a period the run
    // left to another one is not obsolete — proposing it for removal was how a
    // month view offered to delete the week a week view had just created.
    const existing = around.filter((visit) => {
      if (visit.visitDate < dto.from || visit.visitDate > dto.to) return false;
      const span = planned.spans.get(visit.serviceAgreementId);
      return span !== undefined && visit.visitDate >= span.from && visit.visitDate <= span.to;
    });

    // A protected visit already covers its period, so the period's
    // requirement is pinned to that date rather than planned onto another one
    // — otherwise the old date is kept (it is protected) and the new one
    // created too, and the customer gets both.
    const honoured = honourProtectedDates(
      planned.required,
      around,
      this.periodShapesFor(agreements),
    );

    // One cross-agreement pass, after every agreement has had its say. Nothing
    // in per-agreement planning can see that forty of them chose the same day,
    // and nothing in this run's own list can see the work already standing in
    // the calendar — so the guard is given both.
    const standing = await this.loadStandingVisits(dto, agreements, window.from, window.to);
    const guarded = applyDailyLoadGuard(honoured, this.dailyCap, standing);
    // A requirement pinned to a protected visit outside the run's range is
    // already satisfied by it. Left in, it would read as an addition on a day
    // the run was never asked about.
    const required = guarded.required.filter(
      (visit) => visit.visitDate >= dto.from && visit.visitDate <= dto.to,
    );
    const shortfalls = planned.shortfalls;

    const plan = planGeneration(required, existing);

    const names = new Map(
      agreements.map((agreement) => [
        agreement.id,
        { customerName: agreement.customer.name, siteName: agreement.serviceSite.name },
      ]),
    );

    let scheduleRunId: string | null = null;
    if (actor) scheduleRunId = await this.apply(plan, dto, from, to, actor);

    return this.toImpact(
      plan,
      shortfalls,
      guarded.warnings,
      planned.bookingWarnings,
      planned.skipped,
      names,
      {
        from: dto.from,
        to: dto.to,
        agreementsConsidered: agreements.length,
        isPreview: actor === null,
        scheduleRunId,
      },
    );
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
        // And only for a site and customer still being serviced. The import
        // already archives the agreements of a site it read as red, so this is
        // the second lock on the same door: a site a manager deactivates by
        // hand stops generating work immediately, without anyone having to
        // remember to archive each of its agreements too.
        serviceSite: { isActive: true, customer: { isActive: true } },
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
  ): {
    required: RequiredVisit[];
    shortfalls: Shortfall[];
    bookingWarnings: BookingWarning[];
    skipped: SkippedPeriods[];
    /** The span of the periods each agreement actually planned. */
    spans: Map<string, { from: string; to: string }>;
  } {
    const required: RequiredVisit[] = [];
    const shortfalls: Shortfall[] = [];
    const bookingWarnings: BookingWarning[] = [];
    const skipped: SkippedPeriods[] = [];
    const spans = new Map<string, { from: string; to: string }>();

    for (const agreement of agreements) {
      const bookedDates = agreement.bookings.map((booking) => toDateOnly(booking.bookedDate));

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
          provenance: hours.provenance,
        })),
        agreementWindowStartMinute: agreement.serviceWindowStartMinute,
        agreementWindowEndMinute: agreement.serviceWindowEndMinute,
        durationMinutes: agreement.durationMinutes,
        // The range's real last day. Rounded up to whole weeks, a run over
        // 1-30 September believed it held the first days of October whole.
        from,
        to,
        bookedDates,
        // Anchors only mean something over a month: they are a day of the
        // month, and a week holds at most seven of those in a row. A weekly
        // agreement already visits every week, so it was never the source of
        // the pile-up — it is the monthly ones that all chose day one.
        anchorDays:
          agreement.frequencyUnit === FrequencyUnit.MONTH
            ? anchorDaysFrom(bookedDates, agreement.frequencyCount)
            : [],
        // A period this run cannot see whole belongs to the run that can. The
        // portal's month view used to ask about the calendar grid, whose
        // first cell is the last Monday of the previous month, and the stub
        // was planned as though it were the month.
        wholePeriodsOnly: true,
      });

      // The periods this agreement actually planned, so an untouched visit
      // outside them is left alone rather than proposed for removal.
      if (preview.plannedPeriods.length > 0) {
        const starts = preview.plannedPeriods.map((period) => period.start);
        const ends = preview.plannedPeriods.map((period) => period.end);
        spans.set(agreement.id, {
          from: starts.reduce((a, b) => (a < b ? a : b)),
          to: ends.reduce((a, b) => (a > b ? a : b)),
        });
      }

      // A range holding no whole period of this agreement's cadence plans
      // nothing at all. Said out loud: a quarterly agreement asked about from
      // a week view is otherwise a silent zero no manager can tell from a
      // calendar that is already correct.
      if (preview.plannedPeriods.length === 0 && preview.skippedPeriods.length > 0) {
        skipped.push({
          serviceAgreementId: agreement.id,
          frequencyUnit: agreement.frequencyUnit,
          frequencyInterval: agreement.frequencyInterval,
          periodsSkipped: preview.skippedPeriods.length,
          reason: 'RANGE_HOLDS_NO_WHOLE_PERIOD',
          message: `${cadenceName(agreement.frequencyUnit, agreement.frequencyInterval)} agreements need a range covering a whole ${cadenceNoun(agreement.frequencyUnit, agreement.frequencyInterval)}; ${from} to ${to} holds none, so nothing was planned for this agreement. Generate over a longer range.`,
        });
      }

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
          // The preview says where each visit's window actually came from:
          // the provenance of the hours row it used, the agreement's own
          // stated window, or the disclosed 08:00-17:00 assumption. Deciding
          // it here from "has any hours rows" called manager-confirmed hours
          // derived and raised a source-data warning against them.
          windowProvenance: visit.windowProvenance,
          isPreferredDay: visit.isPreferredDay,
          placement: VisitPlacement[visit.placement],
          periodIndex: visit.periodIndex,
          // Only a day still inside the requested horizon is somewhere the
          // load guard may move this visit to.
          alternatives: visit.alternatives.filter(
            (alternative) => alternative.date >= from && alternative.date <= to,
          ),
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

      for (const issue of preview.bookingIssues) {
        if (issue.date > to) continue;
        bookingWarnings.push(bookingWarningFrom(agreement.id, issue));
      }
    }

    return { required, shortfalls, bookingWarnings, skipped, spans };
  }

  /**
   * How each agreement's work divides into periods.
   *
   * The same arithmetic the preview uses, so a protected visit lands in the
   * period the run planned for it rather than a period of its own — and
   * anchored to the agreement, so it lands in the same period whatever range
   * the run was given.
   */
  private periodShapesFor(
    agreements: AgreementForGeneration[],
  ): Map<string, AgreementPeriodShape> {
    return new Map(
      agreements.map((agreement) => [
        agreement.id,
        {
          serviceAgreementId: agreement.id,
          anchor: toDateOnly(agreement.startDate),
          frequencyUnit: agreement.frequencyUnit,
          frequencyInterval: agreement.frequencyInterval,
          allowedDays: agreement.dayRules
            .filter((rule) => rule.kind === DayRuleKind.ALLOWED)
            .map((rule) => rule.weekday),
        },
      ]),
    );
  }

  /**
   * Everything already in the horizon that this run will leave standing.
   *
   * Deliberately not limited to the agreements in scope. A run asked about one
   * agreement still has to see the other eleven visits on the Monday it is
   * about to choose, or it will anchor onto a full day and the next full run
   * will move the visit straight off it again.
   *
   * A cancelled visit is the one exception. It is protected, and it is never
   * removed, but the optimizer excludes it from the day's capacity and so must
   * the guard: counting one reserved a crew's worth of room for work nobody
   * will do, and pushed the next agreement onto a day it had no reason to be
   * on.
   */
  private async loadStandingVisits(
    dto: GenerateVisitsDto,
    agreements: AgreementForGeneration[],
    from: Date,
    to: Date,
  ): Promise<StandingVisit[]> {
    const inScope = new Set(agreements.map((agreement) => agreement.id));

    const visits = await this.prisma.generatedVisit.findMany({
      where: {
        visitDate: { gte: from, lte: to },
        // Cancelled work occupies no part of the day. Everything else does.
        status: { not: VisitStatus.CANCELLED },
        // Branch isolation: a Kandy day says nothing about a Colombo one, and
        // a run scoped to a branch has no business reading the other's book.
        ...(dto.branchCode ? { branchCode: dto.branchCode } : {}),
      },
      select: {
        serviceAgreementId: true,
        branchCode: true,
        visitDate: true,
        status: true,
        isManuallyAdjusted: true,
        lockedAt: true,
        _count: { select: { assignments: true } },
      },
    });

    return visits
      .filter(
        (visit) =>
          !inScope.has(visit.serviceAgreementId) ||
          protectionReasonFor({
            status: visit.status,
            isManuallyAdjusted: visit.isManuallyAdjusted,
            isLocked: visit.lockedAt !== null,
            hasAssignments: visit._count.assignments > 0,
          }) !== null,
      )
      .map((visit) => ({
        serviceAgreementId: visit.serviceAgreementId,
        branchCode: visit.branchCode,
        visitDate: toDateOnly(visit.visitDate),
      }));
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
      updatedAt: visit.updatedAt,
      serviceAgreementId: visit.serviceAgreementId,
      visitDate: toDateOnly(visit.visitDate),
      windowStartMinute: visit.windowStartMinute,
      windowEndMinute: visit.windowEndMinute,
      durationMinutes: visit.durationMinutes,
      requiredCrewSize: visit.requiredCrewSize,
      status: visit.status,
      placement: visit.placement,
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
      (await this.prisma.branch.findMany()).map((branch) => [
        branch.code,
        branch.id,
      ]),
    );
    const currentVersions = await this.currentVersionIds(plan);

    return this.prisma.$transaction(async (tx) => {
      const changes = [...plan.updates, ...plan.removals];
      await lockScheduleVisits(
        tx,
        changes.map((change) => change.visitId),
      );
      const current = await tx.generatedVisit.findMany({
        where: { id: { in: changes.map((change) => change.visitId) } },
        include: { _count: { select: { assignments: true } } },
      });
      const byId = new Map(current.map((visit) => [visit.id, visit]));
      // Validate the whole plan before additions, updates, removals or run/audit
      // writes. A stale plan is rejected atomically, never partially skipped.
      for (const change of changes) {
        const visit = byId.get(change.visitId);
        if (
          !visit ||
          visit._count.assignments !== 0 ||
          visit.lockedAt !== null ||
          visit.isManuallyAdjusted ||
          (visit.status !== VisitStatus.PENDING &&
            visit.status !== VisitStatus.UNASSIGNED)
        ) {
          throw new AppException(
            'RESOURCE_CONFLICT',
            'A visit became protected after generation was planned. Preview again before confirming.',
            HttpStatus.CONFLICT,
            { visitId: change.visitId },
          );
        }
        assertVisitRevision(
          change.visitId,
          change.expectedUpdatedAt,
          visit.updatedAt,
        );
      }
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
            windowProvenance: addition.required.windowProvenance ?? DataProvenance.UNKNOWN,
            placement: addition.required.placement,
            status: VisitStatus.PENDING,
            generatedByRunId: run.id,
            agreementVersionId:
              currentVersions.get(addition.required.serviceAgreementId) ?? null,
          },
        });
      }

      for (const update of plan.updates) {
        const applied = await tx.generatedVisit.updateMany({
          where: { id: update.visitId, updatedAt: update.expectedUpdatedAt },
          data: {
            windowEndMinute: update.required.windowEndMinute,
            durationMinutes: update.required.durationMinutes,
            requiredCrewSize: update.required.requiredCrewSize,
            windowProvenance: update.required.windowProvenance ?? DataProvenance.UNKNOWN,
            placement: update.required.placement,
            generatedByRunId: run.id,
            agreementVersionId:
              currentVersions.get(update.required.serviceAgreementId) ?? null,
          },
        });
        if (applied.count !== 1) {
          throw new AppException(
            'RESOURCE_CONFLICT',
            'A visit changed after generation was planned.',
            HttpStatus.CONFLICT,
            { visitId: update.visitId },
          );
        }
      }

      if (plan.removals.length > 0) {
        const removed = await tx.generatedVisit.deleteMany({
          where: {
            OR: plan.removals.map((removal) => ({
              id: removal.visitId,
              updatedAt: removal.expectedUpdatedAt,
            })),
          },
        });
        if (removed.count !== plan.removals.length) {
          throw new AppException(
            'RESOURCE_CONFLICT',
            'A visit changed after generation was planned.',
            HttpStatus.CONFLICT,
          );
        }
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
    loadWarnings: DailyLoadWarning[],
    bookingWarnings: BookingWarning[],
    skippedPeriods: SkippedPeriods[],
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
        ...toPlannedVisit(addition.required),
        ...nameFor(addition.required.serviceAgreementId),
      })),
      updates: plan.updates.map((update) => ({
        visitId: update.visitId,
        ...toPlannedVisit(update.required),
        ...nameFor(update.required.serviceAgreementId),
        changes: asText(update.changes),
      })),
      removals: plan.removals.map((removal) => ({
        visitId: removal.visitId,
        serviceAgreementId: removal.serviceAgreementId,
        visitDate: removal.visitDate,
        reason: removal.reason,
        ...nameFor(removal.serviceAgreementId),
      })),
      protectedVisits: plan.protectedVisits.map((entry) => ({
        ...entry,
        ...nameFor(entry.serviceAgreementId),
        changes: entry.changes ? asText(entry.changes) : undefined,
      })),
      unchangedCount: plan.unchangedCount,
      shortfalls,
      loadWarnings,
      bookingWarnings,
      skippedPeriods,
      isPreview: meta.isPreview,
      scheduleRunId: meta.scheduleRunId,
    };
  }
}

/**
 * A planned visit as the manager's screen sees it.
 *
 * The planner carries a period index and the days a visit could have moved to,
 * neither of which is part of the contract. Spreading the whole requirement
 * onto the wire would ship fields the OpenAPI document does not describe, and
 * the first person to rely on one would find it gone the next release.
 */
/**
 * A booking issue as the impact report carries it.
 *
 * The agreement's id, never the customer's name: a warning outlives the screen
 * it was raised on — it is logged, pasted into a message, read by someone who
 * is not the manager — and a customer name travelling that far is a privacy
 * decision nobody made. The id resolves to the agreement for anyone entitled
 * to look it up.
 */
/**
 * The whole calendar months a range touches.
 *
 * Periods are months, and half a month tells the pinning and the load guard
 * very little: a run over 31 August to 4 October that reads only its own range
 * sees an empty August and plans a second visit into it. Widening the *read*
 * costs one index scan and nothing else — what the run may change is still
 * exactly its own range.
 */
function enclosingMonths(from: Date, to: Date): { from: Date; to: Date } {
  return {
    from: new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)),
    to: new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() + 1, 0)),
  };
}

/** "Quarterly", "Fortnightly" — the word UltraKIL sells the cadence by. */
function cadenceName(unit: FrequencyUnit, interval: number): string {
  const named: Record<string, string> = {
    'WEEK|1': 'Weekly',
    'WEEK|2': 'Fortnightly',
    'MONTH|1': 'Monthly',
    'MONTH|2': 'Two-monthly',
    'MONTH|3': 'Quarterly',
    'MONTH|6': 'Six-monthly',
    'MONTH|12': 'Yearly',
  };
  return (
    named[`${unit}|${interval}`] ??
    `Every ${interval} ${unit === FrequencyUnit.WEEK ? 'weeks' : 'months'}`
  );
}

/** The span such an agreement needs a run to hold whole. */
function cadenceNoun(unit: FrequencyUnit, interval: number): string {
  const named: Record<string, string> = {
    'WEEK|1': 'week',
    'WEEK|2': 'fortnight',
    'MONTH|1': 'month',
    'MONTH|3': 'quarter',
  };
  return (
    named[`${unit}|${interval}`] ??
    `${interval} ${unit === FrequencyUnit.WEEK ? 'weeks' : 'months'}`
  );
}

function bookingWarningFrom(
  serviceAgreementId: string,
  issue: PreviewBookingIssue,
): BookingWarning {
  return {
    serviceAgreementId,
    date: issue.date,
    reason: issue.reason,
    message: issue.message,
  };
}

function toPlannedVisit(required: RequiredVisit) {
  return {
    serviceAgreementId: required.serviceAgreementId,
    visitDate: required.visitDate,
    windowStartMinute: required.windowStartMinute,
    windowEndMinute: required.windowEndMinute,
    durationMinutes: required.durationMinutes,
    requiredCrewSize: required.requiredCrewSize,
    branchCode: required.branchCode,
    isPreferredDay: required.isPreferredDay,
    placement: required.placement,
  };
}

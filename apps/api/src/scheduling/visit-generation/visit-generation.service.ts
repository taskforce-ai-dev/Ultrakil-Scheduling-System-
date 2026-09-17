import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AgreementStatus,
  BranchCode,
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
  periodIndexOf,
  toDateOnly,
} from '../../catalog/schedule-preview';
import { AppException } from '../../common/errors/app.exception';
import { DEFAULT_DAILY_VISIT_CAP } from '../../config/constants';
import { lockAgreementRows } from '../../common/locks/agreement-lock';
import { PrismaService } from '../../prisma/prisma.service';
import { BranchDay, lockBranchDays } from '../optimizer/branch-day-lock';
import { branchDayKey } from '../optimizer/daily-load-ledger';
import { assertVisitRevision, lockScheduleVisits } from '../optimizer/schedule-visit-lock';
import { anchorDaysFrom } from './anchors';
import { cadenceName, cadenceNoun, spansOf } from './cadence';
import { clippedPeriodsAtRisk, clippingOneMayLoseIt } from './clipped-periods';
import { ExtendHorizonsDto, GenerateVisitsDto, GenerationImpactDto } from './dto';
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
import { AgreementLifetime, leftStandingBy, thisRunsToJudge } from './run-scope';

/** What one read of the run's horizon tells it: see {@link VisitGenerationService.readTheRange}. */
interface RangeAsItStands {
  /** Everything in the range this run will leave exactly where it is. */
  standing: StandingVisit[];
  /** How full each branch-day of the range is, by `branchDayKey`. */
  loadByDay: Map<string, number>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A run covering more than a year is almost certainly a mistyped date. */
const MAX_HORIZON_DAYS = 366;
/** How far ahead {@link VisitGenerationService.extendRollingHorizons} plans an open-ended agreement. */
const ROLLING_HORIZON_DAYS = 365;

function addDays(date: string, days: number): string {
  return toDateOnly(new Date(parseDateOnly(date).getTime() + days * DAY_MS));
}

function laterDateOnly(a: string, b: string): string {
  return a >= b ? a : b;
}

/** One open-ended agreement {@link VisitGenerationService.extendRollingHorizons} planned further into. */
export interface HorizonExtension {
  serviceAgreementId: string;
  customerName: string;
  siteName: string;
  from: string;
  to: string;
  visitsAdded: number;
}

export interface HorizonExtensionSummary {
  today: string;
  targetHorizon: string;
  /** Every active, open-ended agreement considered — extended or already caught up. */
  agreementsConsidered: number;
  agreementsExtended: HorizonExtension[];
}

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
  reason: 'RANGE_HOLDS_NO_WHOLE_PERIOD' | 'RANGE_CLIPS_A_PERIOD';
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

  /**
   * Keeps every open-ended agreement planned a rolling year ahead.
   *
   * An agreement with an end date stops there, the same as any other
   * generation call — this only ever widens the horizon for one that never
   * ends, and only for the stretch it does not have yet. "Has" means the
   * latest date among its own non-cancelled visits; an agreement with none
   * yet is planned from its own start date, and never from earlier than
   * today either — an agreement that started years ago and somehow has no
   * visits at all is not this operation's chance to backfill its whole
   * history, only to make sure the year ahead of it is covered.
   *
   * Each agreement is generated through the ordinary, scoped {@link confirm}
   * — the same call a manager's own Generate Visits makes for one agreement
   * — so it inherits every protection that path already has: it can only
   * ever add, update or remove *this* agreement's own visits, published and
   * locked work stays put, and a second call over ground already covered
   * reports nothing to do. Calling this twice in a row, or while a manager
   * is generating something else entirely, is exactly as safe as calling
   * `confirm` twice in a row already is.
   *
   * Nothing here runs this on a schedule. `docs/ARCHITECTURE.md` and the PR
   * that added it say why: wiring a live cron changes what happens in every
   * environment the moment it deploys, and this branch's own rule is no
   * deploy, no staging changes. This is the operation a scheduled job (or an
   * operator, by hand) calls; deciding when to call it is a deployment
   * decision for later.
   *
   * `scope` narrows which open-ended agreements are considered — by branch,
   * by id, or both — the same two filters {@link GenerateVisitsDto} already
   * offers. Omitted, every open-ended agreement in the company is
   * considered, which is the real operation: a company has one financial
   * calendar, not one per branch. Narrowing it is for an operator fixing one
   * branch or one customer's horizon without touching anyone else's.
   */
  async extendRollingHorizons(
    actor: AuthenticatedUser,
    scope: ExtendHorizonsDto = {},
  ): Promise<HorizonExtensionSummary> {
    const today = toDateOnly(new Date());
    const targetHorizon = addDays(today, ROLLING_HORIZON_DAYS);

    const agreements = await this.prisma.serviceAgreement.findMany({
      where: {
        status: AgreementStatus.ACTIVE,
        endDate: null,
        serviceSite: { isActive: true, customer: { isActive: true } },
        ...(scope.branchCode ? { branchCode: scope.branchCode } : {}),
        ...(scope.serviceAgreementIds?.length
          ? { id: { in: scope.serviceAgreementIds } }
          : {}),
      },
      select: {
        id: true,
        startDate: true,
        customer: { select: { name: true } },
        serviceSite: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const plannedThroughRows = await this.prisma.generatedVisit.groupBy({
      by: ['serviceAgreementId'],
      where: {
        serviceAgreementId: { in: agreements.map((agreement) => agreement.id) },
        status: { not: VisitStatus.CANCELLED },
      },
      _max: { visitDate: true },
    });
    const plannedThroughById = new Map(
      plannedThroughRows.map((row) => [row.serviceAgreementId, row._max.visitDate]),
    );

    const extended: HorizonExtension[] = [];
    for (const agreement of agreements) {
      const agreementStart = toDateOnly(agreement.startDate);
      const lastPlanned = plannedThroughById.get(agreement.id);
      const plannedThrough = lastPlanned
        ? toDateOnly(lastPlanned)
        : addDays(agreementStart, -1);

      // Already planned to the target, or past it — nothing to extend. True,
      // harmlessly, on every call after the first one for a given agreement
      // once it has caught up, which is what keeps this idempotent.
      if (plannedThrough >= targetHorizon) continue;

      const from = laterDateOnly(laterDateOnly(addDays(plannedThrough, 1), agreementStart), today);
      // The agreement's own start is still further out than a year from now
      // — nothing is due yet.
      if (from > targetHorizon) continue;

      const impact = await this.confirm(
        { from, to: targetHorizon, serviceAgreementIds: [agreement.id] },
        actor,
      );
      if (impact.additions.length === 0 && impact.updates.length === 0) continue;

      extended.push({
        serviceAgreementId: agreement.id,
        customerName: agreement.customer.name,
        siteName: agreement.serviceSite.name,
        from,
        to: targetHorizon,
        visitsAdded: impact.additions.length,
      });
    }

    return {
      today,
      targetHorizon,
      agreementsConsidered: agreements.length,
      agreementsExtended: extended,
    };
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

    const shapes = this.periodShapesFor(agreements);

    const planned = this.requiredVisitsFor(
      agreements,
      dto.from,
      dto.to,
      cancelledSlotsBy(around),
      await this.periodsHoldingAVisit(agreements, shapes, window),
    );

    const lives = lifetimes(agreements);
    const existing = around.filter((visit) =>
      thisRunsToJudge(visit, dto, shapes, planned.periods, lives),
    );

    // A protected visit already covers its period, so the period's
    // requirement is pinned to that date rather than planned onto another one
    // — otherwise the old date is kept (it is protected) and the new one
    // created too, and the customer gets both.
    const honoured = honourProtectedDates(planned.required, around, shapes);

    // One cross-agreement pass, after every agreement has had its say. Nothing
    // in per-agreement planning can see that forty of them chose the same day,
    // and nothing in this run's own list can see the work already standing in
    // the calendar — so the guard is given both.
    const range = await this.readTheRange(dto, agreements, from, to, {
      shapes,
      plannedPeriods: planned.periods,
      lives,
    });
    const guarded = applyDailyLoadGuard(honoured, this.dailyCap, range.standing);
    // A day the run was never asked about is not its to warn about. Standing
    // work is already read over the range alone, but `honoured` can pin a
    // requirement onto a protected visit outside it — which is dropped from
    // the plan two lines below, and must not leave a warning behind either.
    const loadWarnings = guarded.warnings.filter(
      (warning) => warning.date >= dto.from && warning.date <= dto.to,
    );
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
    if (actor) {
      scheduleRunId = await this.apply(plan, dto, from, to, actor, range.loadByDay);
    }

    return this.toImpact(
      plan,
      shortfalls,
      loadWarnings,
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
    blockedSlots: Map<string, Array<{ date: string; windowStartMinute: number }>>,
    occupiedPeriods: Map<string, Set<number>>,
  ): {
    required: RequiredVisit[];
    shortfalls: Shortfall[];
    bookingWarnings: BookingWarning[];
    skipped: SkippedPeriods[];
    /** Which of each agreement's periods this run actually planned. */
    periods: Map<string, Set<number>>;
  } {
    const required: RequiredVisit[] = [];
    const shortfalls: Shortfall[] = [];
    const bookingWarnings: BookingWarning[] = [];
    const skipped: SkippedPeriods[] = [];
    const periods = new Map<string, Set<number>>();

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
        blockedSlots: blockedSlots.get(agreement.id) ?? [],
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
      // sitting in one this run left alone is not proposed for removal.
      periods.set(
        agreement.id,
        new Set(preview.plannedPeriods.map((period) => period.periodIndex)),
      );

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
      } else if (clippingOneMayLoseIt(agreement.frequencyUnit, agreement.frequencyInterval)) {
        // A period clipped at the edge of a month grid is normally handed over
        // rather than lost, and `clippedPeriodsAtRisk` keeps only the ones
        // nobody is coming back for: one that begins before the week of
        // overlap the next grid starts on, or one clipped at either edge that
        // no visit of this agreement stands in. Multi-week cadences only: a
        // month clipped this way is always picked up by the next grid, which
        // holds the calendar month whole by construction.
        const unfinished = clippedPeriodsAtRisk(preview.skippedPeriods, {
          from,
          to,
          periodsHoldingAVisit: occupiedPeriods.get(agreement.id) ?? new Set<number>(),
        });
        if (unfinished.length > 0) {
          skipped.push({
            serviceAgreementId: agreement.id,
            frequencyUnit: agreement.frequencyUnit,
            frequencyInterval: agreement.frequencyInterval,
            periodsSkipped: unfinished.length,
            reason: 'RANGE_CLIPS_A_PERIOD',
            message: `${cadenceName(agreement.frequencyUnit, agreement.frequencyInterval)} agreements are planned a whole ${cadenceNoun(agreement.frequencyUnit, agreement.frequencyInterval)} at a time, and ${from} to ${to} holds only part of ${spansOf(unfinished)}. Nothing is planned there, no visit stands there, and no neighbouring month's grid holds it whole either. Generate from the month it starts in, or use a wider range, to plan it.`,
          });
        }
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

    return { required, shortfalls, bookingWarnings, skipped, periods };
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
   * The horizon as it stands, read once: what this run will leave standing,
   * and how full each of its days is.
   *
   * Two answers from one read, and that is the point of the method rather than
   * an economy. `apply` decides whether a day it is adding to has grown since
   * the plan was made, and it can only ask that question against the very
   * calendar the guard planned against. A second count taken a moment later is
   * a *different* calendar: with the count read first and the standing set
   * second, a visit removed in between leaves the baseline reading twelve and
   * the guard reading eleven, the guard plans its addition, another planner
   * takes the freed slot, and the commit-time comparison sees twelve against a
   * baseline of twelve and calls that no growth at all. Measured: a thirteenth
   * visit committed on a day capped at twelve, with no warning. One statement
   * is one snapshot, and the question stays answerable.
   *
   * ## What is standing
   *
   * Deliberately not limited to the agreements in scope. A run asked about one
   * agreement still has to see the other eleven visits on the Monday it is
   * about to choose, or it will anchor onto a full day and the next full run
   * will move the visit straight off it again.
   *
   * Nor is it limited to *protected* work. The set the guard needs is the
   * complement of the set the comparison judges: whatever this run will not be
   * replacing is still on its day. A PENDING visit whose period this range
   * holds only a slice of — a monthly visit met from a week view — is in
   * neither set until you say so, and that gap is what made a week run and a
   * month run disagree about how full the same Monday was. Such a visit stays
   * out of `existing`, so it is never proposed for removal, and now counts
   * towards its day, so it is never planned over either.
   *
   * Only days inside the run's own range, because those are the only days the
   * guard may place anything on, and a day the run was never asked about is
   * not its to warn about. That is the whole range and nothing wider: the read
   * used to widen to the enclosing calendar months for protected and
   * out-of-scope work, which bought the guard nothing it could act on — every
   * day it may move a visit to is inside the range — and cost an October view
   * a warning about a September day.
   *
   * A cancelled visit is the one exception. It is protected, and it is never
   * removed, but the optimizer excludes it from the day's capacity and so must
   * the guard: counting one reserved a crew's worth of room for work nobody
   * will do, and pushed the next agreement onto a day it had no reason to be
   * on.
   */
  private async readTheRange(
    dto: GenerateVisitsDto,
    agreements: AgreementForGeneration[],
    from: Date,
    to: Date,
    scope: {
      shapes: Map<string, AgreementPeriodShape>;
      plannedPeriods: Map<string, Set<number>>;
      lives: Map<string, AgreementLifetime>;
    },
  ): Promise<RangeAsItStands> {
    const inScope = new Set(agreements.map((agreement) => agreement.id));

    const visits = await this.prisma.generatedVisit.findMany({
      where: this.theRangeCounted(dto, from, to),
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

    // Every row, whoever it belongs to and whether or not this run judges it:
    // a day is as full as the work on it. Counted before anything is filtered
    // out, because the filter below is about *authorship*, and the cap is not.
    const loadByDay = new Map<string, number>();
    for (const visit of visits) {
      const key = branchDayKey(visit.branchCode, toDateOnly(visit.visitDate));
      loadByDay.set(key, (loadByDay.get(key) ?? 0) + 1);
    }

    const standing = visits
      .map((visit) => ({
        serviceAgreementId: visit.serviceAgreementId,
        branchCode: visit.branchCode,
        visitDate: toDateOnly(visit.visitDate),
        isInScope: inScope.has(visit.serviceAgreementId),
        isProtected:
          protectionReasonFor({
            status: visit.status,
            isManuallyAdjusted: visit.isManuallyAdjusted,
            isLocked: visit.lockedAt !== null,
            hasAssignments: visit._count.assignments > 0,
          }) !== null,
      }))
      .filter((visit) =>
        leftStandingBy(visit, dto, scope.shapes, scope.plannedPeriods, scope.lives),
      )
      .map((visit) => ({
        serviceAgreementId: visit.serviceAgreementId,
        branchCode: visit.branchCode,
        visitDate: visit.visitDate,
      }));

    return { standing, loadByDay };
  }

  /**
   * The rows a branch-day's load is counted from — here and in the
   * transaction, from one definition so the two cannot drift apart.
   *
   * Cancelled work occupies no part of the day; everything else does. Branch
   * isolation: a Kandy day says nothing about a Colombo one, and a run scoped
   * to a branch has no business reading the other's book.
   */
  private theRangeCounted(
    dto: GenerateVisitsDto,
    from: Date,
    to: Date,
  ): Prisma.GeneratedVisitWhereInput {
    return {
      visitDate: { gte: from, lte: to },
      status: { not: VisitStatus.CANCELLED },
      ...(dto.branchCode ? { branchCode: dto.branchCode } : {}),
    };
  }

  /**
   * The periods each multi-week agreement already has a visit in, by index.
   *
   * This is the evidence a clipped period is reported on: one handed over as
   * designed holds a visit, and one nobody planned is empty. Asking the
   * calendar rather than reasoning about which runs have been pressed is what
   * makes the rule assumption-free.
   *
   * Read over its own window, wider than the enclosing months `around` covers,
   * because a clipped period reaches past the range by up to a whole period
   * and the visit standing in it can be anywhere inside. June's grid encloses
   * June and July; the fortnight it clips at the start began on 25 May, and
   * the visit May's run put there is on that very day.
   *
   * Only the cadences a clipped period is ever reported for, so on a book of
   * weekly and monthly work this costs no query at all. A cancelled visit does
   * not count: it satisfies no period anywhere else in generation, and
   * counting it here would say a customer is served when nobody is going.
   */
  private async periodsHoldingAVisit(
    agreements: AgreementForGeneration[],
    shapes: Map<string, AgreementPeriodShape>,
    window: { from: Date; to: Date },
  ): Promise<Map<string, Set<number>>> {
    const watched = agreements.filter((agreement) =>
      clippingOneMayLoseIt(agreement.frequencyUnit, agreement.frequencyInterval),
    );
    if (watched.length === 0) return new Map();

    const reach =
      Math.max(...watched.map((agreement) => agreement.frequencyInterval * 7)) * DAY_MS;

    const visits = await this.prisma.generatedVisit.findMany({
      where: {
        serviceAgreementId: { in: watched.map((agreement) => agreement.id) },
        visitDate: {
          gte: new Date(window.from.getTime() - reach),
          lte: new Date(window.to.getTime() + reach),
        },
        status: { not: VisitStatus.CANCELLED },
      },
      select: { serviceAgreementId: true, visitDate: true },
    });

    const held = new Map<string, Set<number>>();
    for (const visit of visits) {
      const shape = shapes.get(visit.serviceAgreementId);
      if (!shape) continue;

      const period = periodIndexOf(
        visit.visitDate,
        parseDateOnly(shape.anchor),
        shape.frequencyUnit,
        shape.frequencyInterval,
      );
      const periods = held.get(visit.serviceAgreementId) ?? new Set<number>();
      periods.add(period);
      held.set(visit.serviceAgreementId, periods);
    }

    return held;
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
   * Refuses a plan whose days filled up while it was being confirmed.
   *
   * Generation works out where visits go before it opens a transaction: the
   * load guard reads the calendar, spreads what it can, and hands `apply` a
   * list of days. Nothing in that sequence holds anything. A second generation
   * over other agreements, or a solve committing the optimizer's moves, can
   * put the last visit a day had room for on it in between — and the additions
   * below take no lock anybody could notice, because a row that does not exist
   * yet cannot be locked.
   *
   * So the days this run adds to are locked here, and the load read again
   * inside the transaction that will commit the additions. Two conditions have
   * to hold together before a plan is refused, and both matter:
   *
   * - **the day grew.** If it carries exactly what it carried when the plan
   *   was made, no one has raced this run and the plan is as good as it was.
   *   This is what keeps the ordinary case — every generation that is not
   *   racing anything — behaving exactly as before. "When the plan was made"
   *   is `readTheRange`'s own count, taken from the rows the load guard was
   *   handed; an aggregate read a moment apart from those rows is a different
   *   calendar, and a removal landing between the two hid a later addition
   *   well enough to commit a thirteenth visit on a day capped at twelve.
   * - **and it would now end over the cap.** A day the guard already reported
   *   as over the cap, and could do nothing about, is still allowed to be
   *   generated onto: `applyDailyLoadGuard` warns rather than blocks there,
   *   deliberately, and a backstop that turned that warning into a refusal
   *   would stop a branch generating at all.
   *
   * The refusal is the whole run, not the one visit. A generation is all or
   * nothing by design — a half-applied one leaves a calendar nobody can
   * explain — and the honest answer to "the calendar moved under you" is the
   * one already given when a visit becomes protected mid-plan: preview again,
   * and the guard will spread this visit somewhere that has room.
   */
  private async assertTheDaysStillHaveRoom(
    tx: Prisma.TransactionClient,
    dto: GenerateVisitsDto,
    from: Date,
    to: Date,
    plan: GenerationPlan,
    changing: Map<string, { branchCode: BranchCode }>,
    /** Each day's load in the same read the guard planned against. */
    loadWhenPlanned: Map<string, number>,
  ): Promise<void> {
    // A run that adds nothing cannot make a day fuller, so it queues behind
    // nobody. Updates change a visit's window, never its date.
    if (plan.additions.length === 0) return;

    const days = new Map<string, BranchDay>();
    const delta = new Map<string, number>();
    for (const addition of plan.additions) {
      const day: BranchDay = {
        branchCode: addition.required.branchCode,
        date: addition.required.visitDate,
      };
      const key = branchDayKey(day.branchCode, day.date);
      days.set(key, day);
      delta.set(key, (delta.get(key) ?? 0) + 1);
    }
    // A removal on the same day makes room for an addition, and the plan
    // commits both or neither. The branch comes from the locked row rather
    // than the plan, which carries only the date.
    for (const removal of plan.removals) {
      const branchCode = changing.get(removal.visitId)?.branchCode;
      if (!branchCode) continue;
      const key = branchDayKey(branchCode, removal.visitDate);
      delta.set(key, (delta.get(key) ?? 0) - 1);
    }

    // Last of the three, after the agreement and visit rows `apply` has
    // already locked, and in the sorted order `lockBranchDays` imposes: the
    // two writers must agree on the whole sequence or they deadlock instead of
    // queueing. Only the days this run adds to are locked — a day it only
    // removes from can only get emptier.
    await lockBranchDays(tx, [...days.values()]);
    const loadNow = await this.readBranchDayLoad(tx, dto, from, to);

    for (const [key, day] of days) {
      const now = loadNow.get(key) ?? 0;
      const ending = now + (delta.get(key) ?? 0);
      if (now <= (loadWhenPlanned.get(key) ?? 0)) continue;
      if (ending <= this.dailyCap) continue;

      throw new AppException(
        'RESOURCE_CONFLICT',
        `${day.date} filled up while this generation was being confirmed: it now carries ${now} ${
          now === 1 ? 'visit' : 'visits'
        } in ${day.branchCode}, and this run would leave ${ending} there, over the ${this.dailyCap} a day this branch plans for. Preview again before confirming.`,
        HttpStatus.CONFLICT,
        { branchCode: day.branchCode, date: day.date, carrying: now, cap: this.dailyCap },
      );
    }
  }

  /**
   * How many visits each branch-day of the horizon carries, read inside the
   * transaction that is about to add to it.
   *
   * The plan-time half of the comparison is not another call to this: it is
   * counted from the rows {@link readTheRange} already fetched, so that the
   * baseline and the guard's own picture are one snapshot rather than two
   * moments. What both halves share is `theRangeCounted` — the same rows, the
   * same basis, and no way for the two to drift into counting different days.
   *
   * That basis is the load guard's own, and the optimizer's: every visit
   * standing on the day that is not cancelled, whatever agreement it belongs
   * to and whoever put it there.
   */
  private async readBranchDayLoad(
    client: Prisma.TransactionClient,
    dto: GenerateVisitsDto,
    from: Date,
    to: Date,
  ): Promise<Map<string, number>> {
    const rows = await client.generatedVisit.groupBy({
      by: ['branchCode', 'visitDate'],
      where: this.theRangeCounted(dto, from, to),
      _count: { _all: true },
    });
    return new Map(
      rows.map((row) => [
        branchDayKey(row.branchCode, toDateOnly(row.visitDate)),
        row._count._all,
      ]),
    );
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
    loadWhenPlanned: Map<string, number>,
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
      // Agreements first, then visits, then — inside the cap check — the
      // branch-days. That is the order `ScheduleRunService.persistResult`
      // takes, and both writers have to take it or they deadlock instead of
      // queueing.
      //
      // **Additions are the reason this is here at all.** A run that only adds
      // changes no visit, so it locks no visit row, and used to reach the
      // branch-day lock holding nothing. The insert that follows still needs
      // the agreement — Postgres takes a `FOR KEY SHARE` on the referenced row
      // for the foreign key — and the optimizer holds that row `FOR UPDATE`
      // from the start of its own transaction while it waits for the same day.
      // Postgres named the cycle exactly: "Process A waits for ShareLock on
      // transaction …; Process B waits for ExclusiveLock on advisory lock
      // [… 1430998084 …]", and killed one of the two. Locking the agreement
      // here, before the day, means this run waits at the same place the
      // optimizer does instead of meeting it head on.
      await lockAgreementRows(tx, [
        ...plan.additions.map((addition) => addition.required.serviceAgreementId),
        ...plan.updates.map((update) => update.required.serviceAgreementId),
        ...plan.removals.map((removal) => removal.serviceAgreementId),
      ]);
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
      // The cap, this time under a lock and against the calendar as it stands
      // now. Everything above was planned against a calendar read before this
      // transaction opened.
      await this.assertTheDaysStillHaveRoom(tx, dto, from, to, plan, byId, loadWhenPlanned);

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
      },
      // Prisma's default is five seconds, and this transaction now queues:
      // holding the agreement rows in the one order everybody uses means a
      // confirm can legitimately wait behind an import updating the same
      // customer. Thirty seconds, the same budget the optimizer's persistence
      // runs on, is long enough for that queue and short enough that a stuck
      // writer is still reported rather than sat behind. The largest run in
      // the integration suite — 65 agreements, 325 additions — commits in
      // 1.3s. Exceeding it rolls the whole run back; nothing is half-applied,
      // and the manager presses Generate again.
      { timeout: 30_000 },
    );
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

/** Each agreement's own first and last day, as the run reads them. */
function lifetimes(
  agreements: AgreementForGeneration[],
): Map<string, AgreementLifetime> {
  return new Map(
    agreements.map((agreement) => [
      agreement.id,
      {
        start: toDateOnly(agreement.startDate),
        end: agreement.endDate ? toDateOnly(agreement.endDate) : null,
      },
    ]),
  );
}

/**
 * The slots cancelled visits hold, by agreement.
 *
 * A cancelled visit is never removed, and a visit is identified by agreement,
 * date and start time — so the slot is spent. Handed to the preview, the
 * period picks another allowed day instead of quietly reporting itself
 * satisfied by work nobody will do.
 */
function cancelledSlotsBy(
  visits: ExistingVisit[],
): Map<string, Array<{ date: string; windowStartMinute: number }>> {
  const slots = new Map<string, Array<{ date: string; windowStartMinute: number }>>();

  for (const visit of visits) {
    if (visit.status !== VisitStatus.CANCELLED) continue;
    const list = slots.get(visit.serviceAgreementId) ?? [];
    list.push({ date: visit.visitDate, windowStartMinute: visit.windowStartMinute });
    slots.set(visit.serviceAgreementId, list);
  }

  return slots;
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

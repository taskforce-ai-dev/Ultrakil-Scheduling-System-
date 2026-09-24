import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  AssignmentStatus,
  BranchCode,
  CrewRole,
  DayRuleKind,
  FrequencyUnit,
  LockScope,
  Prisma,
  ScheduleRunDispatchStatus,
  ScheduleRunStatus,
  VisitPlacement,
  VisitStatus,
  Weekday,
} from '@prisma/client';

import { AuditService } from '../../audit/audit.service';
import { AuthenticatedUser } from '../../auth/auth.types';
import { weekdayOf } from '../../catalog/schedule-preview';
import { AppException } from '../../common/errors/app.exception';
import { lockAgreementRows } from '../../common/locks/agreement-lock';
import { lockSiteRows } from '../../common/locks/site-lock';
import { PrismaService } from '../../prisma/prisma.service';
import { crewMinutesOf } from '../capacity';
import { Conflict } from '../eligibility/conflict-codes';
import { EligibilityService } from '../eligibility/eligibility.service';
import { BranchDayCapacityService } from '../visit-generation/branch-day-capacity.service';
import { lockBranchDays } from './branch-day-lock';
import { buildCandidateSlots, splitDayRules } from './candidate-slots';
import {
  branchDayKey,
  dailyCapRefusal,
  DailyLoadLedger,
} from './daily-load-ledger';
import { SchedulerClient, SolveRequest } from './scheduler.client';
import {
  lockScheduleResources,
  assertScheduleSnapshotRows,
  assertVisitRevision,
  lockScheduleVisits,
} from './schedule-visit-lock';
import type { ScheduleRunDispatcherProvider } from './schedule-run.dispatcher';
import {
  BULLMQ_EXECUTION_LEASE_SECONDS,
  BULLMQ_LEASE_HEARTBEAT_MILLISECONDS,
  SCHEDULE_EXECUTION_LEASE_SAFETY_SECONDS,
  SCHEDULE_EXECUTION_PERSISTENCE_RESERVE_SECONDS,
  SCHEDULE_EXECUTION_PREPARATION_RESERVE_SECONDS,
  SCHEDULE_SOLVER_TRANSPORT_RESERVE_SECONDS,
  SELF_HOSTED_EXECUTION_BUDGET_SECONDS,
} from './schedule-run-execution-budget';
import {
  failScheduleRunForQStash,
  settleExpiredScheduleRunCancellation,
} from './schedule-run-recovery';

const LIVE_STATUSES: AssignmentStatus[] = [
  AssignmentStatus.DRAFT,
  AssignmentStatus.PROPOSED,
  AssignmentStatus.PUBLISHED,
  AssignmentStatus.ACKNOWLEDGED,
  AssignmentStatus.IN_PROGRESS,
];

/** Assignments a run is allowed to replace. Published work is never touched. */
const REPLACEABLE_STATUSES: AssignmentStatus[] = [
  AssignmentStatus.DRAFT,
  AssignmentStatus.PROPOSED,
];

const MAX_RANGE_DAYS = 62;

interface ExecutionLease {
  id: string;
  expiresAt: Date;
}

interface ExecutionLeaseHeartbeat {
  stop(): Promise<void>;
  assertActive(): void;
}

type DeliveryOutcome =
  | { kind: 'completed'; scheduled: number; unassigned: number }
  | { kind: 'cancelled' }
  | { kind: 'not_found' }
  | { kind: 'settled' }
  | { kind: 'busy' };

interface DeliveryOptions {
  executionBudgetSeconds: number;
  /** Current durable delivery generation, atomically fenced at lease claim. */
  dispatchId?: string;
  /** Optional shorter durable lease for a long-running self-hosted delivery. */
  executionLeaseSeconds?: number;
  /** A QStash lease ends with its function; BullMQ renews while its worker lives. */
  renewExecutionLease?: boolean;
  retryOnFailure: boolean;
  timeLimitSeconds?: number;
  onProgress?: (percent: number) => Promise<void>;
}

const VISIT_FOR_SOLVE = {
  serviceAgreement: {
    include: {
      requiredSkills: { select: { skillCode: true } },
      // The allowed and preferred weekdays, and the site's opening hours: the
      // two things needed to work out where else a visit could legally go.
      dayRules: { select: { weekday: true, kind: true } },
      serviceSite: {
        select: {
          operatingHours: {
            select: {
              weekday: true,
              opensAtMinute: true,
              closesAtMinute: true,
            },
          },
        },
      },
    },
  },
  assignments: {
    where: { status: { in: LIVE_STATUSES } },
    include: {
      crewMembers: { select: { employeeId: true, role: true, isPmsSupervisor: true } },
      vehicles: { select: { vehicleId: true, driverEmployeeId: true } },
      locks: { where: { releasedAt: null } },
    },
  },
} satisfies Prisma.GeneratedVisitInclude;

type VisitForSolve = Prisma.GeneratedVisitGetPayload<{
  include: typeof VISIT_FOR_SOLVE;
}>;

const EMPLOYEE_FOR_SOLVE = {
  skills: { select: { skillCode: true } },
  vehicleAuthorizations: { select: { vehicleId: true } },
  permanentAssignments: { select: { serviceSiteId: true } },
  availability: { select: { startDate: true, endDate: true } },
} satisfies Prisma.EmployeeInclude;

type EmployeeForSolve = Prisma.EmployeeGetPayload<{
  include: typeof EMPLOYEE_FOR_SOLVE;
}>;

const VEHICLE_FOR_SOLVE = {
  branch: { select: { code: true } },
} satisfies Prisma.VehicleInclude;

type VehicleForSolve = Prisma.VehicleGetPayload<{
  include: typeof VEHICLE_FOR_SOLVE;
}>;

interface SolveSnapshot {
  visitId: string;
  serviceAgreementId: string;
  expectedUpdatedAt: Date;
  replaceAssignmentId?: string;
}

type SlotVisit = {
  visitDate: Date;
  placement: VisitPlacement;
  windowStartMinute: number;
  windowEndMinute: number;
  durationMinutes: number;
  serviceAgreement: {
    startDate: Date;
    endDate: Date | null;
    frequencyUnit: FrequencyUnit;
    frequencyInterval: number;
    serviceWindowStartMinute: number | null;
    serviceWindowEndMinute: number | null;
    dayRules: { weekday: Weekday; kind: DayRuleKind }[];
    serviceSite: {
      operatingHours: {
        weekday: Weekday;
        opensAtMinute: number;
        closesAtMinute: number;
      }[];
    };
  };
};

function candidateSlotsForVisit(visit: SlotVisit, from: Date, to: Date) {
  const { allowedDays, preferredDays } = splitDayRules(
    visit.serviceAgreement.dayRules,
  );
  const booked = visit.placement === VisitPlacement.BOOKED;
  const slots = buildCandidateSlots({
    // The booked date is the customer's source commitment. It may override
    // cadence and weekday selection, but never the site's time window.
    allowedDays: booked ? [weekdayOf(visit.visitDate)] : allowedDays,
    preferredDays,
    siteWindows: visit.serviceAgreement.serviceSite.operatingHours.map((hours) => ({
      weekday: hours.weekday,
      startMinute: hours.opensAtMinute,
      endMinute: hours.closesAtMinute,
    })),
    agreementStartMinute: visit.serviceAgreement.serviceWindowStartMinute,
    agreementEndMinute: visit.serviceAgreement.serviceWindowEndMinute,
    visitDate: visit.visitDate,
    agreementStartDate: booked ? visit.visitDate : visit.serviceAgreement.startDate,
    agreementEndDate: booked ? visit.visitDate : visit.serviceAgreement.endDate,
    frequencyUnit: visit.serviceAgreement.frequencyUnit,
    frequencyInterval: visit.serviceAgreement.frequencyInterval,
    durationMinutes: visit.durationMinutes,
    from: booked ? visit.visitDate : from,
    to: booked ? visit.visitDate : to,
  });
  const currentDate = dateOnly(visit.visitDate);
  return slots
    .map((slot) => ({
      ...slot,
      // A same-date solver result does not rewrite the visit window, so only
      // advertise times the persistence fence can accept. Alternate dates use
      // their full legal service window and carry a proposed visit update.
      earliestStartMinute: slot.date === currentDate
        ? Math.max(slot.earliestStartMinute, visit.windowStartMinute)
        : slot.earliestStartMinute,
      latestStartMinute: slot.date === currentDate
        ? Math.min(
          slot.latestStartMinute,
          visit.windowEndMinute - visit.durationMinutes,
        )
        : slot.latestStartMinute,
    }))
    .filter((slot) => slot.earliestStartMinute <= slot.latestStartMinute);
}

/** A manager-protected date/window is authoritative even outside cadence. */
function protectedDateSlots(visit: SlotVisit) {
  const latestStartMinute = visit.windowEndMinute - visit.durationMinutes;
  if (latestStartMinute < visit.windowStartMinute) return [];
  return [{
    date: dateOnly(visit.visitDate),
    earliestStartMinute: visit.windowStartMinute,
    latestStartMinute,
    isPreferred: false,
  }];
}

/**
 * A source booking or manager date pin fixes its date, not stale working
 * hours. Retain the generated fallback window only when that weekday has no
 * recorded site hours; otherwise current site and agreement windows remain
 * authoritative and may require the manager to resolve an infeasible pin.
 */
function constrainedProtectedDateSlots(
  visit: SlotVisit,
  durationMinutes = visit.durationMinutes,
) {
  if (durationMinutes <= 0) return [];
  const bookedWeekday = weekdayOf(visit.visitDate);
  const hasRecordedHours = visit.serviceAgreement.serviceSite.operatingHours
    .some((hours) => hours.weekday === bookedWeekday);
  const boundedVisit = {
    ...visit,
    // Slot construction may enforce current time windows, but a protected
    // date must not be removed by cadence or allowed-weekday rules.
    placement: VisitPlacement.BOOKED,
    durationMinutes,
    windowStartMinute: Math.max(
      visit.windowStartMinute,
      visit.serviceAgreement.serviceWindowStartMinute ?? visit.windowStartMinute,
    ),
    windowEndMinute: Math.min(
      visit.windowEndMinute,
      visit.serviceAgreement.serviceWindowEndMinute ?? visit.windowEndMinute,
    ),
  };

  return hasRecordedHours
    ? candidateSlotsForVisit(boundedVisit, visit.visitDate, visit.visitDate)
    : protectedDateSlots(boundedVisit);
}

interface ProposedAssignment extends SolveSnapshot {
  dto: {
    plannedStartMinute: number;
    plannedEndMinute: number;
    crew: { employeeId: string; role: CrewRole }[];
    vehicles: { vehicleId: string; driverEmployeeId: string }[];
  };
  proposedVisit?: {
    visitDate: Date;
    windowStartMinute: number;
    windowEndMinute: number;
  };
  /** The branch-day the visit stands on now, which a move would empty. */
  branchCode: BranchCode;
  visitDate: Date;
  /** This visit's own cost against the daily cap: duration times crew size. */
  crewMinutes: number;
}

/**
 * Why one visit could not be staffed, reason by reason.
 *
 * Deliberately not a list of codes beside one shared sentence. It was exactly
 * that, and the queue showed every reason's text under every reason's heading:
 * a visit that clashed on crew, on hours and on vehicle displayed all three
 * sentences three times, so "Service-window conflict" read as though the
 * customer's opening hours were the reason an employee was double-booked. A
 * manager cannot act on that, and worse, cannot trust the rest of the screen
 * either.
 */
interface UnassignedReason {
  code: string;
  message: string;
  /** What to actually do about this one. Shown as "What to do". */
  remediation?: string;
  resources?: unknown;
}

interface UnassignedResult extends SolveSnapshot {
  reasons: UnassignedReason[];
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function parseDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function minuteOfDay(value: Date): number {
  return value.getUTCHours() * 60 + value.getUTCMinutes();
}

function minuteFromDayStart(value: Date, day: Date): number {
  const start = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  return Math.round((value.getTime() - start) / 60_000);
}

function isPrismaUniqueConstraint(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

function supervisorEmployeeIds(
  crewMembers: readonly {
    employeeId: string;
    role: CrewRole;
    isPmsSupervisor: boolean;
  }[],
): string[] {
  const roleMarked = crewMembers
    .filter((member) => member.role === CrewRole.SUPERVISOR)
    .map((member) => member.employeeId)
    .sort();
  if (roleMarked.length > 0) return roleMarked;

  // Older/manual drafts may carry the PMS fact without a role label. The
  // manager read model already treats that person as the supervisor; use the
  // same deterministic fallback so a valid pin cannot invalidate the request.
  return crewMembers
    .filter((member) => member.isPmsSupervisor)
    .map((member) => member.employeeId)
    .sort();
}

/**
 * Turning a date range into a staffed schedule.
 *
 * The solver proposes; this service disposes. Every proposal is re-checked
 * against the ULK-C05 engine before it is written, even though the solver
 * already had the same rules as constraints. That is deliberate belt and
 * braces: the two implementations could drift, the database could have changed
 * under a long solve, and the cost of a crew sent somewhere they are not
 * allowed to be is far higher than the cost of checking twice.
 */
/**
 * Which member of a solved crew is the supervisor.
 *
 * The solver returns employee ids sorted by uuid and has no opinion about
 * rank, so stamping SUPERVISOR on the first of them named whoever happened to
 * sort first. On screen that put the Dispatch Board's Supervisor column — which
 * reads the PMS grade — and the Edit crew drawer's role labels on the same
 * visit in open disagreement: the column named the PMS-grade technician, the
 * drawer called them a Technician and called somebody else Supervisor.
 *
 * The supervisor is the PMS-grade member, which is the grade the rule is
 * actually about, and there is exactly one of them however many hold it. With
 * no grade at all the first member keeps the role, so the output stays defined
 * for a crew the eligibility engine would refuse anyway.
 */
export function solvedCrewRoles(
  employeeIds: readonly string[],
  isPmsGrade: (employeeId: string) => boolean,
  preferredSupervisorIds: readonly string[] = [],
): { employeeId: string; role: CrewRole }[] {
  const pinned = new Set(
    preferredSupervisorIds.filter((id) => employeeIds.includes(id) && isPmsGrade(id)),
  );
  const supervisorId = employeeIds.find(isPmsGrade) ?? employeeIds[0];
  return employeeIds.map((employeeId) => ({
    employeeId,
    role: (pinned.size > 0 ? pinned.has(employeeId) : employeeId === supervisorId)
      ? CrewRole.SUPERVISOR
      : CrewRole.TECHNICIAN,
  }));
}

@Injectable()
export class ScheduleRunService {
  private readonly logger = new Logger(ScheduleRunService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: SchedulerClient,
    private readonly eligibility: EligibilityService,
    private readonly audit: AuditService,
    private readonly branchDayCapacity: BranchDayCapacityService,
  ) {}

  /** Records the run. The work itself happens in the queue worker. */
  async create(
    input: {
      from: string;
      to: string;
      branchCode?: BranchCode;
      timeLimitSeconds?: number;
    },
    actor: AuthenticatedUser,
    dispatcherProvider: ScheduleRunDispatcherProvider = 'bullmq',
  ) {
    const from = parseDate(input.from);
    const to = parseDate(input.to);

    if (to < from) {
      throw new AppException(
        'AGREEMENT_DATES_INVALID',
        `The range ends on ${input.to}, before it starts on ${input.from}.`,
        HttpStatus.BAD_REQUEST,
        { from: input.from, to: input.to },
      );
    }

    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (days > MAX_RANGE_DAYS) {
      throw new AppException(
        'AGREEMENT_DATES_INVALID',
        `A schedule run covers at most ${MAX_RANGE_DAYS} days; this asks for ${days}. Solving a longer range takes minutes and is nearly always a mistyped date.`,
        HttpStatus.BAD_REQUEST,
        { days, maximum: MAX_RANGE_DAYS },
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const run = await tx.scheduleRun.create({
        data: {
          status: ScheduleRunStatus.QUEUED,
          rangeStart: from,
          rangeEnd: to,
          branchCode: input.branchCode ?? null,
          requestedByUserId: actor.id,
          timeLimitSeconds: input.timeLimitSeconds ?? 20,
        } as unknown as Prisma.ScheduleRunCreateInput,
      });
      await this.dispatchOutboxModel(tx).create({
        data: {
          scheduleRunId: run.id,
          provider: dispatcherProvider === 'qstash' ? 'QSTASH' : 'BULLMQ',
        },
      });
      await this.audit.record(
        {
          entityType: 'ScheduleRun',
          entityId: run.id,
          action: 'schedule_run.queued',
          actor,
          before: null,
          after: run,
        },
        tx,
      );
      return run;
    });
  }

  /**
   * Does the work: gather, solve, re-check, write.
   *
   * `onProgress` is how the queue worker keeps the run's percentage moving. A
   * solve can take twenty seconds; a manager watching a bar that never moves
   * assumes it has hung and starts another one.
   */
  async execute(
    runId: string,
    options: {
      timeLimitSeconds?: number;
      executionBudgetSeconds?: number;
      onProgress?: (percent: number) => Promise<void>;
    } = {},
  ): Promise<{ scheduled: number; unassigned: number; cancelled: boolean }> {
    const outcome = await this.deliver(runId, {
      executionBudgetSeconds:
        options.executionBudgetSeconds ?? SELF_HOSTED_EXECUTION_BUDGET_SECONDS,
      executionLeaseSeconds: BULLMQ_EXECUTION_LEASE_SECONDS,
      renewExecutionLease: true,
      retryOnFailure: false,
      timeLimitSeconds: options.timeLimitSeconds,
      onProgress: options.onProgress,
    });
    if (outcome.kind === 'completed') {
      return {
        scheduled: outcome.scheduled,
        unassigned: outcome.unassigned,
        cancelled: false,
      };
    }
    if (outcome.kind === 'cancelled') {
      return { scheduled: 0, unassigned: 0, cancelled: true };
    }
    if (outcome.kind === 'not_found') {
      throw new AppException(
        'RESOURCE_NOT_FOUND',
        `Schedule run "${runId}" was not found.`,
        HttpStatus.NOT_FOUND,
        { runId },
      );
    }
    throw new AppException(
      'RESOURCE_CONFLICT',
      'This schedule run is already being processed or has finished.',
      HttpStatus.CONFLICT,
      { runId, state: outcome.kind },
    );
  }

  /** Handles one queue delivery; callers decide whether a failure is retried. */
  async deliver(
    runId: string,
    options: DeliveryOptions,
  ): Promise<DeliveryOutcome> {
    const executionLeaseSeconds =
      options.executionLeaseSeconds ?? options.executionBudgetSeconds;
    const claim = await this.claimExecutionLease(
      runId,
      executionLeaseSeconds,
      options.dispatchId,
    );
    if (claim.kind !== 'acquired') return claim;

    const heartbeat = options.renewExecutionLease
      ? this.startExecutionLeaseHeartbeat(
          runId,
          claim.lease,
          executionLeaseSeconds,
        )
      : undefined;

    try {
      const result = await this.executeLeased(runId, claim.lease, options);
      await heartbeat?.stop();
      heartbeat?.assertActive();
      return result.cancelled
        ? { kind: 'cancelled' }
        : {
            kind: 'completed',
            scheduled: result.scheduled,
            unassigned: result.unassigned,
          };
    } catch (caught) {
      await heartbeat?.stop();
      let failure = caught;
      try {
        heartbeat?.assertActive();
      } catch (heartbeatFailure) {
        failure = heartbeatFailure;
      }
      const code =
        typeof (failure as { code?: unknown }).code === 'string'
          ? (failure as { code: string }).code
          : 'INTERNAL_ERROR';
      const message =
        failure instanceof Error ? failure.message : String(failure);
      if (options.retryOnFailure) {
        await this.releaseLeaseForRetry(runId, claim.lease);
      } else {
        await this.fail(runId, claim.lease, code, message);
      }
      throw failure;
    }
  }

  private async executeLeased(
    runId: string,
    lease: ExecutionLease,
    options: DeliveryOptions,
  ): Promise<{ scheduled: number; unassigned: number; cancelled: boolean }> {
    const notifyProgress = options.onProgress ?? (async () => undefined);
    const progress = async (percent: number) => {
      await this.setProgress(runId, lease, percent);
      await notifyProgress(percent);
    };

    const run = await this.prisma.scheduleRun.findUnique({
      where: { id: runId },
    });
    if (!run) {
      throw new AppException(
        'RESOURCE_NOT_FOUND',
        `Schedule run "${runId}" was not found.`,
        HttpStatus.NOT_FOUND,
        { runId },
      );
    }

    await progress(5);

    const branchFilter = run.branchCode ? { branchCode: run.branchCode } : {};

    // Visits worth solving: in range, not already published or finished, and
    // not already held by a manager. A locked visit keeps its crew; the solver
    // is told about it so it does not double-book those people elsewhere.
    const visits = await this.prisma.generatedVisit.findMany({
      where: {
        visitDate: { gte: run.rangeStart, lte: run.rangeEnd },
        status: { notIn: [VisitStatus.COMPLETED, VisitStatus.CANCELLED] },
        // Work for a client that is no longer serviced is never scheduled.
        // Visits already generated before the site went inactive would
        // otherwise keep competing for crews and, worse, keep being staffed.
        // The rows stay in the database: this excludes them from the solve,
        // it does not erase the history.
        serviceAgreement: {
          serviceSite: { isActive: true, customer: { isActive: true } },
        },
        ...branchFilter,
      },
      include: VISIT_FOR_SOLVE,
      orderBy: { id: 'asc' },
    });

    await progress(20);
    if (await this.isCancelled(runId)) return this.markCancelled(runId, lease);

    const [employees, vehicles] = await Promise.all([
      this.prisma.employee.findMany({
        where: { isActive: true, ...branchFilter },
        include: EMPLOYEE_FOR_SOLVE,
        orderBy: { id: 'asc' },
      }),
      this.prisma.vehicle.findMany({
        where: { isActive: true },
        include: VEHICLE_FOR_SOLVE,
        orderBy: { id: 'asc' },
      }),
    ]);

    // A sibling can be omitted from this solve because it is published,
    // unassigned, completed, or otherwise outside the solver's remit.  Its
    // generated-visit key nevertheless remains in the database, so include
    // every sibling key that falls in the candidate horizon.
    const siblingKeys = await this.prisma.generatedVisit.findMany({
      where: {
        serviceAgreementId: {
          in: [...new Set(visits.map((visit) => visit.serviceAgreementId))],
        },
        visitDate: { gte: run.rangeStart, lte: run.rangeEnd },
      },
      select: {
        id: true,
        serviceAgreementId: true,
        visitDate: true,
        windowStartMinute: true,
      },
      orderBy: { id: 'asc' },
    });

    const request = this.buildSolveRequest(
      run.id,
      visits,
      employees,
      vehicles,
      {
        timeLimitSeconds:
          options.timeLimitSeconds ??
          (run as typeof run & { timeLimitSeconds?: number })
            .timeLimitSeconds ??
          20,
        from: run.rangeStart,
        to: run.rangeEnd,
      },
      siblingKeys,
    );

    await this.updateLeasedRun(runId, lease, {
      visitsConsidered: request.visits.length,
      progressPercent: 35,
    });
    await notifyProgress(35);

    if (request.visits.length === 0) {
      return this.finish(runId, 0, 0, lease);
    }

    // The solver can spend the time limit on each day. A locked multi-day run
    // also spends it once on joint lock allocation before those daily solves.
    // Reserve for every phase in both admission and the HTTP timeout.
    const solveDays = new Set(
      request.visits.flatMap((visit) =>
        visit.candidate_slots?.length
          ? visit.candidate_slots.map((slot) => slot.date)
          : [visit.visit_date],
      ),
    ).size;
    const solvePhases = solveDays + (solveDays > 1 && request.locks.length > 0 ? 1 : 0);
    const availableSolverSeconds =
      options.executionBudgetSeconds -
      SCHEDULE_EXECUTION_PERSISTENCE_RESERVE_SECONDS -
      SCHEDULE_SOLVER_TRANSPORT_RESERVE_SECONDS -
      SCHEDULE_EXECUTION_PREPARATION_RESERVE_SECONDS -
      SCHEDULE_EXECUTION_LEASE_SAFETY_SECONDS;
    if (availableSolverSeconds < solvePhases) {
      throw new AppException(
        'SCHEDULE_EXECUTION_BUDGET_EXCEEDED',
        'This schedule run exceeds the execution budget available to its delivery provider.',
        HttpStatus.UNPROCESSABLE_ENTITY,
        { runId, solveDays, solvePhases, executionBudgetSeconds: options.executionBudgetSeconds },
      );
    }
    const perPhaseLimitSeconds = Math.min(
      request.time_limit_seconds,
      Math.max(1, Math.floor(availableSolverSeconds / solvePhases)),
    );
    const boundedRequest = {
      ...request,
      time_limit_seconds: perPhaseLimitSeconds,
    };
    const solution = await this.scheduler.solve(
      boundedRequest,
      (perPhaseLimitSeconds * solvePhases +
        SCHEDULE_SOLVER_TRANSPORT_RESERVE_SECONDS) *
        1000,
    );

    await progress(70);
    // Checked after the solve and again before writing: a manager who cancels
    // during a twenty-second solve should not find a schedule appearing anyway.
    if (await this.isCancelled(runId)) return this.markCancelled(runId, lease);

    const byId = new Map(visits.map((visit) => [visit.id, visit]));
    // Who actually holds the grade the supervisor rule is about. The solver
    // answers with employee ids in its own order and says nothing about rank.
    const pmsGradeById = new Map(
      employees.map((employee) => [employee.id, employee.isPmsGrade]),
    );
    const proposals: ProposedAssignment[] = [];

    for (const proposal of solution.assignments) {
      const visit = byId.get(proposal.visit_id);
      if (!visit) continue;

      // Validate the proposed date/window without changing the stored visit.
      // A manager can publish the snapshotted draft while the solver runs;
      // only the guarded persistence transaction may commit a move.
      const moved =
        proposal.scheduled_date !== undefined &&
        proposal.scheduled_date !== dateOnly(visit.visitDate);
      const proposedVisit = moved
        ? {
            visitDate: new Date(`${proposal.scheduled_date}T00:00:00.000Z`),
            windowStartMinute: proposal.start_minute,
            windowEndMinute: Math.max(
              visit.windowEndMinute,
              proposal.start_minute + visit.durationMinutes,
            ),
          }
        : undefined;

      const pinnedAssignment = visit.assignments.find((assignment) =>
        REPLACEABLE_STATUSES.includes(assignment.status) &&
        assignment.locks.some((lock) =>
          lock.scope === LockScope.SUPERVISOR || lock.scope === LockScope.FULL,
        ),
      );
      const timePinnedAssignment = visit.assignments.find((assignment) =>
        REPLACEABLE_STATUSES.includes(assignment.status) &&
        assignment.locks.some((lock) =>
          lock.scope === LockScope.TIME || lock.scope === LockScope.FULL,
        ),
      );

      const dto = {
        plannedStartMinute: proposal.start_minute,
        plannedEndMinute: timePinnedAssignment
          ? minuteFromDayStart(timePinnedAssignment.plannedEnd, visit.visitDate)
          : proposal.start_minute + visit.durationMinutes,
        crew: solvedCrewRoles(
          proposal.employee_ids,
          (employeeId) => pmsGradeById.get(employeeId) === true,
          pinnedAssignment
            ? supervisorEmployeeIds(pinnedAssignment.crewMembers)
            : undefined,
        ),
        vehicles: proposal.vehicles.map((entry) => ({
          vehicleId: entry.vehicle_id,
          driverEmployeeId: entry.driver_employee_id,
        })),
      };

      const existing = visit.assignments.find((a) =>
        REPLACEABLE_STATUSES.includes(a.status),
      );
      proposals.push({
        visitId: visit.id,
        serviceAgreementId: visit.serviceAgreementId,
        expectedUpdatedAt: visit.updatedAt,
        dto,
        replaceAssignmentId: existing?.id,
        proposedVisit,
        branchCode: visit.branchCode,
        visitDate: visit.visitDate,
        crewMinutes: crewMinutesOf(visit),
      });
    }

    await progress(90);

    const unassigned = solution.unassigned.map((entry) => ({
      visitId: entry.visit_id,
      reasons: entry.reason_codes.map((code) => ({
        code,
        // The solver sends one sentence per code in `reason_messages`. The
        // joined `message` is kept only as a fallback for a solver that
        // predates the split.
        message: entry.reason_messages?.[code] ?? entry.message,
      })),
    }));

    return this.persistResult(
      runId,
      proposals,
      unassigned.map((entry) => {
        const visit = byId.get(entry.visitId);
        if (!visit) {
          throw new AppException(
            'RESOURCE_CONFLICT',
            'The solver returned a visit outside its snapshot.',
            HttpStatus.CONFLICT,
            { visitId: entry.visitId },
          );
        }
        return {
          ...entry,
          serviceAgreementId: visit.serviceAgreementId,
          expectedUpdatedAt: visit.updatedAt,
          replaceAssignmentId: visit.assignments.find((assignment) =>
            REPLACEABLE_STATUSES.includes(assignment.status),
          )?.id,
        };
      }),
      lease,
    );
  }

  private buildSolveRequest(
    runId: string,
    visits: VisitForSolve[],
    employees: EmployeeForSolve[],
    vehicles: VehicleForSolve[],
    options: {
      timeLimitSeconds: number;
      from: Date;
      to: Date;
      /** Repair callers may omit their exact superseded predecessor only. */
      excludeReservationAssignmentIds?: string[];
    },
    siblingKeys: {
      id: string;
      serviceAgreementId: string;
      visitDate: Date;
      windowStartMinute: number;
    }[] = [],
  ): SolveRequest {
    const locks: SolveRequest['locks'] = [];
    const existing: SolveRequest['existing'] = [];
    /** Visit-level protection fixes only the date; TIME/FULL fixes date and time. */
    const datePinned = new Set<string>();
    const timePinned = new Set<string>();
    const excludedReservations = new Set(
      options.excludeReservationAssignmentIds ?? [],
    );
    const reservations: NonNullable<SolveRequest['reservations']> = [];

    const solvable = visits.filter((visit) => {
      // A manager's visit-level decision fixes the date even when no draft
      // assignment exists. Assignment locks below retain their own time/crew
      // semantics; a visit-level pin does not invent a TIME or FULL lock.
      if (visit.isManuallyAdjusted || visit.lockedAt !== null) {
        datePinned.add(visit.id);
      }
      const live = visit.assignments.find((a) =>
        LIVE_STATUSES.includes(a.status),
      );
      if (!live) return true;

      // Published work is settled — the solver is not offered it at all.
      if (!REPLACEABLE_STATUSES.includes(live.status)) return false;

      const supervisorIds = supervisorEmployeeIds(live.crewMembers);

      for (const lock of [...live.locks].sort((left, right) => left.scope.localeCompare(right.scope))) {
        // Every active manager pin must reach the solver. An assignment may
        // carry separate TIME, CREW and VEHICLE decisions at once.
        if (lock.scope === LockScope.FULL || lock.scope === LockScope.TIME) {
          datePinned.add(visit.id);
          timePinned.add(visit.id);
        }
        locks.push({
          visit_id: visit.id,
          scope: lock.scope,
          employee_ids:
            lock.scope === LockScope.SUPERVISOR
              ? supervisorIds
              : live.crewMembers.map((member) => member.employeeId).sort(),
          vehicle_ids: live.vehicles.map((vehicle) => vehicle.vehicleId).sort(),
          vehicle_drivers: live.vehicles
            .map((vehicle) => ({
              vehicle_id: vehicle.vehicleId,
              driver_employee_id: vehicle.driverEmployeeId,
            }))
            .sort((left, right) => left.vehicle_id.localeCompare(right.vehicle_id)),
          start_minute:
            lock.scope === LockScope.FULL || lock.scope === LockScope.TIME
              ? minuteOfDay(live.plannedStart)
              : null,
          end_minute:
            lock.scope === LockScope.FULL || lock.scope === LockScope.TIME
              ? minuteFromDayStart(live.plannedEnd, visit.visitDate)
              : null,
        });
      }

      existing.push({
        visit_id: visit.id,
        employee_ids: live.crewMembers.map((m) => m.employeeId),
        vehicle_ids: live.vehicles.map((v) => v.vehicleId),
        start_minute: minuteOfDay(live.plannedStart),
      });
      return true;
    });

    for (const visit of visits) {
      for (const assignment of visit.assignments) {
        if (REPLACEABLE_STATUSES.includes(assignment.status)) continue;
        if (excludedReservations.has(assignment.id)) continue;
        reservations.push({
          assignment_id: assignment.id,
          scheduled_date: dateOnly(assignment.plannedStart),
          start_minute: minuteOfDay(assignment.plannedStart),
          end_minute: minuteFromDayStart(assignment.plannedEnd, assignment.plannedStart),
          employee_ids: assignment.crewMembers
            .map((member) => member.employeeId)
            .sort(),
          vehicle_ids: assignment.vehicles
            .map((vehicle) => vehicle.vehicleId)
            .sort(),
        });
      }
    }

    return {
      run_id: runId,
      visits: solvable.map((visit) => {
        // The day a visit was generated on is one legal option among several,
        // not a decision. Handing the solver all of them is what lets it settle
        // date, time, crew and vehicle in one pass instead of taking the date
        // as given and hunting for people who happen to be free.
        //
        // A manual/visit-level or workbook BOOKED decision fixes only the
        // calendar date. Keep every legal start on that date so a date pin
        // never silently becomes a TIME lock. Assignment TIME/FULL locks carry
        // their exact interval separately and use the legacy fixed-window
        // fallback (`null`). An explicit empty list remains "no legal slot".
        const protectedDate = datePinned.has(visit.id) ||
          visit.placement === VisitPlacement.BOOKED;
        const allCandidates = protectedDate
          ? constrainedProtectedDateSlots(visit)
          : candidateSlotsForVisit(visit, options.from, options.to);
        const candidates = timePinned.has(visit.id)
          ? null
          : protectedDate
            ? allCandidates.filter((slot) => slot.date === dateOnly(visit.visitDate))
            : allCandidates;

        return {
          id: visit.id,
          branch_code: visit.branchCode,
          visit_date: dateOnly(visit.visitDate),
          window_start_minute: visit.windowStartMinute,
          window_end_minute: visit.windowEndMinute,
          duration_minutes: visit.durationMinutes,
          required_crew_size: visit.requiredCrewSize,
          required_skill_codes: visit.serviceAgreement.requiredSkills
            .map((skill) => skill.skillCode)
            .sort(),
          service_site_id: visit.serviceAgreement.serviceSiteId,
          service_agreement_id: visit.serviceAgreementId,
          is_preferred_day: false,
          occupied_start_keys: siblingKeys
            .filter(
              (sibling) =>
                sibling.serviceAgreementId === visit.serviceAgreementId &&
                sibling.id !== visit.id,
            )
            .map((sibling) => ({
              date: dateOnly(sibling.visitDate),
              start_minute: sibling.windowStartMinute,
            })),
          candidate_slots: candidates?.map((slot) => ({
            date: slot.date,
            earliest_start_minute: slot.earliestStartMinute,
            latest_start_minute: slot.latestStartMinute,
            is_preferred: slot.isPreferred,
          })) ?? null,
        };
      }),
      employees: employees.map((employee) => ({
        id: employee.id,
        branch_code: employee.branchCode,
        is_pms_grade: employee.isPmsGrade,
        is_permanently_stationed:
          employee.deploymentType === 'PERMANENTLY_STATIONED',
        permanent_site_ids: employee.permanentAssignments
          .map((a) => a.serviceSiteId)
          .sort(),
        skill_codes: employee.skills.map((s) => s.skillCode).sort(),
        authorized_vehicle_ids: employee.vehicleAuthorizations
          .map((a) => a.vehicleId)
          .sort(),
        can_use_public_transport: employee.canUsePublicTransport,
        unavailable_dates: expandDates(employee.availability),
      })),
      vehicles: vehicles.map((vehicle) => ({
        id: vehicle.id,
        branch_code: vehicle.branch?.code ?? null,
        seat_capacity: vehicle.seatCapacity,
      })),
      locks,
      existing,
      reservations,
      excluded_reservation_assignment_ids: [...excludedReservations].sort(),
      time_limit_seconds: options.timeLimitSeconds,
    };
  }

  private async persistResult(
    runId: string,
    proposals: ProposedAssignment[],
    unassigned: UnassignedResult[],
    lease: ExecutionLease,
  ) {
    const entries = [...proposals, ...unassigned];
    if (
      new Set(entries.map((entry) => entry.visitId)).size !== entries.length
    ) {
      throw new AppException(
        'RESOURCE_CONFLICT',
        'The solver returned multiple outcomes for one visit. Run the scheduler again.',
        HttpStatus.CONFLICT,
        { runId },
      );
    }
    const movedVisitIds = new Set(
      proposals
        .filter((proposal) => proposal.proposedVisit !== undefined)
        .map((proposal) => proposal.visitId),
    );
    return this.prisma.$transaction(
      async (tx) => {
        // One solver response is one atomic change. Lock the entire affected set
        // in the shared deterministic order, then validate every revision before
        // creating drafts, transferring locks, moving dates or changing reasons.
        await lockAgreementRows(
          tx,
          entries.map((entry) => entry.serviceAgreementId),
        );
        const agreementSites = await tx.serviceAgreement.findMany({
          where: { id: { in: entries.map((entry) => entry.serviceAgreementId) } },
          select: { serviceSiteId: true },
        });
        // Site parents guard every opening-hours child row, including an
        // empty week where an editor may insert the first opening window.
        // They follow agreements and precede visits/resources in every writer.
        await lockSiteRows(tx, agreementSites.map((row) => row.serviceSiteId));
        await lockScheduleVisits(
          tx,
          entries.map((entry) => entry.visitId),
        );
        await lockScheduleResources(
          tx,
          proposals.flatMap((entry) =>
            entry.dto.crew.map((member) => member.employeeId),
          ),
          proposals.flatMap((entry) =>
            entry.dto.vehicles.map((vehicle) => vehicle.vehicleId),
          ),
        );
        // Read denormalised history facts only after the resource lock. A
        // concurrent grade change must not leave an assignment recording a
        // supervisor qualification that was already stale when it committed.
        const employeeIds = [
          ...new Set(
            proposals.flatMap((entry) =>
              entry.dto.crew.map((member) => member.employeeId),
            ),
          ),
        ];
        const pms = await tx.employee.findMany({
          where: { id: { in: employeeIds } },
          select: { id: true, isPmsGrade: true },
        });
        const pmsById = new Map(
          pms.map((row) => [row.id, row.isPmsGrade]),
        );
        const currentRun = await tx.scheduleRun.findUnique({
          where: { id: runId },
          select: { rangeStart: true, rangeEnd: true },
        });
        if (!currentRun) {
          throw new AppException('RESOURCE_CONFLICT', 'The schedule run disappeared while it was being saved.', HttpStatus.CONFLICT, { runId });
        }
        // One post-lock read captures current cadence, opening hours, draft
        // identity, published lineage, and active pins for the entire result.
        // The same rows are used for every validation before any write begins.
        const currentVisits = await tx.generatedVisit.findMany({
          where: { id: { in: entries.map((entry) => entry.visitId) } },
          select: {
            id: true,
            updatedAt: true,
            isManuallyAdjusted: true,
            lockedAt: true,
            visitDate: true,
            windowStartMinute: true,
            windowEndMinute: true,
            durationMinutes: true,
            placement: true,
            assignments: {
              select: {
                id: true,
                status: true,
                publishedAt: true,
                _count: { select: { notificationOutboxEntries: true } },
                plannedStart: true,
                plannedEnd: true,
                crewMembers: { select: { employeeId: true, role: true, isPmsSupervisor: true } },
                vehicles: { select: { vehicleId: true, driverEmployeeId: true } },
                locks: {
                  where: { releasedAt: null },
                  select: { scope: true },
                },
              },
            },
            serviceAgreement: {
              select: {
                startDate: true,
                endDate: true,
                frequencyUnit: true,
                frequencyInterval: true,
                serviceWindowStartMinute: true,
                serviceWindowEndMinute: true,
                dayRules: { select: { weekday: true, kind: true } },
                serviceSite: {
                  select: {
                    operatingHours: {
                      select: { weekday: true, opensAtMinute: true, closesAtMinute: true },
                    },
                  },
                },
              },
            },
          },
        });
        const currentById = new Map(currentVisits.map((visit) => [visit.id, visit]));
        const lockedAssignmentIds = new Set(
          currentVisits.flatMap((visit) =>
            visit.assignments.filter((assignment) => assignment.locks.length > 0)
              .map((assignment) => assignment.id),
          ),
        );
        for (const entry of entries) {
          const visit = currentById.get(entry.visitId);
          if (!visit) {
            throw new AppException(
              'RESOURCE_CONFLICT',
              'A visit disappeared while this schedule was being saved. Refresh and run again.',
              HttpStatus.CONFLICT,
              { runId, visitId: entry.visitId },
            );
          }
          assertScheduleSnapshotRows(entry.visitId, entry.replaceAssignmentId, visit.assignments);
          // Lock/unlock decisions also advance this revision under the same
          // visit lock, so a stale lock snapshot rejects the complete response.
          assertVisitRevision(
            entry.visitId,
            entry.expectedUpdatedAt,
            visit.updatedAt,
          );
          if (
            movedVisitIds.has(entry.visitId) &&
            (visit.isManuallyAdjusted || visit.lockedAt !== null)
          ) {
            throw new AppException(
              'RESOURCE_CONFLICT',
              'A manager protected this visit date. Refresh and run the scheduler again.',
              HttpStatus.CONFLICT,
              { runId, visitId: entry.visitId },
            );
          }
          const replaced = visit.assignments.find(
            (assignment) => assignment.id === entry.replaceAssignmentId,
          );
          if (!('dto' in entry)) this.assertMayUnassign(runId, entry, lockedAssignmentIds);
          if ('dto' in entry) {
            if (replaced) {
              const active = new Set(replaced.locks.map((lock) => lock.scope));
              const timePinned = active.has(LockScope.FULL) || active.has(LockScope.TIME);
              const crewPinned = active.has(LockScope.FULL) || active.has(LockScope.CREW);
              const supervisorPinned = active.has(LockScope.FULL) || active.has(LockScope.SUPERVISOR);
              const vehiclePinned = active.has(LockScope.FULL) || active.has(LockScope.VEHICLE);
              const sorted = (values: string[]) => [...values].sort();
              const currentVehicles = replaced.vehicles
                .map(({ vehicleId, driverEmployeeId }) => [vehicleId, driverEmployeeId])
                .sort(([left], [right]) => left!.localeCompare(right!));
              const proposedVehicles = entry.dto.vehicles
                .map(({ vehicleId, driverEmployeeId }) => [vehicleId, driverEmployeeId])
                .sort(([left], [right]) => left!.localeCompare(right!));
              const currentSupervisors = supervisorEmployeeIds(replaced.crewMembers);
              const proposedSupervisors = entry.dto.crew
                .filter((member) => member.role === CrewRole.SUPERVISOR)
                .map((member) => member.employeeId);
              const violatesLock =
                (timePinned && (
                  entry.proposedVisit !== undefined ||
                  entry.dto.plannedStartMinute !== minuteOfDay(replaced.plannedStart) ||
                  entry.dto.plannedEndMinute !== minuteFromDayStart(replaced.plannedEnd, visit.visitDate)
                )) ||
                (crewPinned && JSON.stringify(sorted(replaced.crewMembers.map((member) => member.employeeId))) !==
                  JSON.stringify(sorted(entry.dto.crew.map((member) => member.employeeId)))) ||
                (supervisorPinned && JSON.stringify(sorted(currentSupervisors)) !==
                  JSON.stringify(sorted(proposedSupervisors))) ||
                (vehiclePinned && JSON.stringify(currentVehicles) !== JSON.stringify(proposedVehicles));
              if (violatesLock) {
                throw new AppException(
                  'RESOURCE_CONFLICT',
                  'The solver changed a manager-locked time, crew, vehicle, or driver. Refresh and run the scheduler again.',
                  HttpStatus.CONFLICT,
                  { runId, visitId: entry.visitId },
                );
              }
            }
          }
          if ('dto' in entry) {
            const target = entry.proposedVisit?.visitDate ?? visit.visitDate;
            const validTarget = !Number.isNaN(target.getTime());
            const sameDate = validTarget && dateOnly(target) === dateOnly(visit.visitDate);
            const assignmentDatePinned = replaced?.locks.some(
              (lock) => lock.scope === LockScope.FULL || lock.scope === LockScope.TIME,
            ) ?? false;
            const proposedDuration = entry.dto.plannedEndMinute - entry.dto.plannedStartMinute;
            let legalSlots: ReturnType<typeof candidateSlotsForVisit>;
            if (sameDate && (
              visit.placement === VisitPlacement.BOOKED ||
              visit.isManuallyAdjusted ||
              visit.lockedAt !== null
            )) {
              legalSlots = constrainedProtectedDateSlots(visit, proposedDuration);
            } else if (sameDate && assignmentDatePinned) {
              legalSlots = constrainedProtectedDateSlots(visit, proposedDuration);
            } else {
              legalSlots = candidateSlotsForVisit(
                visit,
                currentRun.rangeStart,
                currentRun.rangeEnd,
              );
            }
            const legal = validTarget &&
              (sameDate || visit.placement !== VisitPlacement.BOOKED) &&
              (!sameDate || (
                entry.dto.plannedStartMinute >= visit.windowStartMinute &&
                entry.dto.plannedEndMinute <= visit.windowEndMinute
              )) &&
              legalSlots.some(
                (slot) => slot.date === dateOnly(target) &&
                  entry.dto.plannedStartMinute >= slot.earliestStartMinute &&
                  entry.dto.plannedStartMinute <= slot.latestStartMinute,
              );
            if (!legal) {
              throw new AppException(
                'RESOURCE_CONFLICT',
                'The solver proposed a date outside this visit’s booked date, cadence period, agreement dates, or service window. Refresh and run the scheduler again.',
                HttpStatus.CONFLICT,
                { runId, visitId: entry.visitId },
              );
            }
          }
        }
        // What every branch-day this run would move work between carries
        // right now, read inside the transaction that commits the moves, and
        // under a lock on every day a move could land on.
        const ledger = await this.lockAndReadDailyLoad(tx, proposals);
        let scheduled = 0;
        let rejected = 0;
        for (const entry of proposals) {
          // A move on to a day already at the cap is refused before it is
          // judged, and the visit keeps its generated date. This is the one
          // place a solver's move is committed, so it is the one place the
          // cap can be made to hold whatever the solver decided.
          //
          // Refusing a move is not refusing an assignment: `refused` only
          // clears `proposedVisit`, and the engine is then asked the same
          // question about the day the visit is already standing on. A day
          // that was over the cap before this run still gets its crews.
          const refused = this.refuseOvercapMove(ledger, entry);
          let move = refused ? undefined : entry.proposedVisit;

          // Evaluate and apply in order inside this transaction. Later checks
          // must see the slots freed or occupied by earlier accepted results.
          // The engine still wins whenever it disagrees with the solver.
          let verdict = await this.eligibility.evaluate(
            entry.visitId,
            entry.dto,
            {
              excludeAssignmentId: entry.replaceAssignmentId,
              proposedVisit: move,
            },
            tx,
          );
          if (!verdict.isEligible && move) {
            // The engine has refused the move, so the move is not happening —
            // and everything it just said is about a day this visit will not
            // be on. Recorded as-is, those reasons name other people's clashes
            // on another date beside a visit dated where it was generated:
            // "on 2026-09-18" against a visit on Monday the 21st, with nothing
            // on the screen to say the date is not the visit's own. A manager
            // reading that checks the wrong day's crews.
            //
            // So the question is asked again about the day the visit keeps,
            // exactly as a cap refusal does above. Refusing a move is not
            // refusing an assignment: a crew that cannot serve the day the
            // solver wanted is often free on the day the visit was generated
            // for, and either way what gets recorded describes that day.
            move = undefined;
            verdict = await this.eligibility.evaluate(
              entry.visitId,
              entry.dto,
              {
                excludeAssignmentId: entry.replaceAssignmentId,
                proposedVisit: undefined,
              },
              tx,
            );
          }
          if (!verdict.isEligible) {
            this.logger.warn(
              `Solver proposed an assignment the engine refused for visit ${entry.visitId}: ${verdict.conflicts
                .map((conflict) => conflict.code)
                .join(', ')}`,
            );
            await this.recordUnassigned(tx, runId, [
              {
                ...entry,
                // Keep one explanation/remedy per conflict. The queue and visit
                // detail read the same structured reasons as manual checks.
                // A refused move is listed among them: without it the queue
                // says the crew clashes and never says the visit is only on
                // this day because the day the scheduler wanted was full.
                reasons: [...(refused ? [refused] : []), ...verdict.conflicts].map(
                  (conflict) => ({
                    code: conflict.code,
                    message: conflict.message,
                    remediation: conflict.remediation,
                    resources: conflict.resources,
                  }),
                ),
              },
            ], lockedAssignmentIds);
            rejected += 1;
            continue;
          }
          await this.persist(tx, runId, { ...entry, proposedVisit: move }, pmsById);
          if (move) {
            ledger.recordMove(
              entry.branchCode,
              dateOnly(entry.visitDate),
              dateOnly(move.visitDate),
              entry.crewMinutes,
            );
          }
          scheduled += 1;
        }
        await this.recordUnassigned(tx, runId, unassigned, lockedAssignmentIds);
        return this.finish(
          runId,
          scheduled,
          unassigned.length + rejected,
          lease,
          tx,
        );
      },
      { timeout: 30_000 },
    ).catch((error: unknown) => {
      if (isPrismaUniqueConstraint(error)) {
        throw new AppException(
          'RESOURCE_CONFLICT',
          'This schedule changed while it was being saved. Refresh and run the scheduler again.',
          HttpStatus.CONFLICT,
          { runId },
        );
      }
      throw error;
    });
  }

  /**
   * How full every branch-day this run might move work between already is.
   *
   * The basis is generation's own: every visit standing on the branch-day that
   * is not cancelled, whatever agreement it belongs to and whoever planned it.
   * `docs/ARCHITECTURE.md` states that basis for the generation guard, and the
   * two have to agree — a backstop that counted only this run's visits would
   * read a day holding twelve as empty and wave the thirteenth straight on to
   * it, which is exactly the hole this closes.
   *
   * Only the days a move could touch are read: its origin, which a committed
   * move empties by one, and its destination. A run that proposes no move
   * reads nothing at all — and takes no lock, because a run that moves nothing
   * changes no day's load and has no business queueing behind one that does.
   *
   * ## Why the count is locked before it is read
   *
   * The count is an aggregate, and an aggregate locks nothing. At READ
   * COMMITTED two runs over disjoint visits, agreements and crews could both
   * read a day as carrying eleven and both commit their twelfth, leaving
   * thirteen on a day whose cap is twelve; none of the row locks above
   * serialise that, because neither run touches anything the other holds.
   * {@link lockBranchDays} gives the day itself a name to contend for, and it
   * is held until this transaction commits, so a count read after it is a
   * count that cannot change underneath the moves it authorises.
   *
   * Only the *destinations* are locked, not the origins. A day's count is
   * consulted for one purpose — deciding whether a move may land on it — and
   * every day a move can land on is a destination. An origin that is not also
   * a destination is never asked how full it is; an origin that is also a
   * destination is locked on that account. Reading an unlocked origin can
   * therefore only ever leave the ledger with a stale idea of a day nobody
   * asks about.
   *
   * The lock binds the two writers that plan days — this one and generation's
   * `apply`. It cannot bind a manager moving one visit by hand, and is not
   * meant to: `docs/ARCHITECTURE.md` has always said the cap constrains what
   * the system does on its own.
   */
  private async lockAndReadDailyLoad(
    tx: Prisma.TransactionClient,
    proposals: ProposedAssignment[],
  ): Promise<DailyLoadLedger> {
    const moves = proposals.filter((entry) => entry.proposedVisit !== undefined);
    if (moves.length === 0) return new DailyLoadLedger(new Map(), new Map());

    // Taken after the visit, agreement and resource locks, and in the sorted
    // order `lockBranchDays` imposes: every schedule writer takes these locks
    // in the same sequence, which is what keeps two runs over the same days
    // queueing rather than deadlocking.
    await lockBranchDays(
      tx,
      moves.map((entry) => ({
        branchCode: entry.branchCode,
        date: dateOnly(entry.proposedVisit!.visitDate),
      })),
    );

    const branchCodes = [...new Set(moves.map((entry) => entry.branchCode))];
    const dates = [
      ...new Map(
        moves
          .flatMap((entry) => [entry.visitDate, entry.proposedVisit!.visitDate])
          .map((date) => [date.getTime(), date]),
      ).values(),
    ];

    // `groupBy` cannot sum a product of two columns, so the rows themselves
    // are read and reduced here — the same approach generation's own
    // commit-time recheck uses, and for the same reason: crew-minutes is
    // duration times crew size, not a column either side can aggregate alone.
    const rows = await tx.generatedVisit.findMany({
      where: {
        branchCode: { in: branchCodes },
        visitDate: { in: dates },
        // Cancelled work occupies no part of the day. Everything else does —
        // pending, scheduled, unassigned, published, a manager's own visit.
        status: { not: VisitStatus.CANCELLED },
      },
      select: {
        branchCode: true,
        visitDate: true,
        durationMinutes: true,
        requiredCrewSize: true,
      },
    });

    const minutes = new Map<string, number>();
    for (const row of rows) {
      const key = branchDayKey(row.branchCode, dateOnly(row.visitDate));
      minutes.set(key, (minutes.get(key) ?? 0) + crewMinutesOf(row));
    }

    // Real, resource-derived capacity for every branch-day a move could
    // land on or leave — origin and destination alike, paired with the
    // move's own branch rather than the naive branch×date cross-product
    // `rows` above reads load over.
    const touchedBranchDays = new Map<string, { branchCode: BranchCode; date: string }>();
    for (const entry of moves) {
      const add = (date: Date) => {
        const key = branchDayKey(entry.branchCode, dateOnly(date));
        touchedBranchDays.set(key, { branchCode: entry.branchCode, date: dateOnly(date) });
      };
      add(entry.visitDate);
      add(entry.proposedVisit!.visitDate);
    }
    const capacities = await this.branchDayCapacity.capacitiesFor(
      [...touchedBranchDays.values()],
      tx,
    );
    const capMinutesByDay = new Map(
      [...capacities].map(([key, capacity]) => [key, capacity.capacityMinutes]),
    );

    return new DailyLoadLedger(minutes, capMinutesByDay);
  }

  /**
   * The refusal, or nothing when the move may stand.
   *
   * Returns the conflict rather than a boolean so the caller can put it in
   * front of a manager unchanged if the visit ends up unassigned. A proposal
   * that moves nowhere is never refused: that is an assignment for the day the
   * visit already sits on, and a full day still needs its crews.
   *
   * One limitation, stated rather than hidden: the ledger refuses **in
   * proposal order**, which is the order the solver returned — by visit id —
   * and each proposal is answered against the day as it stands at that
   * moment. A mutual swap between two days that are both exactly at the cap is
   * therefore refused rather than resolved: moving visit V from day A to day B
   * and visit W from B to A would be legal applied in either order, but
   * whichever is judged first sees a full destination and is refused, and
   * nothing has moved by the time the other is judged. Nothing here reorders
   * or retries. The outcome is deterministic and errs on the safe side — no
   * day ever ends over the cap — and both visits keep their generated dates.
   */
  private refuseOvercapMove(
    ledger: DailyLoadLedger,
    entry: ProposedAssignment,
  ): Conflict | undefined {
    if (!entry.proposedVisit) return undefined;

    const target = dateOnly(entry.proposedVisit.visitDate);
    if (ledger.admitsMoveOnto(entry.branchCode, target, entry.crewMinutes)) return undefined;

    const kept = dateOnly(entry.visitDate);
    this.logger.warn(
      `Solver proposed moving visit ${entry.visitId} to ${target}, which already carries ${ledger.minutesOn(
        entry.branchCode,
        target,
      )} crew-minutes in ${entry.branchCode}; the visit stays on ${kept}.`,
    );
    return dailyCapRefusal({
      visitId: entry.visitId,
      branchCode: entry.branchCode,
      proposedDate: target,
      keptDate: kept,
      carryingMinutes: ledger.minutesOn(entry.branchCode, target),
      visitMinutes: entry.crewMinutes,
      capMinutes: ledger.capOn(entry.branchCode, target),
    });
  }

  private async persist(
    tx: Prisma.TransactionClient,
    runId: string,
    { visitId, dto, replaceAssignmentId, proposedVisit }: ProposedAssignment,
    pmsById: Map<string, boolean>,
  ) {
    const visit = await tx.generatedVisit.findUniqueOrThrow({
      where: { id: visitId },
      select: { visitDate: true, branchId: true, branchCode: true },
    });
    const at = (minute: number) =>
      new Date(
        (proposedVisit?.visitDate ?? visit.visitDate).getTime() +
          minute * 60_000,
      );

    const replacement = await tx.assignment.create({
      data: {
        generatedVisitId: visitId,
        branchId: visit.branchId,
        branchCode: visit.branchCode,
        status: AssignmentStatus.DRAFT,
        scheduleRunId: runId,
        plannedStart: at(dto.plannedStartMinute),
        plannedEnd: at(dto.plannedEndMinute),
        crewMembers: {
          create: dto.crew.map((member) => ({
            employeeId: member.employeeId,
            role: member.role,
            isPmsSupervisor: pmsById.get(member.employeeId) ?? false,
          })),
        },
        vehicles: {
          create: dto.vehicles.map((entry) => ({
            vehicleId: entry.vehicleId,
            driverEmployeeId: entry.driverEmployeeId,
          })),
        },
      },
    });
    if (replaceAssignmentId) {
      // Move every pin (including released history) before the FK cascade
      // can remove it. Keep a new assignment identity so concurrent manual
      // and publication writers still reject their stale snapshot.
      await tx.assignmentLock.updateMany({
        where: { assignmentId: replaceAssignmentId },
        data: { assignmentId: replacement.id },
      });
      const replaced = await tx.assignment.deleteMany({
        where: {
          id: replaceAssignmentId,
          status: { in: REPLACEABLE_STATUSES },
        },
      });
      if (replaced.count !== 1) {
        throw new AppException(
          'RESOURCE_CONFLICT',
          'An assignment changed while the scheduler was solving. Refresh and run the scheduler again.',
          HttpStatus.CONFLICT,
          { runId, visitId, assignmentId: replaceAssignmentId },
        );
      }
    }
    await tx.visitUnassignedReason.deleteMany({
      where: { generatedVisitId: visitId },
    });
    await tx.generatedVisit.update({
      where: { id: visitId },
      data: { status: VisitStatus.SCHEDULED, ...proposedVisit },
    });
  }

  private assertMayUnassign(
    runId: string,
    entry: UnassignedResult,
    lockedAssignmentIds: Set<string>,
  ) {
    if (entry.replaceAssignmentId && lockedAssignmentIds.has(entry.replaceAssignmentId)) {
      throw new AppException(
        'RESOURCE_CONFLICT',
        'A manager-locked assignment became infeasible. Keep it unchanged; a manager must unlock or repair it before rerunning the scheduler.',
        HttpStatus.CONFLICT,
        { runId, visitId: entry.visitId, assignmentId: entry.replaceAssignmentId },
      );
    }
  }

  private async recordUnassigned(
    tx: Prisma.TransactionClient,
    runId: string,
    entries: UnassignedResult[],
    lockedAssignmentIds: Set<string>,
  ) {
    for (const entry of entries) {
      this.assertMayUnassign(runId, entry, lockedAssignmentIds);
      if (entry.replaceAssignmentId) {
        // Keep the rejected draft as history, but make it unpublishable in
        // the same transaction that puts its visit in the unassigned queue.
        const invalidated = await tx.assignment.updateMany({
          where: {
            id: entry.replaceAssignmentId,
            status: { in: REPLACEABLE_STATUSES },
          },
          data: { status: AssignmentStatus.CANCELLED },
        });
        if (invalidated.count !== 1) {
          throw new AppException(
            'RESOURCE_CONFLICT',
            'An assignment changed while the scheduler was solving. Refresh and run the scheduler again.',
            HttpStatus.CONFLICT,
            {
              runId,
              visitId: entry.visitId,
              assignmentId: entry.replaceAssignmentId,
            },
          );
        }
      }
      await tx.visitUnassignedReason.deleteMany({
        where: { generatedVisitId: entry.visitId },
      });
      await tx.visitUnassignedReason.createMany({
        data: entry.reasons.map((reason) => ({
          generatedVisitId: entry.visitId,
          scheduleRunId: runId,
          code: reason.code,
          message: reason.message,
          // Matches what the manual path records, so the queue reads the same
          // whether a person or the solver failed to staff the work.
          details: {
            remediation: reason.remediation ?? null,
            resources: reason.resources ?? null,
          } as unknown as Prisma.InputJsonValue,
        })),
      });
      await tx.generatedVisit.update({
        where: { id: entry.visitId },
        data: { status: VisitStatus.UNASSIGNED },
      });
    }
  }

  private async claimExecutionLease(
    runId: string,
    executionBudgetSeconds: number,
    dispatchId?: string,
  ): Promise<DeliveryOutcome | { kind: 'acquired'; lease: ExecutionLease }> {
    const before = await this.prisma.scheduleRun.findUnique({
      where: { id: runId },
    });
    if (!before) return { kind: 'not_found' };
    if (before.status === ScheduleRunStatus.CANCELLED) {
      return { kind: 'cancelled' };
    }
    if (this.isSettled(before.status)) return { kind: 'settled' };
    if (before.cancelRequestedAt) {
      if (before.status === ScheduleRunStatus.QUEUED) {
        return { kind: 'cancelled' };
      }
      if (before.status === ScheduleRunStatus.RUNNING) {
        if (await this.settleExpiredCancellation(runId)) {
          return { kind: 'cancelled' };
        }
        const afterCancellation = await this.prisma.scheduleRun.findUnique({
          where: { id: runId },
        });
        if (!afterCancellation) return { kind: 'not_found' };
        if (afterCancellation.status === ScheduleRunStatus.CANCELLED) {
          return { kind: 'cancelled' };
        }
        if (this.isSettled(afterCancellation.status)) return { kind: 'settled' };
        // The lease owner will observe the cancellation flag at its next safe
        // point. Acknowledging this QStash delivery would strand a crashed
        // owner, so keep it retriable while that lease is still live.
        return { kind: 'busy' };
      }
      return { kind: 'cancelled' };
    }

    const now = new Date();
    const lease: ExecutionLease = {
      id: randomUUID(),
      expiresAt: new Date(now.getTime() + executionBudgetSeconds * 1_000),
    };
    const claimWhere = {
      id: runId,
      cancelRequestedAt: null,
      ...(dispatchId
        ? {
            dispatchOutbox: {
              is: {
                id: dispatchId,
                status: {
                  in: [
                    ScheduleRunDispatchStatus.PENDING,
                    ScheduleRunDispatchStatus.PUBLISHED,
                  ],
                },
                terminalFailureAt: null,
              },
            },
          }
        : {}),
      OR: [
        { status: ScheduleRunStatus.QUEUED },
        {
          status: ScheduleRunStatus.RUNNING,
          OR: [
            { executionLeaseExpiresAt: { lte: now } },
            { executionLeaseExpiresAt: null },
          ],
        },
      ],
    } satisfies Prisma.ScheduleRunWhereInput;
    const changed = await this.leaseModel(this.prisma).updateMany({
      where: claimWhere,
      data: {
        status: ScheduleRunStatus.RUNNING,
        startedAt: before.startedAt ?? now,
        progressPercent: 5,
        executionLeaseId: lease.id,
        executionLeaseExpiresAt: lease.expiresAt,
        executionAttempt: { increment: 1 },
      },
    });
    if (changed.count === 1) return { kind: 'acquired', lease };

    const after = await this.prisma.scheduleRun.findUnique({
      where: { id: runId },
    });
    if (!after) return { kind: 'not_found' };
    if (after.status === ScheduleRunStatus.CANCELLED) {
      return { kind: 'cancelled' };
    }
    if (this.isSettled(after.status)) return { kind: 'settled' };
    if (after.cancelRequestedAt) return { kind: 'cancelled' };
    return { kind: 'busy' };
  }

  private isSettled(status: ScheduleRunStatus): boolean {
    const settled: ScheduleRunStatus[] = [
      ScheduleRunStatus.SUCCEEDED,
      ScheduleRunStatus.FAILED,
      ScheduleRunStatus.CANCELLED,
      ScheduleRunStatus.SUPERSEDED,
    ];
    return settled.includes(status);
  }

  private leaseModel(
    client:
      | Pick<PrismaService, 'scheduleRun'>
      | Pick<Prisma.TransactionClient, 'scheduleRun'>,
  ) {
    return client.scheduleRun as unknown as {
      updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
    };
  }

  private dispatchOutboxModel(
    client: PrismaService | Prisma.TransactionClient,
  ) {
    return (
      client as unknown as {
        scheduleRunDispatchOutbox: {
          create(args: Record<string, unknown>): Promise<unknown>;
          findUnique(args: Record<string, unknown>): Promise<{
            id: string;
            terminalFailureAt: Date | null;
          } | null>;
          updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
        };
      }
    ).scheduleRunDispatchOutbox;
  }

  private leaseWhere(
    runId: string,
    lease: ExecutionLease,
    allowCancellation = false,
  ) {
    return {
      id: runId,
      status: ScheduleRunStatus.RUNNING,
      executionLeaseId: lease.id,
      executionLeaseExpiresAt: { gt: new Date() },
      ...(allowCancellation ? {} : { cancelRequestedAt: null }),
    };
  }

  private async updateLeasedRun(
    runId: string,
    lease: ExecutionLease,
    data: Record<string, unknown>,
    client:
      | Pick<PrismaService, 'scheduleRun'>
      | Pick<Prisma.TransactionClient, 'scheduleRun'> = this.prisma,
  ): Promise<void> {
    const changed = await this.leaseModel(client).updateMany({
      where: this.leaseWhere(runId, lease),
      data,
    });
    if (changed.count !== 1) {
      throw new AppException(
        'RESOURCE_CONFLICT',
        'This schedule run lease is no longer active.',
        HttpStatus.CONFLICT,
        { runId },
      );
    }
  }

  private async settleExpiredCancellation(runId: string): Promise<boolean> {
    return settleExpiredScheduleRunCancellation(this.prisma, runId);
  }

  /**
   * BullMQ may run a self-hosted solve for hours, but a crashed process must
   * surrender quickly. Renewal is fenced by the same lease id as every write,
   * so a reclaimed owner cannot prolong or overwrite the new owner's work.
   */
  private startExecutionLeaseHeartbeat(
    runId: string,
    lease: ExecutionLease,
    executionLeaseSeconds: number,
  ): ExecutionLeaseHeartbeat {
    let stopped = false;
    let failure: unknown;
    let inFlight: Promise<void> | undefined;
    let renewing = false;
    const tick = () => {
      if (stopped || failure || renewing) return;
      renewing = true;
      inFlight = this.renewExecutionLease(
        runId,
        lease,
        executionLeaseSeconds,
      )
        .catch((error: unknown) => {
          failure = error;
        })
        .finally(() => {
          renewing = false;
        });
    };
    const timer = setInterval(tick, BULLMQ_LEASE_HEARTBEAT_MILLISECONDS);

    return {
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        await inFlight;
      },
      assertActive: () => {
        if (failure) throw failure;
      },
    };
  }

  private async renewExecutionLease(
    runId: string,
    lease: ExecutionLease,
    executionLeaseSeconds: number,
  ): Promise<void> {
    const expiresAt = new Date(
      Date.now() + executionLeaseSeconds * 1_000,
    );
    const renewed = await this.leaseModel(this.prisma).updateMany({
      // Cancellation is cooperative: its current owner must keep its fence
      // until it reaches a safe cancellation check, rather than looking stale.
      where: this.leaseWhere(runId, lease, true),
      data: { executionLeaseExpiresAt: expiresAt },
    });
    if (renewed.count !== 1) {
      throw new AppException(
        'RESOURCE_CONFLICT',
        'This schedule run lease is no longer active.',
        HttpStatus.CONFLICT,
        { runId },
      );
    }
    lease.expiresAt = expiresAt;
  }

  private async releaseLeaseForRetry(
    runId: string,
    lease: ExecutionLease,
  ): Promise<void> {
    await this.updateLeasedRun(runId, lease, {
      status: ScheduleRunStatus.QUEUED,
      executionLeaseId: null,
      executionLeaseExpiresAt: null,
    });
  }

  private async isCancelled(runId: string): Promise<boolean> {
    const run = await this.prisma.scheduleRun.findUnique({
      where: { id: runId },
      select: { cancelRequestedAt: true },
    });
    return (
      run?.cancelRequestedAt !== null && run?.cancelRequestedAt !== undefined
    );
  }

  private async markCancelled(runId: string, lease: ExecutionLease) {
    const changed = await this.leaseModel(this.prisma).updateMany({
      where: this.leaseWhere(runId, lease, true),
      data: {
        status: ScheduleRunStatus.CANCELLED,
        finishedAt: new Date(),
        progressPercent: 100,
      },
    });
    if (changed.count !== 1) {
      throw new AppException(
        'RESOURCE_CONFLICT',
        'This schedule run lease is no longer active.',
        HttpStatus.CONFLICT,
        { runId },
      );
    }
    return { scheduled: 0, unassigned: 0, cancelled: true };
  }

  private async finish(
    runId: string,
    scheduled: number,
    unassigned: number,
    lease: ExecutionLease,
    client: Pick<Prisma.TransactionClient, 'scheduleRun'> = this.prisma,
  ) {
    await this.updateLeasedRun(
      runId,
      lease,
      {
        status: ScheduleRunStatus.SUCCEEDED,
        finishedAt: new Date(),
        progressPercent: 100,
        visitsScheduled: scheduled,
        visitsUnassigned: unassigned,
      },
      client,
    );
    return { scheduled, unassigned, cancelled: false };
  }

  /**
   * Asks a run to stop.
   *
   * A flag rather than a kill: the worker checks it between steps and abandons
   * the run without writing, so a cancel can never leave half a schedule
   * behind. A run that has already finished is left exactly as it is.
   */
  async requestCancel(runId: string, actor: AuthenticatedUser) {
    const run = await this.prisma.scheduleRun.findUnique({
      where: { id: runId },
    });
    if (!run) {
      throw new AppException(
        'RESOURCE_NOT_FOUND',
        `Schedule run "${runId}" was not found.`,
        HttpStatus.NOT_FOUND,
        { runId },
      );
    }

    const settled: ScheduleRunStatus[] = [
      ScheduleRunStatus.SUCCEEDED,
      ScheduleRunStatus.FAILED,
      ScheduleRunStatus.CANCELLED,
      ScheduleRunStatus.SUPERSEDED,
    ];
    if (settled.includes(run.status)) {
      throw new AppException(
        'RESOURCE_CONFLICT',
        `This run is already ${run.status.toLowerCase()} and cannot be cancelled.`,
        HttpStatus.CONFLICT,
        { runId, status: run.status },
      );
    }

    const updated = await this.prisma.scheduleRun.update({
      where: { id: runId },
      data: {
        cancelRequestedAt: new Date(),
        // A queued run never reaches the worker, so it is settled here.
        ...(run.status === ScheduleRunStatus.QUEUED
          ? { status: ScheduleRunStatus.CANCELLED, finishedAt: new Date() }
          : {}),
      },
    });

    await this.audit.record({
      entityType: 'ScheduleRun',
      entityId: runId,
      action: 'schedule_run.cancel_requested',
      actor,
      before: run,
      after: updated,
    });

    return updated;
  }

  /** Moves the run's percentage. Called by the lease-holding worker only. */
  async setProgress(runId: string, lease: ExecutionLease, percent: number) {
    await this.updateLeasedRun(runId, lease, {
      progressPercent: Math.max(0, Math.min(100, Math.round(percent))),
    });
  }

  async fail(
    runId: string,
    lease: ExecutionLease,
    code: string,
    message: string,
  ) {
    await this.updateLeasedRun(runId, lease, {
      status: ScheduleRunStatus.FAILED,
      finishedAt: new Date(),
      errorCode: code,
      errorMessage: message,
    });
  }

  /** QStash owns the retry policy, so it is the final failure authority. */
  async failForQStash(
    runId: string,
    dispatchId: string,
    messageId: string,
    code: string,
    message: string,
  ): Promise<'failed' | 'deferred' | 'ignored'> {
    return failScheduleRunForQStash(
      this.prisma,
      runId,
      dispatchId,
      messageId,
      code,
      message,
    );
  }
}

/** Availability is stored as ranges; the solver wants the individual days. */
function expandDates(periods: { startDate: Date; endDate: Date }[]): string[] {
  const days = new Set<string>();
  for (const period of periods) {
    for (
      let cursor = new Date(period.startDate);
      cursor <= period.endDate;
      cursor = new Date(cursor.getTime() + 86_400_000)
    ) {
      days.add(dateOnly(cursor));
    }
  }
  return [...days].sort();
}

export type ScheduleRunRow = Prisma.ScheduleRunGetPayload<object>;

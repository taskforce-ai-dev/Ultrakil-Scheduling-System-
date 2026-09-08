import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  AssignmentStatus,
  BranchCode,
  CrewRole,
  LockScope,
  Prisma,
  ScheduleRunStatus,
  VisitStatus,
} from '@prisma/client';

import { AuditService } from '../../audit/audit.service';
import { AuthenticatedUser } from '../../auth/auth.types';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { EligibilityService } from '../eligibility/eligibility.service';
import { buildCandidateSlots, splitDayRules } from './candidate-slots';
import { SchedulerClient, SolveRequest } from './scheduler.client';
import {
  assertScheduleSnapshot,
  assertVisitRevision,
  lockScheduleVisits,
} from './schedule-visit-lock';

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
const EXECUTION_OVERHEAD_SECONDS = 30;

interface ExecutionLease {
  id: string;
  expiresAt: Date;
}

type DeliveryOutcome =
  | { kind: 'completed'; scheduled: number; unassigned: number }
  | { kind: 'cancelled' }
  | { kind: 'not_found' }
  | { kind: 'settled' }
  | { kind: 'busy' };

interface DeliveryOptions {
  executionBudgetSeconds: number;
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
      crewMembers: { select: { employeeId: true, isPmsSupervisor: true } },
      vehicles: { select: { vehicleId: true } },
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
  expectedUpdatedAt: Date;
  replaceAssignmentId?: string;
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
@Injectable()
export class ScheduleRunService {
  private readonly logger = new Logger(ScheduleRunService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: SchedulerClient,
    private readonly eligibility: EligibilityService,
    private readonly audit: AuditService,
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

    const run = await this.prisma.scheduleRun.create({
      data: {
        status: ScheduleRunStatus.QUEUED,
        rangeStart: from,
        rangeEnd: to,
        branchCode: input.branchCode ?? null,
        requestedByUserId: actor.id,
        timeLimitSeconds: input.timeLimitSeconds ?? 20,
      } as unknown as Prisma.ScheduleRunCreateInput,
    });

    await this.audit.record({
      entityType: 'ScheduleRun',
      entityId: run.id,
      action: 'schedule_run.queued',
      actor,
      before: null,
      after: run,
    });

    return run;
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
      executionBudgetSeconds: options.executionBudgetSeconds ?? 270,
      retryOnFailure: false,
      timeLimitSeconds: options.timeLimitSeconds,
      onProgress: options.onProgress,
    });
    if (outcome.kind === 'completed') {
      return { ...outcome, cancelled: false };
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
    const claim = await this.claimExecutionLease(
      runId,
      options.executionBudgetSeconds,
    );
    if (claim.kind !== 'acquired') return claim;

    try {
      const result = await this.executeLeased(runId, claim.lease, options);
      return result.cancelled
        ? { kind: 'cancelled' }
        : {
            kind: 'completed',
            scheduled: result.scheduled,
            unassigned: result.unassigned,
          };
    } catch (caught) {
      const code =
        typeof (caught as { code?: unknown }).code === 'string'
          ? (caught as { code: string }).code
          : 'INTERNAL_ERROR';
      const message = caught instanceof Error ? caught.message : String(caught);
      if (options.retryOnFailure) {
        await this.releaseLeaseForRetry(runId, claim.lease);
      } else {
        await this.fail(runId, claim.lease, code, message);
      }
      throw caught;
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
    );

    await this.updateLeasedRun(runId, lease, {
      visitsConsidered: request.visits.length,
      progressPercent: 35,
    });
    await notifyProgress(35);

    if (request.visits.length === 0) {
      return this.finish(runId, 0, 0, lease);
    }

    // The solver works a day at a time and spends up to the time limit on each,
    // so a week can legitimately take seven times as long as one day. Timing out
    // at a single day's budget aborted solves that were running perfectly well
    // and reported SCHEDULER_UNAVAILABLE — a service that was in fact answering.
    const solveDays = new Set(
      request.visits.flatMap((visit) =>
        visit.candidate_slots.length > 0
          ? visit.candidate_slots.map((slot) => slot.date)
          : [visit.visit_date],
      ),
    ).size;
    const availableSolverSeconds = Math.max(
      1,
      options.executionBudgetSeconds - EXECUTION_OVERHEAD_SECONDS,
    );
    const perDayLimitSeconds = Math.min(
      request.time_limit_seconds,
      Math.max(1, Math.floor(availableSolverSeconds / Math.max(1, solveDays))),
    );
    const boundedRequest = {
      ...request,
      time_limit_seconds: perDayLimitSeconds,
    };
    const solution = await this.scheduler.solve(
      boundedRequest,
      perDayLimitSeconds * Math.max(1, solveDays) * 1000 + 10_000,
    );

    await progress(70);
    // Checked after the solve and again before writing: a manager who cancels
    // during a twenty-second solve should not find a schedule appearing anyway.
    if (await this.isCancelled(runId)) return this.markCancelled(runId, lease);

    const byId = new Map(visits.map((visit) => [visit.id, visit]));
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

      const dto = {
        plannedStartMinute: proposal.start_minute,
        plannedEndMinute: proposal.start_minute + visit.durationMinutes,
        crew: proposal.employee_ids.map((employeeId, index) => ({
          employeeId,
          role: index === 0 ? CrewRole.SUPERVISOR : CrewRole.TECHNICIAN,
        })),
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
        expectedUpdatedAt: visit.updatedAt,
        dto,
        replaceAssignmentId: existing?.id,
        proposedVisit,
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
    options: { timeLimitSeconds: number; from: Date; to: Date },
  ): SolveRequest {
    const locks: SolveRequest['locks'] = [];
    const existing: SolveRequest['existing'] = [];
    /** Visits a manager has fixed in time. These are never offered new slots. */
    const pinned = new Set<string>();

    const solvable = visits.filter((visit) => {
      const live = visit.assignments.find((a) =>
        LIVE_STATUSES.includes(a.status),
      );
      if (!live) return true;

      // Published work is settled — the solver is not offered it at all.
      if (!REPLACEABLE_STATUSES.includes(live.status)) return false;

      const lock = live.locks[0];
      if (lock) {
        // A lock on the time is a decision about when, so the visit stops being
        // free to move. Any other scope still lets the day change.
        if (lock.scope === LockScope.FULL || lock.scope === LockScope.TIME) {
          pinned.add(visit.id);
        }
        locks.push({
          visit_id: visit.id,
          scope: lock.scope === LockScope.SUPERVISOR ? 'CREW' : lock.scope,
          employee_ids:
            lock.scope === LockScope.SUPERVISOR
              ? live.crewMembers
                  .filter((m) => m.isPmsSupervisor)
                  .map((m) => m.employeeId)
              : live.crewMembers.map((m) => m.employeeId),
          vehicle_ids: live.vehicles.map((v) => v.vehicleId),
          start_minute: null,
        });
      }

      existing.push({
        visit_id: visit.id,
        employee_ids: live.crewMembers.map((m) => m.employeeId),
        vehicle_ids: live.vehicles.map((v) => v.vehicleId),
      });
      return true;
    });

    return {
      run_id: runId,
      visits: solvable.map((visit) => {
        // The day a visit was generated on is one legal option among several,
        // not a decision. Handing the solver all of them is what lets it settle
        // date, time, crew and vehicle in one pass instead of taking the date
        // as given and hunting for people who happen to be free.
        //
        // A visit a manager pinned in time keeps its date: an empty list means
        // "stay exactly where you are", so their decision survives the rerun.
        const { allowedDays, preferredDays } = splitDayRules(
          visit.serviceAgreement.dayRules,
        );
        const candidates = pinned.has(visit.id)
          ? []
          : buildCandidateSlots({
              allowedDays,
              preferredDays,
              siteWindows:
                visit.serviceAgreement.serviceSite.operatingHours.map(
                  (hours) => ({
                    weekday: hours.weekday,
                    startMinute: hours.opensAtMinute,
                    endMinute: hours.closesAtMinute,
                  }),
                ),
              agreementStartMinute:
                visit.serviceAgreement.serviceWindowStartMinute,
              agreementEndMinute: visit.serviceAgreement.serviceWindowEndMinute,
              durationMinutes: visit.durationMinutes,
              from: options.from,
              to: options.to,
            });

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
          candidate_slots: candidates.map((slot) => ({
            date: slot.date,
            earliest_start_minute: slot.earliestStartMinute,
            latest_start_minute: slot.latestStartMinute,
            is_preferred: slot.isPreferred,
          })),
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
        unavailable_dates: expandDates(employee.availability),
      })),
      vehicles: vehicles.map((vehicle) => ({
        id: vehicle.id,
        branch_code: vehicle.branch?.code ?? null,
        seat_capacity: vehicle.seatCapacity,
      })),
      locks,
      existing,
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
    const employeeIds = [
      ...new Set(
        proposals.flatMap((entry) =>
          entry.dto.crew.map((member) => member.employeeId),
        ),
      ),
    ];
    const pms = await this.prisma.employee.findMany({
      where: { id: { in: employeeIds } },
      select: { id: true, isPmsGrade: true },
    });
    const pmsById = new Map(pms.map((row) => [row.id, row.isPmsGrade]));

    return this.prisma.$transaction(
      async (tx) => {
        // One solver response is one atomic change. Lock the entire affected set
        // in the shared deterministic order, then validate every revision before
        // creating drafts, transferring locks, moving dates or changing reasons.
        await lockScheduleVisits(
          tx,
          entries.map((entry) => entry.visitId),
        );
        for (const entry of entries) {
          await assertScheduleSnapshot(
            tx,
            entry.visitId,
            entry.replaceAssignmentId,
          );
          const visit = await tx.generatedVisit.findUniqueOrThrow({
            where: { id: entry.visitId },
            select: { updatedAt: true },
          });
          // Lock/unlock decisions also advance this revision under the same
          // visit lock, so a stale lock snapshot rejects the complete response.
          assertVisitRevision(
            entry.visitId,
            entry.expectedUpdatedAt,
            visit.updatedAt,
          );
        }
        let scheduled = 0;
        let rejected = 0;
        for (const entry of proposals) {
          // Evaluate and apply in order inside this transaction. Later checks
          // must see the slots freed or occupied by earlier accepted results.
          // The engine still wins whenever it disagrees with the solver.
          const verdict = await this.eligibility.evaluate(
            entry.visitId,
            entry.dto,
            {
              excludeAssignmentId: entry.replaceAssignmentId,
              proposedVisit: entry.proposedVisit,
            },
            tx,
          );
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
                reasons: verdict.conflicts.map((conflict) => ({
                  code: conflict.code,
                  message: conflict.message,
                  remediation: conflict.remediation,
                  resources: conflict.resources,
                })),
              },
            ]);
            rejected += 1;
            continue;
          }
          await this.persist(tx, runId, entry, pmsById);
          scheduled += 1;
        }
        await this.recordUnassigned(tx, runId, unassigned);
        return this.finish(
          runId,
          scheduled,
          unassigned.length + rejected,
          lease,
          tx,
        );
      },
      { timeout: 30_000 },
    );
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

  private async recordUnassigned(
    tx: Prisma.TransactionClient,
    runId: string,
    entries: UnassignedResult[],
  ) {
    for (const entry of entries) {
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
  ): Promise<DeliveryOutcome | { kind: 'acquired'; lease: ExecutionLease }> {
    const before = await this.prisma.scheduleRun.findUnique({
      where: { id: runId },
    });
    if (!before) return { kind: 'not_found' };
    if (this.isSettled(before.status)) return { kind: 'settled' };
    if (before.cancelRequestedAt) {
      await this.settleExpiredCancellation(runId);
      return { kind: 'cancelled' };
    }

    const now = new Date();
    const lease: ExecutionLease = {
      id: randomUUID(),
      expiresAt: new Date(now.getTime() + executionBudgetSeconds * 1_000),
    };
    const changed = await this.leaseModel(this.prisma).updateMany({
      where: {
        id: runId,
        cancelRequestedAt: null,
        OR: [
          { status: ScheduleRunStatus.QUEUED },
          {
            status: ScheduleRunStatus.RUNNING,
            OR: [
              { executionLeaseExpiresAt: { lt: now } },
              { executionLeaseExpiresAt: null },
            ],
          },
        ],
      },
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

  private async settleExpiredCancellation(runId: string): Promise<void> {
    const now = new Date();
    await this.leaseModel(this.prisma).updateMany({
      where: {
        id: runId,
        status: ScheduleRunStatus.RUNNING,
        cancelRequestedAt: { not: null },
        OR: [
          { executionLeaseExpiresAt: { lt: now } },
          { executionLeaseExpiresAt: null },
        ],
      },
      data: {
        status: ScheduleRunStatus.CANCELLED,
        finishedAt: now,
        progressPercent: 100,
      },
    });
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
    messageId: string,
    code: string,
    message: string,
  ) {
    const now = new Date();
    await this.leaseModel(this.prisma).updateMany({
      where: {
        id: runId,
        jobId: messageId,
        cancelRequestedAt: null,
        status: { in: [ScheduleRunStatus.QUEUED, ScheduleRunStatus.RUNNING] },
        OR: [
          { executionLeaseId: null },
          { executionLeaseExpiresAt: { lt: now } },
        ],
      },
      data: {
        status: ScheduleRunStatus.FAILED,
        finishedAt: now,
        errorCode: code,
        errorMessage: message,
      },
    });
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

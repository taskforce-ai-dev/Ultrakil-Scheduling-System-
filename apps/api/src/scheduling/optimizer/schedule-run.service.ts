import { HttpStatus, Injectable, Logger } from '@nestjs/common';
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
import { SchedulerClient, SolveRequest } from './scheduler.client';

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

const VISIT_FOR_SOLVE = {
  serviceAgreement: { include: { requiredSkills: { select: { skillCode: true } } } },
  assignments: {
    where: { status: { in: LIVE_STATUSES } },
    include: {
      crewMembers: { select: { employeeId: true, isPmsSupervisor: true } },
      vehicles: { select: { vehicleId: true } },
      locks: { where: { releasedAt: null } },
    },
  },
} satisfies Prisma.GeneratedVisitInclude;

type VisitForSolve = Prisma.GeneratedVisitGetPayload<{ include: typeof VISIT_FOR_SOLVE }>;

const EMPLOYEE_FOR_SOLVE = {
  skills: { select: { skillCode: true } },
  vehicleAuthorizations: { select: { vehicleId: true } },
  permanentAssignments: { select: { serviceSiteId: true } },
  availability: { select: { startDate: true, endDate: true } },
} satisfies Prisma.EmployeeInclude;

type EmployeeForSolve = Prisma.EmployeeGetPayload<{ include: typeof EMPLOYEE_FOR_SOLVE }>;

const VEHICLE_FOR_SOLVE = {
  branch: { select: { code: true } },
} satisfies Prisma.VehicleInclude;

type VehicleForSolve = Prisma.VehicleGetPayload<{ include: typeof VEHICLE_FOR_SOLVE }>;

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
    input: { from: string; to: string; branchCode?: BranchCode; timeLimitSeconds?: number },
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
      },
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
    options: { timeLimitSeconds?: number; onProgress?: (percent: number) => Promise<void> } = {},
  ): Promise<{ scheduled: number; unassigned: number; cancelled: boolean }> {
    const progress = options.onProgress ?? (async () => undefined);

    const run = await this.prisma.scheduleRun.findUnique({ where: { id: runId } });
    if (!run) {
      throw new AppException(
        'RESOURCE_NOT_FOUND',
        `Schedule run "${runId}" was not found.`,
        HttpStatus.NOT_FOUND,
        { runId },
      );
    }

    await this.prisma.scheduleRun.update({
      where: { id: runId },
      data: {
        status: ScheduleRunStatus.RUNNING,
        startedAt: new Date(),
        progressPercent: 5,
      },
    });

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
        serviceAgreement: { serviceSite: { isActive: true, customer: { isActive: true } } },
        ...branchFilter,
      },
      include: VISIT_FOR_SOLVE,
      orderBy: { id: 'asc' },
    });

    await progress(20);
    if (await this.isCancelled(runId)) return this.markCancelled(runId);

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

    const request = this.buildSolveRequest(run.id, visits, employees, vehicles, {
      timeLimitSeconds: options.timeLimitSeconds ?? 20,
    });

    await this.prisma.scheduleRun.update({
      where: { id: runId },
      data: { visitsConsidered: request.visits.length, progressPercent: 35 },
    });

    if (request.visits.length === 0) {
      return this.finish(runId, 0, 0);
    }

    const solution = await this.scheduler.solve(
      request,
      Math.round((options.timeLimitSeconds ?? 20) * 1000) + 15_000,
    );

    await progress(70);
    // Checked after the solve and again before writing: a manager who cancels
    // during a twenty-second solve should not find a schedule appearing anyway.
    if (await this.isCancelled(runId)) return this.markCancelled(runId);

    const byId = new Map(visits.map((visit) => [visit.id, visit]));
    let scheduled = 0;
    const rejected: { visitId: string; codes: string[]; message: string }[] = [];

    for (const proposal of solution.assignments) {
      const visit = byId.get(proposal.visit_id);
      if (!visit) continue;

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

      // The second check. If the solver and the engine ever disagree, the
      // engine wins and the visit goes to the queue — never the other way.
      const existing = visit.assignments.find((a) =>
        REPLACEABLE_STATUSES.includes(a.status),
      );
      const verdict = await this.eligibility.evaluate(visit.id, dto, {
        excludeAssignmentId: existing?.id,
      });

      if (!verdict.isEligible) {
        this.logger.warn(
          `Solver proposed an assignment the engine refused for visit ${visit.id}: ${verdict.conflicts
            .map((conflict) => conflict.code)
            .join(', ')}`,
        );
        rejected.push({
          visitId: visit.id,
          codes: verdict.conflicts.map((conflict) => conflict.code),
          message: verdict.conflicts.map((conflict) => conflict.message).join(' '),
        });
        continue;
      }

      await this.persist(runId, visit.id, dto, existing?.id);
      scheduled += 1;
    }

    await progress(90);

    const unassigned = [
      ...solution.unassigned.map((entry) => ({
        visitId: entry.visit_id,
        codes: entry.reason_codes,
        message: entry.message,
      })),
      ...rejected,
    ];

    await this.recordUnassigned(runId, unassigned);

    return this.finish(runId, scheduled, unassigned.length);
  }

  private buildSolveRequest(
    runId: string,
    visits: VisitForSolve[],
    employees: EmployeeForSolve[],
    vehicles: VehicleForSolve[],
    options: { timeLimitSeconds: number },
  ): SolveRequest {
    const locks: SolveRequest['locks'] = [];
    const existing: SolveRequest['existing'] = [];

    const solvable = visits.filter((visit) => {
      const live = visit.assignments.find((a) => LIVE_STATUSES.includes(a.status));
      if (!live) return true;

      // Published work is settled — the solver is not offered it at all.
      if (!REPLACEABLE_STATUSES.includes(live.status)) return false;

      const lock = live.locks[0];
      if (lock) {
        locks.push({
          visit_id: visit.id,
          scope: lock.scope === LockScope.SUPERVISOR ? 'CREW' : lock.scope,
          employee_ids:
            lock.scope === LockScope.SUPERVISOR
              ? live.crewMembers.filter((m) => m.isPmsSupervisor).map((m) => m.employeeId)
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
      visits: solvable.map((visit) => ({
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
        is_preferred_day: false,
      })),
      employees: employees.map((employee) => ({
        id: employee.id,
        branch_code: employee.branchCode,
        is_pms_grade: employee.isPmsGrade,
        is_permanently_stationed: employee.deploymentType === 'PERMANENTLY_STATIONED',
        permanent_site_ids: employee.permanentAssignments.map((a) => a.serviceSiteId).sort(),
        skill_codes: employee.skills.map((s) => s.skillCode).sort(),
        authorized_vehicle_ids: employee.vehicleAuthorizations.map((a) => a.vehicleId).sort(),
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

  private async persist(
    runId: string,
    visitId: string,
    dto: {
      plannedStartMinute: number;
      plannedEndMinute: number;
      crew: { employeeId: string; role: CrewRole }[];
      vehicles: { vehicleId: string; driverEmployeeId: string }[];
    },
    replaceAssignmentId?: string,
  ) {
    const visit = await this.prisma.generatedVisit.findUniqueOrThrow({
      where: { id: visitId },
      select: { visitDate: true, branchId: true, branchCode: true },
    });

    const pms = await this.prisma.employee.findMany({
      where: { id: { in: dto.crew.map((member) => member.employeeId) } },
      select: { id: true, isPmsGrade: true },
    });
    const pmsById = new Map(pms.map((row) => [row.id, row.isPmsGrade]));

    const at = (minute: number) => new Date(visit.visitDate.getTime() + minute * 60_000);

    await this.prisma.$transaction(async (tx) => {
      if (replaceAssignmentId) {
        await tx.assignment.delete({ where: { id: replaceAssignmentId } });
      }
      await tx.assignment.create({
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
      await tx.visitUnassignedReason.deleteMany({ where: { generatedVisitId: visitId } });
      await tx.generatedVisit.update({
        where: { id: visitId },
        data: { status: VisitStatus.SCHEDULED },
      });
    });
  }

  private async recordUnassigned(
    runId: string,
    entries: { visitId: string; codes: string[]; message: string }[],
  ) {
    if (entries.length === 0) return;

    await this.prisma.$transaction(async (tx) => {
      for (const entry of entries) {
        await tx.visitUnassignedReason.deleteMany({
          where: { generatedVisitId: entry.visitId },
        });
        await tx.visitUnassignedReason.createMany({
          data: entry.codes.map((code) => ({
            generatedVisitId: entry.visitId,
            scheduleRunId: runId,
            code,
            message: entry.message,
          })),
        });
        await tx.generatedVisit.update({
          where: { id: entry.visitId },
          data: { status: VisitStatus.UNASSIGNED },
        });
      }
    });
  }

  private async isCancelled(runId: string): Promise<boolean> {
    const run = await this.prisma.scheduleRun.findUnique({
      where: { id: runId },
      select: { cancelRequestedAt: true },
    });
    return run?.cancelRequestedAt !== null && run?.cancelRequestedAt !== undefined;
  }

  private async markCancelled(runId: string) {
    await this.prisma.scheduleRun.update({
      where: { id: runId },
      data: {
        status: ScheduleRunStatus.CANCELLED,
        finishedAt: new Date(),
        progressPercent: 100,
      },
    });
    return { scheduled: 0, unassigned: 0, cancelled: true };
  }

  private async finish(runId: string, scheduled: number, unassigned: number) {
    await this.prisma.scheduleRun.update({
      where: { id: runId },
      data: {
        status: ScheduleRunStatus.SUCCEEDED,
        finishedAt: new Date(),
        progressPercent: 100,
        visitsScheduled: scheduled,
        visitsUnassigned: unassigned,
      },
    });
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
    const run = await this.prisma.scheduleRun.findUnique({ where: { id: runId } });
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

  /** Moves the run's percentage. Called by the worker as the solve proceeds. */
  async setProgress(runId: string, percent: number) {
    await this.prisma.scheduleRun.update({
      where: { id: runId },
      data: { progressPercent: Math.max(0, Math.min(100, Math.round(percent))) },
    });
  }

  async fail(runId: string, code: string, message: string) {
    await this.prisma.scheduleRun.update({
      where: { id: runId },
      data: {
        status: ScheduleRunStatus.FAILED,
        finishedAt: new Date(),
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

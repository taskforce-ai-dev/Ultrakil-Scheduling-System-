import { Injectable } from '@nestjs/common';
import { AssignmentStatus } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../prisma/prisma.service';
import { PublishingService } from '../optimizer/publishing.service';
import {
  provenanceWarnings,
  publishReadiness,
} from '../optimizer/publish-readiness';
import { ScheduleRunService } from '../optimizer/schedule-run.service';
import type {
  DayStaffingPort,
  StaffedDay,
} from './day-coverage.service';

/**
 * The real staffing port: one ordinary schedule run for one day.
 *
 * Everything here goes through the paths a manager's own click already uses —
 * `ScheduleRunService.create` and `.execute` to solve, `PublishingService` to
 * freeze — so replenishment inherits the execution lease, the dispatch
 * outbox, the audit record, the branch-day lock and the publication
 * re-check under lock, rather than growing a second implementation of any of
 * them that would have to be kept in step.
 *
 * The two publication arguments that matter are the two that are never sent:
 * `acknowledgePartial` and `acknowledgeProvenance` are both false, and the
 * reason is null. A machine cannot give a manager's acknowledgement, so this
 * publishes only what needs none — and asks first, through
 * {@link isPublishableWithoutManager}, rather than attempting a publication
 * and treating the refusal as a result.
 */
@Injectable()
export class DayStaffingAdapter implements DayStaffingPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: ScheduleRunService,
    private readonly publishing: PublishingService,
  ) {}

  async staffDay(input: {
    branchCode: Parameters<ScheduleRunService['create']>[0]['branchCode'];
    date: string;
    actor: AuthenticatedUser;
  }): Promise<StaffedDay> {
    const run = await this.runs.create(
      { from: input.date, to: input.date, branchCode: input.branchCode },
      input.actor,
    );

    let succeeded = true;
    try {
      const result = await this.runs.execute(run.id);
      succeeded = !result.cancelled;
    } catch {
      // The run row carries its own failure detail and audit trail; the
      // coverage row only needs to know the day did not get an answer.
      succeeded = false;
    }

    return {
      scheduleRunId: run.id,
      succeeded,
      assignments: await this.collectDraftAssignments(run.id),
    };
  }

  /**
   * Everything the run drafted, unfiltered.
   *
   * Deliberately not narrowed to the due set. `ScheduleRunService` solves a
   * branch-day filtering inactive sites and completed or cancelled visits,
   * but it knows nothing about paused or ended agreements, locks or manual
   * adjustment — so this can legitimately return an assignment for a visit
   * the day must not touch. Hiding that here would make the day look clean
   * while the run still carried the extra assignment into publication, since
   * publication freezes the run rather than the list this returns. Handing
   * the real contents to the guard is what lets it withhold the whole day.
   */
  async collectDraftAssignments(
    scheduleRunId: string,
  ): Promise<StaffedDay['assignments']> {
    const assignments = await this.prisma.assignment.findMany({
      where: { scheduleRunId, status: AssignmentStatus.DRAFT },
      select: {
        id: true,
        generatedVisitId: true,
        crewMembers: { select: { employeeId: true } },
        vehicles: { select: { vehicleId: true } },
      },
    });

    return assignments.map((assignment) => ({
      id: assignment.id,
      generatedVisitId: assignment.generatedVisitId,
      crewEmployeeIds: assignment.crewMembers.map((c) => c.employeeId),
      vehicleIds: assignment.vehicles.map((v) => v.vehicleId),
    }));
  }

  /**
   * Whether the existing gate would let this run publish with no manager.
   *
   * READY only: nothing unassigned and no unconfirmed-source warning. On
   * today's data this is reliably false — no service window or site branch in
   * the database is confirmed — and that is the policy holding, not a bug.
   */
  async isPublishableWithoutManager(scheduleRunId: string): Promise<boolean> {
    const run = await this.prisma.scheduleRun.findUnique({
      where: { id: scheduleRunId },
      select: {
        visitsConsidered: true,
        visitsScheduled: true,
        visitsUnassigned: true,
      },
    });
    if (!run) return false;

    const assignments = await this.prisma.assignment.findMany({
      where: { scheduleRunId, status: AssignmentStatus.DRAFT },
      select: {
        generatedVisitId: true,
        vehicles: { select: { vehicle: { select: { branchId: true } } } },
        generatedVisit: {
          select: {
            windowProvenance: true,
            serviceAgreement: {
              select: {
                crewSizeProvenance: true,
                durationProvenance: true,
                dayRuleProvenance: true,
                serviceSite: {
                  select: { branchConfidence: true, branchSource: true },
                },
              },
            },
          },
        },
      },
    });

    return (
      publishReadiness(run, provenanceWarnings(assignments)).state === 'READY'
    );
  }

  /** No acknowledgement, no reason. Both belong to a manager. */
  async publish(
    scheduleRunId: string,
    actor: AuthenticatedUser,
  ): Promise<void> {
    await this.publishing.publish(scheduleRunId, null, actor, false, false);
  }
}

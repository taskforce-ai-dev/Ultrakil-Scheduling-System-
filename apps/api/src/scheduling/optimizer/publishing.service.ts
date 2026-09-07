import { HttpStatus, Injectable } from '@nestjs/common';
import { AssignmentStatus, LockScope, Prisma, ScheduleRunStatus } from '@prisma/client';

import { AuditService } from '../../audit/audit.service';
import { AuthenticatedUser } from '../../auth/auth.types';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { lockScheduleVisits } from './schedule-visit-lock';

const PUBLISH_ASSIGNMENT_INCLUDE = {
  crewMembers: { include: { employee: { select: { fullName: true } } } },
  vehicles: { include: { vehicle: { select: { label: true } } } },
  generatedVisit: {
    include: {
      serviceAgreement: {
        include: {
          customer: { select: { name: true } },
          serviceSite: { select: { name: true } },
        },
      },
    },
  },
} satisfies Prisma.AssignmentInclude;

/**
 * Publishing a schedule, and pinning parts of one.
 *
 * A published schedule is what the crews were told. It is never edited and
 * never deleted — a later publication supersedes it, and both remain. Rewriting
 * history is how "who said I was going to Kandy?" becomes unanswerable.
 */
@Injectable()
export class PublishingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Freezes a run's draft assignments and supersedes whatever it replaces.
   *
   * The snapshot written to the audit log is the immutable version: every crew
   * member and vehicle as published, so the record survives even if an employee
   * is later renamed or deactivated.
   */
  async publish(
    runId: string,
    reason: string | null,
    actor: AuthenticatedUser,
  ) {
    const run = await this.prisma.scheduleRun.findUnique({
      where: { id: runId },
      include: {
        assignments: {
          select: { id: true, generatedVisitId: true, status: true },
        },
      },
    });

    if (!run) {
      throw new AppException(
        'RESOURCE_NOT_FOUND',
        `Schedule run "${runId}" was not found.`,
        HttpStatus.NOT_FOUND,
        { runId },
      );
    }

    if (run.publishedAt) {
      throw new AppException(
        'RESOURCE_CONFLICT',
        'This schedule was already published. Run the scheduler again and publish the new run — a published schedule is never edited.',
        HttpStatus.CONFLICT,
        { runId, publishedAt: run.publishedAt.toISOString() },
      );
    }

    if (run.status !== ScheduleRunStatus.SUCCEEDED) {
      throw new AppException(
        'RESOURCE_CONFLICT',
        `Only a finished run can be published; this one is ${run.status.toLowerCase()}.`,
        HttpStatus.CONFLICT,
        { runId, status: run.status },
      );
    }

    const expected = run.assignments.filter(
      (assignment) => assignment.status === AssignmentStatus.DRAFT,
    );

    if (expected.length === 0) {
      throw new AppException(
        'RESOURCE_CONFLICT',
        'This run produced no assignments to publish.',
        HttpStatus.CONFLICT,
        { runId },
      );
    }

    // Everything published earlier for the same visits is superseded, not
    // deleted — the crews were told those, and that stays on the record.
    const visitIds = expected.map((assignment) => assignment.generatedVisitId);

    const published = await this.prisma.$transaction(async (tx) => {
      await lockScheduleVisits(tx, visitIds);
      // Only the identities come from the pre-lock read. Adjustments may have
      // changed visit and draft timing while publication waited for the lock.
      const publishable = await tx.assignment.findMany({
        where: {
          id: { in: expected.map((assignment) => assignment.id) },
          scheduleRunId: runId,
          status: AssignmentStatus.DRAFT,
        },
        include: PUBLISH_ASSIGNMENT_INCLUDE,
      });
      if (publishable.length !== expected.length) {
        throw new AppException(
          'RESOURCE_CONFLICT',
          'One or more assignments changed while the schedule was being published. Refresh and try again.',
          HttpStatus.CONFLICT,
          { runId },
        );
      }
      const snapshot = publishable.map((assignment) => ({
        assignmentId: assignment.id,
        visitId: assignment.generatedVisitId,
        customerName: assignment.generatedVisit.serviceAgreement.customer.name,
        siteName: assignment.generatedVisit.serviceAgreement.serviceSite.name,
        visitDate: assignment.generatedVisit.visitDate
          .toISOString()
          .slice(0, 10),
        plannedStart: assignment.plannedStart.toISOString(),
        plannedEnd: assignment.plannedEnd.toISOString(),
        crew: assignment.crewMembers.map((member) => ({
          employeeId: member.employeeId,
          fullName: member.employee.fullName,
          role: member.role,
          isPmsSupervisor: member.isPmsSupervisor,
        })),
        vehicles: assignment.vehicles.map((entry) => ({
          vehicleId: entry.vehicleId,
          label: entry.vehicle.label,
          driverEmployeeId: entry.driverEmployeeId,
        })),
      }));

      // Another publication may have finished while this one waited. Read
      // supersession targets under the same visit locks used by the solver.
      const previouslyPublished = await tx.assignment.findMany({
        where: {
          generatedVisitId: { in: visitIds },
          status: AssignmentStatus.PUBLISHED,
          id: { notIn: publishable.map((assignment) => assignment.id) },
        },
        select: { id: true, scheduleRunId: true },
      });
      const publishedAt = new Date();

      // Claim the run with one conditional write. Two managers can click
      // Publish at almost the same moment; only the transaction that changes
      // this row is allowed to continue and create notifications.
      const claim = await tx.scheduleRun.updateMany({
        where: {
          id: runId,
          status: ScheduleRunStatus.SUCCEEDED,
          publishedAt: null,
        },
        data: { publishedAt, publishedByUserId: actor.id },
      });
      if (claim.count !== 1) {
        throw new AppException(
          'RESOURCE_CONFLICT',
          'This schedule was already published or is no longer publishable.',
          HttpStatus.CONFLICT,
          { runId },
        );
      }

      const promoted = await tx.assignment.updateMany({
        where: {
          id: { in: publishable.map((assignment) => assignment.id) },
          status: AssignmentStatus.DRAFT,
        },
        data: { status: AssignmentStatus.PUBLISHED, publishedAt },
      });
      if (promoted.count !== publishable.length) {
        throw new AppException(
          'RESOURCE_CONFLICT',
          'One or more assignments changed while the schedule was being published. Nothing was published; refresh and try again.',
          HttpStatus.CONFLICT,
          { runId, expected: publishable.length, found: promoted.count },
        );
      }

      if (previouslyPublished.length > 0) {
        await tx.assignment.updateMany({
          where: {
            id: { in: previouslyPublished.map((assignment) => assignment.id) },
          },
          data: { status: AssignmentStatus.SUPERSEDED },
        });

        const supersededRunIds = [
          ...new Set(
            previouslyPublished
              .map((assignment) => assignment.scheduleRunId)
              .filter((id): id is string => id !== null && id !== runId),
          ),
        ];
        if (supersededRunIds.length > 0) {
          await tx.scheduleRun.updateMany({
            where: { id: { in: supersededRunIds } },
            data: {
              status: ScheduleRunStatus.SUPERSEDED,
              supersededByRunId: runId,
            },
          });
        }
      }

      // One outbox row per crew member per published assignment — everything a
      // future notification would need to say, snapshotted now so it stays
      // correct even if the employee or visit changes later. Nothing reads
      // these yet; Phase 2 adds the sender, not this write.
      await tx.assignmentNotificationOutbox.createMany({
        data: publishable.flatMap((assignment) =>
          assignment.crewMembers.map((member) => ({
            assignmentId: assignment.id,
            employeeId: member.employeeId,
            eventType: 'assignment.published',
            payload: {
              visitId: assignment.generatedVisitId,
              customerName:
                assignment.generatedVisit.serviceAgreement.customer.name,
              siteName:
                assignment.generatedVisit.serviceAgreement.serviceSite.name,
              visitDate: assignment.generatedVisit.visitDate
                .toISOString()
                .slice(0, 10),
              plannedStart: assignment.plannedStart.toISOString(),
              plannedEnd: assignment.plannedEnd.toISOString(),
              role: member.role,
              isPmsSupervisor: member.isPmsSupervisor,
            } as unknown as Prisma.InputJsonValue,
          })),
        ),
        skipDuplicates: true,
      });

      await this.audit.record(
        {
          entityType: 'ScheduleRun',
          entityId: runId,
          action: 'schedule_run.published',
          actor,
          before: null,
          // The immutable version: names and labels as published, so the record
          // still reads correctly after people and vehicles change.
          after: {
            reason,
            assignmentCount: snapshot.length,
            supersededAssignments: previouslyPublished.length,
            snapshot,
          } as unknown as Prisma.InputJsonValue,
        },
        tx,
      );

      return {
        run: await tx.scheduleRun.findUniqueOrThrow({ where: { id: runId } }),
        publishedCount: publishable.length,
      };
    });

    return published;
  }

  /** Pins part of an assignment so the next run cannot change it. */
  async lock(
    assignmentId: string,
    scope: LockScope,
    reason: string | null,
    actor: AuthenticatedUser,
  ) {
    const assignment = await this.prisma.assignment.findUnique({
      where: { id: assignmentId },
      select: { id: true, generatedVisitId: true, updatedAt: true },
    });

    if (!assignment) {
      throw new AppException(
        'RESOURCE_NOT_FOUND',
        `Assignment "${assignmentId}" was not found.`,
        HttpStatus.NOT_FOUND,
        { assignmentId },
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await lockScheduleVisits(tx, [assignment.generatedVisitId]);
      const current = await tx.assignment.findUnique({ where: { id: assignmentId } });
      if (!current || current.updatedAt.getTime() !== assignment.updatedAt.getTime()) {
        throw this.assignmentChanged(assignmentId);
      }
      const lock = await tx.assignmentLock.upsert({
        where: { assignmentId_scope: { assignmentId, scope } },
        create: { assignmentId, scope, reason, lockedByUserId: actor.id },
        update: { reason, lockedByUserId: actor.id, releasedAt: null },
      });
      await this.reviseVisit(tx, assignment.generatedVisitId);
      await this.audit.record({
        entityType: 'Assignment', entityId: assignmentId, action: 'assignment.locked',
        actor, before: null, after: lock,
      }, tx);
      return lock;
    });
  }

  async unlock(
    assignmentId: string,
    scope: LockScope,
    actor: AuthenticatedUser,
  ) {
    const snapshot = await this.prisma.assignmentLock.findUnique({
      where: { assignmentId_scope: { assignmentId, scope } },
      include: { assignment: { select: { generatedVisitId: true } } },
    });

    if (!snapshot || snapshot.releasedAt) {
      throw new AppException(
        'RESOURCE_NOT_FOUND',
        `No ${scope.toLowerCase()} lock is held on this assignment.`,
        HttpStatus.NOT_FOUND,
        { assignmentId, scope },
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await lockScheduleVisits(tx, [snapshot.assignment.generatedVisitId]);
      const existing = await tx.assignmentLock.findUnique({
        where: { assignmentId_scope: { assignmentId, scope } },
      });
      if (!existing || existing.releasedAt || existing.updatedAt.getTime() !== snapshot.updatedAt.getTime()) {
        throw this.assignmentChanged(assignmentId);
      }
      const released = await tx.assignmentLock.update({
        where: { assignmentId_scope: { assignmentId, scope } },
        data: { releasedAt: new Date() },
      });
      await this.reviseVisit(tx, snapshot.assignment.generatedVisitId);
      await this.audit.record({
        entityType: 'Assignment', entityId: assignmentId, action: 'assignment.unlocked',
        actor, before: existing, after: released,
      }, tx);
      return released;
    });
  }

  private assignmentChanged(assignmentId: string) {
    return new AppException(
      'RESOURCE_CONFLICT',
      'This assignment changed while its lock was being updated. Refresh and try again.',
      HttpStatus.CONFLICT,
      { assignmentId },
    );
  }

  /** A solve or generation plan made before this decision must be retried. */
  private async reviseVisit(tx: Prisma.TransactionClient, visitId: string) {
    const visit = await tx.generatedVisit.findUniqueOrThrow({ where: { id: visitId }, select: { updatedAt: true } });
    await tx.generatedVisit.update({
      where: { id: visitId },
      // Avoid equal millisecond timestamps when two writes arrive together.
      data: { updatedAt: new Date(Math.max(Date.now(), visit.updatedAt.getTime() + 1)) },
    });
  }
}

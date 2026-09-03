import { HttpStatus, Injectable } from '@nestjs/common';
import { AssignmentStatus, LockScope, Prisma, ScheduleRunStatus } from '@prisma/client';

import { AuditService } from '../../audit/audit.service';
import { AuthenticatedUser } from '../../auth/auth.types';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../prisma/prisma.service';

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
  async publish(runId: string, reason: string | null, actor: AuthenticatedUser) {
    const run = await this.prisma.scheduleRun.findUnique({
      where: { id: runId },
      include: {
        assignments: {
          include: {
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
          },
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

    const publishable = run.assignments.filter(
      (assignment) => assignment.status === AssignmentStatus.DRAFT,
    );

    if (publishable.length === 0) {
      throw new AppException(
        'RESOURCE_CONFLICT',
        'This run produced no assignments to publish.',
        HttpStatus.CONFLICT,
        { runId },
      );
    }

    // Everything published earlier for the same visits is superseded, not
    // deleted — the crews were told those, and that stays on the record.
    const visitIds = publishable.map((assignment) => assignment.generatedVisitId);
    const previouslyPublished = await this.prisma.assignment.findMany({
      where: {
        generatedVisitId: { in: visitIds },
        status: AssignmentStatus.PUBLISHED,
        id: { notIn: publishable.map((assignment) => assignment.id) },
      },
      select: { id: true, scheduleRunId: true },
    });

    const snapshot = publishable.map((assignment) => ({
      assignmentId: assignment.id,
      visitId: assignment.generatedVisitId,
      customerName: assignment.generatedVisit.serviceAgreement.customer.name,
      siteName: assignment.generatedVisit.serviceAgreement.serviceSite.name,
      visitDate: assignment.generatedVisit.visitDate.toISOString().slice(0, 10),
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

    const published = await this.prisma.$transaction(async (tx) => {
      await tx.assignment.updateMany({
        where: { id: { in: publishable.map((assignment) => assignment.id) } },
        data: { status: AssignmentStatus.PUBLISHED, publishedAt: new Date() },
      });

      if (previouslyPublished.length > 0) {
        await tx.assignment.updateMany({
          where: { id: { in: previouslyPublished.map((assignment) => assignment.id) } },
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
            data: { status: ScheduleRunStatus.SUPERSEDED, supersededByRunId: runId },
          });
        }
      }

      const updated = await tx.scheduleRun.update({
        where: { id: runId },
        data: { publishedAt: new Date(), publishedByUserId: actor.id },
      });

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
              customerName: assignment.generatedVisit.serviceAgreement.customer.name,
              siteName: assignment.generatedVisit.serviceAgreement.serviceSite.name,
              visitDate: assignment.generatedVisit.visitDate.toISOString().slice(0, 10),
              plannedStart: assignment.plannedStart.toISOString(),
              plannedEnd: assignment.plannedEnd.toISOString(),
              role: member.role,
              isPmsSupervisor: member.isPmsSupervisor,
            } as unknown as Prisma.InputJsonValue,
          })),
        ),
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

      return updated;
    });

    return { run: published, publishedCount: publishable.length };
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
      select: { id: true, status: true },
    });

    if (!assignment) {
      throw new AppException(
        'RESOURCE_NOT_FOUND',
        `Assignment "${assignmentId}" was not found.`,
        HttpStatus.NOT_FOUND,
        { assignmentId },
      );
    }

    const lock = await this.prisma.assignmentLock.upsert({
      where: { assignmentId_scope: { assignmentId, scope } },
      create: { assignmentId, scope, reason, lockedByUserId: actor.id },
      update: { reason, lockedByUserId: actor.id, releasedAt: null },
    });

    await this.audit.record({
      entityType: 'Assignment',
      entityId: assignmentId,
      action: 'assignment.locked',
      actor,
      before: null,
      after: lock,
    });

    return lock;
  }

  async unlock(assignmentId: string, scope: LockScope, actor: AuthenticatedUser) {
    const existing = await this.prisma.assignmentLock.findUnique({
      where: { assignmentId_scope: { assignmentId, scope } },
    });

    if (!existing || existing.releasedAt) {
      throw new AppException(
        'RESOURCE_NOT_FOUND',
        `No ${scope.toLowerCase()} lock is held on this assignment.`,
        HttpStatus.NOT_FOUND,
        { assignmentId, scope },
      );
    }

    const released = await this.prisma.assignmentLock.update({
      where: { assignmentId_scope: { assignmentId, scope } },
      data: { releasedAt: new Date() },
    });

    await this.audit.record({
      entityType: 'Assignment',
      entityId: assignmentId,
      action: 'assignment.unlocked',
      actor,
      before: existing,
      after: released,
    });

    return released;
  }
}

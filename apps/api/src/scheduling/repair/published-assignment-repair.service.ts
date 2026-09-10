import { createHash, randomUUID } from 'node:crypto';

import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AssignmentRepairAction,
  AssignmentStatus,
  CrewRole,
  Prisma,
  PublishedAssignmentRepairCommunicationState,
  UserRole,
  VisitStatus,
} from '@prisma/client';

import { AuditService } from '../../audit/audit.service';
import { AuthenticatedUser } from '../../auth/auth.types';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { Conflict, sortConflicts } from '../eligibility/conflict-codes';
import { EligibilityService } from '../eligibility/eligibility.service';
import { AssignmentProposal } from '../eligibility/rules';
import {
  lockScheduleResources,
  lockScheduleVisits,
} from '../optimizer/schedule-visit-lock';

const SOURCE_INCLUDE = {
  crewMembers: {
    include: { employee: { select: { fullName: true } } },
  },
  vehicles: {
    include: { vehicle: { select: { label: true } } },
  },
  locks: {
    where: { releasedAt: null },
    select: { assignmentId: true, scope: true, reason: true },
  },
  generatedVisit: {
    include: {
      assignments: {
        where: { status: AssignmentStatus.PUBLISHED },
        select: { id: true },
      },
      serviceAgreement: {
        include: {
          customer: { select: { name: true } },
          serviceSite: { select: { name: true } },
        },
      },
    },
  },
} satisfies Prisma.AssignmentInclude;

type SourceAssignment = Prisma.AssignmentGetPayload<{
  include: typeof SOURCE_INCLUDE;
}>;
type RepairClient = PrismaService | Prisma.TransactionClient;

export interface RepairCrewMemberInput {
  employeeId: string;
  role: CrewRole;
}

export interface RepairVehicleInput {
  vehicleId: string;
  driverEmployeeId?: string | null;
}

export interface RepairReplacementInput {
  plannedStartMinute: number;
  plannedEndMinute: number;
  crew: RepairCrewMemberInput[];
  vehicles?: RepairVehicleInput[];
}

export interface RepairUnassignedReasonInput {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface PublishedAssignmentRepairOperation {
  sourceAssignmentId: string;
  action: AssignmentRepairAction;
  replacement?: RepairReplacementInput;
  unassignedReasons?: RepairUnassignedReasonInput[];
}

export interface PublishedAssignmentRepairPreviewInput {
  operations: PublishedAssignmentRepairOperation[];
}

export interface PublishedAssignmentRepairApplyInput extends PublishedAssignmentRepairPreviewInput {
  planHash: string;
  sourceFingerprints: Array<{
    sourceAssignmentId: string;
    fingerprint: string;
  }>;
  confirmation: boolean;
  acknowledgeCurrentDay?: boolean;
  reason: string;
  idempotencyKey: string;
}

export interface PublishedAssignmentRepairPreviewItem {
  sourceAssignmentId: string;
  visitId: string;
  action: AssignmentRepairAction;
  sourceFingerprint: string;
  isValid: boolean;
  conflicts: Conflict[];
  timeScope: RepairTimeScope;
}

export interface PublishedAssignmentRepairPreview {
  planHash: string;
  isValid: boolean;
  items: PublishedAssignmentRepairPreviewItem[];
}

export interface PublishedAssignmentRepairResult {
  repairId: string;
  planHash: string;
  idempotencyKey: string;
  communicationState: PublishedAssignmentRepairCommunicationState;
  items: Array<{
    sourceAssignmentId: string;
    visitId: string;
    action: AssignmentRepairAction;
    replacementAssignmentId: string | null;
  }>;
}

export interface PublishedAssignmentFinding {
  assignmentId: string;
  visitId: string;
  visitDate: string;
  customerName: string;
  siteName: string;
  conflicts: Conflict[];
  sourceFingerprint: string;
  timeScope: RepairTimeScope;
  isSelectableForRepair: boolean;
}

export type RepairTimeScope = 'HISTORICAL' | 'CURRENT_DAY' | 'FUTURE';

interface BuiltPreview extends PublishedAssignmentRepairPreview {
  sources: Map<string, SourceAssignment>;
  operations: PublishedAssignmentRepairOperation[];
}

/**
 * The only writer allowed to correct already-published assignments.
 *
 * Preview is deliberately a plain read. Apply repeats the entire preview after
 * locking every affected visit, then conditionally supersedes each exact
 * predecessor in the same transaction as lineage, audit, and outbox records.
 */
@Injectable()
export class PublishedAssignmentRepairService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligibility: EligibilityService,
    private readonly audit: AuditService,
  ) {}

  async validateCurrent(query: { page?: number; pageSize?: number }): Promise<{
    items: PublishedAssignmentFinding[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where = { status: AssignmentStatus.PUBLISHED };
    const rows = await this.prisma.assignment.findMany({
      where,
      include: SOURCE_INCLUDE,
      orderBy: { id: 'asc' },
    });

    const evaluated = await Promise.all(
      rows.map(async (assignment) => {
        const verdict = await this.eligibility.evaluate(
          assignment.generatedVisitId,
          proposalFromSource(assignment),
          { excludeAssignmentId: assignment.id },
        );
        return { assignment, conflicts: sortConflicts(verdict.conflicts) };
      }),
    );

    const findings = evaluated
      .filter(({ conflicts }) => conflicts.length > 0)
      .map(({ assignment, conflicts }) => ({
        assignmentId: assignment.id,
        visitId: assignment.generatedVisitId,
        visitDate: assignment.generatedVisit.visitDate.toISOString().slice(0, 10),
        customerName: assignment.generatedVisit.serviceAgreement.customer.name,
        siteName: assignment.generatedVisit.serviceAgreement.serviceSite.name,
        conflicts,
        sourceFingerprint: fingerprintSource(assignment),
        timeScope: repairTimeScope(assignment.generatedVisit.visitDate),
        isSelectableForRepair:
          repairTimeScope(assignment.generatedVisit.visitDate) !== 'HISTORICAL',
      }));
    return {
      items: findings.slice((page - 1) * pageSize, page * pageSize),
      total: findings.length,
      page,
      pageSize,
    };
  }

  async preview(
    input: PublishedAssignmentRepairPreviewInput,
  ): Promise<PublishedAssignmentRepairPreview> {
    const {
      sources: _sources,
      operations: _operations,
      ...preview
    } = await this.buildPreview(input, this.prisma);
    return preview;
  }

  async apply(
    input: PublishedAssignmentRepairApplyInput,
    actor: AuthenticatedUser,
  ): Promise<PublishedAssignmentRepairResult> {
    this.assertApplyGate(input, actor);
    const requestHash = hashCanonical({
      actorUserId: actor.id,
      operations: normalizeOperations(input.operations),
      planHash: input.planHash,
      sourceFingerprints: [...input.sourceFingerprints].sort((left, right) =>
        left.sourceAssignmentId.localeCompare(right.sourceAssignmentId),
      ),
      confirmation: input.confirmation,
      acknowledgeCurrentDay: input.acknowledgeCurrentDay ?? false,
      reason: input.reason.trim(),
    });

    const existing = await this.prisma.publishedAssignmentRepair.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) return this.replayOrReject(existing, requestHash);

    // This read discovers the parent rows to lock. No decision from it is used
    // after the locks are acquired; buildPreview is repeated in the transaction.
    const preflight = await this.buildPreview(input, this.prisma);
    const visitIds = preflight.items.map((item) => item.visitId);
    const replacements = preflight.operations.filter(
      (operation) => operation.action === AssignmentRepairAction.REPLACED,
    );
    const employeeIds = replacements.flatMap(
      (operation) => operation.replacement?.crew.map((member) => member.employeeId) ?? [],
    );
    const vehicleIds = replacements.flatMap(
      (operation) =>
        operation.replacement?.vehicles?.map((vehicle) => vehicle.vehicleId) ?? [],
    );

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await lockScheduleVisits(tx, visitIds);
          await lockScheduleResources(tx, employeeIds, vehicleIds);

          // A concurrent identical request may have committed while this one
          // waited for a visit lock. Replay it before inspecting predecessors.
          const concurrent = await tx.publishedAssignmentRepair.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
          });
          if (concurrent) return this.replayOrReject(concurrent, requestHash);

          const locked = await this.buildPreview(input, tx);
          this.assertPreviewMatchesApply(input, locked);

          const repairId = randomUUID();
          const appliedAt = new Date();
          const replacementIds = new Map(
            locked.operations
              .filter((operation) => operation.action === AssignmentRepairAction.REPLACED)
              .map((operation) => [operation.sourceAssignmentId, randomUUID()]),
          );
          const result: PublishedAssignmentRepairResult = {
            repairId,
            planHash: locked.planHash,
            idempotencyKey: input.idempotencyKey,
            communicationState:
              PublishedAssignmentRepairCommunicationState.APPLIED_PENDING_COMMUNICATION,
            items: locked.operations.map((operation) => ({
              sourceAssignmentId: operation.sourceAssignmentId,
              visitId: locked.sources.get(operation.sourceAssignmentId)!.generatedVisitId,
              action: operation.action,
              replacementAssignmentId: replacementIds.get(operation.sourceAssignmentId) ?? null,
            })),
          };

          await tx.publishedAssignmentRepair.create({
            data: {
              id: repairId,
              idempotencyKey: input.idempotencyKey,
              requestHash,
              planHash: locked.planHash,
              reason: input.reason.trim(),
              actorUserId: actor.id,
              actorLabel: `${actor.fullName} <${actor.email}>`,
              result: toJson(result),
              communicationState:
                PublishedAssignmentRepairCommunicationState.APPLIED_PENDING_COMMUNICATION,
            },
          });

          const writeOrder = [...locked.operations].sort((left, right) => {
            const actionOrder =
              Number(left.action === AssignmentRepairAction.REPLACED) -
              Number(right.action === AssignmentRepairAction.REPLACED);
            return actionOrder || left.sourceAssignmentId.localeCompare(right.sourceAssignmentId);
          });
          for (const operation of writeOrder) {
            const source = locked.sources.get(operation.sourceAssignmentId)!;
            const previewItem = locked.items.find((item) => item.sourceAssignmentId === source.id)!;
            const before = snapshotSource(source);
            await tx.assignmentNotificationOutbox.updateMany({
              where: {
                assignmentId: source.id,
                eventType: 'assignment.published',
                processedAt: null,
                cancelledAt: null,
              },
              data: {
                cancelledAt: appliedAt,
                cancelledByRepairId: repairId,
              },
            });
            const claimed = await tx.assignment.updateMany({
              where: {
                id: source.id,
                status: AssignmentStatus.PUBLISHED,
                updatedAt: source.updatedAt,
              },
              data: { status: AssignmentStatus.SUPERSEDED },
            });
            if (claimed.count !== 1) throw sourceChanged(source.id);

            if (operation.action === AssignmentRepairAction.REPLACED) {
              await this.replace(
                tx,
                repairId,
                source,
                operation,
                replacementIds.get(source.id)!,
                previewItem.sourceFingerprint,
                before,
                actor,
                input.reason.trim(),
                appliedAt,
              );
            } else {
              await this.withdraw(
                tx,
                repairId,
                source,
                operation,
                previewItem.sourceFingerprint,
                before,
                actor,
                input.reason.trim(),
              );
            }
          }
          return result;
        },
        { timeout: 30_000 },
      );
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      const raced = await this.prisma.publishedAssignmentRepair.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (!raced) {
        throw new AppException(
          'RESOURCE_CONFLICT',
          'One or more published assignments were repaired concurrently. Nothing from this request was applied; refresh and preview again.',
          HttpStatus.CONFLICT,
        );
      }
      return this.replayOrReject(raced, requestHash);
    }
  }

  private async buildPreview(
    input: PublishedAssignmentRepairPreviewInput,
    client: RepairClient,
  ): Promise<BuiltPreview> {
    const operations = normalizeOperations(input.operations);
    this.assertOperations(operations);
    const sourceIds = operations.map((operation) => operation.sourceAssignmentId);
    const rows = await client.assignment.findMany({
      where: { id: { in: sourceIds } },
      include: SOURCE_INCLUDE,
      orderBy: { id: 'asc' },
    });
    if (rows.length !== sourceIds.length) {
      throw new AppException(
        'RESOURCE_CONFLICT',
        'One or more published assignments no longer exist. Refresh the repair preview.',
        HttpStatus.CONFLICT,
      );
    }

    const sources = new Map(rows.map((row) => [row.id, row]));
    const sourceIdSet = new Set(sourceIds);
    for (const source of rows) {
      if (source.status !== AssignmentStatus.PUBLISHED) {
        throw new AppException(
          'RESOURCE_CONFLICT',
          `Assignment "${source.id}" is ${source.status.toLowerCase()} and cannot be repaired automatically.`,
          HttpStatus.CONFLICT,
          { assignmentId: source.id, status: source.status },
        );
      }
      if (repairTimeScope(source.generatedVisit.visitDate) === 'HISTORICAL') {
        throw new AppException(
          'RESOURCE_CONFLICT',
          'Historical published assignments are evidence and cannot be repaired automatically.',
          HttpStatus.CONFLICT,
          { assignmentId: source.id, timeScope: 'HISTORICAL' },
        );
      }
      const omittedPublishedSiblings = source.generatedVisit.assignments
        .map((assignment) => assignment.id)
        .filter((assignmentId) => !sourceIdSet.has(assignmentId))
        .sort();
      if (omittedPublishedSiblings.length > 0) {
        throw new AppException(
          'RESOURCE_CONFLICT',
          'Every published assignment for an affected visit must be included in one repair plan.',
          HttpStatus.CONFLICT,
          {
            visitId: source.generatedVisitId,
            omittedPublishedAssignmentIds: omittedPublishedSiblings,
          },
        );
      }
    }

    const replacementCountByVisit = new Map<string, number>();
    for (const operation of operations) {
      if (operation.action !== AssignmentRepairAction.REPLACED) continue;
      const visitId = sources.get(operation.sourceAssignmentId)!.generatedVisitId;
      replacementCountByVisit.set(visitId, (replacementCountByVisit.get(visitId) ?? 0) + 1);
    }
    if ([...replacementCountByVisit.values()].some((count) => count > 1)) {
      throw validationFailed('A repair may publish at most one replacement for each visit.');
    }

    const items: PublishedAssignmentRepairPreviewItem[] = [];
    for (const operation of operations) {
      const source = sources.get(operation.sourceAssignmentId)!;
      const conflicts: Conflict[] = [];
      if (source.locks.length > 0) {
        const lock = source.locks[0];
        conflicts.push({
          code: 'ASSIGNMENT_LOCKED',
          message: `A manager has pinned this published assignment${
            lock.reason ? ` — "${lock.reason}"` : ''
          }.`,
          remediation:
            'Release the active manager lock before previewing or applying a repair.',
          resources: {
            visitId: source.generatedVisitId,
            assignmentIds: [source.id],
          },
        });
      }
      if (operation.action === AssignmentRepairAction.REPLACED) {
        const verdict = await this.eligibility.evaluate(
          source.generatedVisitId,
          {
            ...operation.replacement!,
            vehicles: (operation.replacement!.vehicles ?? []).map((entry) => ({
              vehicleId: entry.vehicleId,
              driverEmployeeId: entry.driverEmployeeId ?? null,
            })),
          },
          { excludeAssignmentIds: sourceIds },
          client as Prisma.TransactionClient,
        );
        conflicts.push(...verdict.conflicts);
      }
      items.push({
        sourceAssignmentId: source.id,
        visitId: source.generatedVisitId,
        action: operation.action,
        sourceFingerprint: fingerprintSource(source),
        timeScope: repairTimeScope(source.generatedVisit.visitDate),
        isValid: conflicts.length === 0,
        conflicts: sortConflicts(conflicts),
      });
    }

    this.addBatchReservationConflicts(items, operations, sources);
    const publicItems = items.map((item) => ({
      ...item,
      conflicts: sortConflicts(item.conflicts),
      isValid: item.conflicts.length === 0,
    }));
    const planHash = hashCanonical({
      operations,
      items: publicItems,
    });
    return {
      planHash,
      isValid: publicItems.every((item) => item.isValid),
      items: publicItems,
      sources,
      operations,
    };
  }

  private addBatchReservationConflicts(
    items: PublishedAssignmentRepairPreviewItem[],
    operations: PublishedAssignmentRepairOperation[],
    sources: Map<string, SourceAssignment>,
  ): void {
    const replacements = operations.filter(
      (
        operation,
      ): operation is PublishedAssignmentRepairOperation & {
        replacement: RepairReplacementInput;
      } => operation.action === AssignmentRepairAction.REPLACED,
    );
    for (let leftIndex = 0; leftIndex < replacements.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < replacements.length; rightIndex += 1) {
        const left = replacements[leftIndex];
        const right = replacements[rightIndex];
        const leftSource = sources.get(left.sourceAssignmentId)!;
        const rightSource = sources.get(right.sourceAssignmentId)!;
        if (
          !absoluteWindowsOverlap(
            leftSource.generatedVisit.visitDate,
            left.replacement,
            rightSource.generatedVisit.visitDate,
            right.replacement,
          )
        ) {
          continue;
        }
        const employeeIds = intersection(
          left.replacement.crew.map((member) => member.employeeId),
          right.replacement.crew.map((member) => member.employeeId),
        );
        const vehicleIds = intersection(
          (left.replacement.vehicles ?? []).map((entry) => entry.vehicleId),
          (right.replacement.vehicles ?? []).map((entry) => entry.vehicleId),
        );
        if (employeeIds.length > 0) {
          this.pushPairConflict(items, left, right, {
            code: 'EMPLOYEE_DOUBLE_BOOKED',
            message: 'The repair batch assigns the same crew member to overlapping visits.',
            remediation: 'Use different crew or non-overlapping times before applying the repair.',
            resources: {
              employeeIds,
              assignmentIds: [left.sourceAssignmentId, right.sourceAssignmentId],
            },
          });
        }
        if (vehicleIds.length > 0) {
          this.pushPairConflict(items, left, right, {
            code: 'VEHICLE_DOUBLE_BOOKED',
            message: 'The repair batch assigns the same vehicle to overlapping visits.',
            remediation:
              'Use different vehicles or non-overlapping times before applying the repair.',
            resources: {
              vehicleIds,
              assignmentIds: [left.sourceAssignmentId, right.sourceAssignmentId],
            },
          });
        }
      }
    }
  }

  private pushPairConflict(
    items: PublishedAssignmentRepairPreviewItem[],
    left: PublishedAssignmentRepairOperation,
    right: PublishedAssignmentRepairOperation,
    conflict: Conflict,
  ): void {
    for (const sourceAssignmentId of [left.sourceAssignmentId, right.sourceAssignmentId]) {
      items
        .find((item) => item.sourceAssignmentId === sourceAssignmentId)!
        .conflicts.push(conflict);
    }
  }

  private assertOperations(operations: PublishedAssignmentRepairOperation[]): void {
    if (operations.length === 0 || operations.length > 100) {
      throw validationFailed('A repair must contain between 1 and 100 operations.');
    }
    const ids = operations.map((operation) => operation.sourceAssignmentId);
    if (new Set(ids).size !== ids.length) {
      throw validationFailed('A published assignment may appear only once in a repair.');
    }
    for (const operation of operations) {
      if (operation.action === AssignmentRepairAction.REPLACED && !operation.replacement) {
        throw validationFailed('A replacement operation requires a replacement plan.');
      }
      if (
        operation.action === AssignmentRepairAction.WITHDRAWN &&
        !operation.unassignedReasons?.length
      ) {
        throw validationFailed('A withdrawal requires at least one structured reason.');
      }
    }
  }

  private assertApplyGate(
    input: PublishedAssignmentRepairApplyInput,
    actor: AuthenticatedUser,
  ): void {
    if (actor.role !== UserRole.ADMIN) {
      throw new AppException(
        'INSUFFICIENT_ROLE',
        'Only an administrator can apply a published-assignment repair.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (input.confirmation !== true) {
      throw validationFailed('Explicit confirmation is required before applying a repair.');
    }
    if (!input.reason?.trim() || input.reason.trim().length > 500) {
      throw validationFailed('A repair reason between 1 and 500 characters is required.');
    }
    if (!input.idempotencyKey?.trim() || input.idempotencyKey.length > 200) {
      throw validationFailed('An idempotency key between 1 and 200 characters is required.');
    }
    if (!/^[a-f0-9]{64}$/.test(input.planHash)) {
      throw validationFailed('A valid preview plan hash is required.');
    }
  }

  private assertPreviewMatchesApply(
    input: PublishedAssignmentRepairApplyInput,
    preview: BuiltPreview,
  ): void {
    if (!preview.isValid) {
      throw new AppException(
        'ASSIGNMENT_NOT_ELIGIBLE',
        'The repair plan contains assignments that do not meet the current hard rules.',
        HttpStatus.CONFLICT,
        { items: preview.items },
      );
    }
    if (
      preview.items.some((item) => item.timeScope === 'CURRENT_DAY') &&
      input.acknowledgeCurrentDay !== true
    ) {
      throw validationFailed(
        'Current-day repairs require explicit acknowledgeCurrentDay confirmation.',
      );
    }
    const supplied = new Map(
      input.sourceFingerprints.map((entry) => [entry.sourceAssignmentId, entry.fingerprint]),
    );
    const fingerprintsMatch =
      supplied.size === preview.items.length &&
      preview.items.every(
        (item) => supplied.get(item.sourceAssignmentId) === item.sourceFingerprint,
      );
    if (input.planHash !== preview.planHash || !fingerprintsMatch) {
      throw new AppException(
        'RESOURCE_CONFLICT',
        'The repair plan or one of its source assignments changed. Run a new preview before applying.',
        HttpStatus.CONFLICT,
      );
    }
  }

  private async replace(
    tx: Prisma.TransactionClient,
    repairId: string,
    source: SourceAssignment,
    operation: PublishedAssignmentRepairOperation,
    replacementId: string,
    sourceFingerprint: string,
    before: Record<string, unknown>,
    actor: AuthenticatedUser,
    reason: string,
    publishedAt: Date,
  ): Promise<void> {
    const replacement = operation.replacement!;
    const employees = await tx.employee.findMany({
      where: {
        id: { in: replacement.crew.map((member) => member.employeeId) },
      },
      select: { id: true, isPmsGrade: true },
    });
    const pmsById = new Map(employees.map((employee) => [employee.id, employee.isPmsGrade]));
    const plannedStart = atMinute(source.generatedVisit.visitDate, replacement.plannedStartMinute);
    const plannedEnd = atMinute(source.generatedVisit.visitDate, replacement.plannedEndMinute);
    await tx.assignment.create({
      data: {
        id: replacementId,
        generatedVisitId: source.generatedVisitId,
        branchId: source.generatedVisit.branchId,
        branchCode: source.generatedVisit.branchCode,
        status: AssignmentStatus.PUBLISHED,
        plannedStart,
        plannedEnd,
        scheduleRunId: null,
        publishedAt,
        supersedesAssignmentId: source.id,
        publishedByRepairId: repairId,
        crewMembers: {
          create: replacement.crew.map((member) => ({
            employeeId: member.employeeId,
            role: member.role,
            isPmsSupervisor: pmsById.get(member.employeeId) ?? false,
          })),
        },
        vehicles: {
          create: (replacement.vehicles ?? []).map((entry) => ({
            vehicleId: entry.vehicleId,
            driverEmployeeId: entry.driverEmployeeId ?? null,
          })),
        },
      },
    });
    await tx.generatedVisit.update({
      where: { id: source.generatedVisitId },
      data: { status: VisitStatus.SCHEDULED },
    });
    await tx.visitUnassignedReason.deleteMany({
      where: { generatedVisitId: source.generatedVisitId },
    });

    const after = {
      assignmentId: replacementId,
      supersedesAssignmentId: source.id,
      publishedByRepairId: repairId,
      generatedVisitId: source.generatedVisitId,
      visitDate: source.generatedVisit.visitDate.toISOString().slice(0, 10),
      customerName: source.generatedVisit.serviceAgreement.customer.name,
      siteName: source.generatedVisit.serviceAgreement.serviceSite.name,
      branchId: source.generatedVisit.branchId,
      branchCode: source.generatedVisit.branchCode,
      status: AssignmentStatus.PUBLISHED,
      plannedStart: plannedStart.toISOString(),
      plannedEnd: plannedEnd.toISOString(),
      crew: replacement.crew.map((member) => ({
        ...member,
        isPmsSupervisor: pmsById.get(member.employeeId) ?? false,
      })),
      vehicles: replacement.vehicles ?? [],
    };
    await tx.publishedAssignmentRepairItem.create({
      data: {
        repairId,
        sourceAssignmentId: source.id,
        replacementAssignmentId: replacementId,
        generatedVisitId: source.generatedVisitId,
        action: AssignmentRepairAction.REPLACED,
        sourceFingerprint,
        before: toJson(before),
        after: toJson(after),
      },
    });
    await tx.assignmentNotificationOutbox.createMany({
      data: [
        ...source.crewMembers.map((member) => ({
          assignmentId: source.id,
          employeeId: member.employeeId,
          eventType: 'assignment.corrected',
          payload: toJson({
            visitId: source.generatedVisitId,
            replacementAssignmentId: replacementId,
            reason,
          }),
        })),
        ...replacement.crew.map((member) => ({
          assignmentId: replacementId,
          employeeId: member.employeeId,
          eventType: 'assignment.published',
          payload: toJson({
            visitId: source.generatedVisitId,
            plannedStart: plannedStart.toISOString(),
            plannedEnd: plannedEnd.toISOString(),
            role: member.role,
            repairId,
          }),
        })),
      ],
      skipDuplicates: true,
    });
    await this.audit.record(
      {
        entityType: 'Assignment',
        entityId: source.id,
        action: 'assignment.repair_replaced',
        actor,
        before,
        after: { reason, repairId, replacement: after },
        correlationId: repairId,
      },
      tx,
    );
  }

  private async withdraw(
    tx: Prisma.TransactionClient,
    repairId: string,
    source: SourceAssignment,
    operation: PublishedAssignmentRepairOperation,
    sourceFingerprint: string,
    before: Record<string, unknown>,
    actor: AuthenticatedUser,
    reason: string,
  ): Promise<void> {
    const reasons = operation.unassignedReasons!;
    await tx.generatedVisit.update({
      where: { id: source.generatedVisitId },
      data: { status: VisitStatus.UNASSIGNED },
    });
    await tx.visitUnassignedReason.deleteMany({
      where: { generatedVisitId: source.generatedVisitId },
    });
    await tx.visitUnassignedReason.createMany({
      data: reasons.map((entry) => ({
        generatedVisitId: source.generatedVisitId,
        code: entry.code,
        message: entry.message,
        details: entry.details ? (toJson(entry.details) as Prisma.InputJsonValue) : undefined,
        scheduleRunId: null,
      })),
    });
    const after = {
      assignmentId: null,
      generatedVisitId: source.generatedVisitId,
      visitDate: source.generatedVisit.visitDate.toISOString().slice(0, 10),
      customerName: source.generatedVisit.serviceAgreement.customer.name,
      siteName: source.generatedVisit.serviceAgreement.serviceSite.name,
      status: VisitStatus.UNASSIGNED,
      reasons,
    };
    await tx.publishedAssignmentRepairItem.create({
      data: {
        repairId,
        sourceAssignmentId: source.id,
        replacementAssignmentId: null,
        generatedVisitId: source.generatedVisitId,
        action: AssignmentRepairAction.WITHDRAWN,
        sourceFingerprint,
        before: toJson(before),
        after: toJson(after),
      },
    });
    await tx.assignmentNotificationOutbox.createMany({
      data: source.crewMembers.map((member) => ({
        assignmentId: source.id,
        employeeId: member.employeeId,
        eventType: 'assignment.withdrawn',
        payload: toJson({
          visitId: source.generatedVisitId,
          reason,
          repairId,
        }),
      })),
      skipDuplicates: true,
    });
    await this.audit.record(
      {
        entityType: 'Assignment',
        entityId: source.id,
        action: 'assignment.repair_withdrawn',
        actor,
        before,
        after: { reason, repairId, withdrawal: after },
        correlationId: repairId,
      },
      tx,
    );
  }

  private replayOrReject(
    existing: { requestHash: string; result: Prisma.JsonValue },
    requestHash: string,
  ): PublishedAssignmentRepairResult {
    if (existing.requestHash !== requestHash) {
      throw new AppException(
        'RESOURCE_CONFLICT',
        'This idempotency key was already used for a different repair request.',
        HttpStatus.CONFLICT,
      );
    }
    return existing.result as unknown as PublishedAssignmentRepairResult;
  }
}

function normalizeOperations(
  operations: PublishedAssignmentRepairOperation[],
): PublishedAssignmentRepairOperation[] {
  return [...(operations ?? [])]
    .map((operation) => ({
      sourceAssignmentId: operation.sourceAssignmentId,
      action: operation.action,
      ...(operation.action === AssignmentRepairAction.REPLACED
        ? {
            replacement: operation.replacement
              ? {
                  plannedStartMinute: operation.replacement.plannedStartMinute,
                  plannedEndMinute: operation.replacement.plannedEndMinute,
                  crew: [...operation.replacement.crew]
                    .map((member) => ({
                      employeeId: member.employeeId,
                      role: member.role ?? CrewRole.TECHNICIAN,
                    }))
                    .sort((left, right) => left.employeeId.localeCompare(right.employeeId)),
                  vehicles: [...(operation.replacement.vehicles ?? [])]
                    .map((entry) => ({
                      vehicleId: entry.vehicleId,
                      driverEmployeeId: entry.driverEmployeeId ?? null,
                    }))
                    .sort((left, right) => left.vehicleId.localeCompare(right.vehicleId)),
                }
              : undefined,
          }
        : {
            unassignedReasons: [...(operation.unassignedReasons ?? [])].sort((left, right) =>
              `${left.code}:${left.message}`.localeCompare(`${right.code}:${right.message}`),
            ),
          }),
    }))
    .sort((left, right) => left.sourceAssignmentId.localeCompare(right.sourceAssignmentId));
}

function proposalFromSource(source: SourceAssignment): AssignmentProposal {
  const visitStart = source.generatedVisit.visitDate.getTime();
  return {
    plannedStartMinute: Math.round((source.plannedStart.getTime() - visitStart) / 60_000),
    plannedEndMinute: Math.round((source.plannedEnd.getTime() - visitStart) / 60_000),
    crew: source.crewMembers.map((member) => ({
      employeeId: member.employeeId,
      role: member.role,
    })),
    vehicles: source.vehicles.map((entry) => ({
      vehicleId: entry.vehicleId,
      driverEmployeeId: entry.driverEmployeeId,
    })),
  };
}

function snapshotSource(source: SourceAssignment): Record<string, unknown> {
  return {
    assignmentId: source.id,
    generatedVisitId: source.generatedVisitId,
    visitDate: source.generatedVisit.visitDate.toISOString().slice(0, 10),
    customerName: source.generatedVisit.serviceAgreement.customer.name,
    siteName: source.generatedVisit.serviceAgreement.serviceSite.name,
    branchId: source.branchId,
    branchCode: source.branchCode,
    status: source.status,
    plannedStart: source.plannedStart.toISOString(),
    plannedEnd: source.plannedEnd.toISOString(),
    scheduleRunId: source.scheduleRunId,
    publishedAt: source.publishedAt?.toISOString() ?? null,
    acknowledgedAt: source.acknowledgedAt?.toISOString() ?? null,
    startedAt: source.startedAt?.toISOString() ?? null,
    completedAt: source.completedAt?.toISOString() ?? null,
    crew: source.crewMembers
      .map((member) => ({
        employeeId: member.employeeId,
        fullName: member.employee.fullName,
        role: member.role,
        isPmsSupervisor: member.isPmsSupervisor,
      }))
      .sort((left, right) => left.employeeId.localeCompare(right.employeeId)),
    vehicles: source.vehicles
      .map((entry) => ({
        vehicleId: entry.vehicleId,
        label: entry.vehicle.label,
        driverEmployeeId: entry.driverEmployeeId,
      }))
      .sort((left, right) => left.vehicleId.localeCompare(right.vehicleId)),
    locks: source.locks
      .map((lock) => ({
        assignmentId: lock.assignmentId,
        scope: lock.scope,
        reason: lock.reason,
      }))
      .sort((left, right) => left.scope.localeCompare(right.scope)),
  };
}

function fingerprintSource(source: SourceAssignment): string {
  return hashCanonical({
    ...snapshotSource(source),
    assignmentUpdatedAt: source.updatedAt.toISOString(),
    visitStatus: source.generatedVisit.status,
    visitUpdatedAt: source.generatedVisit.updatedAt.toISOString(),
  });
}

function atMinute(date: Date, minute: number): Date {
  return new Date(date.getTime() + minute * 60_000);
}

function absoluteWindowsOverlap(
  leftDate: Date,
  left: RepairReplacementInput,
  rightDate: Date,
  right: RepairReplacementInput,
): boolean {
  const leftStart = atMinute(leftDate, left.plannedStartMinute).getTime();
  const leftEnd = atMinute(leftDate, left.plannedEndMinute).getTime();
  const rightStart = atMinute(rightDate, right.plannedStartMinute).getTime();
  const rightEnd = atMinute(rightDate, right.plannedEndMinute).getTime();
  return leftStart < rightEnd && rightStart < leftEnd;
}

function intersection(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return [...new Set(left.filter((value) => rightSet.has(value)))].sort();
}

function hashCanonical(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function validationFailed(message: string): AppException {
  return new AppException('VALIDATION_FAILED', message, HttpStatus.UNPROCESSABLE_ENTITY);
}

function sourceChanged(assignmentId: string): AppException {
  return new AppException(
    'RESOURCE_CONFLICT',
    'A published assignment changed while the repair was being applied. Nothing was repaired; refresh and preview again.',
    HttpStatus.CONFLICT,
    { assignmentId },
  );
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function repairTimeScope(visitDate: Date, now: Date = new Date()): RepairTimeScope {
  const visit = visitDate.toISOString().slice(0, 10);
  const today = colomboDate(now);
  if (visit < today) return 'HISTORICAL';
  if (visit === today) return 'CURRENT_DAY';
  return 'FUTURE';
}

function colomboDate(moment: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Colombo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(moment);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

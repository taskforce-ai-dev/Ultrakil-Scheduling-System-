import { Injectable } from '@nestjs/common';
import {
  AssignmentStatus,
  DataProvenance,
  Prisma,
  SiteBranchConfidence,
  SiteBranchSource,
  VisitStatus,
} from '@prisma/client';

import { parseDateOnly, toDateOnly } from '../../catalog/schedule-preview';
import { PrismaService } from '../../prisma/prisma.service';
import { ConflictDto } from '../eligibility/dto';
import { EligibilityService } from '../eligibility/eligibility.service';
import {
  MAX_PUBLISHED_ASSIGNMENT_LINEAGE_ENTRIES,
  OperationsAssignmentSnapshotDto,
  OperationsDayItemDto,
  OperationsDayQueryDto,
  OperationsDayResponseDto,
  OperationsPublishedAssignmentLineageDto,
  OperationsPublishedAssignmentProvenance,
  OperationsWarningDto,
} from './dto';

const DISPATCH_STATUSES: AssignmentStatus[] = [AssignmentStatus.PUBLISHED, AssignmentStatus.ACKNOWLEDGED, AssignmentStatus.IN_PROGRESS, AssignmentStatus.COMPLETED];
const PROPOSED_STATUSES: AssignmentStatus[] = [AssignmentStatus.DRAFT, AssignmentStatus.PROPOSED];
const LIVE_STATUSES = [...DISPATCH_STATUSES, ...PROPOSED_STATUSES];
/**
 * Published history for one visit: the live published work plus every version
 * it has already retired. Draft/proposed rows are never published history.
 */
const PUBLISHED_LINEAGE_STATUSES: AssignmentStatus[] = [...DISPATCH_STATUSES, AssignmentStatus.SUPERSEDED];

/**
 * Lineage needs scalars only. Selecting crew and vehicle rows for superseded
 * versions would multiply the day payload for information no one reads there.
 */
const PUBLISHED_LINEAGE_SELECT = {
  id: true,
  generatedVisitId: true,
  status: true,
  supersedesAssignmentId: true,
  publishedByRepairId: true,
  scheduleRunId: true,
  publishedAt: true,
  updatedAt: true,
} satisfies Prisma.AssignmentSelect;

type PublishedLineageRow = Prisma.AssignmentGetPayload<{ select: typeof PUBLISHED_LINEAGE_SELECT }>;

const OPERATIONS_INCLUDE = {
  serviceAgreement: { include: {
    customer: { select: { name: true } },
    serviceSite: { select: { name: true, branchConfidence: true, branchSource: true } },
    jobType: { select: { name: true } },
  } },
  unassignedReasons: { orderBy: { code: 'asc' } },
  assignments: { where: { status: { in: LIVE_STATUSES } }, include: {
    crewMembers: { include: { employee: { select: { fullName: true } } } },
    vehicles: { include: {
      vehicle: { select: { label: true, branchId: true } },
      driverEmployee: { select: { fullName: true } },
    } },
  } },
} satisfies Prisma.GeneratedVisitInclude;

type VisitRow = Prisma.GeneratedVisitGetPayload<{ include: typeof OPERATIONS_INCLUDE }>;

@Injectable()
export class OperationsService {
  constructor(private readonly prisma: PrismaService, private readonly eligibility: EligibilityService) {}

  async day(query: OperationsDayQueryDto): Promise<OperationsDayResponseDto> {
    const date = parseDateOnly(query.date);
    const visits = await this.prisma.generatedVisit.findMany({
      where: { visitDate: date, ...(query.branchCode ? { branchCode: query.branchCode } : {}) },
      include: OPERATIONS_INCLUDE,
      orderBy: [{ windowStartMinute: 'asc' }, { id: 'asc' }],
    });
    const lineageByVisit = await this.publishedLineageRows(visits.map((visit) => visit.id));
    const items = await Promise.all(
      visits.map((visit) => this.toItem(visit, lineageByVisit.get(visit.id) ?? [])),
    );
    return {
      date: query.date,
      branchCode: query.branchCode ?? null,
      summary: {
        total: items.length,
        ready: countState(items, 'READY'),
        proposed: countState(items, 'PROPOSED'),
        unassigned: countState(items, 'UNASSIGNED'),
        exceptions: countState(items, 'EXCEPTION'),
        hoursUnconfirmed: items.filter((item) => item.visit.hoursUnconfirmed).length,
      },
      items,
    };
  }

  /**
   * One batched query for the whole day, never one per visit. Ordering is done
   * in SQL so the in-memory chain walk starts from a deterministic sequence.
   */
  private async publishedLineageRows(visitIds: string[]): Promise<Map<string, PublishedLineageRow[]>> {
    const grouped = new Map<string, PublishedLineageRow[]>();
    if (visitIds.length === 0) return grouped;
    const rows = await this.prisma.assignment.findMany({
      where: { generatedVisitId: { in: visitIds }, status: { in: PUBLISHED_LINEAGE_STATUSES } },
      select: PUBLISHED_LINEAGE_SELECT,
      orderBy: [{ publishedAt: 'asc' }, { updatedAt: 'asc' }, { id: 'asc' }],
    });
    for (const row of rows) {
      const bucket = grouped.get(row.generatedVisitId);
      if (bucket) bucket.push(row);
      else grouped.set(row.generatedVisitId, [row]);
    }
    return grouped;
  }

  private async toItem(visit: VisitRow, lineageRows: PublishedLineageRow[]): Promise<OperationsDayItemDto> {
    const dispatches = visit.assignments.filter((row) => DISPATCH_STATUSES.includes(row.status));
    const proposals = visit.assignments.filter((row) => PROPOSED_STATUSES.includes(row.status));
    const dispatch = selectDispatch(dispatches);
    const proposed = selectNewest(proposals);
    const violations = dispatch ? await this.violations(visit, dispatch) : storedViolations(visit);
    if (dispatches.length > 1 || proposals.length > 1) {
      violations.push({ code: 'MULTIPLE_LIVE_ASSIGNMENTS', message: 'More than one live assignment exists for this visit.', remediation: 'Keep the published assignment as dispatch truth and resolve the competing proposal.', resources: resources({ visitId: visit.id }) });
    }
    violations.sort((a, b) => a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
    const operationWarnings = warnings(visit, dispatch, proposed);
    const state = operationState(visit.status, dispatch, proposed, violations);
    const lineage = dispatch ?? proposed;
    return {
      visit: {
        id: visit.id,
        visitDate: toDateOnly(visit.visitDate),
        branchCode: visit.branchCode,
        customerName: visit.serviceAgreement.customer.name,
        siteName: visit.serviceAgreement.serviceSite.name,
        jobTypeName: visit.serviceAgreement.jobType.name,
        requiredCrewSize: visit.requiredCrewSize,
        durationMinutes: visit.durationMinutes,
        windowStartMinute: visit.windowStartMinute,
        windowEndMinute: visit.windowEndMinute,
        hoursUnconfirmed: operationWarnings.some((warning) => warning.code === 'HOURS_UNCONFIRMED'),
      },
      state,
      dispatchAssignment: dispatch ? snapshot(dispatch, visit) : null,
      proposedAssignment: proposed ? snapshot(proposed, visit) : null,
      violations,
      warnings: operationWarnings,
      nextAction: nextAction(state, violations),
      publishedAssignmentLineage: publishedAssignmentLineage(lineageRows, dispatch?.id ?? null),
      scheduleVersion: lineage
        ? {
            id: lineage.scheduleRunId,
            status: lineage.status,
            publishedAt: lineage.publishedAt?.toISOString() ?? null,
          }
        : null,
    };
  }

  private async violations(visit: VisitRow, assignment: VisitRow['assignments'][number]): Promise<ConflictDto[]> {
    const result = await this.eligibility.evaluate(visit.id, {
      plannedStartMinute: Math.round((assignment.plannedStart.getTime() - visit.visitDate.getTime()) / 60_000),
      plannedEndMinute: Math.round((assignment.plannedEnd.getTime() - visit.visitDate.getTime()) / 60_000),
      crew: assignment.crewMembers.map((member) => ({ employeeId: member.employeeId, role: member.role })),
      vehicles: assignment.vehicles.map((vehicle) => ({ vehicleId: vehicle.vehicleId, driverEmployeeId: vehicle.driverEmployeeId })),
    }, { excludeAssignmentId: assignment.id });
    return result.conflicts.map((conflict) => ({ ...conflict, resources: resources(conflict.resources) }));
  }
}

/**
 * Order the published versions predecessor -> successor by following
 * `supersedesAssignmentId`. A broken chain (a predecessor that was never
 * published, or that belongs to another visit) simply starts a new run rather
 * than dropping its rows, and a cycle terminates on the visited set.
 */
function publishedAssignmentLineage(
  rows: PublishedLineageRow[],
  currentAssignmentId: string | null,
): OperationsPublishedAssignmentLineageDto {
  const published = [...rows].sort(comparePublishedAssignment);
  const byId = new Map(published.map((row) => [row.id, row]));
  const successorByPredecessor = new Map<string, PublishedLineageRow>();
  for (const row of published) {
    const predecessorId = row.supersedesAssignmentId;
    // `supersedesAssignmentId` is unique in the database, so a second claimant
    // means corrupted data. Keep the deterministically earlier one and let the
    // loser start its own run instead of silently disappearing.
    if (predecessorId && byId.has(predecessorId) && !successorByPredecessor.has(predecessorId)) {
      successorByPredecessor.set(predecessorId, row);
    }
  }

  const ordered: PublishedLineageRow[] = [];
  const seen = new Set<string>();
  const appendChain = (first: PublishedLineageRow): void => {
    let current: PublishedLineageRow | undefined = first;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      ordered.push(current);
      current = successorByPredecessor.get(current.id);
    }
  };

  for (const row of published) {
    const predecessorId = row.supersedesAssignmentId;
    if (!predecessorId || !byId.has(predecessorId)) appendChain(row);
  }
  // Anything left is only reachable from inside a cycle; emit it rather than
  // dropping rows from an audit trail.
  for (const row of published) if (!seen.has(row.id)) appendChain(row);

  const totalCount = ordered.length;
  const omittedCount = Math.max(0, totalCount - MAX_PUBLISHED_ASSIGNMENT_LINEAGE_ENTRIES);
  // Truncate the oldest versions: a manager reads the story backwards from the
  // version that is current now.
  const visible = omittedCount > 0 ? ordered.slice(omittedCount) : ordered;
  const entries = visible.map((row) => ({
    assignmentId: row.id,
    status: row.status,
    supersedesAssignmentId: row.supersedesAssignmentId,
    supersededByAssignmentId: successorByPredecessor.get(row.id)?.id ?? null,
    publishedByRepairId: row.publishedByRepairId,
    provenance: provenanceOf(row),
    publishedAt: row.publishedAt?.toISOString() ?? null,
    isCurrent: currentAssignmentId !== null && row.id === currentAssignmentId,
  }));

  return {
    entries,
    totalCount,
    truncated: omittedCount > 0,
    omittedCount,
    currentAssignmentId: entries.some((entry) => entry.isCurrent) ? currentAssignmentId : null,
    withdrawn: totalCount > 0 && currentAssignmentId === null,
    hasMixedProvenance: new Set(entries.map((entry) => entry.provenance)).size > 1,
  };
}

function provenanceOf(row: PublishedLineageRow): OperationsPublishedAssignmentProvenance {
  if (row.publishedByRepairId) return 'REPAIR';
  return row.scheduleRunId ? 'SCHEDULE_RUN' : 'MANUAL_PUBLISH';
}

function comparePublishedAssignment(a: PublishedLineageRow, b: PublishedLineageRow): number {
  return (a.publishedAt?.getTime() ?? 0) - (b.publishedAt?.getTime() ?? 0)
    || a.updatedAt.getTime() - b.updatedAt.getTime()
    || a.id.localeCompare(b.id);
}

function selectDispatch<T extends { publishedAt: Date | null; updatedAt: Date; id: string }>(rows: T[]): T | null {
  return [...rows].sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0) || b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id))[0] ?? null;
}
function selectNewest<T extends { updatedAt: Date; id: string }>(rows: T[]): T | null {
  return [...rows].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id))[0] ?? null;
}
function snapshot(row: VisitRow['assignments'][number], visit: VisitRow): OperationsAssignmentSnapshotDto {
  return {
    id: row.id, status: row.status,
    plannedStartMinute: Math.round((row.plannedStart.getTime() - visit.visitDate.getTime()) / 60_000),
    plannedEndMinute: Math.round((row.plannedEnd.getTime() - visit.visitDate.getTime()) / 60_000),
    crew: row.crewMembers.map((member) => ({ employeeId: member.employeeId, fullName: member.employee.fullName, role: member.role, isPmsSupervisor: member.isPmsSupervisor })).sort((a, b) => a.fullName.localeCompare(b.fullName) || a.employeeId.localeCompare(b.employeeId)),
    vehicles: row.vehicles.map((vehicle) => ({ vehicleId: vehicle.vehicleId, label: vehicle.vehicle.label, driverEmployeeId: vehicle.driverEmployeeId, driverName: vehicle.driverEmployee?.fullName ?? null })).sort((a, b) => a.label.localeCompare(b.label) || a.vehicleId.localeCompare(b.vehicleId)),
  };
}
function storedViolations(visit: VisitRow): ConflictDto[] {
  return visit.unassignedReasons.map((reason): ConflictDto => {
    const details = (reason.details ?? {}) as { remediation?: string; resources?: Record<string, string[]> };
    return { code: reason.code, message: reason.message, remediation: details.remediation ?? 'Resolve the reported conflict before dispatching.', resources: resources(details.resources) };
  });
}
function warnings(
  visit: VisitRow,
  dispatch: VisitRow['assignments'][number] | null,
  proposed: VisitRow['assignments'][number] | null,
): OperationsWarningDto[] {
  const result: OperationsWarningDto[] = [];
  const agreement = visit.serviceAgreement;

  if (
    visit.windowProvenance === DataProvenance.DEFAULTED
    || visit.windowProvenance === DataProvenance.UNKNOWN
  ) {
    result.push({
      code: 'HOURS_UNCONFIRMED',
      message: 'Opening hours for this visit are not confirmed: either the recorded hours are unconfirmed, or the visible 08:00–17:00 fallback is in use.',
    });
  }
  if (
    agreement.serviceSite.branchConfidence !== SiteBranchConfidence.CONFIRMED
    || agreement.serviceSite.branchSource !== SiteBranchSource.MANAGER_CONFIRMED
  ) {
    result.push({
      code: 'SITE_BRANCH_UNCONFIRMED',
      message: 'The service site branch is inferred from source data and needs manager confirmation.',
    });
  }
  if (agreement.crewSizeProvenance === DataProvenance.DEFAULTED) {
    result.push({
      code: 'CREW_SIZE_DEFAULTED',
      message: 'Crew size was defaulted because the source did not state one.',
    });
  }
  if (agreement.durationProvenance === DataProvenance.DEFAULTED) {
    result.push({
      code: 'DURATION_DEFAULTED',
      message: 'Visit duration was defaulted because the source did not state one.',
    });
  }
  if (agreement.dayRuleProvenance === DataProvenance.DERIVED) {
    result.push({
      code: 'DAY_RULE_DERIVED',
      message: 'Allowed service days were derived from historical bookings and need confirmation.',
    });
  } else if (
    agreement.dayRuleProvenance === DataProvenance.UNKNOWN
    || agreement.dayRuleProvenance === DataProvenance.DEFAULTED
  ) {
    result.push({
      code: 'DAY_RULE_UNCONFIRMED',
      message: 'The source of the allowed service days is not confirmed.',
    });
  }
  if ([dispatch, proposed].some((row) => row?.vehicles.some(({ vehicle }) => vehicle.branchId === null))) {
    result.push({
      code: 'VEHICLE_BRANCH_UNCONFIRMED',
      message: 'An assigned vehicle has no confirmed branch.',
    });
  }

  return result.sort((a, b) => a.code.localeCompare(b.code));
}

function countState(items: OperationsDayItemDto[], state: OperationsDayItemDto['state']): number {
  return items.filter((item) => item.state === state).length;
}
function resources(raw: object | undefined = {}): ConflictDto['resources'] {
  const value = raw as Record<string, unknown>;
  return {
    visitId: typeof value.visitId === 'string' ? value.visitId : null,
    employeeIds: Array.isArray(value.employeeIds) ? value.employeeIds.filter((id): id is string => typeof id === 'string') : [],
    vehicleIds: Array.isArray(value.vehicleIds) ? value.vehicleIds.filter((id): id is string => typeof id === 'string') : [],
    serviceSiteId: typeof value.serviceSiteId === 'string' ? value.serviceSiteId : null,
    skillCodes: Array.isArray(value.skillCodes) ? value.skillCodes.filter((id): id is string => typeof id === 'string') : [],
    assignmentIds: Array.isArray(value.assignmentIds) ? value.assignmentIds.filter((id): id is string => typeof id === 'string') : [],
  };
}
function operationState(status: VisitStatus, dispatch: unknown, proposed: unknown, violations: ConflictDto[]): OperationsDayItemDto['state'] {
  if (status === VisitStatus.CANCELLED) return 'CANCELLED';
  if (status === VisitStatus.COMPLETED) return 'COMPLETED';
  if (violations.some((violation) => violation.code === 'MULTIPLE_LIVE_ASSIGNMENTS')) return 'EXCEPTION';
  if (dispatch) return violations.length === 0 ? 'READY' : 'EXCEPTION';
  return proposed ? 'PROPOSED' : 'UNASSIGNED';
}
function nextAction(state: OperationsDayItemDto['state'], violations: ConflictDto[]): string {
  if (state === 'READY') return 'Dispatch the published assignment.';
  if (state === 'PROPOSED') return 'Review and publish the proposed assignment.';
  if (state === 'UNASSIGNED') return violations[0] ? `Resolve ${violations[0].code.toLowerCase().replaceAll('_', ' ')} before assigning a crew.` : 'Assign an eligible crew.';
  if (state === 'EXCEPTION') return `Resolve ${violations[0]?.code.toLowerCase().replaceAll('_', ' ') ?? 'the reported exception'} before dispatching.`;
  return 'No dispatch action is required.';
}

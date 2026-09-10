import { Injectable } from '@nestjs/common';
import { AssignmentStatus, Prisma, VisitStatus } from '@prisma/client';

import { parseDateOnly, toDateOnly } from '../../catalog/schedule-preview';
import { PrismaService } from '../../prisma/prisma.service';
import { ConflictDto } from '../eligibility/dto';
import { EligibilityService } from '../eligibility/eligibility.service';
import { OperationsAssignmentSnapshotDto, OperationsDayItemDto, OperationsDayQueryDto, OperationsDayResponseDto, OperationsWarningDto } from './dto';

const DISPATCH_STATUSES: AssignmentStatus[] = [AssignmentStatus.PUBLISHED, AssignmentStatus.ACKNOWLEDGED, AssignmentStatus.IN_PROGRESS, AssignmentStatus.COMPLETED];
const PROPOSED_STATUSES: AssignmentStatus[] = [AssignmentStatus.DRAFT, AssignmentStatus.PROPOSED];
const LIVE_STATUSES = [...DISPATCH_STATUSES, ...PROPOSED_STATUSES];

const OPERATIONS_INCLUDE = {
  serviceAgreement: { include: {
    customer: { select: { name: true } },
    serviceSite: { select: { name: true, _count: { select: { operatingHours: true } } } },
    jobType: { select: { name: true } },
  } },
  unassignedReasons: { orderBy: { code: 'asc' } },
  assignments: { where: { status: { in: LIVE_STATUSES } }, include: {
    crewMembers: { include: { employee: { select: { fullName: true } } } },
    vehicles: { include: {
      vehicle: { select: { label: true } },
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
    const items = await Promise.all(visits.map((visit) => this.toItem(visit)));
    return { items, total: items.length };
  }

  private async toItem(visit: VisitRow): Promise<OperationsDayItemDto> {
    const dispatches = visit.assignments.filter((row) => DISPATCH_STATUSES.includes(row.status));
    const proposals = visit.assignments.filter((row) => PROPOSED_STATUSES.includes(row.status));
    const dispatch = selectDispatch(dispatches);
    const proposed = selectNewest(proposals);
    const violations = dispatch ? await this.violations(visit, dispatch) : storedViolations(visit);
    if (dispatches.length > 1 || proposals.length > 1) {
      violations.push({ code: 'MULTIPLE_LIVE_ASSIGNMENTS', message: 'More than one live assignment exists for this visit.', remediation: 'Keep the published assignment as dispatch truth and resolve the competing proposal.', resources: resources({ visitId: visit.id }) });
    }
    violations.sort((a, b) => a.code.localeCompare(b.code) || a.message.localeCompare(b.message));
    const sourceWarnings = warnings(visit, dispatch ?? proposed);
    const state = operationState(visit.status, dispatch, proposed, violations);
    return {
      visitId: visit.id,
      visitDate: toDateOnly(visit.visitDate),
      branchCode: visit.branchCode,
      customerName: visit.serviceAgreement.customer.name,
      siteName: visit.serviceAgreement.serviceSite.name,
      jobTypeName: visit.serviceAgreement.jobType.name,
      state,
      dispatch: dispatch ? snapshot(dispatch, visit) : null,
      proposed: proposed ? snapshot(proposed, visit) : null,
      violations,
      sourceWarnings,
      nextAction: nextAction(state, violations),
      scheduleVersion: { scheduleRunId: dispatch?.scheduleRunId ?? null, publishedAt: dispatch?.publishedAt?.toISOString() ?? null },
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

function selectDispatch<T extends { publishedAt: Date | null; updatedAt: Date; id: string }>(rows: T[]): T | null {
  return [...rows].sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0) || b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id))[0] ?? null;
}
function selectNewest<T extends { updatedAt: Date; id: string }>(rows: T[]): T | null {
  return [...rows].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id))[0] ?? null;
}
function snapshot(row: VisitRow['assignments'][number], visit: VisitRow): OperationsAssignmentSnapshotDto {
  return {
    assignmentId: row.id, status: row.status,
    plannedStartMinute: Math.round((row.plannedStart.getTime() - visit.visitDate.getTime()) / 60_000),
    plannedEndMinute: Math.round((row.plannedEnd.getTime() - visit.visitDate.getTime()) / 60_000),
    crew: row.crewMembers.map((member) => ({ employeeId: member.employeeId, fullName: member.employee.fullName, role: member.role, isPmsSupervisor: member.isPmsSupervisor })).sort((a, b) => a.fullName.localeCompare(b.fullName) || a.employeeId.localeCompare(b.employeeId)),
    vehicles: row.vehicles.map((vehicle) => ({ vehicleId: vehicle.vehicleId, label: vehicle.vehicle.label, driverEmployeeId: vehicle.driverEmployeeId, driverName: vehicle.driverEmployee?.fullName ?? null })).sort((a, b) => a.label.localeCompare(b.label) || a.vehicleId.localeCompare(b.vehicleId)),
    scheduleRunId: row.scheduleRunId, publishedAt: row.publishedAt?.toISOString() ?? null,
  };
}
function storedViolations(visit: VisitRow): ConflictDto[] {
  return visit.unassignedReasons.map((reason): ConflictDto => {
    const details = (reason.details ?? {}) as { remediation?: string; resources?: Record<string, string[]> };
    return { code: reason.code, message: reason.message, remediation: details.remediation ?? 'Resolve the reported conflict before dispatching.', resources: resources(details.resources) };
  });
}
function warnings(visit: VisitRow, row: VisitRow['assignments'][number] | null): OperationsWarningDto[] {
  const warnings: OperationsWarningDto[] = [];
  if (visit.serviceAgreement.serviceSite._count.operatingHours === 0) warnings.push({ code: 'HOURS_UNCONFIRMED', message: 'No source opening hours are recorded; the visible 08:00–17:00 assumption remains unconfirmed.' });
  if (row?.vehicles.length) warnings.push({ code: 'VEHICLE_BRANCH_UNCONFIRMED', message: 'Vehicle branch provenance is not available in the current data model and remains unconfirmed.' });
  return warnings;
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

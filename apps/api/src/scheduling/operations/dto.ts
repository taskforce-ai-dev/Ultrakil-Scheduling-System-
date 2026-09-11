import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AssignmentStatus, BranchCode } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { IsDateOnly } from '../../common/validation/is-date-only';
import { ConflictDto } from '../eligibility/dto';

export const OPERATION_WARNING_CODES = [
  'CREW_SIZE_DEFAULTED',
  'DAY_RULE_DERIVED',
  'DAY_RULE_UNCONFIRMED',
  'DURATION_DEFAULTED',
  'HOURS_UNCONFIRMED',
  'SITE_BRANCH_UNCONFIRMED',
  'VEHICLE_BRANCH_UNCONFIRMED',
] as const;

export type OperationWarningCode = (typeof OPERATION_WARNING_CODES)[number];

/**
 * Where a published assignment version came from. A repair successor is an
 * audited correction of published history; an ordinary schedule run is not.
 */
export const OPERATION_PUBLISHED_ASSIGNMENT_PROVENANCE = [
  'SCHEDULE_RUN',
  'REPAIR',
  'MANUAL_PUBLISH',
] as const;

export type OperationsPublishedAssignmentProvenance =
  (typeof OPERATION_PUBLISHED_ASSIGNMENT_PROVENANCE)[number];

/**
 * The most recent published versions returned for one visit. A visit with a
 * pathological correction history must not be able to balloon the day payload,
 * so the chain is truncated from the oldest end and the truncation is reported.
 */
export const MAX_PUBLISHED_ASSIGNMENT_LINEAGE_ENTRIES = 10;

export class OperationsDayQueryDto {
  @ApiProperty({ format: 'date', description: 'The Colombo calendar date to inspect.' })
  @IsDateOnly()
  date!: string;

  @ApiPropertyOptional({ enum: BranchCode })
  @IsOptional()
  @IsEnum(BranchCode)
  branchCode?: BranchCode;
}

export class OperationsCrewMemberDto {
  @ApiProperty({ type: String, format: 'uuid' }) employeeId!: string;
  @ApiProperty({ type: String }) fullName!: string;
  @ApiProperty({ type: String }) role!: string;
  @ApiProperty({ type: Boolean }) isPmsSupervisor!: boolean;
}

export class OperationsVehicleDto {
  @ApiProperty({ type: String, format: 'uuid' }) vehicleId!: string;
  @ApiProperty({ type: String }) label!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) driverEmployeeId!: string | null;
  @ApiProperty({ type: String, nullable: true }) driverName!: string | null;
}

export class OperationsAssignmentSnapshotDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ enum: AssignmentStatus }) status!: AssignmentStatus;
  @ApiProperty({ type: Number }) plannedStartMinute!: number;
  @ApiProperty({ type: Number }) plannedEndMinute!: number;
  @ApiProperty({ type: [OperationsCrewMemberDto] }) crew!: OperationsCrewMemberDto[];
  @ApiProperty({ type: [OperationsVehicleDto] }) vehicles!: OperationsVehicleDto[];
}

export class OperationsWarningDto {
  @ApiProperty({ enum: OPERATION_WARNING_CODES })
  code!: OperationWarningCode;

  @ApiProperty({ type: String })
  message!: string;
}

export class OperationsScheduleVersionDto {
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) id!: string | null;
  @ApiProperty({ enum: AssignmentStatus }) status!: AssignmentStatus;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) publishedAt!: string | null;
}

export class OperationsPublishedAssignmentLineageEntryDto {
  @ApiProperty({ type: String, format: 'uuid', description: 'Immutable identity of this published assignment version.' })
  assignmentId!: string;

  @ApiProperty({ enum: AssignmentStatus, description: 'Published lifecycle status of this version. SUPERSEDED means it is history, never dispatch truth.' })
  status!: AssignmentStatus;

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The published predecessor this version supersedes, when it is a correction.' })
  supersedesAssignmentId!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The published successor that superseded this version, when one exists in the returned chain.' })
  supersededByAssignmentId!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The audited repair transaction that published this version, when it came from one.' })
  publishedByRepairId!: string | null;

  @ApiProperty({ enum: OPERATION_PUBLISHED_ASSIGNMENT_PROVENANCE, description: 'Whether this version came from an ordinary schedule run, an audited repair, or a manual publish.' })
  provenance!: OperationsPublishedAssignmentProvenance;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  publishedAt!: string | null;

  @ApiProperty({ type: Boolean, description: 'Whether this version is the assignment the read model treats as current dispatch truth.' })
  isCurrent!: boolean;
}

export class OperationsPublishedAssignmentLineageDto {
  @ApiProperty({
    type: [OperationsPublishedAssignmentLineageEntryDto],
    description: 'Published assignment versions for this visit, ordered predecessor to successor. Draft and proposed assignments are deliberately excluded: this is published history, not schedule-run history.',
  })
  entries!: OperationsPublishedAssignmentLineageEntryDto[];

  @ApiProperty({ type: Number, description: 'How many published versions exist for this visit, before any truncation.' })
  totalCount!: number;

  @ApiProperty({ type: Boolean, description: 'Whether older versions were omitted to keep the day payload bounded.' })
  truncated!: boolean;

  @ApiProperty({ type: Number, description: 'How many older versions were omitted. Zero when the chain is complete.' })
  omittedCount!: number;

  @ApiProperty({ type: String, nullable: true, format: 'uuid', description: 'The published version that is current dispatch truth, or null when the published work was withdrawn.' })
  currentAssignmentId!: string | null;

  @ApiProperty({ type: Boolean, description: 'Whether published work existed for this visit and was withdrawn rather than replaced.' })
  withdrawn!: boolean;

  @ApiProperty({ type: Boolean, description: 'Whether the returned chain mixes schedule-run and repair provenance.' })
  hasMixedProvenance!: boolean;
}

export class OperationsVisitDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'date' }) visitDate!: string;
  @ApiProperty({ enum: BranchCode }) branchCode!: BranchCode;
  @ApiProperty({ type: String }) customerName!: string;
  @ApiProperty({ type: String }) siteName!: string;
  @ApiProperty({ type: String }) jobTypeName!: string;
  @ApiProperty({ type: Number }) requiredCrewSize!: number;
  @ApiProperty({ type: Number }) durationMinutes!: number;
  @ApiProperty({ type: Number }) windowStartMinute!: number;
  @ApiProperty({ type: Number }) windowEndMinute!: number;
  @ApiProperty({ type: Boolean }) hoursUnconfirmed!: boolean;
}

export class OperationsDayItemDto {
  @ApiProperty({ type: OperationsVisitDto }) visit!: OperationsVisitDto;
  @ApiProperty({ enum: ['READY', 'PROPOSED', 'UNASSIGNED', 'EXCEPTION', 'COMPLETED', 'CANCELLED'] })
  state!: 'READY' | 'PROPOSED' | 'UNASSIGNED' | 'EXCEPTION' | 'COMPLETED' | 'CANCELLED';
  @ApiProperty({ type: OperationsAssignmentSnapshotDto, nullable: true, description: 'Published dispatch snapshot. An EXCEPTION retains it for inspection but is never dispatchable.' })
  dispatchAssignment!: OperationsAssignmentSnapshotDto | null;
  @ApiProperty({ type: OperationsAssignmentSnapshotDto, nullable: true, description: 'Newest draft/proposed snapshot; never dispatch truth.' })
  proposedAssignment!: OperationsAssignmentSnapshotDto | null;
  @ApiProperty({ type: [ConflictDto] }) violations!: ConflictDto[];
  @ApiProperty({ type: [OperationsWarningDto] }) warnings!: OperationsWarningDto[];
  @ApiProperty({ type: String }) nextAction!: string;
  @ApiProperty({ type: OperationsScheduleVersionDto, nullable: true, description: 'The schedule RUN the current assignment came from. Run history, not per-visit assignment history.' })
  scheduleVersion!: OperationsScheduleVersionDto | null;
  @ApiProperty({ type: OperationsPublishedAssignmentLineageDto, description: 'Per-visit published-assignment lineage. Distinct from scheduleVersion: this is the chain of published assignment versions for this visit.' })
  publishedAssignmentLineage!: OperationsPublishedAssignmentLineageDto;
}

export class OperationsSummaryDto {
  @ApiProperty({ type: Number }) total!: number;
  @ApiProperty({ type: Number }) ready!: number;
  @ApiProperty({ type: Number }) proposed!: number;
  @ApiProperty({ type: Number }) unassigned!: number;
  @ApiProperty({ type: Number }) exceptions!: number;
  @ApiProperty({ type: Number }) hoursUnconfirmed!: number;
}

export class OperationsDayResponseDto {
  @ApiProperty({ type: String, format: 'date' }) date!: string;
  @ApiProperty({ enum: BranchCode, nullable: true }) branchCode!: BranchCode | null;
  @ApiProperty({ type: OperationsSummaryDto }) summary!: OperationsSummaryDto;
  @ApiProperty({ type: [OperationsDayItemDto] }) items!: OperationsDayItemDto[];
}

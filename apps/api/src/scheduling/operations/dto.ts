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
  @ApiProperty({ type: OperationsScheduleVersionDto, nullable: true })
  scheduleVersion!: OperationsScheduleVersionDto | null;
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

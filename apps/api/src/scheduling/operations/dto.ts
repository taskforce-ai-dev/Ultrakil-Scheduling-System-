import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AssignmentStatus, BranchCode } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { IsDateOnly } from '../../common/validation/is-date-only';
import { ConflictDto } from '../eligibility/dto';

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
  @ApiProperty({ type: String, format: 'uuid' }) assignmentId!: string;
  @ApiProperty({ enum: AssignmentStatus }) status!: AssignmentStatus;
  @ApiProperty({ type: Number }) plannedStartMinute!: number;
  @ApiProperty({ type: Number }) plannedEndMinute!: number;
  @ApiProperty({ type: [OperationsCrewMemberDto] }) crew!: OperationsCrewMemberDto[];
  @ApiProperty({ type: [OperationsVehicleDto] }) vehicles!: OperationsVehicleDto[];
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) scheduleRunId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) publishedAt!: string | null;
}

export class OperationsWarningDto {
  @ApiProperty({ enum: ['HOURS_UNCONFIRMED', 'VEHICLE_BRANCH_UNCONFIRMED', 'SOURCE_PROVENANCE_UNKNOWN'] })
  code!: string;
  @ApiProperty({ type: String }) message!: string;
}

export class ScheduleVersionDto {
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) scheduleRunId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) publishedAt!: string | null;
}

export class OperationsDayItemDto {
  @ApiProperty({ type: String, format: 'uuid' }) visitId!: string;
  @ApiProperty({ type: String, format: 'date' }) visitDate!: string;
  @ApiProperty({ enum: BranchCode }) branchCode!: BranchCode;
  @ApiProperty({ type: String }) customerName!: string;
  @ApiProperty({ type: String }) siteName!: string;
  @ApiProperty({ type: String }) jobTypeName!: string;
  @ApiProperty({ enum: ['READY', 'PROPOSED', 'UNASSIGNED', 'EXCEPTION', 'COMPLETED', 'CANCELLED'] })
  state!: 'READY' | 'PROPOSED' | 'UNASSIGNED' | 'EXCEPTION' | 'COMPLETED' | 'CANCELLED';
  @ApiProperty({ type: OperationsAssignmentSnapshotDto, nullable: true, description: 'Published dispatch truth only.' })
  dispatch!: OperationsAssignmentSnapshotDto | null;
  @ApiProperty({ type: OperationsAssignmentSnapshotDto, nullable: true, description: 'Newest draft/proposed snapshot; never dispatch truth.' })
  proposed!: OperationsAssignmentSnapshotDto | null;
  @ApiProperty({ type: [ConflictDto] }) violations!: ConflictDto[];
  @ApiProperty({ type: [OperationsWarningDto] }) sourceWarnings!: OperationsWarningDto[];
  @ApiProperty({ type: String }) nextAction!: string;
  @ApiProperty({ type: ScheduleVersionDto }) scheduleVersion!: ScheduleVersionDto;
}

export class OperationsDayResponseDto {
  @ApiProperty({ type: [OperationsDayItemDto] }) items!: OperationsDayItemDto[];
  @ApiProperty({ type: Number }) total!: number;
}

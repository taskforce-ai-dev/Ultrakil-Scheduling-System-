import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AssignmentStatus, BranchCode, VisitStatus } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional } from 'class-validator';

export class CalendarQueryDto {
  @ApiProperty({ format: 'date', description: 'Visits on or after this date.' })
  @IsDateString()
  from!: string;

  @ApiProperty({ format: 'date', description: 'Visits on or before this date.' })
  @IsDateString()
  to!: string;

  @ApiPropertyOptional({ enum: BranchCode })
  @IsOptional()
  @IsEnum(BranchCode)
  branchCode?: BranchCode;
}

export class CalendarCrewMemberDto {
  @ApiProperty({ type: String, format: 'uuid' }) employeeId!: string;
  @ApiProperty({ type: String }) fullName!: string;
  @ApiProperty({ type: String }) role!: string;
  @ApiProperty({ type: Boolean }) isPmsSupervisor!: boolean;
}

export class CalendarVehicleDto {
  @ApiProperty({ type: String, format: 'uuid' }) vehicleId!: string;
  @ApiProperty({ type: String }) label!: string;
  @ApiProperty({ type: String, nullable: true }) driverName!: string | null;
}

export class CalendarAssignmentDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, enum: Object.values(AssignmentStatus) })
  status!: AssignmentStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'The employee carrying the required PMS-grade supervisor on this crew.',
  })
  supervisorEmployeeId!: string | null;
  @ApiProperty({ type: String, nullable: true }) supervisorName!: string | null;

  @ApiProperty({ type: [CalendarCrewMemberDto] }) crew!: CalendarCrewMemberDto[];
  @ApiProperty({ type: [CalendarVehicleDto] }) vehicles!: CalendarVehicleDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description:
      'The schedule run this assignment came from. Combined with publishedAt this identifies the published schedule version a crew was told about.',
  })
  scheduleRunId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) publishedAt!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description: 'Phase 2 hook. Always null in Phase 1 — no worker app writes this yet.',
  })
  acknowledgedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) startedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) completedAt!: string | null;
}

export class CalendarEntryDto {
  @ApiProperty({ type: String, format: 'uuid' }) visitId!: string;
  @ApiProperty({ type: String, format: 'date' }) visitDate!: string;
  @ApiProperty({ type: Number }) windowStartMinute!: number;
  @ApiProperty({ type: Number }) windowEndMinute!: number;
  @ApiProperty({ type: Number }) durationMinutes!: number;
  @ApiProperty({ type: String, enum: Object.values(VisitStatus) }) visitStatus!: VisitStatus;
  @ApiProperty({ type: String, enum: Object.values(BranchCode) }) branchCode!: BranchCode;

  @ApiProperty({ type: String, format: 'uuid' }) serviceAgreementId!: string;
  @ApiProperty({ type: String }) customerName!: string;
  @ApiProperty({ type: String }) siteName!: string;
  @ApiProperty({ type: String }) jobTypeName!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "What the crew is told to do, from the agreement's notes.",
  })
  instructions!: string | null;

  @ApiProperty({
    type: CalendarAssignmentDto,
    nullable: true,
    description: 'Null when the visit has no crew yet — it belongs in the Unassigned queue.',
  })
  assignment!: CalendarAssignmentDto | null;
}

export class CalendarResponseDto {
  @ApiProperty({ type: [CalendarEntryDto] }) items!: CalendarEntryDto[];
  @ApiProperty({ type: Number }) total!: number;
}

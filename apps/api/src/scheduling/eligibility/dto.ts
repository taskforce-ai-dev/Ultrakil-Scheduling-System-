import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AssignmentStatus, CrewRole } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { IsDateOnly } from '../../common/validation/is-date-only';
import { toBoolean } from '../../common/validation/to-boolean';
import { CONFLICT_CODES } from './conflict-codes';
import {
  CONFLICT_GROUPS,
  ConflictGroup,
  UNASSIGNED_OPERATION_STATES,
  UnassignedOperationState,
} from './conflict-groups';

export class ProposedCrewMemberDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  employeeId!: string;

  @ApiPropertyOptional({ enum: CrewRole, default: CrewRole.TECHNICIAN })
  @IsOptional()
  @IsEnum(CrewRole)
  role?: CrewRole;
}

export class ProposedVehicleDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  vehicleId!: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'Who will drive. Must be in the crew and authorized for this vehicle.',
  })
  @IsOptional()
  @IsUUID()
  driverEmployeeId?: string;
}

export class AssignCrewDto {
  @ApiProperty({ type: Number, minimum: 0, maximum: 1440, example: 540 })
  @IsInt()
  @Min(0)
  @Max(1440)
  plannedStartMinute!: number;

  @ApiProperty({ type: Number, minimum: 0, maximum: 1440, example: 660 })
  @IsInt()
  @Min(0)
  @Max(1440)
  plannedEndMinute!: number;

  @ApiProperty({ type: [ProposedCrewMemberDto] })
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ProposedCrewMemberDto)
  crew!: ProposedCrewMemberDto[];

  @ApiPropertyOptional({
    type: [ProposedVehicleDto],
    description: 'Optional — a crew using public transport needs no vehicle.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => ProposedVehicleDto)
  vehicles?: ProposedVehicleDto[];

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ConflictResourcesDto {
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) visitId!: string | null;
  @ApiProperty({ type: [String] }) employeeIds!: string[];
  @ApiProperty({ type: [String] }) vehicleIds!: string[];
  @ApiProperty({ type: String, nullable: true }) serviceSiteId!: string | null;
  @ApiProperty({ type: [String] }) skillCodes!: string[];
  @ApiProperty({ type: [String] }) assignmentIds!: string[];
}

export class ConflictDto {
  @ApiProperty({ type: String, enum: CONFLICT_CODES })
  code!: string;

  @ApiProperty({ type: String, description: 'Written for a manager.' })
  message!: string;

  @ApiProperty({ type: String, description: 'What to actually do about it.' })
  remediation!: string;

  @ApiProperty({ type: ConflictResourcesDto })
  resources!: ConflictResourcesDto;
}

export class EligibilityResultDto {
  @ApiProperty({ type: Boolean }) isEligible!: boolean;

  @ApiProperty({
    type: [ConflictDto],
    description: 'Every applicable conflict, not just the first, in a stable order.',
  })
  conflicts!: ConflictDto[];
}

export class AssignedCrewMemberDto {
  @ApiProperty({ type: String, format: 'uuid' }) employeeId!: string;
  @ApiProperty({ type: String }) fullName!: string;
  @ApiProperty({ type: String, enum: Object.values(CrewRole) }) role!: CrewRole;
  @ApiProperty({ type: Boolean }) isPmsSupervisor!: boolean;
}

export class AssignedVehicleDto {
  @ApiProperty({ type: String, format: 'uuid' }) vehicleId!: string;
  @ApiProperty({ type: String }) label!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  driverEmployeeId!: string | null;
  @ApiProperty({ type: String, nullable: true }) driverName!: string | null;
}

export class AssignmentDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid' }) generatedVisitId!: string;
  @ApiProperty({ type: String }) status!: string;
  @ApiProperty({ type: String }) branchCode!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  supersedesAssignmentId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  publishedByRepairId!: string | null;
  @ApiProperty({ type: Number }) plannedStartMinute!: number;
  @ApiProperty({ type: Number }) plannedEndMinute!: number;
  @ApiProperty({ type: [AssignedCrewMemberDto] })
  crew!: AssignedCrewMemberDto[];
  @ApiProperty({ type: [AssignedVehicleDto] }) vehicles!: AssignedVehicleDto[];
  @ApiProperty({ type: Boolean }) isLocked!: boolean;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}

export class UnassignedVisitDto {
  @ApiProperty({ type: String, format: 'uuid' }) visitId!: string;
  @ApiProperty({ type: String, format: 'date' }) visitDate!: string;
  @ApiProperty({ type: String }) branchCode!: string;
  @ApiProperty({ type: String }) customerName!: string;
  @ApiProperty({ type: String }) siteName!: string;
  @ApiProperty({ type: Number }) requiredCrewSize!: number;
  @ApiProperty({
    enum: UNASSIGNED_OPERATION_STATES,
    description:
      "The server's own reading of this row: EXCEPTION when eligibility conflicts are recorded against the visit, UNASSIGNED when none are. The same meaning the operationState filter selects on, so a client is told the state rather than re-deriving it.",
  })
  operationState!: UnassignedOperationState;
  @ApiProperty({
    type: Boolean,
    description:
      'True once a crew has been proposed and judged. When false the empty conflict list means nobody has tried yet, not that the visit is fine. The boolean spelling of operationState === EXCEPTION.',
  })
  hasBeenChecked!: boolean;
  @ApiProperty({
    type: [ConflictDto],
    description: 'Why it could not be staffed. Empty when nobody has proposed a crew.',
  })
  conflicts!: ConflictDto[];
  @ApiProperty({ type: String, format: 'date-time' }) recordedAt!: string;
}

export class PaginatedUnassignedVisitsDto {
  @ApiProperty({ type: [UnassignedVisitDto] }) items!: UnassignedVisitDto[];
  @ApiProperty({ type: Number }) total!: number;
  @ApiProperty({ type: Number }) page!: number;
  @ApiProperty({ type: Number }) pageSize!: number;
  @ApiProperty({ type: Boolean }) hasNextPage!: boolean;
  @ApiProperty({ type: Object, additionalProperties: { type: 'number' } })
  conflictFacets!: Record<string, number>;
}

/**
 * The Unassigned queue's filters — and, because the global ValidationPipe runs
 * with `whitelist` and `forbidNonWhitelisted`, the complete list of filters
 * that exist. A parameter not named here is refused at the boundary by name,
 * rather than being dropped and answered with a silently unfiltered page.
 */
export class UnassignedVisitQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  pageSize?: number = 50;
  @ApiPropertyOptional() @IsOptional() @IsString() branchCode?: string;
  @ApiPropertyOptional({ format: 'date' }) @IsOptional() @IsDateOnly() from?: string;
  @ApiPropertyOptional({ format: 'date' }) @IsOptional() @IsDateOnly() to?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() serviceAgreementId?: string;
  @ApiPropertyOptional({ description: 'Whether eligibility has been checked for this visit. The boolean spelling of operationState.' }) @IsOptional() @Transform(toBoolean) @IsBoolean()
  checked?: boolean;
  @ApiPropertyOptional({
    enum: UNASSIGNED_OPERATION_STATES,
    description:
      'UNASSIGNED: no eligibility conflicts are recorded against the visit, so nobody has proposed a crew for it yet. EXCEPTION: a crew was judged and refused and the reasons are stored. Omit for both.',
  })
  @IsOptional()
  @IsEnum(UNASSIGNED_OPERATION_STATES)
  operationState?: UnassignedOperationState;
  @ApiPropertyOptional({
    enum: CONFLICT_GROUPS,
    description:
      'Only visits carrying at least one conflict in this manager-facing group. Groups are the vocabulary the queue filter is offered in; each maps to a fixed set of engine conflict codes. Facets remain scoped to the other filters.',
  })
  @IsOptional()
  @IsEnum(CONFLICT_GROUPS)
  conflictGroup?: ConflictGroup;
  @ApiPropertyOptional({ enum: CONFLICT_CODES, description: 'Only visits carrying this stored conflict code. Engine vocabulary, not group vocabulary — a group label such as MISSING_SKILL is refused here and belongs in conflictGroup.' }) @IsOptional() @IsEnum(CONFLICT_CODES)
  conflictCode?: string;
  @ApiPropertyOptional({ deprecated: true }) @IsOptional() @Transform(toBoolean) @IsBoolean()
  withConflictsOnly?: boolean;
}

export class EmployeeAssignmentQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number = 50;

  @ApiPropertyOptional({
    format: 'date',
    description: 'Assignments on or after this date.',
  })
  @IsOptional()
  @IsDateOnly()
  from?: string;

  @ApiPropertyOptional({
    format: 'date',
    description: 'Assignments on or before this date.',
  })
  @IsOptional()
  @IsDateOnly()
  to?: string;
}

/**
 * Manager/admin read model prepared for a future worker app. Worker self-scope
 * authorization still requires a User-to-Employee identity link in Phase 2.
 */
export class EmployeeAssignmentDto {
  @ApiProperty({ type: String, format: 'uuid' }) assignmentId!: string;
  @ApiProperty({ type: String, enum: Object.values(AssignmentStatus) })
  status!: AssignmentStatus;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  scheduleRunId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  publishedByRepairId!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  supersedesAssignmentId!: string | null;
  @ApiProperty({ type: String, format: 'uuid' }) visitId!: string;
  @ApiProperty({ type: String, format: 'date' }) visitDate!: string;
  @ApiProperty({ type: Number }) plannedStartMinute!: number;
  @ApiProperty({ type: Number }) plannedEndMinute!: number;
  @ApiProperty({ type: String }) branchCode!: string;
  @ApiProperty({ type: String }) customerName!: string;
  @ApiProperty({ type: String }) siteName!: string;
  @ApiProperty({ type: String }) jobTypeName!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Current agreement notes for the visit.' })
  instructions!: string | null;
  @ApiProperty({ type: [AssignedCrewMemberDto] }) crew!: AssignedCrewMemberDto[];
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  supervisorEmployeeId!: string | null;
  @ApiProperty({ type: String, nullable: true }) supervisorName!: string | null;
  @ApiProperty({ type: [AssignedVehicleDto] }) vehicles!: AssignedVehicleDto[];
  @ApiProperty({ type: String, enum: Object.values(CrewRole) }) role!: CrewRole;
  @ApiProperty({ type: Boolean }) isPmsSupervisor!: boolean;
  @ApiProperty({ type: String, format: 'date-time' }) publishedAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  acknowledgedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  startedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  completedAt!: string | null;
}

export class PaginatedEmployeeAssignmentsDto {
  @ApiProperty({ type: [EmployeeAssignmentDto] })
  items!: EmployeeAssignmentDto[];
  @ApiProperty({ type: Number }) total!: number;
  @ApiProperty({ type: Number }) page!: number;
  @ApiProperty({ type: Number }) pageSize!: number;
}

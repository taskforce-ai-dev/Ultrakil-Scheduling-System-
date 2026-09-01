import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CrewRole } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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

import { CONFLICT_CODES } from './conflict-codes';

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
  @ApiProperty({ type: Number }) plannedStartMinute!: number;
  @ApiProperty({ type: Number }) plannedEndMinute!: number;
  @ApiProperty({ type: [AssignedCrewMemberDto] }) crew!: AssignedCrewMemberDto[];
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
    type: Boolean,
    description:
      'True once a crew has been proposed and judged. When false the empty conflict list means nobody has tried yet, not that the visit is fine.',
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
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AssignmentRepairAction,
  CrewRole,
  PublishedAssignmentRepairCommunicationState,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsBoolean,
  IsEnum,
  IsHash,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { ConflictDto } from '../eligibility/dto';

export class RepairCrewMemberDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  employeeId!: string;

  @ApiProperty({ enum: CrewRole })
  @IsEnum(CrewRole)
  role!: CrewRole;
}

export class RepairVehicleDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  vehicleId!: string;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  driverEmployeeId?: string | null;
}

export class RepairReplacementDto {
  @ApiProperty({ type: Number, minimum: 0, maximum: 1440 })
  @IsInt()
  @Min(0)
  @Max(1440)
  plannedStartMinute!: number;

  @ApiProperty({ type: Number, minimum: 0, maximum: 1440 })
  @IsInt()
  @Min(0)
  @Max(1440)
  plannedEndMinute!: number;

  @ApiProperty({ type: [RepairCrewMemberDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => RepairCrewMemberDto)
  crew!: RepairCrewMemberDto[];

  @ApiPropertyOptional({ type: [RepairVehicleDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1)
  @ValidateNested({ each: true })
  @Type(() => RepairVehicleDto)
  vehicles?: RepairVehicleDto[];
}

export class RepairUnassignedReasonDto {
  @ApiProperty({ type: String, maxLength: 100 })
  @IsString()
  @Length(1, 100)
  code!: string;

  @ApiProperty({ type: String, maxLength: 500 })
  @IsString()
  @Length(1, 500)
  message!: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  details?: Record<string, unknown>;
}

export class PublishedAssignmentRepairOperationDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  sourceAssignmentId!: string;

  @ApiProperty({ enum: AssignmentRepairAction })
  @IsEnum(AssignmentRepairAction)
  action!: AssignmentRepairAction;

  @ApiPropertyOptional({ type: RepairReplacementDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RepairReplacementDto)
  replacement?: RepairReplacementDto;

  @ApiPropertyOptional({ type: [RepairUnassignedReasonDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => RepairUnassignedReasonDto)
  unassignedReasons?: RepairUnassignedReasonDto[];
}

export class PublishedAssignmentRepairPreviewDto {
  @ApiProperty({ type: [PublishedAssignmentRepairOperationDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PublishedAssignmentRepairOperationDto)
  operations!: PublishedAssignmentRepairOperationDto[];
}

export class PublishedAssignmentRepairPlanDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: 100,
    uniqueItems: true,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  sourceAssignmentIds!: string[];

  @ApiPropertyOptional({
    type: Boolean,
    description: 'Must be true when any target visit is on the current Colombo day.',
  })
  @IsOptional()
  @IsBoolean()
  acknowledgeCurrentDay?: boolean;
}

export class RepairSourceFingerprintDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  sourceAssignmentId!: string;

  @ApiProperty({ type: String, description: 'SHA-256 fingerprint returned by preview.' })
  @IsHash('sha256')
  fingerprint!: string;
}

export class PublishedAssignmentRepairApplyDto extends PublishedAssignmentRepairPreviewDto {
  @ApiProperty({
    type: String,
    description: 'Canonical SHA-256 plan hash returned by preview.',
  })
  @IsHash('sha256')
  planHash!: string;

  @ApiProperty({ type: [RepairSourceFingerprintDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RepairSourceFingerprintDto)
  sourceFingerprints!: RepairSourceFingerprintDto[];

  @ApiProperty({ type: Boolean, enum: [true], description: 'Must be exactly true.' })
  @Equals(true)
  confirmation!: boolean;

  @ApiPropertyOptional({
    type: Boolean,
    description: 'Must be true when any target visit is on the current Colombo day.',
  })
  @IsOptional()
  @IsBoolean()
  acknowledgeCurrentDay?: boolean;

  @ApiProperty({ type: String, minLength: 1, maxLength: 500 })
  @IsString()
  @Length(1, 500)
  reason!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 200 })
  @IsString()
  @Length(1, 200)
  idempotencyKey!: string;
}

export class PublishedAssignmentFindingQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class PublishedAssignmentFindingDto {
  @ApiProperty({ type: String, format: 'uuid' }) assignmentId!: string;
  @ApiProperty({ type: String, format: 'uuid' }) visitId!: string;
  @ApiProperty({ type: String, format: 'date' }) visitDate!: string;
  @ApiProperty({ type: String }) customerName!: string;
  @ApiProperty({ type: String }) siteName!: string;
  @ApiProperty({ type: [ConflictDto] }) conflicts!: ConflictDto[];
  @ApiProperty({ type: String }) sourceFingerprint!: string;
  @ApiProperty({ enum: ['HISTORICAL', 'CURRENT_DAY', 'FUTURE'] })
  timeScope!: string;
  @ApiProperty({ type: Boolean }) isSelectableForRepair!: boolean;
}

export class PublishedAssignmentRepairPreviewItemDto {
  @ApiProperty({ type: String, format: 'uuid' }) sourceAssignmentId!: string;
  @ApiProperty({ type: String, format: 'uuid' }) visitId!: string;
  @ApiProperty({ type: String, format: 'date' }) visitDate!: string;
  @ApiProperty({ type: String }) customerName!: string;
  @ApiProperty({ type: String }) siteName!: string;
  @ApiProperty({ enum: AssignmentRepairAction }) action!: AssignmentRepairAction;
  @ApiProperty({ type: String }) sourceFingerprint!: string;
  @ApiProperty({ type: Boolean }) isValid!: boolean;
  @ApiProperty({ type: [ConflictDto] }) conflicts!: ConflictDto[];
  @ApiProperty({ enum: ['CURRENT_DAY', 'FUTURE'] }) timeScope!: string;
}

export class PublishedAssignmentRepairResultItemDto {
  @ApiProperty({ type: String, format: 'uuid' }) sourceAssignmentId!: string;
  @ApiProperty({ type: String, format: 'uuid' }) visitId!: string;
  @ApiProperty({ enum: AssignmentRepairAction }) action!: AssignmentRepairAction;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  replacementAssignmentId!: string | null;
}

export class PublishedAssignmentRepairPreviewResponseDto {
  @ApiProperty({ type: String }) planHash!: string;
  @ApiProperty({ type: Boolean }) isValid!: boolean;
  @ApiProperty({ type: [PublishedAssignmentRepairPreviewItemDto] })
  items!: PublishedAssignmentRepairPreviewItemDto[];
}

export class PublishedAssignmentRepairResultDto {
  @ApiProperty({ type: String, format: 'uuid' }) repairId!: string;
  @ApiProperty({ type: String }) planHash!: string;
  @ApiProperty({ type: String }) idempotencyKey!: string;
  @ApiProperty({ enum: PublishedAssignmentRepairCommunicationState })
  communicationState!: PublishedAssignmentRepairCommunicationState;
  @ApiProperty({ type: [PublishedAssignmentRepairResultItemDto] })
  items!: PublishedAssignmentRepairResultItemDto[];
}

export class RepairEmployeeLabelDto {
  @ApiProperty({ type: String, format: 'uuid' }) employeeId!: string;
  @ApiProperty({ type: String }) fullName!: string;
}

export class RepairVehicleLabelDto {
  @ApiProperty({ type: String, format: 'uuid' }) vehicleId!: string;
  @ApiProperty({ type: String }) label!: string;
}

export class RepairResourceLabelsDto {
  @ApiProperty({ type: [RepairEmployeeLabelDto] })
  employees!: RepairEmployeeLabelDto[];
  @ApiProperty({ type: [RepairVehicleLabelDto] })
  vehicles!: RepairVehicleLabelDto[];
}

export class PublishedAssignmentRepairPlanResponseDto extends PublishedAssignmentRepairPreviewResponseDto {
  @ApiProperty({ type: [PublishedAssignmentRepairOperationDto] })
  operations!: PublishedAssignmentRepairOperationDto[];

  @ApiProperty({ type: [RepairSourceFingerprintDto] })
  sourceFingerprints!: RepairSourceFingerprintDto[];

  @ApiProperty({
    type: RepairResourceLabelsDto,
    description:
      'Names for exactly the employees and vehicles this plan references, so the review screen never shows a crew as bare identifiers.',
  })
  resourceLabels!: RepairResourceLabelsDto;
}

/**
 * Paging walks the published-assignment candidates, not the findings. One
 * request evaluates at most one candidate page, so no field here may be read
 * as a statement about candidates this request never checked.
 */
export class PublishedAssignmentFindingsResponseDto {
  @ApiProperty({
    type: [PublishedAssignmentFindingDto],
    description:
      'Invalid published assignments found among the candidates checked by THIS request only. An empty array means nothing was wrong in this candidate page, never that the collection is clean.',
  })
  items!: PublishedAssignmentFindingDto[];

  @ApiProperty({
    type: Number,
    description:
      'One-based candidate page this response describes, in a stable ordering by assignment id.',
  })
  page!: number;

  @ApiProperty({
    type: Number,
    description:
      'Maximum published-assignment candidates this request was allowed to evaluate.',
  })
  pageSize!: number;

  @ApiProperty({
    type: Number,
    description:
      'Published-assignment candidates actually evaluated by this request. Equals pageSize except on the final page, and is 0 past the end of the collection.',
  })
  checkedInPage!: number;

  @ApiProperty({
    type: Number,
    description:
      'Candidates from the start of the ordering through the end of this page, i.e. (page - 1) * pageSize + checkedInPage, never more than totalCandidates. A caller that has walked pages 1..page can show this as "checked N of totalCandidates so far".',
  })
  checkedThrough!: number;

  @ApiProperty({
    type: Number,
    description:
      'Every published assignment that is a repair candidate, whether or not it has been checked. Pair it with checkedThrough to state how much of the collection has been validated.',
  })
  totalCandidates!: number;

  @ApiProperty({
    type: Boolean,
    description:
      'True when candidates remain after this page, so the caller must request page + 1 before concluding anything about the whole collection.',
  })
  hasNextPage!: boolean;
}

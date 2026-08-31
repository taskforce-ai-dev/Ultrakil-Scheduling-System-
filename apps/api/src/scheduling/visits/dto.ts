import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BranchCode, VisitStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Reads a boolean from a query string. See workforce/dto/query.dto.ts. */
const toBoolean = ({ obj, key }: { obj: Record<string, unknown>; key: string }) => {
  const raw = obj?.[key];
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return raw;
};

export class VisitQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 500, default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  pageSize?: number = 100;

  @ApiPropertyOptional({ format: 'date', description: 'Visits on or after this date.' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ format: 'date', description: 'Visits on or before this date.' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ enum: BranchCode })
  @IsOptional()
  @IsEnum(BranchCode)
  branchCode?: BranchCode;

  @ApiPropertyOptional({ enum: VisitStatus })
  @IsOptional()
  @IsEnum(VisitStatus)
  status?: VisitStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  serviceAgreementId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  serviceSiteId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  jobTypeId?: string;

  @ApiPropertyOptional({
    description: 'Only visits a manager owns — locked, hand-edited, scheduled or done.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  protectedOnly?: boolean;

  @ApiPropertyOptional({ description: 'Matches customer or site name.' })
  @IsOptional()
  @IsString()
  search?: string;
}

export class AdjustVisitDto {
  @ApiPropertyOptional({
    format: 'date',
    description: 'Move the visit to another date.',
  })
  @IsOptional()
  @IsDateString()
  visitDate?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 1440 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  windowStartMinute?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 1440 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  windowEndMinute?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 1440 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  durationMinutes?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  requiredCrewSize?: number;

  @ApiPropertyOptional({ maxLength: 500, description: 'Why it was changed.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class LockVisitDto {
  @ApiPropertyOptional({
    maxLength: 500,
    example: 'Customer confirmed this date by phone',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class VisitOriginDto {
  @ApiProperty({ type: String, format: 'uuid' }) serviceAgreementId!: string;
  @ApiProperty({ type: String }) customerName!: string;
  @ApiProperty({ type: String }) siteName!: string;
  @ApiProperty({ type: String }) jobTypeName!: string;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'The agreement version this visit was generated from.',
  })
  agreementVersionNumber!: number | null;
  @ApiProperty({
    type: String,
    description: 'The commitment in plain words, e.g. "Fortnightly".',
  })
  frequencyLabel!: string;
  @ApiProperty({
    type: [String],
    description: 'The allowed weekdays as they stood when this visit was generated.',
  })
  allowedDaysAtGeneration!: string[];
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  generatedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' })
  generatedByRunId!: string | null;
}

export class VisitDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'date' }) visitDate!: string;
  @ApiProperty({ type: Number }) windowStartMinute!: number;
  @ApiProperty({ type: Number }) windowEndMinute!: number;
  @ApiProperty({ type: Number }) durationMinutes!: number;
  @ApiProperty({ type: Number }) requiredCrewSize!: number;
  @ApiProperty({ type: String, enum: Object.values(VisitStatus) }) status!: VisitStatus;
  @ApiProperty({ type: String, enum: Object.values(BranchCode) }) branchCode!: BranchCode;

  @ApiProperty({ type: String, format: 'uuid' }) serviceAgreementId!: string;
  @ApiProperty({ type: String }) customerName!: string;
  @ApiProperty({ type: String }) siteName!: string;
  @ApiProperty({ type: String }) jobTypeName!: string;

  @ApiProperty({
    type: Boolean,
    description: 'True when regeneration will leave this visit alone.',
  })
  isProtected!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Why it is protected: LOCKED, MANUALLY_ADJUSTED, ALREADY_SCHEDULED…',
  })
  protectionReason!: string | null;

  @ApiProperty({ type: Boolean }) isManuallyAdjusted!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  manuallyAdjustedAt!: string | null;
  @ApiProperty({ type: Boolean }) isLocked!: boolean;
  @ApiProperty({ type: String, nullable: true }) lockReason!: string | null;
  @ApiProperty({ type: Number }) assignmentCount!: number;

  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}

export class VisitDetailDto extends VisitDto {
  @ApiProperty({
    type: VisitOriginDto,
    description: 'Why this visit exists — the agreement and version behind it.',
  })
  origin!: VisitOriginDto;
}

export class PaginatedVisitsDto {
  @ApiProperty({ type: [VisitDto] }) items!: VisitDto[];
  @ApiProperty({ type: Number }) total!: number;
  @ApiProperty({ type: Number }) page!: number;
  @ApiProperty({ type: Number }) pageSize!: number;
}

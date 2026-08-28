import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { AgreementStatus, FrequencyUnit, Weekday } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const MINUTES_IN_DAY = 24 * 60;

export class CreateJobTypeDto {
  @ApiProperty({ example: 'TERMITE_CONTROL' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  code!: string;

  @ApiProperty({ example: 'Termite Control' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: 90, default: 60 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MINUTES_IN_DAY)
  defaultDurationMinutes?: number;

  @ApiPropertyOptional({ example: 2, default: 2 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  defaultCrewSize?: number;

  @ApiPropertyOptional({
    default: true,
    description:
      'Phase 1 requires a PMS-grade supervisor on every job. Kept configurable so a future job type does not need a migration.',
  })
  @IsOptional()
  @IsBoolean()
  requiresPmsSupervisor?: boolean;

  @ApiPropertyOptional({ example: 'MBR_FUMIGATION' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  requiredSkillCode?: string | null;
}

export class UpdateJobTypeDto extends PartialType(CreateJobTypeDto) {}

export class CreateServiceAgreementDto {
  @ApiProperty({ format: 'uuid' })
  @IsString()
  serviceSiteId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsString()
  jobTypeId!: string;

  @ApiProperty({
    example: 2,
    minimum: 1,
    description: 'Visits per frequencyUnit. Two per week is 2 with WEEK.',
  })
  @IsInt()
  @Min(1)
  @Max(31)
  frequencyCount!: number;

  @ApiProperty({ enum: FrequencyUnit })
  @IsEnum(FrequencyUnit)
  frequencyUnit!: FrequencyUnit;

  @ApiPropertyOptional({
    example: 2,
    minimum: 1,
    description: "Crew size for this agreement. Defaults to the job type's default.",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  crewSize?: number;

  @ApiPropertyOptional({
    example: 90,
    description: "Estimated visit length. Defaults to the job type's default.",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MINUTES_IN_DAY)
  durationMinutes?: number;

  @ApiProperty({
    enum: Weekday,
    isArray: true,
    example: [Weekday.MONDAY, Weekday.WEDNESDAY, Weekday.FRIDAY],
    description:
      'Hard constraint. A visit is never placed on a weekday outside this list.',
  })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(7)
  @IsEnum(Weekday, { each: true })
  allowedDays!: Weekday[];

  @ApiPropertyOptional({
    enum: Weekday,
    isArray: true,
    example: [Weekday.WEDNESDAY],
    description:
      'Soft preference, ranked ahead of merely-allowed days. Must be a subset of allowedDays.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(7)
  @IsEnum(Weekday, { each: true })
  preferredDays?: Weekday[];

  @ApiPropertyOptional({
    example: 480,
    description:
      "Narrows the site's opening hours for this agreement. It can only restrict — a site shut at 08:00 does not open because an agreement asks.",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MINUTES_IN_DAY)
  serviceWindowStartMinute?: number | null;

  @ApiPropertyOptional({ example: 720 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MINUTES_IN_DAY)
  serviceWindowEndMinute?: number | null;

  @ApiProperty({ example: '2026-09-07', format: 'date' })
  @IsDateString()
  startDate!: string;

  @ApiPropertyOptional({ example: '2027-09-06', format: 'date' })
  @IsOptional()
  @IsDateString()
  endDate?: string | null;

  @ApiPropertyOptional({
    type: [String],
    example: ['MBR_FUMIGATION'],
    description:
      "Skills a crew member must hold, on top of the job type's own requirement.",
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  requiredSkillCodes?: string[];

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class UpdateServiceAgreementDto extends PartialType(CreateServiceAgreementDto) {}

export class ChangeAgreementStatusDto {
  @ApiProperty({
    enum: AgreementStatus,
    description:
      'PAUSED stops visit generation but expects the agreement back. ARCHIVED is final. Neither deletes anything: past visits must stay explainable.',
  })
  @IsEnum(AgreementStatus)
  status!: AgreementStatus;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}

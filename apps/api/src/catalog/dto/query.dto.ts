import { ApiPropertyOptional } from '@nestjs/swagger';
import { AgreementStatus, BranchCode, FrequencyUnit } from '@prisma/client';
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
  Min,
} from 'class-validator';

import { PaginationQueryDto } from '../../workforce/dto/query.dto';

/**
 * Reads a boolean from a query string.
 *
 * Reads the raw value off the source object rather than the coerced `value`:
 * the global ValidationPipe runs with `enableImplicitConversion`, and
 * `Boolean('false')` is `true`, which would invert every `?flag=false` filter.
 */
const toBoolean = ({ obj, key }: { obj: Record<string, unknown>; key: string }) => {
  const raw = obj?.[key];
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return raw;
};

export class CustomerQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: BranchCode })
  @IsOptional()
  @IsEnum(BranchCode)
  branch?: BranchCode;

  @ApiPropertyOptional({
    description: 'Defaults to active customers only. Pass false for deactivated ones.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ description: 'Matches customer name, code, or a site name.' })
  @IsOptional()
  @IsString()
  search?: string;
}

export class ServiceAgreementQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: BranchCode })
  @IsOptional()
  @IsEnum(BranchCode)
  branch?: BranchCode;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  serviceSiteId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  jobTypeId?: string;

  @ApiPropertyOptional({
    enum: AgreementStatus,
    description: 'Defaults to ACTIVE and PAUSED — archived agreements are hidden.',
  })
  @IsOptional()
  @IsEnum(AgreementStatus)
  status?: AgreementStatus;

  @ApiPropertyOptional({ enum: FrequencyUnit })
  @IsOptional()
  @IsEnum(FrequencyUnit)
  frequencyUnit?: FrequencyUnit;

  @ApiPropertyOptional({
    format: 'date',
    description: 'Only agreements in force on this date.',
  })
  @IsOptional()
  @IsDateString()
  activeOn?: string;

  @ApiPropertyOptional({ description: 'Matches customer, site or job type name.' })
  @IsOptional()
  @IsString()
  search?: string;
}

export class JobTypeQueryDto {
  @ApiPropertyOptional({ description: 'Defaults to active job types only.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  active?: boolean;
}

export class SchedulePreviewQueryDto {
  @ApiPropertyOptional({
    format: 'date',
    description: "Where the preview starts. Defaults to the agreement's start date.",
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 52, default: 4 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(52)
  horizonWeeks?: number;
}

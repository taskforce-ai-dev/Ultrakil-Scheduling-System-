import { ApiPropertyOptional } from '@nestjs/swagger';
import { AvailabilityKind, BranchCode, DeploymentType } from '@prisma/client';
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

/**
 * Reads a boolean from a query string.
 *
 * Deliberately reads the *raw* value off the source object rather than the
 * `value` argument. The global ValidationPipe runs with
 * `enableImplicitConversion`, which coerces to the declared type using
 * `Boolean(...)` — and `Boolean('false')` is `true`. Taking `value` here would
 * therefore invert every `?flag=false` filter, silently returning the opposite
 * of what was asked for.
 */
const toBoolean = ({ obj, key }: { obj: Record<string, unknown>; key: string }) => {
  const raw = obj?.[key];
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return raw;
};

export class PaginationQueryDto {
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
}

export class EmployeeQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: BranchCode,
    description: 'Only employees of this branch.',
  })
  @IsOptional()
  @IsEnum(BranchCode)
  branch?: BranchCode;

  @ApiPropertyOptional({
    description:
      'true returns only PMS-grade supervisors. Normalised by the API — never infer this from the job title.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  pmsGrade?: boolean;

  @ApiPropertyOptional({
    enum: DeploymentType,
    description:
      'PERMANENTLY_STATIONED returns staff fixed to one site; MOBILE returns dispatchable staff.',
  })
  @IsOptional()
  @IsEnum(DeploymentType)
  deployment?: DeploymentType;

  @ApiPropertyOptional({
    description: 'Normalised skill code, e.g. MBR_FUMIGATION.',
  })
  @IsOptional()
  @IsString()
  skill?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Only employees authorised to drive this vehicle.',
  })
  @IsOptional()
  @IsUUID()
  vehicleId?: string;

  @ApiPropertyOptional({
    format: 'date',
    example: '2026-09-01',
    description:
      'Only employees with no recorded absence covering this date. Staff are available unless an absence says otherwise.',
  })
  @IsOptional()
  @IsDateString()
  availableOn?: string;

  @ApiPropertyOptional({ description: 'Only employees who can travel by public transport.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  canUsePublicTransport?: boolean;

  @ApiPropertyOptional({
    default: true,
    description: 'Defaults to active only. Pass false to see deactivated staff.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  active?: boolean = true;

  @ApiPropertyOptional({ description: 'Case-insensitive match on name or grade.' })
  @IsOptional()
  @IsString()
  search?: string;
}

export class VehicleQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: BranchCode })
  @IsOptional()
  @IsEnum(BranchCode)
  branch?: BranchCode;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  active?: boolean = true;

  @ApiPropertyOptional({ description: 'Match on registration or label.' })
  @IsOptional()
  @IsString()
  search?: string;
}

export class AvailabilityQueryDto {
  @ApiPropertyOptional({ enum: AvailabilityKind })
  @IsOptional()
  @IsEnum(AvailabilityKind)
  kind?: AvailabilityKind;
}

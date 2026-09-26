import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BranchCode } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

import { IsDateOnly } from '../../common/validation/is-date-only';
import { CoverageDayState } from './coverage-projection';

export class CoverageQueryDto {
  @ApiProperty({ type: String, format: 'date' })
  @IsDateOnly()
  from!: string;

  @ApiProperty({ type: String, format: 'date' })
  @IsDateOnly()
  to!: string;

  @ApiPropertyOptional({ enum: BranchCode })
  @IsOptional()
  @IsEnum(BranchCode)
  branchCode?: BranchCode;
}

export class CoverageShortfallDto {
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: String }) message!: string;
}

export class CoverageDayDto {
  @ApiProperty({ type: String, format: 'date' }) date!: string;
  @ApiProperty({ enum: ['UNCHECKED', 'IN_PROGRESS', 'NOTHING_DUE', 'FAILED', 'SHORTFALL', 'STALE', 'PREPARED_AWAITING_MANAGER', 'COVERED_PUBLISHED'] })
  state!: CoverageDayState;
  @ApiProperty({ type: Number }) visitsDue!: number;
  @ApiProperty({ type: Number }) visitsPublished!: number;
  @ApiProperty({ type: Number }) visitsPrepared!: number;
  @ApiProperty({ type: [CoverageShortfallDto] }) shortfalls!: CoverageShortfallDto[];
}

export class CoverageResponseDto {
  @ApiProperty({ type: String, format: 'date' }) windowStart!: string;
  @ApiProperty({ type: String, format: 'date' }) windowEnd!: string;
  @ApiProperty({ enum: BranchCode, nullable: true }) branchCode!: BranchCode | null;
  @ApiProperty({ type: String, format: 'date', nullable: true }) coveredThrough!: string | null;
  @ApiProperty({ type: Boolean }) fullyPublished!: boolean;
  @ApiProperty({ type: CoverageDayDto }) boundaryDay!: CoverageDayDto;
  @ApiProperty({ type: [CoverageDayDto] }) days!: CoverageDayDto[];
}

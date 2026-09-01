import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BranchCode, LockScope, ScheduleRunStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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

export class StartScheduleRunDto {
  @ApiProperty({ format: 'date', example: '2026-09-07' })
  @IsDateString()
  from!: string;

  @ApiProperty({ format: 'date', example: '2026-09-13' })
  @IsDateString()
  to!: string;

  @ApiPropertyOptional({ enum: BranchCode, description: 'One branch, or both when omitted.' })
  @IsOptional()
  @IsEnum(BranchCode)
  branchCode?: BranchCode;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 300,
    default: 20,
    description: 'How long the solver may search. Longer finds better schedules, not more legal ones.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(300)
  timeLimitSeconds?: number;
}

export class LockAssignmentDto {
  @ApiProperty({ enum: LockScope })
  @IsEnum(LockScope)
  scope!: LockScope;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class PublishScheduleDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ScheduleRunQueryDto {
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

  @ApiPropertyOptional({ enum: ScheduleRunStatus })
  @IsOptional()
  @IsEnum(ScheduleRunStatus)
  status?: ScheduleRunStatus;

  @ApiPropertyOptional({ type: [String], format: 'uuid' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  ids?: string[];
}

export class ScheduleRunDto {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, enum: Object.values(ScheduleRunStatus) })
  status!: ScheduleRunStatus;
  @ApiProperty({ type: String, format: 'date' }) rangeStart!: string;
  @ApiProperty({ type: String, format: 'date' }) rangeEnd!: string;
  @ApiProperty({ type: String, nullable: true }) branchCode!: string | null;

  @ApiProperty({ type: Number, description: '0-100.' }) progressPercent!: number;
  @ApiProperty({ type: Number }) visitsConsidered!: number;
  @ApiProperty({ type: Number }) visitsScheduled!: number;
  @ApiProperty({ type: Number }) visitsUnassigned!: number;

  @ApiProperty({ type: Boolean, description: 'True once published and frozen.' })
  isPublished!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  publishedAt!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description: 'The later run that replaced this one.',
  })
  supersededByRunId!: string | null;

  @ApiProperty({ type: Boolean }) cancelRequested!: boolean;
  @ApiProperty({ type: String, nullable: true }) errorCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) errorMessage!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  startedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  finishedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

export class PaginatedScheduleRunsDto {
  @ApiProperty({ type: [ScheduleRunDto] }) items!: ScheduleRunDto[];
  @ApiProperty({ type: Number }) total!: number;
  @ApiProperty({ type: Number }) page!: number;
  @ApiProperty({ type: Number }) pageSize!: number;
}

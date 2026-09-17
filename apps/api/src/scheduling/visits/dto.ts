import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BranchCode, VisitPlacement, VisitStatus } from '@prisma/client';
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

import { toBoolean } from '../../common/validation/to-boolean';

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
  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uuid',
    description:
      'The schedule run that generated this visit. For links only — a screen names a run by the weeks it covered, never by its id.',
  })
  generatedByRunId!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date',
    description:
      "First day of that run's horizon, which is how a screen names it. Null when no run generated this visit.",
  })
  generatedByRunRangeStart!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date',
    description: "Last day of that run's horizon. Null when no run generated this visit.",
  })
  generatedByRunRangeEnd!: string | null;
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
    description:
      'The site has no recorded opening hours, so this visit was placed on an assumed working day. Clears itself once real hours are entered.',
  })
  hoursUnconfirmed!: boolean;

  @ApiProperty({
    type: String,
    enum: Object.values(VisitPlacement),
    description:
      'Why this visit is on this date. BOOKED: the date is already agreed with the customer. ANCHORED: no booking covered the period, so it was placed near the days this agreement is usually served on. SPREAD: moved off a day that was already full. EARLIEST: no booking and no usual day, so the first allowed day of the period.',
  })
  placement!: VisitPlacement;

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
  @ApiProperty({
    type: Number,
    description:
      'How many assignment records this visit has ever had, live and historical. Not a headcount — one record holds a whole crew.',
  })
  assignmentCount!: number;
  @ApiProperty({
    type: Number,
    description:
      'How many people are on the visit right now: the crew of the assignment in force, or 0 when nobody is assigned. This is the number to show a manager beside requiredCrewSize.',
  })
  assignedCrewCount!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'When the crew is actually due, in minutes from visitDate at UTC midnight — the same number the calendar read model reports. Null when nobody is assigned: the service window is what the visit must fall inside, never a decided time, and a defaulted 08:00-17:00 window presented as a plan sends a manager six hours wrong.',
  })
  plannedStartMinute!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'When the crew is due to leave, on the same scale. Null when nobody is assigned.',
  })
  plannedEndMinute!: number | null;

  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}

export const VISIT_CREW_CHANGE_ACTIONS = [
  'CREW_SET',
  'CREW_REPLACED',
  'CREW_REMOVED',
] as const;

export type VisitCrewChangeAction = (typeof VISIT_CREW_CHANGE_ACTIONS)[number];

export class VisitCrewChangeDto {
  @ApiProperty({ type: String, format: 'date-time' }) changedAt!: string;
  @ApiProperty({
    type: String,
    enum: VISIT_CREW_CHANGE_ACTIONS,
    description:
      'CREW_SET: a crew was put on a visit that had none. CREW_REPLACED: a crew already on the visit was changed. CREW_REMOVED: the crew was taken off.',
  })
  action!: VisitCrewChangeAction;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Who made the change, as recorded at the time.',
  })
  actorLabel!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The reason the manager gave. Null where none was asked for, as when a crew is taken off.',
  })
  reason!: string | null;
  @ApiProperty({ type: Number, description: 'How many people the change left on the visit.' })
  crewSize!: number;
}

export class VisitDetailDto extends VisitDto {
  @ApiProperty({
    type: VisitOriginDto,
    description: 'Why this visit exists — the agreement and version behind it.',
  })
  origin!: VisitOriginDto;

  @ApiProperty({
    type: [VisitCrewChangeDto],
    description:
      "Every time a manager set, changed or removed this visit's crew by hand, newest first, with the reason they gave. Empty for a visit only the scheduler has touched. Capped at the most recent 20.",
  })
  crewChanges!: VisitCrewChangeDto[];
}

export class PaginatedVisitsDto {
  @ApiProperty({ type: [VisitDto] }) items!: VisitDto[];
  @ApiProperty({ type: Number }) total!: number;
  @ApiProperty({ type: Number }) page!: number;
  @ApiProperty({ type: Number }) pageSize!: number;
}

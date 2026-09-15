import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BranchCode, VisitPlacement } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsUUID,
} from 'class-validator';

export class GenerateVisitsDto {
  @ApiProperty({
    example: '2026-09-07',
    format: 'date',
    description: 'First date of the planning horizon, inclusive.',
  })
  @IsDateString()
  from!: string;

  @ApiProperty({
    example: '2026-10-04',
    format: 'date',
    description: 'Last date of the planning horizon, inclusive.',
  })
  @IsDateString()
  to!: string;

  @ApiPropertyOptional({
    enum: BranchCode,
    description: 'Limit the run to one branch. Omit for both.',
  })
  @IsOptional()
  @IsEnum(BranchCode)
  branchCode?: BranchCode;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description:
      'Limit the run to particular agreements. Omit for every active agreement in range.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  serviceAgreementIds?: string[];
}

class VisitChangeDto {
  @ApiProperty({ type: String }) field!: string;
  @ApiProperty({ type: String }) from!: string;
  @ApiProperty({ type: String }) to!: string;
}

class PlannedVisitDto {
  @ApiProperty({ type: String, format: 'uuid' }) serviceAgreementId!: string;
  @ApiProperty({ type: String }) customerName!: string;
  @ApiProperty({ type: String }) siteName!: string;
  @ApiProperty({ type: String, format: 'date' }) visitDate!: string;
  @ApiProperty({ type: Number }) windowStartMinute!: number;
  @ApiProperty({ type: Number }) windowEndMinute!: number;
  @ApiProperty({ type: Number }) durationMinutes!: number;
  @ApiProperty({ type: Number }) requiredCrewSize!: number;
  @ApiProperty({ type: String }) branchCode!: string;
  @ApiProperty({
    type: Boolean,
    description: 'Fell on a preferred weekday rather than a merely allowed one.',
  })
  isPreferredDay!: boolean;
  @ApiProperty({
    type: String,
    enum: Object.values(VisitPlacement),
    description:
      'Why this date: BOOKED is a date already agreed with the customer, ANCHORED is near the days this agreement is usually served on, SPREAD was moved off a day that was already full, EARLIEST is the first allowed day of the period.',
  })
  placement!: VisitPlacement;
}

class PlannedUpdateDto extends PlannedVisitDto {
  @ApiProperty({ type: String, format: 'uuid' }) visitId!: string;
  @ApiProperty({ type: [VisitChangeDto] }) changes!: VisitChangeDto[];
}

class PlannedRemovalDto {
  @ApiProperty({ type: String, format: 'uuid' }) visitId!: string;
  @ApiProperty({ type: String, format: 'uuid' }) serviceAgreementId!: string;
  @ApiProperty({ type: String }) customerName!: string;
  @ApiProperty({ type: String }) siteName!: string;
  @ApiProperty({ type: String, format: 'date' }) visitDate!: string;
  @ApiProperty({ type: String, enum: ['NO_LONGER_REQUIRED'] }) reason!: string;
}

class ProtectedVisitDto {
  @ApiProperty({ type: String, format: 'uuid' }) visitId!: string;
  @ApiProperty({ type: String, format: 'uuid' }) serviceAgreementId!: string;
  @ApiProperty({ type: String }) customerName!: string;
  @ApiProperty({ type: String }) siteName!: string;
  @ApiProperty({ type: String, format: 'date' }) visitDate!: string;
  @ApiProperty({
    type: String,
    enum: [
      'LOCKED',
      'MANUALLY_ADJUSTED',
      'HAS_ASSIGNMENT',
      'ALREADY_SCHEDULED',
      'ALREADY_COMPLETED',
      'CANCELLED',
    ],
    description: 'Why generation left this visit alone.',
  })
  protection!: string;
  @ApiProperty({
    type: String,
    enum: ['UPDATE', 'REMOVE'],
    description: 'What generation would have done, had it been allowed to.',
  })
  wouldHave!: string;
  @ApiProperty({ type: [VisitChangeDto], required: false })
  changes?: VisitChangeDto[];
}

class GenerationShortfallDto {
  @ApiProperty({ type: String, format: 'uuid' }) serviceAgreementId!: string;
  @ApiProperty({ type: String }) customerName!: string;
  @ApiProperty({ type: String }) siteName!: string;
  @ApiProperty({ type: String, format: 'date' }) periodStart!: string;
  @ApiProperty({ type: String, format: 'date' }) periodEnd!: string;
  @ApiProperty({ type: Number }) requested!: number;
  @ApiProperty({ type: Number }) scheduled!: number;
  @ApiProperty({ type: String }) reason!: string;
  @ApiProperty({ type: String }) message!: string;
}

class DailyLoadWarningDto {
  @ApiProperty({ type: String, enum: Object.values(BranchCode) })
  branchCode!: string;
  @ApiProperty({ type: String, format: 'date' }) date!: string;
  @ApiProperty({ type: Number }) plannedCount!: number;
  @ApiProperty({
    type: Number,
    description: 'How many of them are dates already booked, so unmovable.',
  })
  bookedCount!: number;
  @ApiProperty({ type: Number }) cap!: number;
  @ApiProperty({ type: String }) message!: string;
}

class BookingWarningDto {
  @ApiProperty({ type: String, format: 'uuid' }) serviceAgreementId!: string;
  @ApiProperty({ type: String, format: 'date' }) date!: string;
  @ApiProperty({
    type: String,
    enum: [
      'SITE_CLOSED_ON_BOOKED_DAY',
      'WINDOW_TOO_SHORT_FOR_BOOKED_VISIT',
      'AGREEMENT_WINDOW_OUTSIDE_SITE_HOURS',
    ],
    description:
      "SITE_CLOSED_ON_BOOKED_DAY is a booking on a weekday the site has no recorded hours for; WINDOW_TOO_SHORT_FOR_BOOKED_VISIT is a booking inside recorded hours shorter than the visit needs; AGREEMENT_WINDOW_OUTSIDE_SITE_HOURS is a booking on a day whose recorded hours the agreement's own service window does not overlap at all.",
  })
  reason!: string;
  @ApiProperty({ type: String }) message!: string;
}

export class GenerationImpactDto {
  @ApiProperty({ type: String, format: 'date' }) from!: string;
  @ApiProperty({ type: String, format: 'date' }) to!: string;
  @ApiProperty({ type: Number }) agreementsConsidered!: number;

  @ApiProperty({ type: [PlannedVisitDto], description: 'Visits that would be created.' })
  additions!: PlannedVisitDto[];

  @ApiProperty({
    type: [PlannedUpdateDto],
    description: 'Untouched visits that would be brought in line with the agreement.',
  })
  updates!: PlannedUpdateDto[];

  @ApiProperty({
    type: [PlannedRemovalDto],
    description: 'Untouched visits the agreements no longer ask for.',
  })
  removals!: PlannedRemovalDto[];

  @ApiProperty({
    type: [ProtectedVisitDto],
    description:
      'Visits a manager owns. Left exactly as they are, and listed so the change is never a surprise.',
  })
  protectedVisits!: ProtectedVisitDto[];

  @ApiProperty({ type: Number, description: 'Already correct; nothing to do.' })
  unchangedCount!: number;

  @ApiProperty({
    type: [GenerationShortfallDto],
    description:
      'Periods that cannot hold the promised number of visits. Reported, never quietly dropped.',
  })
  shortfalls!: GenerationShortfallDto[];

  @ApiProperty({
    type: [DailyLoadWarningDto],
    description:
      'Days still carrying more visits than the branch plans for, because the work on them is already booked with customers. Named by date and count only.',
  })
  loadWarnings!: DailyLoadWarningDto[];

  @ApiProperty({
    type: [BookingWarningDto],
    description:
      "Dates booked with a customer that the site's own recorded opening hours do not support — a weekday it is shut, or a window shorter than the visit. The visit is still planned, because the booking is a commitment. Named by date and agreement only.",
  })
  bookingWarnings!: BookingWarningDto[];

  @ApiProperty({
    type: Boolean,
    description: 'True when this was a preview. Nothing was written.',
  })
  isPreview!: boolean;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'The schedule run recorded, when this was confirmed. Null on a preview, which writes nothing.',
  })
  scheduleRunId!: string | null;
}

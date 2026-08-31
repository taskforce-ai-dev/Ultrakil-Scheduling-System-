import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BranchCode } from '@prisma/client';
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

import { ApiProperty } from '@nestjs/swagger';
import {
  AgreementStatus,
  BranchCode,
  DayRuleKind,
  FrequencyUnit,
  Weekday,
} from '@prisma/client';

/**
 * Response shapes for the customer, site and agreement endpoints.
 *
 * Field names deliberately match what the portal already built against in
 * ULK-O03, so integrating means swapping an import rather than rewriting a
 * screen. Every property states its `type` explicitly: this project does not
 * run the Swagger CLI plugin, so nothing infers it from the TypeScript.
 */

export class SiteOperatingHoursResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, enum: Object.values(Weekday) })
  weekday!: Weekday;

  @ApiProperty({ type: Number, example: 540, description: '540 is 09:00.' })
  opensAtMinute!: number;

  @ApiProperty({ type: Number, example: 1020, description: '1020 is 17:00.' })
  closesAtMinute!: number;
}

export class ServiceSiteDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  customerId!: string;

  @ApiProperty({ type: String, example: 'Starbucks Newark Penn Station' })
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  addressLine!: string | null;

  @ApiProperty({ type: String, nullable: true })
  city!: string | null;

  @ApiProperty({ type: String, enum: Object.values(BranchCode) })
  branchCode!: BranchCode;

  @ApiProperty({ type: Boolean })
  isActive!: boolean;

  @ApiProperty({
    type: [SiteOperatingHoursResponseDto],
    description:
      'Opening windows. A weekday with no window is closed; several windows on one weekday mean the site shuts in between.',
  })
  operatingHours!: SiteOperatingHoursResponseDto[];

  @ApiProperty({ type: Number, description: 'Agreements referencing this site.' })
  serviceAgreementCount!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;
}

export class CustomerDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, example: 'Starbucks New Jersey' })
  name!: string;

  @ApiProperty({ type: String, nullable: true, example: 'SBUX-NJ' })
  customerCode!: string | null;

  @ApiProperty({ type: String, enum: Object.values(BranchCode) })
  branchCode!: BranchCode;

  @ApiProperty({ type: String, nullable: true })
  contactName!: string | null;

  @ApiProperty({ type: String, nullable: true })
  contactPhone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  contactEmail!: string | null;

  @ApiProperty({ type: Boolean })
  isActive!: boolean;

  @ApiProperty({ type: [ServiceSiteDto] })
  sites!: ServiceSiteDto[];

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;
}

export class JobTypeDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, example: 'TERMITE_CONTROL' })
  code!: string;

  @ApiProperty({ type: String, example: 'Termite Control' })
  name!: string;

  @ApiProperty({ type: Number })
  defaultDurationMinutes!: number;

  @ApiProperty({ type: Number })
  defaultCrewSize!: number;

  @ApiProperty({
    type: Boolean,
    description: 'Phase 1 requires a PMS-grade supervisor on every job.',
  })
  requiresPmsSupervisor!: boolean;

  @ApiProperty({ type: String, nullable: true, example: 'MBR_FUMIGATION' })
  requiredSkillCode!: string | null;

  @ApiProperty({ type: Boolean })
  isActive!: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;
}

export class ServiceAgreementDayRuleDto {
  @ApiProperty({ type: String, enum: Object.values(Weekday) })
  weekday!: Weekday;

  @ApiProperty({ type: String, enum: Object.values(DayRuleKind) })
  kind!: DayRuleKind;
}

export class ServiceAgreementDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  customerId!: string;

  @ApiProperty({ type: String })
  customerName!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  serviceSiteId!: string;

  @ApiProperty({ type: String })
  siteName!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  jobTypeId!: string;

  @ApiProperty({ type: String })
  jobTypeName!: string;

  @ApiProperty({ type: String, enum: Object.values(BranchCode) })
  branchCode!: BranchCode;

  @ApiProperty({ type: Number, description: 'Visits per frequencyUnit.' })
  frequencyCount!: number;

  @ApiProperty({ type: String, enum: Object.values(FrequencyUnit) })
  frequencyUnit!: FrequencyUnit;

  @ApiProperty({ type: Number })
  crewSize!: number;

  @ApiProperty({ type: Number })
  durationMinutes!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: "Narrows the site's hours. Null falls back to them entirely.",
  })
  serviceWindowStartMinute!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  serviceWindowEndMinute!: number | null;

  @ApiProperty({ type: String, format: 'date' })
  startDate!: string;

  @ApiProperty({ type: String, nullable: true, format: 'date' })
  endDate!: string | null;

  @ApiProperty({ type: String, enum: Object.values(AgreementStatus) })
  status!: AgreementStatus;

  @ApiProperty({
    type: Boolean,
    description: 'True only when status is ACTIVE.',
  })
  isActive!: boolean;

  @ApiProperty({
    type: Number,
    description: 'Increments whenever a change would alter the visits produced.',
  })
  currentVersion!: number;

  @ApiProperty({ type: [ServiceAgreementDayRuleDto] })
  dayRules!: ServiceAgreementDayRuleDto[];

  @ApiProperty({
    type: [String],
    enum: Object.values(Weekday),
    description: 'Hard constraint. A visit never lands outside these weekdays.',
  })
  allowedDays!: Weekday[];

  @ApiProperty({
    type: [String],
    enum: Object.values(Weekday),
    description: 'Soft ranking preference. Always a subset of allowedDays.',
  })
  preferredDays!: Weekday[];

  @ApiProperty({ type: [String], example: ['MBR_FUMIGATION'] })
  requiredSkillCodes!: string[];

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;
}

export class AgreementVersionDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: Number })
  versionNumber!: number;

  @ApiProperty({ type: String, nullable: true })
  changedByLabel!: string | null;

  @ApiProperty({ type: String, nullable: true })
  changeSummary!: string | null;

  @ApiProperty({
    type: Object,
    description:
      'The agreement as it stood at this version — the scheduling-relevant fields only.',
  })
  snapshot!: Record<string, unknown>;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;
}

export class PreviewVisitDto {
  @ApiProperty({ type: String, format: 'date' })
  date!: string;

  @ApiProperty({ type: String, enum: Object.values(Weekday) })
  weekday!: Weekday;

  @ApiProperty({ type: Number })
  windowStartMinute!: number;

  @ApiProperty({ type: Number })
  windowEndMinute!: number;

  @ApiProperty({
    type: Boolean,
    description: 'Fell on a preferred weekday, not merely an allowed one.',
  })
  isPreferredDay!: boolean;
}

export class PreviewShortfallDto {
  @ApiProperty({ type: String, format: 'date' })
  periodStart!: string;

  @ApiProperty({ type: String, format: 'date' })
  periodEnd!: string;

  @ApiProperty({ type: Number })
  requested!: number;

  @ApiProperty({ type: Number })
  scheduled!: number;

  @ApiProperty({
    type: String,
    enum: [
      'NOT_ENOUGH_ALLOWED_DAYS',
      'SITE_CLOSED_ON_ALLOWED_DAYS',
      'WINDOW_TOO_SHORT_FOR_VISIT',
    ],
  })
  reason!: string;

  @ApiProperty({ type: String, description: 'Actionable explanation for a manager.' })
  message!: string;
}

export class SchedulePreviewDto {
  @ApiProperty({ type: [PreviewVisitDto] })
  visits!: PreviewVisitDto[];

  @ApiProperty({
    type: [PreviewShortfallDto],
    description:
      'Periods that cannot hold the promised number of visits. Reported, never silently dropped.',
  })
  shortfalls!: PreviewShortfallDto[];

  @ApiProperty({ type: String, format: 'date' })
  horizonStart!: string;

  @ApiProperty({ type: String, format: 'date' })
  horizonEnd!: string;
}

export class PaginatedCustomersDto {
  @ApiProperty({ type: [CustomerDto] })
  items!: CustomerDto[];

  @ApiProperty({ type: Number })
  total!: number;

  @ApiProperty({ type: Number })
  page!: number;

  @ApiProperty({ type: Number })
  pageSize!: number;
}

export class PaginatedServiceAgreementsDto {
  @ApiProperty({ type: [ServiceAgreementDto] })
  items!: ServiceAgreementDto[];

  @ApiProperty({ type: Number })
  total!: number;

  @ApiProperty({ type: Number })
  page!: number;

  @ApiProperty({ type: Number })
  pageSize!: number;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AvailabilityKind,
  BranchCode,
  DeploymentType,
} from '@prisma/client';

/**
 * Response shapes for the workforce endpoints.
 *
 * Declared explicitly rather than returning Prisma rows, for two reasons: the
 * OpenAPI contract can only type what it can see, and the raw rows carry
 * `sourceKey` and `sourceRow` — internal import bookkeeping and a copy of the
 * entire workbook line — which the portal has no use for and should not be
 * handed.
 */

export class BranchSummaryDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, enum: Object.values(BranchCode) })
  code!: BranchCode;

  @ApiProperty({ type: String, example: 'Colombo Branch' })
  name!: string;
}

export class EmployeeSkillDto {
  @ApiProperty({ type: String, example: 'MBR_FUMIGATION' })
  skillCode!: string;

  @ApiProperty({
    type: String,
    example: 'MBr Fumigation',
    description: 'Exactly as spelled in the workforce matrix.',
  })
  skillLabel!: string;
}

export class AuthorizedVehicleDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, example: '253-4289' })
  code!: string;

  @ApiProperty({ type: String, example: 'Van( 04 People) 253-4289' })
  label!: string;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 4 })
  seatCapacity!: number | null;
}

export class AvailabilityDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'date', example: '2026-09-01' })
  startDate!: string;

  @ApiProperty({
    type: String,
    format: 'date',
    example: '2026-09-05',
    description: 'Inclusive.',
  })
  endDate!: string;

  @ApiProperty({ type: String, enum: Object.values(AvailabilityKind) })
  kind!: AvailabilityKind;

  @ApiPropertyOptional({ type: String, nullable: true })
  reason!: string | null;
}

export class EmployeeDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  employeeCode!: string | null;

  @ApiProperty({ type: String, example: 'A Perera' })
  fullName!: string;

  @ApiProperty({
    type: String,
    example: 'Senoir PMS',
    description:
      'Exactly as spelled in the workforce matrix, typos included. Never parse this to decide seniority — use isPmsGrade.',
  })
  gradeLabel!: string;

  @ApiProperty({
    type: Boolean,
    description:
      'Whether this person satisfies the "every job needs a PMS-grade supervisor" rule. Decided by the API from the grade; clients must not infer it from the label.',
  })
  isPmsGrade!: boolean;

  @ApiProperty({ type: String, enum: Object.values(BranchCode) })
  branchCode!: BranchCode;

  @ApiProperty({ type: BranchSummaryDto })
  branch!: BranchSummaryDto;

  @ApiProperty({ type: String, enum: Object.values(DeploymentType) })
  deploymentType!: DeploymentType;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Lion Brewery',
    description:
      'Set only for permanently stationed staff, who are never dispatched elsewhere.',
  })
  permanentSiteLabel!: string | null;

  @ApiProperty({
    type: Boolean,
    description:
      'Can reach a site by bus or other public transport, so a crew can be sent without a company vehicle.',
  })
  canUsePublicTransport!: boolean;

  @ApiProperty({ type: Boolean })
  isActive!: boolean;

  @ApiProperty({ type: [EmployeeSkillDto] })
  skills!: EmployeeSkillDto[];

  @ApiProperty({
    type: [AuthorizedVehicleDto],
    description:
      'Vehicles this person may drive. Authorization only — nothing here implies ownership or a usual driver.',
  })
  authorizedVehicles!: AuthorizedVehicleDto[];

  @ApiProperty({
    type: [String],
    description: 'Convenience list of the same vehicle ids, for filtering in the UI.',
  })
  authorizedVehicleIds!: string[];

  @ApiProperty({ type: [AvailabilityDto], description: 'Recorded absences.' })
  availability!: AvailabilityDto[];

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;
}

export class VehicleDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, example: '253-4289' })
  code!: string;

  @ApiProperty({ type: String, example: 'Van( 04 People) 253-4289' })
  label!: string;

  @ApiPropertyOptional({ type: Number, nullable: true, example: 4 })
  seatCapacity!: number | null;

  @ApiPropertyOptional({
    type: String,
    enum: Object.values(BranchCode),
    nullable: true,
  })
  branchCode!: BranchCode | null;

  @ApiProperty({ type: Boolean })
  isActive!: boolean;

  @ApiProperty({
    type: Number,
    description: 'How many employees are authorised to drive it.',
  })
  authorizedDriverCount!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;
}

export class AuthorizedDriverDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String })
  fullName!: string;

  @ApiProperty({ type: String })
  gradeLabel!: string;

  @ApiProperty({ type: Boolean })
  isPmsGrade!: boolean;

  @ApiProperty({ type: String, enum: Object.values(BranchCode) })
  branchCode!: BranchCode;

  @ApiProperty({ type: String, enum: Object.values(DeploymentType) })
  deploymentType!: DeploymentType;

  @ApiProperty({ type: Boolean })
  isActive!: boolean;
}

export class AuthorizedDriversResponseDto {
  @ApiProperty({ type: AuthorizedVehicleDto })
  vehicle!: AuthorizedVehicleDto;

  @ApiProperty({ type: [AuthorizedDriverDto] })
  drivers!: AuthorizedDriverDto[];

  @ApiProperty({ type: Number })
  total!: number;
}

export class BranchListItemDto extends BranchSummaryDto {
  @ApiProperty({ type: Number })
  employeeCount!: number;

  @ApiProperty({ type: Number })
  vehicleCount!: number;

  @ApiProperty({
    type: Number,
    description:
      'Active PMS-grade supervisors. A branch with zero cannot be scheduled at all — every job needs one.',
  })
  pmsSupervisorCount!: number;
}

export class SkillListItemDto extends EmployeeSkillDto {
  @ApiProperty({ type: Number })
  employeeCount!: number;
}

export class PaginatedEmployeesDto {
  @ApiProperty({ type: [EmployeeDto] })
  items!: EmployeeDto[];

  @ApiProperty({ type: Number })
  total!: number;

  @ApiProperty({ type: Number })
  page!: number;

  @ApiProperty({ type: Number })
  pageSize!: number;
}

export class PaginatedVehiclesDto {
  @ApiProperty({ type: [VehicleDto] })
  items!: VehicleDto[];

  @ApiProperty({ type: Number })
  total!: number;

  @ApiProperty({ type: Number })
  page!: number;

  @ApiProperty({ type: Number })
  pageSize!: number;
}

import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  AvailabilityKind,
  BranchCode,
  DeploymentType,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CreateEmployeeDto {
  @ApiProperty({ example: 'A Perera' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName!: string;

  @ApiProperty({
    example: 'Senior PMS',
    description:
      'Free text, kept exactly as given. PMS eligibility is derived from it by the API — clients must not infer it themselves.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  gradeLabel!: string;

  @ApiProperty({ enum: BranchCode })
  @IsEnum(BranchCode)
  branchCode!: BranchCode;

  @ApiPropertyOptional({ enum: DeploymentType, default: DeploymentType.MOBILE })
  @IsOptional()
  @IsEnum(DeploymentType)
  deploymentType?: DeploymentType;

  @ApiPropertyOptional({
    example: 'Lion Brewery',
    description: 'Required when deploymentType is PERMANENTLY_STATIONED.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  permanentSiteLabel?: string | null;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  canUsePublicTransport?: boolean;

  @ApiPropertyOptional({
    type: [String],
    description: 'Normalised skill codes, e.g. ["MBR_FUMIGATION"].',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  skillCodes?: string[];
}

export class UpdateEmployeeDto extends PartialType(CreateEmployeeDto) {}

export class SetPermanentAssignmentDto {
  @ApiProperty({
    example: 'Lion Brewery',
    description:
      'Site the employee is permanently stationed at. Pass null to make them mobile again.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  siteLabel!: string | null;
}

export class CreateAvailabilityDto {
  @ApiProperty({ format: 'date', example: '2026-09-01' })
  @IsDateString()
  startDate!: string;

  @ApiProperty({
    format: 'date',
    example: '2026-09-05',
    description: 'Inclusive. Same as startDate for a single day.',
  })
  @IsDateString()
  endDate!: string;

  @ApiPropertyOptional({ enum: AvailabilityKind, default: AvailabilityKind.LEAVE })
  @IsOptional()
  @IsEnum(AvailabilityKind)
  kind?: AvailabilityKind;

  @ApiPropertyOptional({ example: 'Annual leave' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export class SkillAssignmentDto {
  @ApiProperty({ example: 'MBR_FUMIGATION' })
  @IsString()
  @MinLength(1)
  skillCode!: string;

  @ApiPropertyOptional({
    example: 'MBr Fumigation',
    description: 'Display label. Defaults to the code when omitted.',
  })
  @IsOptional()
  @IsString()
  skillLabel?: string;
}

export class ReplaceSkillsDto {
  @ApiProperty({ type: [SkillAssignmentDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SkillAssignmentDto)
  skills!: SkillAssignmentDto[];
}

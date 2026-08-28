import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { BranchCode, Weekday } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const MINUTES_IN_DAY = 24 * 60;

export class CreateCustomerDto {
  @ApiProperty({ example: 'Starbucks New Jersey' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ example: 'SBUX-NJ' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  customerCode?: string | null;

  @ApiProperty({
    enum: BranchCode,
    description:
      'Mandatory. A customer belongs to exactly one branch, and its sites cannot be served from the other one.',
  })
  @IsEnum(BranchCode)
  branchCode!: BranchCode;

  @ApiPropertyOptional({ example: 'Ravi Fernando' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contactName?: string | null;

  @ApiPropertyOptional({ example: '+94 77 123 4567' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  contactPhone?: string | null;

  @ApiPropertyOptional({ example: 'facilities@example.com' })
  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  contactEmail?: string | null;
}

export class UpdateCustomerDto extends PartialType(CreateCustomerDto) {}

/**
 * One opening window on one weekday.
 *
 * A weekday with no window is closed — absence of a window *is* closed, there
 * is no separate flag. Several windows on the same weekday are allowed, which
 * is how a site that shuts over lunch is expressed.
 */
export class SiteOperatingHoursDto {
  @ApiProperty({ enum: Weekday })
  @IsEnum(Weekday)
  weekday!: Weekday;

  @ApiProperty({
    example: 540,
    description: 'Minutes from midnight. 540 is 09:00.',
    minimum: 0,
    maximum: MINUTES_IN_DAY,
  })
  @IsInt()
  @Min(0)
  @Max(MINUTES_IN_DAY)
  opensAtMinute!: number;

  @ApiProperty({
    example: 1020,
    description: 'Minutes from midnight. 1020 is 17:00. Must be after opensAtMinute.',
    minimum: 0,
    maximum: MINUTES_IN_DAY,
  })
  @IsInt()
  @Min(0)
  @Max(MINUTES_IN_DAY)
  closesAtMinute!: number;
}

export class CreateServiceSiteDto {
  @ApiProperty({ example: 'Starbucks Newark Penn Station' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ example: '1 Raymond Plaza W' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  addressLine?: string | null;

  @ApiPropertyOptional({ example: 'Colombo 03' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string | null;

  @ApiPropertyOptional({
    enum: BranchCode,
    description:
      "Defaults to the customer's branch. A site may not sit in the other branch from its customer.",
  })
  @IsOptional()
  @IsEnum(BranchCode)
  branchCode?: BranchCode;

  @ApiPropertyOptional({
    type: [SiteOperatingHoursDto],
    description:
      'Opening windows by weekday. Omit a weekday to mark the site closed that day. Several windows per weekday are allowed; they must not overlap.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(21)
  @ValidateNested({ each: true })
  @Type(() => SiteOperatingHoursDto)
  operatingHours?: SiteOperatingHoursDto[];
}

export class UpdateServiceSiteDto extends PartialType(CreateServiceSiteDto) {}

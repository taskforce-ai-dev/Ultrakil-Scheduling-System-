import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { BranchCode } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateVehicleDto {
  @ApiProperty({
    example: '253-4289',
    description: 'Registration. Unique, and how the vehicle is identified.',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(40)
  code!: string;

  @ApiProperty({ example: 'Van( 04 People) 253-4289' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  label!: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 60,
    description: 'How many crew it carries. Limits crew size when assigned.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  seatCapacity?: number | null;

  @ApiPropertyOptional({
    enum: BranchCode,
    description: 'Branch the vehicle is based at. Null means unassigned.',
  })
  @IsOptional()
  @IsEnum(BranchCode)
  branchCode?: BranchCode | null;
}

export class UpdateVehicleDto extends PartialType(CreateVehicleDto) {}

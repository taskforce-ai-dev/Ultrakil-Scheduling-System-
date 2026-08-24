import { ApiProperty } from '@nestjs/swagger';

export class MetaResponseDto {
  @ApiProperty({ type: String, example: '0.1.0', description: 'API package version.' })
  apiVersion!: string;

  @ApiProperty({
    type: String,
    example: 'Asia/Colombo',
    description:
      'Timezone all scheduling dates and service windows are expressed in.',
  })
  timezone!: string;

  @ApiProperty({
    type: [String],
    example: ['COLOMBO', 'KANDY'],
    description:
      'Branches. Staff may only serve work in their own branch — this is a hard rule.',
  })
  branchCodes!: string[];

  @ApiProperty({
    type: [String],
    example: ['MONDAY', 'TUESDAY'],
    description: 'Weekday vocabulary used by allowed and preferred day rules.',
  })
  weekdays!: string[];

  @ApiProperty({
    type: [String],
    example: ['Senior PMS', 'PMS', 'Assistant PMS', 'SPMS', 'APMS'],
    description:
      'Grades that satisfy the "every job needs at least one PMS-grade supervisor" rule.',
  })
  pmsGradeLabels!: string[];

  @ApiProperty({
    example: { WEEK: 'visits per week', MONTH: 'visits per month' },
    description: 'Frequency units available on a service agreement.',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  frequencyUnits!: Record<string, string>;

  @ApiProperty({
    type: [String],
    example: ['VALIDATION_FAILED', 'NO_PMS_SUPERVISOR_AVAILABLE'],
    description:
      'Every stable error code the API can return. Clients must branch on these, never on message text.',
  })
  errorCodes!: string[];
}

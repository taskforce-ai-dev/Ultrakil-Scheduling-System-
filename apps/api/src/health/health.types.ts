import { ApiExtraModels, ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';

export type DependencyStatus = 'up' | 'down';

export class DependencyHealthDto {
  @ApiProperty({
    type: String,
    enum: ['up', 'down'],
    example: 'up',
    description: 'Whether this dependency answered its probe.',
  })
  status!: DependencyStatus;

  @ApiPropertyOptional({
    type: Number,
    description: 'Round-trip time of the probe, in milliseconds.',
    example: 4,
  })
  responseTimeMs?: number;

  @ApiPropertyOptional({
    type: String,
    description: 'Stable error code when the dependency is down.',
    example: 'DATABASE_UNAVAILABLE',
  })
  code?: string;

  @ApiPropertyOptional({
    type: String,
    description: 'Actionable explanation of how to fix it.',
    example:
      'Cannot reach PostgreSQL. Start it with "pnpm dev:infra" and confirm DATABASE_URL in your .env.',
  })
  message?: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Probe-specific extra information.',
  })
  details?: Record<string, unknown>;
}

@ApiExtraModels(DependencyHealthDto)
export class HealthResponseDto {
  @ApiProperty({
    type: String,
    enum: ['ok', 'degraded'],
    example: 'ok',
    description:
      '"ok" when every dependency is up; "degraded" when at least one is down. A degraded result is served with HTTP 503.',
  })
  status!: 'ok' | 'degraded';

  @ApiProperty({ type: String, example: '2026-08-24T04:15:00.000Z' })
  checkedAt!: string;

  @ApiProperty({
    type: Number,
    example: 1423.5,
    description: 'Process uptime in seconds.',
  })
  uptimeSeconds!: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { $ref: getSchemaPath(DependencyHealthDto) },
    description:
      'One entry per checked dependency: "database", "queue" and "scheduler".',
  })
  dependencies!: Record<string, DependencyHealthDto>;
}

export class LivenessResponseDto {
  @ApiProperty({ type: String, enum: ['ok'], example: 'ok' })
  status!: 'ok';

  @ApiProperty({ type: String, example: '2026-08-24T04:15:00.000Z' })
  checkedAt!: string;
}

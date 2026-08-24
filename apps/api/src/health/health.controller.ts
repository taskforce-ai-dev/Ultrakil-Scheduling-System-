import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { HealthService } from './health.service';
import { HealthResponseDto, LivenessResponseDto } from './health.types';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      'Returns 200 as long as the API process is running. Checks no dependencies, so an orchestrator will not restart the API just because the database is briefly down.',
  })
  @ApiResponse({ status: 200, type: LivenessResponseDto })
  live(): LivenessResponseDto {
    return { status: 'ok', checkedAt: new Date().toISOString() };
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Checks PostgreSQL, the BullMQ/Redis connection and the Python scheduling service. Returns 200 when all are up and 503 when any is down; the body names the failing dependency and how to fix it.',
  })
  @ApiResponse({ status: 200, type: HealthResponseDto })
  @ApiResponse({
    status: 503,
    type: HealthResponseDto,
    description: 'At least one dependency is unavailable.',
  })
  async ready(
    @Res({ passthrough: true }) res: Response,
  ): Promise<HealthResponseDto> {
    const result = await this.health.check();
    res.status(
      result.status === 'ok'
        ? HttpStatus.OK
        : HttpStatus.SERVICE_UNAVAILABLE,
    );
    return result;
  }
}

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { LockScope, ScheduleRun, UserRole } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import {
  LockAssignmentDto,
  PaginatedScheduleRunsDto,
  PublishScheduleDto,
  ScheduleRunDto,
  ScheduleRunQueryDto,
  StartScheduleRunDto,
} from './dto';
import { PublishingService } from './publishing.service';
import { ScheduleRunQueue } from './schedule-run.processor';
import { ScheduleRunService } from './schedule-run.service';

function toDto(run: ScheduleRun): ScheduleRunDto {
  return {
    id: run.id,
    status: run.status,
    rangeStart: run.rangeStart.toISOString().slice(0, 10),
    rangeEnd: run.rangeEnd.toISOString().slice(0, 10),
    branchCode: run.branchCode,
    progressPercent: run.progressPercent,
    visitsConsidered: run.visitsConsidered,
    visitsScheduled: run.visitsScheduled,
    visitsUnassigned: run.visitsUnassigned,
    isPublished: run.publishedAt !== null,
    publishedAt: run.publishedAt?.toISOString() ?? null,
    supersededByRunId: run.supersededByRunId,
    cancelRequested: run.cancelRequestedAt !== null,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
  };
}

@ApiTags('schedule-runs')
@ApiBearerAuth('bearer')
@ApiResponse({ status: 401, description: 'Missing or invalid token.' })
@Controller()
export class ScheduleRunsController {
  constructor(
    private readonly runs: ScheduleRunService,
    private readonly queue: ScheduleRunQueue,
    private readonly publishing: PublishingService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('schedule-runs')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Solve a date range',
    description:
      'Queues a solve and returns immediately with a run to poll — a solve takes seconds and would time out behind a proxy if it were held open. Published work is never touched, and locked parts of a draft are kept exactly as they are.',
  })
  @ApiResponse({ status: 201, type: ScheduleRunDto })
  @ApiResponse({ status: 400, description: 'AGREEMENT_DATES_INVALID' })
  async start(
    @Body() dto: StartScheduleRunDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<ScheduleRunDto> {
    const run = await this.runs.create(dto, actor);
    const jobId = await this.queue.enqueue({
      runId: run.id,
      timeLimitSeconds: dto.timeLimitSeconds ?? 20,
    });
    const withJob = await this.prisma.scheduleRun.update({
      where: { id: run.id },
      data: { jobId },
    });
    return toDto(withJob);
  }

  @Get('schedule-runs')
  @ApiOperation({ summary: 'Past and current schedule runs' })
  @ApiResponse({ status: 200, type: PaginatedScheduleRunsDto })
  async list(@Query() query: ScheduleRunQueryDto): Promise<PaginatedScheduleRunsDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.ids?.length ? { id: { in: query.ids } } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.scheduleRun.count({ where }),
      this.prisma.scheduleRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { items: rows.map(toDto), total, page, pageSize };
  }

  @Get('schedule-runs/:id')
  @ApiOperation({
    summary: 'One run, with its progress',
    description: 'Poll this while a solve is working. `progressPercent` moves as it goes.',
  })
  @ApiResponse({ status: 200, type: ScheduleRunDto })
  @ApiResponse({ status: 404, description: 'RESOURCE_NOT_FOUND' })
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<ScheduleRunDto> {
    const run = await this.prisma.scheduleRun.findUniqueOrThrow({ where: { id } });
    return toDto(run);
  }

  @Post('schedule-runs/:id/cancel')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Stop a run',
    description:
      'Sets a cancel flag the worker checks at each safe point, so a run stops without writing a half-finished schedule. A run that has already written is left as it is.',
  })
  @ApiResponse({ status: 200, type: ScheduleRunDto })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<ScheduleRunDto> {
    const run = await this.runs.requestCancel(id, actor);
    await this.queue.cancel(id);
    return toDto(run);
  }

  @Post('schedule-runs/:id/publish')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Publish the schedule',
    description:
      'Freezes this run: its assignments become the schedule the crews were told, and neither they nor the run may change afterwards. Anything published earlier for the same visits is superseded, never deleted.',
  })
  @ApiResponse({ status: 200, type: ScheduleRunDto })
  @ApiResponse({
    status: 409,
    description: 'RESOURCE_CONFLICT — already published, unfinished, or nothing to publish.',
  })
  async publish(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublishScheduleDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<ScheduleRunDto> {
    const { run } = await this.publishing.publish(id, dto.reason ?? null, actor);
    return toDto(run);
  }

  @Post('assignments/:id/lock')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pin part of an assignment',
    description:
      'CREW, SUPERVISOR, VEHICLE, TIME or FULL. The next run keeps whatever is pinned. A lock can never make an illegal crew legal — the hard rules still apply, so a pinned but impossible crew leaves the visit unassigned.',
  })
  @ApiResponse({ status: 200, description: 'Locked.' })
  lock(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LockAssignmentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.publishing.lock(id, dto.scope, dto.reason ?? null, actor);
  }

  @Post('assignments/:id/unlock')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Release a pinned part of an assignment' })
  @ApiResponse({ status: 200, description: 'Released.' })
  unlock(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LockAssignmentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.publishing.unlock(id, dto.scope as LockScope, actor);
  }
}

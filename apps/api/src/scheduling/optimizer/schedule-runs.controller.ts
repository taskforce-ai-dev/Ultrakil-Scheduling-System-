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
  Inject,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AssignmentStatus, LockScope, Prisma, ScheduleRun, UserRole } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { AppException } from '../../common/errors/app.exception';
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
import { ScheduleRunDispatchService } from './schedule-run-dispatch.service';
import {
  SCHEDULE_RUN_DISPATCHER,
  ScheduleRunDispatcher,
} from './schedule-run.dispatcher';
import { ScheduleRunService } from './schedule-run.service';
import {
  materialProvenanceWarnings,
  MaterialProvenanceWarning,
  publishReadiness,
} from './publish-readiness';

const SCHEDULE_RUN_READINESS_INCLUDE = {
  assignments: {
    where: { status: { in: [AssignmentStatus.DRAFT, AssignmentStatus.PUBLISHED] } },
    include: {
      vehicles: { include: { vehicle: { select: { branchId: true } } } },
      generatedVisit: {
        include: {
          serviceAgreement: {
            include: {
              serviceSite: { select: { branchConfidence: true, branchSource: true } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.ScheduleRunInclude;

type ScheduleRunWithReadiness = Prisma.ScheduleRunGetPayload<{
  include: typeof SCHEDULE_RUN_READINESS_INCLUDE;
}>;

function toDto(
  run: ScheduleRun,
  provenanceWarnings: MaterialProvenanceWarning[] = [],
): ScheduleRunDto {
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
    publishReadiness: publishReadiness(run, provenanceWarnings),
    isPublished: run.publishedAt !== null,
    publishedAt: run.publishedAt?.toISOString() ?? null,
    supersededByRunId: run.supersededByRunId,
    cancelRequested: run.cancelRequestedAt !== null,
    errorCode: run.errorCode,
    errorMessage: managerSafeError(run.errorMessage),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
  };
}

function toReadinessDto(run: ScheduleRunWithReadiness): ScheduleRunDto {
  return toDto(run, materialProvenanceWarnings(run.assignments));
}

/** Scheduler/provider diagnostics belong in logs, never in a manager response. */
export function managerSafeError(message: string | null): string | null {
  if (!message) return null;
  return 'The schedule run could not finish. Retry it, and contact support with the run ID if it persists.';
}

@ApiTags('schedule-runs')
@ApiBearerAuth('bearer')
@ApiResponse({ status: 401, description: 'Missing or invalid token.' })
@Controller()
export class ScheduleRunsController {
  constructor(
    @Inject(ScheduleRunService)
    private readonly runs: ScheduleRunService,
    @Inject(SCHEDULE_RUN_DISPATCHER)
    private readonly dispatcher: ScheduleRunDispatcher,
    @Inject(PublishingService)
    private readonly publishing: PublishingService,
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(ScheduleRunDispatchService)
    private readonly dispatches: ScheduleRunDispatchService,
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
    this.assertProviderRange(dto.from, dto.to);
    const run = await this.runs.create(dto, actor, this.dispatcher.provider);
    // A durable outbox now owns publish/recovery. Returning the queued run
    // retains the existing polling API even if the first remote publish fails.
    return toDto((await this.dispatches.dispatch(run.id)) ?? run);
  }

  @Get('schedule-runs')
  @ApiOperation({ summary: 'Past and current schedule runs' })
  @ApiResponse({ status: 200, type: PaginatedScheduleRunsDto })
  async list(
    @Query() query: ScheduleRunQueryDto,
  ): Promise<PaginatedScheduleRunsDto> {
    await this.reconcileSelfHosted();
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
        include: SCHEDULE_RUN_READINESS_INCLUDE,
      }),
    ]);

    return { items: rows.map(toReadinessDto), total, page, pageSize };
  }

  @Get('schedule-runs/:id')
  @ApiOperation({
    summary: 'One run, with its progress',
    description:
      'Poll this while a solve is working. `progressPercent` moves as it goes.',
  })
  @ApiResponse({ status: 200, type: ScheduleRunDto })
  @ApiResponse({ status: 404, description: 'RESOURCE_NOT_FOUND' })
  async get(@Param('id', ParseUUIDPipe) id: string): Promise<ScheduleRunDto> {
    await this.reconcileSelfHosted();
    const run = await this.prisma.scheduleRun.findUniqueOrThrow({
      where: { id },
      include: SCHEDULE_RUN_READINESS_INCLUDE,
    });
    return toReadinessDto(run);
  }

  private async reconcileSelfHosted(): Promise<void> {
    // BullMQ has no external signed cron endpoint. Its polling API provides a
    // bounded recovery sweep for jobs abandoned after maxStalledCount. QStash
    // uses its signed schedule instead, keeping Vercel polling reads remote-free.
    if (this.dispatcher.provider === 'bullmq') {
      await this.dispatches.reconcilePending();
    }
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
    await this.dispatches.cancel(run.id, run.jobId);
    return toDto(run);
  }

  private assertProviderRange(from: string, to: string): void {
    if (this.dispatcher.maxRangeDays === undefined) return;
    const days =
      Math.floor(
        (new Date(`${to}T00:00:00.000Z`).getTime() -
          new Date(`${from}T00:00:00.000Z`).getTime()) /
          86_400_000,
      ) + 1;
    if (days <= this.dispatcher.maxRangeDays) return;
    throw new AppException(
      'SCHEDULE_EXECUTION_BUDGET_EXCEEDED',
      `This QStash deployment can solve at most ${this.dispatcher.maxRangeDays} days per run within Vercel Hobby's execution budget. Use a shorter range.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
      {
        days,
        maximumDays: this.dispatcher.maxRangeDays,
        provider: this.dispatcher.provider,
      },
    );
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
    description:
      'RESOURCE_CONFLICT — already published, unfinished, or nothing to publish.',
  })
  async publish(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublishScheduleDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<ScheduleRunDto> {
    const { run, provenanceWarnings } = await this.publishing.publish(
      id,
      dto.reason ?? null,
      actor,
      dto.acknowledgePartial === true,
      dto.acknowledgeProvenance === true,
    );
    return toDto(run, provenanceWarnings);
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

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
import {
  AssignmentStatus,
  LockScope,
  Prisma,
  ScheduleRun,
  ScheduleRunStatus,
  UserRole,
} from '@prisma/client';

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
  ProvenanceWarning,
  provenanceWarnings,
  publishReadiness,
} from './publish-readiness';

/**
 * Readiness is shown on a list, so it has to cost a list's worth of reading.
 * Nothing here loads an assignment object graph: only the scalar provenance
 * markers and the one vehicle column the vehicle-branch warning needs.
 */
const PROVENANCE_SELECT = {
  scheduleRunId: true,
  generatedVisitId: true,
  generatedVisit: {
    select: {
      windowProvenance: true,
      serviceAgreement: {
        select: {
          crewSizeProvenance: true,
          durationProvenance: true,
          dayRuleProvenance: true,
          serviceSite: { select: { branchConfidence: true, branchSource: true } },
        },
      },
    },
  },
  vehicles: { select: { vehicle: { select: { branchId: true } } } },
} satisfies Prisma.AssignmentSelect;

/**
 * A run row, and the one relation that says what made it.
 *
 * Every optimiser run is created with a dispatch outbox row in the same
 * transaction — that is how a solve gets delivered at all. A confirmed
 * "Generate visits" writes a run to account for what it did and creates no
 * outbox row, because there is nothing to dispatch.
 */
type RunWithDispatch = ScheduleRun & { dispatchOutbox: { id: string } | null };

const RUN_KIND_INCLUDE = {
  dispatchOutbox: { select: { id: true } },
} satisfies Prisma.ScheduleRunInclude;

/**
 * What produced this run.
 *
 * Read from the dispatch outbox rather than from `trigger`, which defaults to
 * MANUAL and is left at the default by both — it has never told the two apart.
 * Deriving it here also settles the rows already in the database, which a new
 * column could not do without a backfill.
 */
function kindOf(run: RunWithDispatch): ScheduleRunDto['kind'] {
  return run.dispatchOutbox === null ? 'VISIT_GENERATION' : 'OPTIMIZER';
}

/** Only a finished, unpublished solve with results can still be published. */
function awaitsPublication(run: RunWithDispatch): boolean {
  return (
    kindOf(run) === 'OPTIMIZER' &&
    run.status === ScheduleRunStatus.SUCCEEDED &&
    run.publishedAt === null &&
    run.visitsScheduled > 0
  );
}

/**
 * `kind` is passed in rather than derived, because three of the five callers
 * already know it for certain: starting, cancelling and publishing are solver
 * endpoints, and no generation run can ever reach them.
 */
function toDto(
  run: ScheduleRun,
  warnings: ProvenanceWarning[],
  kind: ScheduleRunDto['kind'],
): ScheduleRunDto {
  return {
    id: run.id,
    kind,
    status: run.status,
    rangeStart: run.rangeStart.toISOString().slice(0, 10),
    rangeEnd: run.rangeEnd.toISOString().slice(0, 10),
    branchCode: run.branchCode,
    progressPercent: run.progressPercent,
    visitsConsidered: run.visitsConsidered,
    visitsScheduled: run.visitsScheduled,
    visitsUnassigned: run.visitsUnassigned,
    // A generation run has no publication to be ready for. Computing one
    // reported BLOCKED/ZERO_RESULTS on every single one of them — "this run
    // produced no dispatchable assignments", about a run that was never
    // trying to produce any.
    publishReadiness: kind === 'OPTIMIZER' ? publishReadiness(run, warnings) : null,
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
    return toDto((await this.dispatches.dispatch(run.id)) ?? run, [], 'OPTIMIZER');
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
        include: RUN_KIND_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const warnings = await this.provenanceWarningsByRun(rows);
    return {
      items: rows.map((run) => toDto(run, warnings.get(run.id) ?? [], kindOf(run))),
      total,
      page,
      pageSize,
    };
  }

  /**
   * One scalar-only read for the whole page, and only for the runs that can
   * still be published — a published or failed run has no decision left to
   * warn about.
   */
  private async provenanceWarningsByRun(
    runs: RunWithDispatch[],
  ): Promise<Map<string, ProvenanceWarning[]>> {
    const runIds = runs.filter(awaitsPublication).map((run) => run.id);
    if (runIds.length === 0) return new Map();

    const rows = await this.prisma.assignment.findMany({
      where: { scheduleRunId: { in: runIds }, status: AssignmentStatus.DRAFT },
      select: PROVENANCE_SELECT,
    });

    const byRun = new Map<string, typeof rows>();
    for (const row of rows) {
      if (row.scheduleRunId === null) continue;
      byRun.set(row.scheduleRunId, [...(byRun.get(row.scheduleRunId) ?? []), row]);
    }
    return new Map(
      [...byRun].map(([runId, assignments]) => [runId, provenanceWarnings(assignments)]),
    );
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
      include: RUN_KIND_INCLUDE,
    });
    const warnings = await this.provenanceWarningsByRun([run]);
    return toDto(run, warnings.get(run.id) ?? [], kindOf(run));
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
    return toDto(run, [], 'OPTIMIZER');
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
    const { run, provenanceWarnings: warnings } = await this.publishing.publish(
      id,
      dto.reason ?? null,
      actor,
      dto.acknowledgePartial === true,
      dto.acknowledgeProvenance === true,
    );
    return toDto(run, warnings, 'OPTIMIZER');
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

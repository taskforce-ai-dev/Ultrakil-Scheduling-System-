import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Job, Queue } from 'bullmq';

import { AuthenticatedUser } from '../../auth/auth.types';
import { QUEUE_HORIZON_EXTENSION } from '../../queue/queue.constants';
import { ExtendHorizonsDto } from './dto';
import { VisitGenerationService } from './visit-generation.service';

/**
 * Empty for the real repeatable job — every open-ended agreement in the
 * company, which is the actual operation (see `extendRollingHorizons`'s own
 * reasoning for why). A narrower scope is accepted only so this processor's
 * own wiring can be proven against one agreement at a time, without a test
 * having to sweep the whole, shared integration database to do it.
 */
export interface HorizonExtensionJobData {
  scope?: ExtendHorizonsDto;
}

export const HORIZON_EXTENSION_JOB = 'sweep';
/** One id, so every self-hosted deployment shares the same repeatable schedule. */
const HORIZON_EXTENSION_REPEAT_JOB_ID = 'rolling-horizon-daily-sweep';
/** Once a day, at an hour nothing else in this codebase schedules against. */
const HORIZON_EXTENSION_CRON = '0 3 * * *';

/**
 * The actor an unattended sweep runs as.
 *
 * Not a real row in `users` — every place this id could land
 * (`AuditEvent.actorUserId`, `ServiceAgreementVersion.changedByUserId`) is a
 * bare, unconstrained column, kept that way for exactly this reason: an
 * audit trail has to be able to say a scheduled job made a change without
 * inventing a login nobody can sign in as.
 */
export const HORIZON_EXTENSION_SYSTEM_ACTOR: AuthenticatedUser = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'rolling-horizon-scheduler@ultrakil.internal',
  fullName: 'Rolling Horizon Scheduler',
  role: UserRole.ADMIN,
};

/**
 * Keeps every open-ended agreement planned a rolling year ahead, without a
 * manager having to remember to call `POST /visit-generation/extend-horizons`.
 *
 * The Technical Director's review overrode this branch's own earlier
 * position that wiring a schedule was a deployment decision outside its
 * scope — this is that wiring. Self-hosted (BullMQ) deployments get a real
 * repeatable job, registered once below. A QStash/serverless deployment has
 * no persistent worker process to run a BullMQ repeatable job at all; the
 * same effect there is an operational step outside this codebase — a QStash
 * Schedule pointed at the same, already-idempotent
 * `POST /visit-generation/extend-horizons` endpoint. Stated rather than
 * silently left uncovered.
 *
 * Idempotent by construction: it calls the same scoped `confirm` a manager's
 * own click already uses, per agreement, so a sweep that finds an agreement
 * already caught up does nothing to it, and two sweeps that happen to
 * overlap queue behind each other's own agreement/branch-day locks rather
 * than double-planning anything.
 */
@Injectable()
@Processor(QUEUE_HORIZON_EXTENSION)
export class HorizonExtensionProcessor extends WorkerHost {
  private readonly logger = new Logger(HorizonExtensionProcessor.name);

  constructor(
    @Inject(VisitGenerationService)
    private readonly generation: VisitGenerationService,
  ) {
    super();
  }

  async process(job?: Job<HorizonExtensionJobData>): Promise<void> {
    const summary = await this.generation.extendRollingHorizons(
      HORIZON_EXTENSION_SYSTEM_ACTOR,
      job?.data.scope ?? {},
    );
    this.logger.log(
      `Rolling horizon sweep: ${summary.agreementsConsidered} open-ended agreements considered, ${summary.agreementsExtended.length} extended toward ${summary.targetHorizon}, ${summary.failures.length} could not be extended.`,
    );
    for (const failure of summary.failures) {
      this.logger.warn(
        `Rolling horizon sweep could not extend ${failure.customerName} — ${failure.siteName} (${failure.serviceAgreementId}): ${failure.message}`,
      );
    }
  }
}

/** Registers the repeatable job once the queue is up. Adds nothing else. */
@Injectable()
export class HorizonExtensionScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(QUEUE_HORIZON_EXTENSION) private readonly queue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Adding the same repeatable job (same name, pattern and jobId) again on
    // every process start is how BullMQ repeatable jobs are meant to be
    // (re-)registered — it does not create a second schedule.
    await this.queue.add(
      HORIZON_EXTENSION_JOB,
      {},
      {
        repeat: { pattern: HORIZON_EXTENSION_CRON },
        jobId: HORIZON_EXTENSION_REPEAT_JOB_ID,
      },
    );
  }
}

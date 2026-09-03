import { Module } from '@nestjs/common';

import { CalendarController } from './calendar/calendar.controller';
import { CalendarService } from './calendar/calendar.service';
import { PublishingService } from './optimizer/publishing.service';
import { ScheduleRunProcessor, ScheduleRunQueue } from './optimizer/schedule-run.processor';
import { ScheduleRunService } from './optimizer/schedule-run.service';
import { ScheduleRunsController } from './optimizer/schedule-runs.controller';
import { SchedulerClient } from './optimizer/scheduler.client';
import { AssignmentsController } from './eligibility/assignments.controller';
import { AssignmentsService } from './eligibility/assignments.service';
import { EligibilityService } from './eligibility/eligibility.service';
import { VisitGenerationController } from './visit-generation/visit-generation.controller';
import { VisitGenerationService } from './visit-generation/visit-generation.service';
import { VisitsController } from './visits/visits.controller';
import { VisitsService } from './visits/visits.service';

/**
 * Turning commitments into dated work.
 *
 * ULK-C04 covers generation — which visits the agreements require, and when.
 * ULK-C05 adds the eligibility engine: who may serve each one, and why not.
 * ULK-C06 adds the optimizer that chooses between the legal options, the locks
 * that protect a manager's decisions from it, and publishing.
 */
@Module({
  controllers: [
    VisitGenerationController,
    VisitsController,
    AssignmentsController,
    ScheduleRunsController,
    CalendarController,
  ],
  providers: [
    VisitGenerationService,
    VisitsService,
    EligibilityService,
    AssignmentsService,
    SchedulerClient,
    ScheduleRunService,
    ScheduleRunQueue,
    ScheduleRunProcessor,
    PublishingService,
    CalendarService,
  ],
  exports: [VisitGenerationService, VisitsService, EligibilityService, ScheduleRunService],
})
export class SchedulingModule {}

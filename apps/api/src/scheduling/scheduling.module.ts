import { DynamicModule, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CalendarController } from './calendar/calendar.controller';
import { CalendarService } from './calendar/calendar.service';
import { OperationsController } from './operations/operations.controller';
import { OperationsService } from './operations/operations.service';
import { PublishingService } from './optimizer/publishing.service';
import {
  ScheduleRunProcessor,
  ScheduleRunQueue,
} from './optimizer/schedule-run.processor';
import {
  createQStashClient,
  QSTASH_CLIENT,
  QStashScheduleRunDispatcher,
  SCHEDULE_RUN_DISPATCHER,
} from './optimizer/schedule-run.dispatcher';
import { ScheduleRunService } from './optimizer/schedule-run.service';
import { ScheduleRunDispatchService } from './optimizer/schedule-run-dispatch.service';
import { ScheduleRunsController } from './optimizer/schedule-runs.controller';
import {
  createQStashReceiver,
  QSTASH_RECEIVER,
  ScheduleRunQStashController,
} from './optimizer/schedule-run.qstash.controller';
import { SchedulerClient } from './optimizer/scheduler.client';
import { AssignmentsController } from './eligibility/assignments.controller';
import { AssignmentsService } from './eligibility/assignments.service';
import { EligibilityService } from './eligibility/eligibility.service';
import { VisitGenerationController } from './visit-generation/visit-generation.controller';
import { VisitGenerationService } from './visit-generation/visit-generation.service';
import { VisitsController } from './visits/visits.controller';
import { VisitsService } from './visits/visits.service';
import { PublishedAssignmentRepairController } from './repair/published-assignment-repair.controller';
import { PublishedAssignmentRepairPlannerAdapter } from './repair/published-assignment-repair-planner.adapter';
import { PublishedAssignmentRepairPlannerService } from './repair/published-assignment-repair-planner.service';
import { PublishedAssignmentRepairService } from './repair/published-assignment-repair.service';

/**
 * Turning commitments into dated work.
 *
 * ULK-C04 covers generation — which visits the agreements require, and when.
 * ULK-C05 adds the eligibility engine: who may serve each one, and why not.
 * ULK-C06 adds the optimizer that chooses between the legal options, the locks
 * that protect a manager's decisions from it, and publishing.
 */
@Module({})
export class SchedulingModule {
  static register(): DynamicModule {
    const qstash = process.env.SCHEDULE_DISPATCHER === 'qstash';
    return {
      module: SchedulingModule,
      controllers: [
        VisitGenerationController,
        VisitsController,
        AssignmentsController,
        ScheduleRunsController,
        CalendarController,
        OperationsController,
        PublishedAssignmentRepairController,
        ...(qstash ? [ScheduleRunQStashController] : []),
      ],
      providers: [
        VisitGenerationService,
        VisitsService,
        EligibilityService,
        AssignmentsService,
        SchedulerClient,
        ScheduleRunService,
        ScheduleRunDispatchService,
        PublishingService,
        CalendarService,
        OperationsService,
        PublishedAssignmentRepairService,
        PublishedAssignmentRepairPlannerAdapter,
        PublishedAssignmentRepairPlannerService,
        ...(qstash
          ? [
              {
                provide: QSTASH_CLIENT,
                inject: [ConfigService],
                useFactory: (config: ConfigService) =>
                  createQStashClient(
                    config.getOrThrow<string>(
                      'scheduleDispatch.qstash.token',
                    ),
                  ),
              },
              QStashScheduleRunDispatcher,
              {
                provide: QSTASH_RECEIVER,
                inject: [ConfigService],
                useFactory: (config: ConfigService) =>
                  createQStashReceiver(config),
              },
              {
                provide: SCHEDULE_RUN_DISPATCHER,
                useExisting: QStashScheduleRunDispatcher,
              },
            ]
          : [
              ScheduleRunQueue,
              ScheduleRunProcessor,
              {
                provide: SCHEDULE_RUN_DISPATCHER,
                useExisting: ScheduleRunQueue,
              },
            ]),
      ],
      exports: [
        VisitGenerationService,
        VisitsService,
        EligibilityService,
        ScheduleRunService,
      ],
    };
  }
}

import { Module } from '@nestjs/common';

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
 * Choosing between the eligible options is the optimizer, ULK-C06.
 */
@Module({
  controllers: [VisitGenerationController, VisitsController, AssignmentsController],
  providers: [VisitGenerationService, VisitsService, EligibilityService, AssignmentsService],
  exports: [VisitGenerationService, VisitsService, EligibilityService],
})
export class SchedulingModule {}

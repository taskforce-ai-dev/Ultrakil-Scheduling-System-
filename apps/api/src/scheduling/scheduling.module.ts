import { Module } from '@nestjs/common';

import { VisitGenerationController } from './visit-generation/visit-generation.controller';
import { VisitGenerationService } from './visit-generation/visit-generation.service';

/**
 * Turning commitments into dated work.
 *
 * ULK-C04 covers generation — which visits the agreements require, and when.
 * Deciding who serves each one is ULK-C05 and beyond; nothing here assigns a
 * crew or a vehicle.
 */
@Module({
  controllers: [VisitGenerationController],
  providers: [VisitGenerationService],
  exports: [VisitGenerationService],
})
export class SchedulingModule {}

import { Module } from '@nestjs/common';

import { SchedulingModule } from '../scheduling/scheduling.module';
import { AgreementsController, JobTypesController } from './agreements.controller';
import { AgreementsService } from './agreements.service';
import { CustomersController, ServiceSitesController } from './customers.controller';
import { CustomersService } from './customers.service';
import { JobTypesService } from './job-types.service';

/**
 * Customers, their sites, the job types offered, and the recurring service
 * agreements that tie the three together — everything the scheduler needs in
 * order to know what work is owed, before anyone decides who does it.
 *
 * Imports `SchedulingModule` one-way, never the reverse: `AgreementsService`
 * triggers a scoped generation the moment an agreement is created, so a
 * manager never has to remember a separate Generate Visits click for a new
 * client. Nothing in `scheduling` imports back from here.
 */
@Module({
  controllers: [
    CustomersController,
    ServiceSitesController,
    AgreementsController,
    JobTypesController,
  ],
  imports: [SchedulingModule.register()],
  providers: [CustomersService, AgreementsService, JobTypesService],
  exports: [CustomersService, AgreementsService, JobTypesService],
})
export class CatalogModule {}

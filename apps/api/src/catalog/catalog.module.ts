import { Module } from '@nestjs/common';

import { AgreementsController, JobTypesController } from './agreements.controller';
import { AgreementsService } from './agreements.service';
import { CustomersController, ServiceSitesController } from './customers.controller';
import { CustomersService } from './customers.service';
import { JobTypesService } from './job-types.service';

/**
 * Customers, their sites, the job types offered, and the recurring service
 * agreements that tie the three together — everything the scheduler needs in
 * order to know what work is owed, before anyone decides who does it.
 */
@Module({
  controllers: [
    CustomersController,
    ServiceSitesController,
    AgreementsController,
    JobTypesController,
  ],
  providers: [CustomersService, AgreementsService, JobTypesService],
  exports: [CustomersService, AgreementsService, JobTypesService],
})
export class CatalogModule {}

import { Module } from '@nestjs/common';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { ReferenceController } from './reference.controller';
import { VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';

@Module({
  controllers: [EmployeesController, VehiclesController, ReferenceController],
  providers: [EmployeesService, VehiclesService],
  exports: [EmployeesService, VehiclesService],
})
export class WorkforceModule {}

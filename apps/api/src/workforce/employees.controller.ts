import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import {
  CreateAvailabilityDto,
  CreateEmployeeDto,
  ReplaceSkillsDto,
  SetPermanentAssignmentDto,
  UpdateEmployeeDto,
} from './dto/employee.dto';
import { EmployeeQueryDto } from './dto/query.dto';
import { ApiEmployeeQuery } from './dto/query.swagger';
import { EmployeeDto, PaginatedEmployeesDto } from './dto/responses.dto';
import { EmployeesService } from './employees.service';
import { toEmployeeDto } from './workforce.mapper';

@ApiTags('workforce')
@ApiBearerAuth('bearer')
@ApiResponse({ status: 401, description: 'Missing or invalid token.' })
@Controller('employees')
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @ApiOperation({
    summary: 'List employees',
    description:
      'Filter by branch, PMS eligibility, deployment, skill, vehicle authorization, availability on a date and public-transport capability. PMS eligibility is decided by the API from the grade — never infer it in the client from the job title.',
  })
  @ApiEmployeeQuery()
  @ApiResponse({ status: 200, type: PaginatedEmployeesDto })
  async list(@Query() query: EmployeeQueryDto): Promise<PaginatedEmployeesDto> {
    const result = await this.employees.list(query);
    return { ...result, items: result.items.map(toEmployeeDto) };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One employee',
    description:
      'Includes skills, driving authorizations, recorded absences and the permanent site if there is one.',
  })
  @ApiResponse({ status: 200, type: EmployeeDto })
  @ApiResponse({ status: 404, description: 'No such employee.' })
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<EmployeeDto> {
    return toEmployeeDto(await this.employees.findOne(id));
  }

  @Post()
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Add an employee',
    description: 'Admin only. PMS eligibility is derived from the grade.',
  })
  @ApiResponse({ status: 403, description: 'Requires the ADMIN role.' })
  @ApiResponse({ status: 409, description: 'Same name already exists in that branch.' })
  @ApiResponse({
    status: 422,
    description: 'PERMANENT_SITE_REQUIRED — a stationed employee must name a site.',
  })
  @ApiResponse({ status: 201, type: EmployeeDto })
  async create(
    @Body() dto: CreateEmployeeDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<EmployeeDto> {
    return toEmployeeDto(await this.employees.create(dto, actor));
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update an employee',
    description:
      'Changing the grade re-derives PMS eligibility. A permanently stationed employee cannot be moved to the other branch.',
  })
  @ApiResponse({
    status: 422,
    description:
      'PERMANENT_EMPLOYEE_CANNOT_CHANGE_BRANCH or PERMANENT_SITE_REQUIRED.',
  })
  @ApiResponse({ status: 200, type: EmployeeDto })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEmployeeDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<EmployeeDto> {
    return toEmployeeDto(await this.employees.update(id, dto, actor));
  }

  @Post(':id/deactivate')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Deactivate an employee',
    description:
      'Admin only. Records are never deleted — completed assignments reference them, and history that loses its crew is worse than a disabled record.',
  })
  @ApiResponse({ status: 201, type: EmployeeDto })
  async deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<EmployeeDto> {
    return toEmployeeDto(await this.employees.setActive(id, false, actor));
  }

  @Post(':id/reactivate')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Reactivate an employee', description: 'Admin only.' })
  @ApiResponse({ status: 201, type: EmployeeDto })
  async reactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<EmployeeDto> {
    return toEmployeeDto(await this.employees.setActive(id, true, actor));
  }

  @Put(':id/permanent-assignment')
  @ApiOperation({
    summary: 'Set or clear the permanent site',
    description:
      'Naming a site marks the employee PERMANENTLY_STATIONED; passing null makes them MOBILE again. Sites are held as labels until customer sites exist (ULK-C03).',
  })
  @ApiResponse({ status: 200, type: EmployeeDto })
  async setPermanentAssignment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetPermanentAssignmentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<EmployeeDto> {
    return toEmployeeDto(
      await this.employees.setPermanentAssignment(id, dto.siteLabel, actor),
    );
  }

  @Put(':id/skills')
  @ApiOperation({
    summary: 'Replace an employee’s skills',
    description: 'The list given becomes the complete set. Anything omitted is removed.',
  })
  @ApiResponse({ status: 200, type: EmployeeDto })
  async replaceSkills(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplaceSkillsDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<EmployeeDto> {
    return toEmployeeDto(await this.employees.replaceSkills(id, dto.skills, actor));
  }

  @Post(':id/vehicle-authorizations/:vehicleId')
  @ApiOperation({
    summary: 'Authorise an employee to drive a vehicle',
    description:
      'Authorization only — this records nothing about ownership or who normally drives.',
  })
  @ApiResponse({ status: 409, description: 'Already authorised.' })
  @ApiResponse({ status: 422, description: 'Employee or vehicle is deactivated.' })
  @ApiResponse({ status: 201, type: EmployeeDto })
  async authorize(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vehicleId', ParseUUIDPipe) vehicleId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<EmployeeDto> {
    return toEmployeeDto(await this.employees.authorizeVehicle(id, vehicleId, actor));
  }

  @Delete(':id/vehicle-authorizations/:vehicleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Withdraw a driving authorization' })
  revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('vehicleId', ParseUUIDPipe) vehicleId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.employees.revokeVehicle(id, vehicleId, actor);
  }

  @Post(':id/availability')
  @ApiOperation({
    summary: 'Record an absence',
    description:
      'Absences are recorded, not availabilities — staff are available unless something says otherwise. Overlapping periods are rejected.',
  })
  @ApiResponse({ status: 409, description: 'AVAILABILITY_OVERLAPS with an existing absence.' })
  @ApiResponse({ status: 422, description: 'AVAILABILITY_RANGE_INVALID — end before start.' })
  @ApiResponse({ status: 201, type: EmployeeDto })
  async addAvailability(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAvailabilityDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<EmployeeDto> {
    return toEmployeeDto(await this.employees.addAvailability(id, dto, actor));
  }

  @Delete(':id/availability/:availabilityId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a recorded absence' })
  removeAvailability(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('availabilityId', ParseUUIDPipe) availabilityId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.employees.removeAvailability(id, availabilityId, actor);
  }
}

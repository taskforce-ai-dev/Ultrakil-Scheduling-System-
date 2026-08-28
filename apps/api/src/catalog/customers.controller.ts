import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { BranchCode, UserRole } from '@prisma/client';

import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { CustomersService } from './customers.service';
import {
  CreateCustomerDto,
  CreateServiceSiteDto,
  UpdateCustomerDto,
  UpdateServiceSiteDto,
} from './dto/customer.dto';
import { CustomerQueryDto } from './dto/query.dto';
import {
  CustomerDto,
  PaginatedCustomersDto,
  ServiceSiteDto,
} from './dto/responses.dto';

@ApiTags('customers')
@ApiBearerAuth('bearer')
@ApiResponse({ status: 401, description: 'Missing or invalid token.' })
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @ApiOperation({
    summary: 'List customers with their sites',
    description:
      'Each customer carries its sites and their opening hours, because a site is never useful on its own.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'branch', required: false, enum: BranchCode })
  @ApiQuery({
    name: 'active',
    required: false,
    type: Boolean,
    description: 'Defaults to active customers only.',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Matches customer name, code, or a site name.',
  })
  @ApiResponse({ status: 200, type: PaginatedCustomersDto })
  list(@Query() query: CustomerQueryDto): Promise<PaginatedCustomersDto> {
    return this.customers.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One customer' })
  @ApiResponse({ status: 200, type: CustomerDto })
  @ApiResponse({ status: 404, description: 'No such customer.' })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<CustomerDto> {
    return this.customers.get(id);
  }

  @Post()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Create a customer' })
  @ApiResponse({ status: 201, type: CustomerDto })
  @ApiResponse({ status: 409, description: 'CUSTOMER_CODE_TAKEN.' })
  create(
    @Body() dto: CreateCustomerDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<CustomerDto> {
    return this.customers.create(dto, actor);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update a customer' })
  @ApiResponse({ status: 200, type: CustomerDto })
  @ApiResponse({
    status: 409,
    description: 'CUSTOMER_CODE_TAKEN, or SITE_BRANCH_MISMATCH when it still has sites.',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<CustomerDto> {
    return this.customers.update(id, dto, actor);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Deactivate a customer',
    description:
      'Hidden from the default list but kept, because past visits and agreements reference it.',
  })
  @ApiResponse({ status: 200, type: CustomerDto })
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<CustomerDto> {
    return this.customers.setActive(id, false, actor);
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Reactivate a customer' })
  @ApiResponse({ status: 200, type: CustomerDto })
  reactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<CustomerDto> {
    return this.customers.setActive(id, true, actor);
  }

  // --- Sites ---------------------------------------------------------------

  @Get(':id/sites')
  @ApiOperation({ summary: "A customer's service sites" })
  @ApiResponse({ status: 200, type: [ServiceSiteDto] })
  listSites(@Param('id', ParseUUIDPipe) id: string): Promise<ServiceSiteDto[]> {
    return this.customers.listSites(id);
  }

  @Post(':id/sites')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Add a service site',
    description:
      "Inherits the customer's branch unless one is given, and may never sit in the other branch.",
  })
  @ApiResponse({ status: 201, type: ServiceSiteDto })
  @ApiResponse({
    status: 400,
    description: 'OPERATING_HOURS_INVALID or OPERATING_HOURS_OVERLAP.',
  })
  @ApiResponse({ status: 409, description: 'SITE_BRANCH_MISMATCH or CUSTOMER_INACTIVE.' })
  createSite(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateServiceSiteDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<ServiceSiteDto> {
    return this.customers.createSite(id, dto, actor);
  }
}

@ApiTags('customers')
@ApiBearerAuth('bearer')
@ApiResponse({ status: 401, description: 'Missing or invalid token.' })
@Controller('service-sites')
export class ServiceSitesController {
  constructor(private readonly customers: CustomersService) {}

  @Get(':id')
  @ApiOperation({ summary: 'One service site' })
  @ApiResponse({ status: 200, type: ServiceSiteDto })
  @ApiResponse({ status: 404, description: 'No such site.' })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<ServiceSiteDto> {
    return this.customers.getSite(id);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Update a service site',
    description:
      'Opening hours are replaced wholesale when given: send the week you want, and a weekday you omit means closed.',
  })
  @ApiResponse({ status: 200, type: ServiceSiteDto })
  @ApiResponse({
    status: 400,
    description: 'OPERATING_HOURS_INVALID or OPERATING_HOURS_OVERLAP.',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateServiceSiteDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<ServiceSiteDto> {
    return this.customers.updateSite(id, dto, actor);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Deactivate a site' })
  @ApiResponse({ status: 200, type: ServiceSiteDto })
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<ServiceSiteDto> {
    return this.customers.setSiteActive(id, false, actor);
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Reactivate a site' })
  @ApiResponse({ status: 200, type: ServiceSiteDto })
  reactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<ServiceSiteDto> {
    return this.customers.setSiteActive(id, true, actor);
  }
}

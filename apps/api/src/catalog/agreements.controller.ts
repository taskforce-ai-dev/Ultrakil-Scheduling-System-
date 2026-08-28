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
import {
  AgreementStatus,
  BranchCode,
  FrequencyUnit,
  UserRole,
} from '@prisma/client';

import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AgreementsService } from './agreements.service';
import {
  ChangeAgreementStatusDto,
  CreateJobTypeDto,
  CreateServiceAgreementDto,
  UpdateJobTypeDto,
  UpdateServiceAgreementDto,
} from './dto/agreement.dto';
import {
  JobTypeQueryDto,
  SchedulePreviewQueryDto,
  ServiceAgreementQueryDto,
} from './dto/query.dto';
import {
  AgreementVersionDto,
  JobTypeDto,
  PaginatedServiceAgreementsDto,
  SchedulePreviewDto,
  ServiceAgreementDto,
} from './dto/responses.dto';
import { JobTypesService } from './job-types.service';

@ApiTags('service-agreements')
@ApiBearerAuth('bearer')
@ApiResponse({ status: 401, description: 'Missing or invalid token.' })
@Controller('service-agreements')
export class AgreementsController {
  constructor(private readonly agreements: AgreementsService) {}

  @Get()
  @ApiOperation({
    summary: 'List service agreements',
    description: 'Archived agreements are hidden unless status=ARCHIVED is asked for.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'branch', required: false, enum: BranchCode })
  @ApiQuery({ name: 'customerId', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'serviceSiteId', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'jobTypeId', required: false, type: String, format: 'uuid' })
  @ApiQuery({ name: 'status', required: false, enum: AgreementStatus })
  @ApiQuery({ name: 'frequencyUnit', required: false, enum: FrequencyUnit })
  @ApiQuery({
    name: 'activeOn',
    required: false,
    type: String,
    format: 'date',
    description: 'Only agreements in force on this date.',
  })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiResponse({ status: 200, type: PaginatedServiceAgreementsDto })
  list(
    @Query() query: ServiceAgreementQueryDto,
  ): Promise<PaginatedServiceAgreementsDto> {
    return this.agreements.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One service agreement' })
  @ApiResponse({ status: 200, type: ServiceAgreementDto })
  @ApiResponse({ status: 404, description: 'No such agreement.' })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<ServiceAgreementDto> {
    return this.agreements.get(id);
  }

  @Post()
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Create a service agreement',
    description:
      'Branch and customer are taken from the site. Rejected if it could never produce a visit — an unschedulable commitment is caught here, not discovered later as a silent gap.',
  })
  @ApiResponse({ status: 201, type: ServiceAgreementDto })
  @ApiResponse({
    status: 400,
    description:
      'PREFERRED_DAYS_NOT_ALLOWED, ALLOWED_DAYS_REQUIRED, SERVICE_WINDOW_INVALID or AGREEMENT_DATES_INVALID.',
  })
  @ApiResponse({
    status: 422,
    description: 'AGREEMENT_UNSATISFIABLE — no visit can be placed at all.',
  })
  create(
    @Body() dto: CreateServiceAgreementDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<ServiceAgreementDto> {
    return this.agreements.create(dto, actor);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Update a service agreement',
    description:
      'Bumps the version, so visits already generated stay explainable against the agreement as it was.',
  })
  @ApiResponse({ status: 200, type: ServiceAgreementDto })
  @ApiResponse({ status: 409, description: 'AGREEMENT_ARCHIVED.' })
  @ApiResponse({ status: 422, description: 'AGREEMENT_UNSATISFIABLE.' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateServiceAgreementDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<ServiceAgreementDto> {
    return this.agreements.update(id, dto, actor);
  }

  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Pause, resume or archive an agreement',
    description:
      'PAUSED stops visit generation but expects it back. ARCHIVED is final — past visits are explained by it, so it can never be revived or edited.',
  })
  @ApiResponse({ status: 200, type: ServiceAgreementDto })
  @ApiResponse({ status: 409, description: 'AGREEMENT_ARCHIVED.' })
  changeStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeAgreementStatusDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<ServiceAgreementDto> {
    return this.agreements.changeStatus(id, dto, actor);
  }

  @Get(':id/versions')
  @ApiOperation({
    summary: 'Every version of this agreement',
    description:
      'Newest first. A generated visit records the version it came from, so a schedule can still be explained after the agreement changes.',
  })
  @ApiResponse({ status: 200, type: [AgreementVersionDto] })
  versions(@Param('id', ParseUUIDPipe) id: string): Promise<AgreementVersionDto[]> {
    return this.agreements.listVersions(id);
  }

  @Get(':id/schedule-preview')
  @ApiOperation({
    summary: 'Which dates this agreement asks for',
    description:
      'A preview of the required visits, not a schedule: it assigns nobody and books nothing. Periods that cannot hold the promised number of visits come back as shortfalls rather than being quietly dropped.',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    type: String,
    format: 'date',
    description: "Defaults to the agreement's start date.",
  })
  @ApiQuery({
    name: 'horizonWeeks',
    required: false,
    type: Number,
    description: 'How far ahead to look. Defaults to 4.',
  })
  @ApiResponse({ status: 200, type: SchedulePreviewDto })
  preview(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: SchedulePreviewQueryDto,
  ): Promise<SchedulePreviewDto> {
    return this.agreements.preview(id, query);
  }
}

@ApiTags('service-agreements')
@ApiBearerAuth('bearer')
@ApiResponse({ status: 401, description: 'Missing or invalid token.' })
@Controller('job-types')
export class JobTypesController {
  constructor(private readonly jobTypes: JobTypesService) {}

  @Get()
  @ApiOperation({ summary: 'List job types' })
  @ApiQuery({
    name: 'active',
    required: false,
    type: Boolean,
    description: 'Defaults to active job types only.',
  })
  @ApiResponse({ status: 200, type: [JobTypeDto] })
  list(@Query() query: JobTypeQueryDto): Promise<JobTypeDto[]> {
    return this.jobTypes.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One job type' })
  @ApiResponse({ status: 200, type: JobTypeDto })
  @ApiResponse({ status: 404, description: 'No such job type.' })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<JobTypeDto> {
    return this.jobTypes.get(id);
  }

  @Post()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Create a job type' })
  @ApiResponse({ status: 201, type: JobTypeDto })
  @ApiResponse({ status: 409, description: 'JOB_TYPE_CODE_TAKEN.' })
  create(
    @Body() dto: CreateJobTypeDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<JobTypeDto> {
    return this.jobTypes.create(dto, actor);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Update a job type' })
  @ApiResponse({ status: 200, type: JobTypeDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateJobTypeDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<JobTypeDto> {
    return this.jobTypes.update(id, dto, actor);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Deactivate a job type',
    description: 'Kept, not deleted — existing agreements still reference it.',
  })
  @ApiResponse({ status: 200, type: JobTypeDto })
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<JobTypeDto> {
    return this.jobTypes.setActive(id, false, actor);
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Reactivate a job type' })
  @ApiResponse({ status: 200, type: JobTypeDto })
  reactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<JobTypeDto> {
    return this.jobTypes.setActive(id, true, actor);
  }
}

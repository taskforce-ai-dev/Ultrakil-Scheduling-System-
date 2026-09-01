import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { BranchCode, UserRole } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { AssignmentsService } from './assignments.service';
import {
  AssignCrewDto,
  AssignmentDto,
  EligibilityResultDto,
  PaginatedUnassignedVisitsDto,
} from './dto';

@ApiTags('assignments')
@ApiBearerAuth('bearer')
@ApiResponse({ status: 401, description: 'Missing or invalid token.' })
@Controller()
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  @Post('visits/:id/assignment/check')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Would this crew be allowed to take the visit?',
    description:
      'Writes nothing. Returns every conflict, not just the first — a manager who fixes the branch only to be told the crew is too short, then that a skill is missing, stops trusting the screen.',
  })
  @ApiResponse({ status: 200, type: EligibilityResultDto })
  @ApiResponse({ status: 404, description: 'RESOURCE_NOT_FOUND' })
  check(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignCrewDto,
  ): Promise<EligibilityResultDto> {
    return this.assignments.check(id, dto);
  }

  @Get('visits/:id/assignment')
  @ApiOperation({ summary: 'The crew and vehicles on this visit, if any' })
  @ApiResponse({ status: 200, type: AssignmentDto })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<AssignmentDto | null> {
    return this.assignments.get(id);
  }

  @Put('visits/:id/assignment')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Put a crew on the visit',
    description:
      'Runs the eligibility engine first and refuses if any hard rule fails — there is no override, because a rule that can be skipped is not a hard rule. A refusal lists the visit in the Unassigned queue with every reason.',
  })
  @ApiResponse({ status: 200, type: AssignmentDto })
  @ApiResponse({
    status: 409,
    description: 'ASSIGNMENT_NOT_ELIGIBLE — details.conflicts holds every reason.',
  })
  assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignCrewDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<AssignmentDto> {
    return this.assignments.assign(id, dto, actor);
  }

  @Delete('visits/:id/assignment')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Take the crew off the visit',
    description: 'Returns the visit to the Unassigned queue. Refused while a lock is on it.',
  })
  @ApiResponse({ status: 204, description: 'Removed.' })
  unassign(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<void> {
    return this.assignments.unassign(id, actor);
  }

  @Get('unassigned-visits')
  @ApiOperation({
    summary: 'Work that still needs a crew, and why it has none',
    description:
      'Every visit with no crew on it — including ones nobody has tried to staff yet, which is most of them before the optimizer runs. Where a crew was proposed and refused, the full conflict list comes with it. This is the queue the hard rules protect: work is never quietly dropped.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, example: 50 })
  @ApiQuery({ name: 'branchCode', required: false, enum: Object.values(BranchCode) })
  @ApiQuery({ name: 'from', required: false, type: String, example: '2026-09-07' })
  @ApiQuery({ name: 'to', required: false, type: String, example: '2026-10-04' })
  @ApiQuery({
    name: 'serviceAgreementId',
    required: false,
    type: String,
    format: 'uuid',
    description: 'Only unstaffed visits generated from this agreement.',
  })
  @ApiQuery({
    name: 'withConflictsOnly',
    required: false,
    type: Boolean,
    description: 'Only visits already found to be unstaffable, rather than all unstaffed work.',
  })
  @ApiResponse({ status: 200, type: PaginatedUnassignedVisitsDto })
  queue(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('branchCode') branchCode?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('withConflictsOnly') withConflictsOnly?: string,
    @Query('serviceAgreementId') serviceAgreementId?: string,
  ): Promise<PaginatedUnassignedVisitsDto> {
    return this.assignments.unassignedQueue({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      branchCode,
      from,
      to,
      withConflictsOnly: withConflictsOnly === 'true' || withConflictsOnly === '1',
      serviceAgreementId,
    });
  }
}

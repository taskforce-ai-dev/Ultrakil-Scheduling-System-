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
import { CONFLICT_CODES } from './conflict-codes';
import {
  CONFLICT_GROUPS,
  UNASSIGNED_OPERATION_STATES,
} from './conflict-groups';
import {
  AssignCrewDto,
  AssignmentDto,
  EligibilityResultDto,
  EmployeeAssignmentQueryDto,
  PaginatedEmployeeAssignmentsDto,
  PaginatedUnassignedVisitsDto,
  UnassignedVisitQueryDto,
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
  @ApiResponse({
    status: 409,
    description: 'RESOURCE_CONFLICT — published assignment history or multiple active assignments prevent a draft eligibility check.',
  })
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
      'Every visit with no crew on it — including ones nobody has tried to staff yet, which is most of them before the optimizer runs. Where a crew was proposed and refused, the full conflict list comes with it. This is the queue the hard rules protect: work is never quietly dropped. Every filter is applied here, in the query, so the items, the total and the paging always describe the same set — which they cannot if a client re-filters the page it was handed. `visitId` is the one parameter that is not a filter: it names a single visit and overrides all the others, answering with that visit or with nothing.',
  })
  @ApiResponse({
    status: 400,
    description:
      'VALIDATION_FAILED — an unknown filter, or a conflict-group label sent as conflictCode.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, example: 50 })
  @ApiQuery({
    name: 'visitId',
    required: false,
    type: String,
    format: 'uuid',
    description:
      'One named visit, for the dispatch board\'s "Why?" deep link. A selector rather than a filter: every other parameter here is ignored when it is present, and the response describes exactly this visit wherever its date and whichever page it would otherwise fall on — one item when it still needs a crew, or an empty page with total 0 when the id is unknown or the visit has since been staffed, completed or cancelled. No other visit is ever returned alongside it, so an empty result means the named visit was not found rather than "here is something else".',
  })
  @ApiQuery({
    name: 'branchCode',
    required: false,
    enum: Object.values(BranchCode),
  })
  @ApiQuery({
    name: 'from',
    required: false,
    type: String,
    example: '2026-09-07',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    type: String,
    example: '2026-10-04',
  })
  @ApiQuery({
    name: 'serviceAgreementId',
    required: false,
    type: String,
    format: 'uuid',
    description: 'Only unstaffed visits generated from this agreement.',
  })
  @ApiQuery({
    name: 'checked',
    required: false,
    type: Boolean,
    description: 'true returns visits with recorded conflict checks; false returns unchecked visits.',
  })
  @ApiQuery({
    name: 'operationState',
    required: false,
    enum: UNASSIGNED_OPERATION_STATES,
    description:
      'UNASSIGNED: no eligibility conflicts are recorded against the visit, so nobody has proposed a crew for it yet. EXCEPTION: a crew was judged and refused and the reasons are stored. Omit for both.',
  })
  @ApiQuery({
    name: 'conflictGroup',
    required: false,
    enum: CONFLICT_GROUPS,
    description:
      'Only visits carrying at least one conflict in this manager-facing group. Each group maps to a fixed set of engine conflict codes. Facets remain scoped to the other filters.',
  })
  @ApiQuery({
    name: 'conflictCode',
    required: false,
    enum: CONFLICT_CODES,
    description: 'Only visits with this recorded conflict code. Engine vocabulary, not group vocabulary — a group label such as MISSING_SKILL belongs in conflictGroup. Facets remain scoped to the other filters.',
  })
  @ApiQuery({
    name: 'withConflictsOnly',
    required: false,
    type: Boolean,
    deprecated: true,
    description: 'Deprecated alias for checked=true.',
  })
  @ApiResponse({ status: 200, type: PaginatedUnassignedVisitsDto })
  queue(@Query() query: UnassignedVisitQueryDto): Promise<PaginatedUnassignedVisitsDto> {
    return this.assignments.unassignedQueue(query);
  }

  @Get('employees/:employeeId/assignments')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @ApiOperation({
    summary: "An employee's published daily assignments",
    description:
      'Manager/admin read model prepared for a future worker app. Only published-descended assignments with schedule-run or repair provenance and non-null publishedAt are returned. Dates and date filters use assignment plannedStart, preserving the published planned date if the visit is later moved. Phase 2 must add User-to-Employee identity linking and worker self-scope authorization before worker access is enabled.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, example: 50 })
  @ApiQuery({
    name: 'from',
    required: false,
    type: String,
    example: '2026-09-07',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    type: String,
    example: '2026-10-04',
  })
  @ApiResponse({ status: 200, type: PaginatedEmployeeAssignmentsDto })
  @ApiResponse({ status: 403, description: 'ADMIN or MANAGER role required.' })
  @ApiResponse({ status: 404, description: 'RESOURCE_NOT_FOUND' })
  employeeAssignments(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Query() query: EmployeeAssignmentQueryDto,
  ): Promise<PaginatedEmployeeAssignmentsDto> {
    return this.assignments.employeeAssignments(employeeId, query);
  }
}

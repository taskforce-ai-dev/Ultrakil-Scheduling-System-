import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import {
  PublishedAssignmentFindingQueryDto,
  PublishedAssignmentFindingsResponseDto,
  PublishedAssignmentRepairApplyDto,
  PublishedAssignmentRepairPreviewDto,
  PublishedAssignmentRepairPreviewResponseDto,
  PublishedAssignmentRepairResultDto,
} from './published-assignment-repair.dto';
import {
  PublishedAssignmentRepairPreview,
  PublishedAssignmentRepairResult,
  PublishedAssignmentRepairService,
} from './published-assignment-repair.service';

@ApiTags('published-assignment-repairs')
@ApiBearerAuth('bearer')
@ApiResponse({ status: 401, description: 'Missing or invalid token.' })
@Controller('operations/published-assignment-repairs')
export class PublishedAssignmentRepairController {
  constructor(private readonly repairs: PublishedAssignmentRepairService) {}

  @Get('findings')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @ApiOperation({
    summary: 'Find current published assignments that violate hard rules',
    description:
      'Read-only validation. Historical acknowledged, started, completed, cancelled, and superseded assignments are not automatic repair targets.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, example: 20 })
  @ApiResponse({ status: 200, type: PublishedAssignmentFindingsResponseDto })
  findings(@Query() query: PublishedAssignmentFindingQueryDto) {
    return this.repairs.validateCurrent(query);
  }

  @Post('preview')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Validate a repair batch without writing anything',
    description:
      'Returns a canonical plan hash and exact source fingerprints. Apply rejects them if any source or rule result changes.',
  })
  @ApiBody({ type: PublishedAssignmentRepairPreviewDto })
  @ApiResponse({
    status: 200,
    type: PublishedAssignmentRepairPreviewResponseDto,
  })
  preview(
    @Body() dto: PublishedAssignmentRepairPreviewDto,
  ): Promise<PublishedAssignmentRepairPreview> {
    return this.repairs.preview(dto);
  }

  @Post('apply')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Atomically apply a confirmed published-assignment repair',
    description:
      'Requires an administrator, reason, explicit confirmation, idempotency key, matching plan hash, and unchanged source fingerprints.',
  })
  @ApiBody({ type: PublishedAssignmentRepairApplyDto })
  @ApiResponse({ status: 200, type: PublishedAssignmentRepairResultDto })
  @ApiResponse({
    status: 409,
    description:
      'RESOURCE_CONFLICT or ASSIGNMENT_NOT_ELIGIBLE — run a new preview before retrying.',
  })
  apply(
    @Body() dto: PublishedAssignmentRepairApplyDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<PublishedAssignmentRepairResult> {
    return this.repairs.apply(dto, actor);
  }
}

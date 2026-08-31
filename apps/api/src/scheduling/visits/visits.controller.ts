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
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import {
  AdjustVisitDto,
  LockVisitDto,
  PaginatedVisitsDto,
  VisitDetailDto,
  VisitDto,
  VisitQueryDto,
} from './dto';
import { ApiVisitQuery } from './query.swagger';
import { VisitsService } from './visits.service';

@ApiTags('visits')
@ApiBearerAuth('bearer')
@ApiResponse({ status: 401, description: 'Missing or invalid token.' })
@Controller('visits')
export class VisitsController {
  constructor(private readonly visits: VisitsService) {}

  @Get()
  @ApiVisitQuery()
  @ApiOperation({
    summary: 'The generated calendar',
    description:
      'Visits in date order. Filter by branch, date range, status, customer or site. Each row says whether regeneration would leave it alone, and why.',
  })
  @ApiResponse({ status: 200, type: PaginatedVisitsDto })
  list(@Query() query: VisitQueryDto): Promise<PaginatedVisitsDto> {
    return this.visits.list(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'One visit, and why it exists',
    description:
      'Adds the agreement, the version it was generated from and the allowed days as they stood at that moment — so a visit can be explained even after the agreement has since changed.',
  })
  @ApiResponse({ status: 200, type: VisitDetailDto })
  @ApiResponse({ status: 404, description: 'RESOURCE_NOT_FOUND' })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<VisitDetailDto> {
    return this.visits.get(id);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Move or resize a visit by hand',
    description:
      'Marks the visit manually adjusted, which is what makes the next generation run leave it alone. A completed or cancelled visit is a record of what happened and is refused.',
  })
  @ApiResponse({ status: 200, type: VisitDto })
  @ApiResponse({ status: 400, description: 'SERVICE_WINDOW_INVALID' })
  @ApiResponse({ status: 409, description: 'RESOURCE_CONFLICT — the visit is finished.' })
  adjust(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdjustVisitDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<VisitDto> {
    return this.visits.adjust(id, dto, actor);
  }

  @Post(':id/lock')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pin a visit',
    description:
      'A locked visit survives every regeneration, whatever the agreement later says. Use it once a date is promised to a customer.',
  })
  @ApiResponse({ status: 200, type: VisitDto })
  lock(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LockVisitDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<VisitDto> {
    return this.visits.setLocked(id, true, dto, actor);
  }

  @Post(':id/unlock')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Release a pinned visit',
    description:
      'Hands the visit back to generation. If it was also hand-edited it stays protected on that ground.',
  })
  @ApiResponse({ status: 200, type: VisitDto })
  unlock(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<VisitDto> {
    return this.visits.setLocked(id, false, {}, actor);
  }
}

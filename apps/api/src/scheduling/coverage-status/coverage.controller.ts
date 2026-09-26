import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { BranchCode, UserRole } from '@prisma/client';

import { Roles } from '../../auth/decorators/roles.decorator';
import { CoverageService } from './coverage.service';
import { CoverageQueryDto, CoverageResponseDto } from './dto';

@ApiTags('coverage')
@ApiBearerAuth('bearer')
@Controller('scheduling/coverage')
export class CoverageController {
  constructor(private readonly coverage: CoverageService) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @ApiOperation({
    summary: 'Verified published coverage for a bounded rolling window',
    description:
      'Read-only. Drafts never count as dispatch. A day without a current completed staffing sweep is UNCHECKED, even when it has no generated visits.',
  })
  @ApiQuery({ name: 'from', required: true, type: String, format: 'date' })
  @ApiQuery({ name: 'to', required: true, type: String, format: 'date' })
  @ApiQuery({ name: 'branchCode', required: false, enum: BranchCode })
  @ApiResponse({ status: 200, type: CoverageResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid date or range wider than 31 days.' })
  list(@Query() query: CoverageQueryDto): Promise<CoverageResponseDto> {
    return this.coverage.list(query);
  }
}

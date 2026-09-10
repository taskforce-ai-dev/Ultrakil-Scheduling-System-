import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { BranchCode, UserRole } from '@prisma/client';

import { Roles } from '../../auth/decorators/roles.decorator';
import { OperationsDayQueryDto, OperationsDayResponseDto } from './dto';
import { OperationsService } from './operations.service';

@ApiTags('operations')
@ApiBearerAuth('bearer')
@Controller('operations')
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}

  @Get('day')
  @Roles(UserRole.ADMIN, UserRole.MANAGER)
  @ApiOperation({
    summary: 'Authoritative operational view for one day',
    description: 'Server-calculated dispatch state. Published work is dispatch truth; draft proposals remain separate.',
  })
  @ApiQuery({ name: 'date', required: true, type: String, format: 'date' })
  @ApiQuery({ name: 'branchCode', required: false, enum: BranchCode })
  @ApiResponse({ status: 200, type: OperationsDayResponseDto })
  day(@Query() query: OperationsDayQueryDto): Promise<OperationsDayResponseDto> {
    return this.operations.day(query);
  }
}

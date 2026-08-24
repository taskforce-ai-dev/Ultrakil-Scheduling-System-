import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { BranchCode, FrequencyUnit, Weekday } from '@prisma/client';
import { ErrorCode } from '../common/errors/error-codes';
import { PMS_GRADE_LABELS } from '../workforce/pms-grade';
import { MetaResponseDto } from './meta.types';

// Kept in sync with apps/api/package.json by the release process.
const API_VERSION = '0.1.0';

@ApiTags('meta')
@Controller('meta')
export class MetaController {
  @Get()
  @ApiOperation({
    summary: 'Shared vocabulary for clients',
    description:
      'Single source of truth for the enums and error codes the manager portal needs. Consuming this endpoint means the portal never hard-codes a list that the backend might change.',
  })
  @ApiResponse({ status: 200, type: MetaResponseDto })
  get(): MetaResponseDto {
    return {
      apiVersion: API_VERSION,
      timezone: 'Asia/Colombo',
      branchCodes: Object.values(BranchCode),
      weekdays: Object.values(Weekday),
      pmsGradeLabels: [...PMS_GRADE_LABELS],
      frequencyUnits: {
        [FrequencyUnit.WEEK]: 'visits per week',
        [FrequencyUnit.MONTH]: 'visits per month',
      },
      errorCodes: Object.values(ErrorCode),
    };
  }
}

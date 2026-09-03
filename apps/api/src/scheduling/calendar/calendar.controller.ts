import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { BranchCode } from '@prisma/client';

import { CalendarService } from './calendar.service';
import { CalendarQueryDto, CalendarResponseDto } from './dto';

@ApiTags('calendar')
@ApiBearerAuth('bearer')
@ApiResponse({ status: 401, description: 'Missing or invalid token.' })
@Controller('schedule/calendar')
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Get()
  @ApiOperation({
    summary: 'The unified schedule, one row per visit',
    description:
      'Date, time, crew, vehicle and status joined server-side so the manager portal can render one calendar instead of assembling it from several screens. Bounded to 120 days — page through the visits endpoint for a longer range.',
  })
  @ApiQuery({ name: 'from', required: true, type: String, example: '2026-09-07' })
  @ApiQuery({ name: 'to', required: true, type: String, example: '2026-10-04' })
  @ApiQuery({ name: 'branchCode', required: false, enum: Object.values(BranchCode) })
  @ApiResponse({ status: 200, type: CalendarResponseDto })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED — bad or too wide a date range.' })
  list(@Query() query: CalendarQueryDto): Promise<CalendarResponseDto> {
    return this.calendar.list(query);
  }
}

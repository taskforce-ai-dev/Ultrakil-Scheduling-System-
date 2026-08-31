import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { GenerateVisitsDto, GenerationImpactDto } from './dto';
import { VisitGenerationService } from './visit-generation.service';

@ApiTags('visit-generation')
@ApiBearerAuth('bearer')
@ApiResponse({ status: 401, description: 'Missing or invalid token.' })
@Controller('visit-generation')
export class VisitGenerationController {
  constructor(private readonly generation: VisitGenerationService) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'What generating this horizon would change',
    description:
      'Writes nothing. Returns the full impact: visits to add, untouched ones to update or remove, and the ones a manager owns — which are left alone and listed so the change is never a surprise. Confirm applies exactly this.',
  })
  @ApiResponse({ status: 200, type: GenerationImpactDto })
  @ApiResponse({
    status: 400,
    description: 'AGREEMENT_DATES_INVALID, or a horizon longer than a year.',
  })
  preview(@Body() dto: GenerateVisitsDto): Promise<GenerationImpactDto> {
    return this.generation.preview(dto);
  }

  @Post('confirm')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate the visits',
    description:
      'Applies what preview described and records a schedule run. Safe to repeat: a visit is identified by its agreement, date and start time, so running the same horizon twice leaves the calendar unchanged. Visits that are locked, hand-edited, scheduled or completed are never touched.',
  })
  @ApiResponse({ status: 200, type: GenerationImpactDto })
  confirm(
    @Body() dto: GenerateVisitsDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<GenerationImpactDto> {
    return this.generation.confirm(dto, actor);
  }
}

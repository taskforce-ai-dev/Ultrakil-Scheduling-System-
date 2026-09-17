import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';

import { AuthenticatedUser } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import {
  ExtendHorizonsDto,
  GenerateVisitsDto,
  GenerationImpactDto,
  HorizonExtensionSummaryDto,
} from './dto';
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
  // Declared explicitly: without it the contract described the response and
  // said nothing about the range being asked for, so `from` and `to` carried
  // none of the date-only shape every comparison in generation assumes.
  @ApiBody({ type: GenerateVisitsDto })
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
  @ApiBody({ type: GenerateVisitsDto })
  @ApiResponse({ status: 200, type: GenerationImpactDto })
  confirm(
    @Body() dto: GenerateVisitsDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<GenerationImpactDto> {
    return this.generation.confirm(dto, actor);
  }

  @Post('extend-horizons')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Keep every open-ended agreement planned a rolling year ahead',
    description:
      "Generates the missing stretch, up to a year from today, for every active agreement with no end date — an agreement with an end date is untouched, the same as it is for a dated range. Each agreement is planned through the same scoped confirm a manager's own Generate Visits uses, so it can only ever change that agreement's own visits, and calling this again immediately reports nothing further to do. Nothing calls this on its own; wiring it to a schedule is a deployment decision. Body is optional — omit it, or leave both fields out, to sweep every open-ended agreement in the company.",
  })
  @ApiBody({ type: ExtendHorizonsDto, required: false })
  @ApiResponse({ status: 200, type: HorizonExtensionSummaryDto })
  extendHorizons(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() scope: ExtendHorizonsDto = {},
  ): Promise<HorizonExtensionSummaryDto> {
    return this.generation.extendRollingHorizons(actor, scope);
  }
}

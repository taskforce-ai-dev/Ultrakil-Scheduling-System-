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
  RepairBunchingDto,
  RepairBunchingSummaryDto,
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
      "Generates the missing stretch, up to a year from today, for every active agreement with no end date — an agreement with an end date is untouched, the same as it is for a dated range. Each agreement is planned through the same scoped confirm a manager's own Generate Visits uses, so it can only ever change that agreement's own visits, and calling this again immediately reports nothing further to do. A self-hosted (BullMQ) deployment already calls this itself once a day (see HorizonExtensionScheduler) — this endpoint remains for an operator to sweep on demand, or for a QStash/serverless deployment's own external Schedule to call. Body is optional — omit it, or leave both fields out, to sweep every open-ended agreement in the company.",
  })
  @ApiBody({ type: ExtendHorizonsDto, required: false })
  @ApiResponse({ status: 200, type: HorizonExtensionSummaryDto })
  extendHorizons(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() scope: ExtendHorizonsDto = {},
  ): Promise<HorizonExtensionSummaryDto> {
    return this.generation.extendRollingHorizons(actor, scope);
  }

  @Post('repair-bunching')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Move an agreement\'s own unbooked visits off a day the current cap no longer allows',
    description:
      "Not a new kind of write: for every active agreement with a generated visit today or later, it calls the same scoped confirm a manager's own Generate Visits already uses, over the stretch that agreement already has generated. The load guard, reading the day's true crew-minutes, moves whichever of that agreement's own unbooked, unpublished visits no longer fit — exactly as it would for a newly generated one. A booked date, a published or locked visit, a hand-adjusted one, is never touched. For a calendar generated before capacity moved to crew-minutes, this is what brings it in line with the current cap without rewriting anything before today. Calling it again finds nothing left to move.",
  })
  @ApiBody({ type: RepairBunchingDto, required: false })
  @ApiResponse({ status: 200, type: RepairBunchingSummaryDto })
  repairBunching(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() scope: RepairBunchingDto = {},
  ): Promise<RepairBunchingSummaryDto> {
    return this.generation.repairBunching(actor, scope);
  }
}

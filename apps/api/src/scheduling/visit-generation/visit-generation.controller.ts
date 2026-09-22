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
  RepairBunchingApplyDto,
  RepairBunchingApplyResultDto,
  RepairBunchingDto,
  RepairBunchingPlanResponseDto,
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

  @Post('repair-bunching/plan')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "What un-bunching an agreement's own visits off a day the current cap no longer allows would move",
    description:
      "Writes nothing. For every active agreement with a generated visit today or later, works out — over the stretch that agreement already has generated — which of its own unbooked, unpublished visits the current crew-minutes cap would move, exactly as a newly generated one would be placed. A booked date, a published or locked visit, a hand-adjusted one is never listed as moving. Returns a planHash: pass it unchanged to apply, which refuses to run if the calendar has moved since.",
  })
  @ApiBody({ type: RepairBunchingDto, required: false })
  @ApiResponse({ status: 200, type: RepairBunchingPlanResponseDto })
  planBunchingRepair(
    @Body() scope: RepairBunchingDto = {},
  ): Promise<RepairBunchingPlanResponseDto> {
    return this.generation.planBunchingRepair(scope);
  }

  @Post('repair-bunching/apply')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Apply exactly the plan repair-bunching/plan described',
    description:
      "Applies what plan described, calling the same scoped confirm a manager's own Generate Visits already uses for each moved agreement — never a new kind of write. Requires the planHash plan returned, explicit confirmation, a reason and an idempotencyKey: repeating the same key with the same body returns the first application's own result again rather than moving anything twice; the same key with a different body is refused. If the calendar changed since the plan was reviewed, nothing is applied and a fresh plan is required. Calling it again after everything settled finds nothing left to move.",
  })
  @ApiBody({ type: RepairBunchingApplyDto })
  @ApiResponse({ status: 200, type: RepairBunchingApplyResultDto })
  @ApiResponse({
    status: 409,
    description:
      'RESOURCE_CONFLICT — either the plan is stale, or this idempotency key was already used for a different request.',
  })
  applyBunchingRepair(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() input: RepairBunchingApplyDto,
  ): Promise<RepairBunchingApplyResultDto> {
    return this.generation.applyBunchingRepair(actor, input);
  }
}

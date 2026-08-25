import { applyDecorators } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { AvailabilityKind, BranchCode, DeploymentType } from '@prisma/client';

/**
 * Query parameters, declared for the contract.
 *
 * NestJS cannot introspect a class passed to `@Query()` without the Swagger
 * CLI plugin, and that plugin is a build-time transformer that our
 * `tsx scripts/generate-openapi.ts` does not run. Left implicit, the contract
 * published every list endpoint with `parameters: []` — so the filters existed,
 * worked, and were invisible to the portal. Declaring them here keeps the
 * generated client and the running API in agreement.
 */

const pagination = [
  ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    example: 1,
    description: '1-based page number.',
  }),
  ApiQuery({
    name: 'pageSize',
    required: false,
    type: Number,
    example: 50,
    description: 'Up to 200 per page.',
  }),
];

export const ApiEmployeeQuery = () =>
  applyDecorators(
    ...pagination,
    ApiQuery({
      name: 'branch',
      required: false,
      enum: Object.values(BranchCode),
      description: 'Only employees of this branch.',
    }),
    ApiQuery({
      name: 'pmsGrade',
      required: false,
      type: Boolean,
      description:
        'true returns only PMS-grade supervisors. Decided by the API from the grade — do not infer it from the job title.',
    }),
    ApiQuery({
      name: 'deployment',
      required: false,
      enum: Object.values(DeploymentType),
      description:
        'PERMANENTLY_STATIONED for staff fixed to one site, MOBILE for dispatchable staff.',
    }),
    ApiQuery({
      name: 'skill',
      required: false,
      type: String,
      example: 'MBR_FUMIGATION',
      description: 'Normalised skill code. See GET /api/skills.',
    }),
    ApiQuery({
      name: 'vehicleId',
      required: false,
      type: String,
      format: 'uuid',
      description: 'Only employees authorised to drive this vehicle.',
    }),
    ApiQuery({
      name: 'availableOn',
      required: false,
      type: String,
      format: 'date',
      example: '2026-09-01',
      description:
        'Only employees with no recorded absence covering this date. Staff are available unless an absence says otherwise.',
    }),
    ApiQuery({
      name: 'canUsePublicTransport',
      required: false,
      type: Boolean,
      description:
        'Only employees who can reach a site by bus or other public transport.',
    }),
    ApiQuery({
      name: 'active',
      required: false,
      type: Boolean,
      description: 'Defaults to true. Pass false to see deactivated staff.',
    }),
    ApiQuery({
      name: 'search',
      required: false,
      type: String,
      description: 'Case-insensitive match on name or grade.',
    }),
  );

export const ApiVehicleQuery = () =>
  applyDecorators(
    ...pagination,
    ApiQuery({
      name: 'branch',
      required: false,
      enum: Object.values(BranchCode),
    }),
    ApiQuery({
      name: 'active',
      required: false,
      type: Boolean,
      description: 'Defaults to true.',
    }),
    ApiQuery({
      name: 'search',
      required: false,
      type: String,
      description: 'Match on registration or label.',
    }),
  );

export const ApiAvailabilityQuery = () =>
  applyDecorators(
    ApiQuery({
      name: 'kind',
      required: false,
      enum: Object.values(AvailabilityKind),
    }),
  );

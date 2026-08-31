import { applyDecorators } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { BranchCode, VisitStatus } from '@prisma/client';

/**
 * Query parameters for `GET /api/visits`, declared for the contract.
 *
 * Same reason as `workforce/dto/query.swagger.ts`: NestJS cannot introspect a
 * class passed to `@Query()` without the Swagger CLI plugin, which
 * `tsx scripts/generate-openapi.ts` does not run. Left implicit, the calendar
 * published `parameters: []` — every filter worked and none of them could be
 * discovered or typed by the portal.
 */
export const ApiVisitQuery = () =>
  applyDecorators(
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
      example: 100,
      description: 'Up to 500 per page — a month of real work runs to hundreds.',
    }),
    ApiQuery({
      name: 'from',
      required: false,
      type: String,
      example: '2026-09-07',
      description: 'Visits on or after this date.',
    }),
    ApiQuery({
      name: 'to',
      required: false,
      type: String,
      example: '2026-10-04',
      description: 'Visits on or before this date.',
    }),
    ApiQuery({
      name: 'branchCode',
      required: false,
      enum: Object.values(BranchCode),
      description: 'Colombo and Kandy workloads are never mixed.',
    }),
    ApiQuery({
      name: 'status',
      required: false,
      enum: Object.values(VisitStatus),
      description: 'SCHEDULED means a crew is assigned; UNASSIGNED means nobody is going yet.',
    }),
    ApiQuery({
      name: 'serviceAgreementId',
      required: false,
      type: String,
      format: 'uuid',
      description: 'Only visits generated from this agreement.',
    }),
    ApiQuery({
      name: 'serviceSiteId',
      required: false,
      type: String,
      format: 'uuid',
    }),
    ApiQuery({
      name: 'customerId',
      required: false,
      type: String,
      format: 'uuid',
    }),
    ApiQuery({
      name: 'jobTypeId',
      required: false,
      type: String,
      format: 'uuid',
      description: 'Only visits for this treatment.',
    }),
    ApiQuery({
      name: 'protectedOnly',
      required: false,
      type: Boolean,
      description: 'Only visits a manager owns — locked, hand-edited, scheduled or done.',
    }),
    ApiQuery({
      name: 'search',
      required: false,
      type: String,
      description: 'Matches customer or site name.',
    }),
  );

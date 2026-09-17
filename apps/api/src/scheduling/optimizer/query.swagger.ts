import { applyDecorators } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { ScheduleRunStatus } from '@prisma/client';

/**
 * Query parameters for `GET /api/schedule-runs`, declared for the contract.
 *
 * Same reason as `workforce/dto/query.swagger.ts` and
 * `scheduling/visits/query.swagger.ts`: NestJS cannot introspect a class
 * passed to `@Query()` without the Swagger CLI plugin, which
 * `tsx scripts/generate-openapi.ts` does not run. Left implicit, this
 * endpoint published `parameters: []` — `page`, `pageSize`, `status` and
 * `ids` all worked and none of them could be discovered or typed by the
 * portal, so a hand-written call was the only way to use them.
 */
export const ApiScheduleRunQuery = () =>
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
      example: 20,
      description: 'Up to 100 per page.',
    }),
    ApiQuery({
      name: 'status',
      required: false,
      enum: Object.values(ScheduleRunStatus),
    }),
    ApiQuery({
      name: 'ids',
      required: false,
      type: String,
      isArray: true,
      format: 'uuid',
      description:
        'Up to 50. Repeat the parameter for more than one id (?ids=a&ids=b) — the API also accepts a single bare id.',
    }),
  );

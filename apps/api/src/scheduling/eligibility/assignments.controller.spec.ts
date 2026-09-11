import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';

import { AssignmentsController } from './assignments.controller';
import { UnassignedVisitQueryDto } from './dto';

/**
 * The real HTTP boundary, not a stand-in for it.
 *
 * The pipe below is configured exactly as `apps/api/src/main.ts` configures
 * the global one — whitelist, forbidNonWhitelisted, transform and implicit
 * conversion. That combination is what turned the Unassigned queue's filters
 * into 400s: a mocked UI test cannot see it, because in the browser the
 * rejection happens on the other side of `fetch`.
 */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const asQuery: ArgumentMetadata = {
  type: 'query',
  metatype: UnassignedVisitQueryDto,
  data: '',
};

/** What the API would tell the caller it refused, and why. */
async function refusalMessages(query: Record<string, unknown>): Promise<string[]> {
  try {
    await pipe.transform(query, asQuery);
  } catch (caught) {
    const response = (caught as BadRequestException).getResponse();
    const message = (response as { message?: string[] }).message ?? [];
    return message;
  }
  throw new Error('Expected the query to be refused, but it was accepted.');
}

describe('GET /unassigned-visits query validation', () => {
  it('accepts the filters the Unassigned queue page sends', async () => {
    const query = (await pipe.transform(
      {
        page: '1',
        pageSize: '25',
        branchCode: 'KANDY',
        from: '2026-09-11',
        to: '2026-09-11',
        operationState: 'EXCEPTION',
        conflictGroup: 'MISSING_SKILL',
      },
      asQuery,
    )) as UnassignedVisitQueryDto;

    expect(query.operationState).toBe('EXCEPTION');
    expect(query.conflictGroup).toBe('MISSING_SKILL');
    expect(query.branchCode).toBe('KANDY');
    // Query strings arrive as strings; the handler is given numbers.
    expect(query.page).toBe(1);
    expect(query.pageSize).toBe(25);
  });

  it('accepts every conflict group the filter offers', async () => {
    for (const group of [
      'MISSING_PMS',
      'INSUFFICIENT_CREW',
      'MISSING_SKILL',
      'NO_AUTHORIZED_DRIVER',
      'UNAVAILABLE_VEHICLE',
      'BRANCH_RESTRICTION',
      'PERMANENT_STAFF_RESTRICTION',
      'SERVICE_WINDOW_CONFLICT',
      'EMPLOYEE_OVERLAP',
      'VEHICLE_OVERLAP',
      'CREW_CANNOT_TRAVEL',
      'OTHER',
    ]) {
      const query = (await pipe.transform(
        { conflictGroup: group },
        asQuery,
      )) as UnassignedVisitQueryDto;
      expect(query.conflictGroup).toBe(group);
    }
  });

  it('accepts both operation states', async () => {
    for (const state of ['UNASSIGNED', 'EXCEPTION']) {
      const query = (await pipe.transform(
        { operationState: state },
        asQuery,
      )) as UnassignedVisitQueryDto;
      expect(query.operationState).toBe(state);
    }
  });

  it('rejects the unsupported status filter the page used to send', async () => {
    // `status` was never a field of this DTO, and forbidNonWhitelisted means
    // the whole request is refused rather than the parameter ignored.
    await expect(
      pipe.transform({ status: 'EXCEPTION' }, asQuery),
    ).rejects.toBeInstanceOf(BadRequestException);
    // And it says which parameter it refused, rather than a bare 400.
    expect(await refusalMessages({ status: 'EXCEPTION' })).toEqual(
      expect.arrayContaining([expect.stringContaining('status')]),
    );
  });

  it('rejects a display-group label sent as conflictCode', async () => {
    // MISSING_SKILL is a manager-facing group, not an engine conflict code —
    // the engine's code is SKILL_NOT_HELD. Sending the group here is the
    // other half of the defect and must not be quietly accepted.
    await expect(
      pipe.transform({ conflictCode: 'MISSING_SKILL' }, asQuery),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await refusalMessages({ conflictCode: 'MISSING_SKILL' })).toEqual(
      expect.arrayContaining([expect.stringContaining('conflictCode')]),
    );
  });

  it('rejects the old status + display-group conflictCode combination outright', async () => {
    await expect(
      pipe.transform(
        { status: 'EXCEPTION', conflictCode: 'MISSING_SKILL' },
        asQuery,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an operation state and a conflict group it does not define', async () => {
    await expect(
      pipe.transform({ operationState: 'SKILL_NOT_HELD' }, asQuery),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      pipe.transform({ conflictGroup: 'SKILL_NOT_HELD' }, asQuery),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('still accepts an engine conflict code in conflictCode', async () => {
    const query = (await pipe.transform(
      { conflictCode: 'SKILL_NOT_HELD' },
      asQuery,
    )) as UnassignedVisitQueryDto;

    expect(query.conflictCode).toBe('SKILL_NOT_HELD');
  });

  it('hands the validated filters to the service instead of a client', async () => {
    const assignments = { unassignedQueue: jest.fn().mockResolvedValue({ items: [] }) };
    const controller = new AssignmentsController(assignments as never);

    const query = (await pipe.transform(
      { operationState: 'UNASSIGNED', conflictGroup: 'VEHICLE_OVERLAP' },
      asQuery,
    )) as UnassignedVisitQueryDto;
    await controller.queue(query);

    expect(assignments.unassignedQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        operationState: 'UNASSIGNED',
        conflictGroup: 'VEHICLE_OVERLAP',
      }),
    );
  });
});

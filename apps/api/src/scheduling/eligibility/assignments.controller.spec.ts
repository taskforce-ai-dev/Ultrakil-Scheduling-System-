import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';

import { VisitStatus } from '@prisma/client';

import { AssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';
import { PaginatedUnassignedVisitsDto, UnassignedVisitQueryDto } from './dto';

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
  // `Boolean('false')` is `true`. Under `enableImplicitConversion` a
  // `@Type(() => Boolean)` flag therefore answered `?checked=false` with
  // checked visits — the exact opposite of what was asked for — and the
  // deprecated `withConflictsOnly=false` alias switched conflict-only
  // filtering on. These pin the raw-string transform that fixes it.
  it.each([
    ['checked', 'true', true],
    ['checked', 'false', false],
    ['checked', '1', true],
    ['checked', '0', false],
    ['withConflictsOnly', 'true', true],
    ['withConflictsOnly', 'false', false],
    ['withConflictsOnly', '1', true],
    ['withConflictsOnly', '0', false],
  ])('reads ?%s=%s as %s', async (field, raw, expected) => {
    const query = (await pipe.transform({ [field]: raw }, asQuery)) as Record<string, unknown>;

    expect(query[field]).toBe(expected);
  });

  it.each(['checked', 'withConflictsOnly'])(
    'refuses a spelling of %s it cannot read rather than guessing',
    async (field) => {
      expect(await refusalMessages({ [field]: 'yes' })).toEqual(
        expect.arrayContaining([expect.stringContaining(field)]),
      );
    },
  );

  it('leaves an omitted boolean flag absent instead of defaulting it', async () => {
    const query = (await pipe.transform({}, asQuery)) as UnassignedVisitQueryDto;

    expect(query.checked).toBeUndefined();
    expect(query.withConflictsOnly).toBeUndefined();
  });

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

/**
 * The deep link, driven through the same boundary.
 *
 * The dispatch board's "Why?" sends a URL carrying one parameter — the visit
 * id — and the queue behind it defaults to today and page 1. A visit on any
 * other date, or past the first pageful, was therefore simply absent from the
 * response, and the screen showed the rows it did get instead.
 *
 * These drive the real ValidationPipe into the real controller into the real
 * service, over a Prisma double that actually honours `where`, `skip` and
 * `take`. A mock that only records the arguments it was handed cannot tell
 * whether the named visit comes back; this can.
 */
interface FakeVisit {
  id: string;
  visitDate: Date;
  branchCode: string;
  status: VisitStatus;
  hasLiveAssignment: boolean;
  customerName: string;
  reasonCodes: string[];
}

const TODAY = new Date('2026-09-11T00:00:00.000Z');
const ANOTHER_DATE = new Date('2026-11-24T00:00:00.000Z');

function visit(overrides: Partial<FakeVisit> & { id: string }): FakeVisit {
  return {
    visitDate: TODAY,
    branchCode: 'COLOMBO',
    status: VisitStatus.SCHEDULED,
    hasLiveAssignment: false,
    customerName: `Customer ${overrides.id}`,
    reasonCodes: [],
    ...overrides,
  };
}

/** A uuid the DTO will accept, distinct per index. */
function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function matches(row: FakeVisit, where: Record<string, any>): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.status?.notIn?.includes(row.status)) return false;
  if (where.assignments?.none && row.hasLiveAssignment) return false;
  if (where.branchCode !== undefined && row.branchCode !== where.branchCode) {
    return false;
  }
  if (where.visitDate?.gte && row.visitDate < where.visitDate.gte) return false;
  if (where.visitDate?.lte && row.visitDate > where.visitDate.lte) return false;
  for (const clause of where.AND ?? []) {
    const reasons = clause.unassignedReasons;
    if (reasons?.none && row.reasonCodes.length > 0) return false;
    if (reasons?.some) {
      const code = reasons.some.code;
      if (code === undefined) {
        if (row.reasonCodes.length === 0) return false;
      } else if (typeof code === 'string') {
        if (!row.reasonCodes.includes(code)) return false;
      } else if (code.in) {
        if (!row.reasonCodes.some((c) => code.in.includes(c))) return false;
      } else if (code.notIn) {
        if (!row.reasonCodes.some((c) => !code.notIn.includes(c))) return false;
      }
    }
  }
  return true;
}

function fakePrisma(rows: FakeVisit[]) {
  const select = (where: Record<string, any>) =>
    rows
      .filter((row) => matches(row, where))
      .sort((a, b) => a.visitDate.getTime() - b.visitDate.getTime());
  return {
    generatedVisit: {
      count: jest.fn(({ where }: any) => Promise.resolve(select(where).length)),
      findMany: jest.fn(({ where, skip, take }: any) =>
        Promise.resolve(
          select(where)
            .slice(skip, skip + take)
            .map((row) => ({
              id: row.id,
              visitDate: row.visitDate,
              branchCode: row.branchCode,
              requiredCrewSize: 2,
              updatedAt: TODAY,
              serviceAgreement: {
                customer: { name: row.customerName },
                serviceSite: { name: 'Main Kitchen' },
              },
              unassignedReasons: row.reasonCodes.map((code) => ({
                code,
                message: `${code} message`,
                details: null,
                createdAt: TODAY,
              })),
            })),
        ),
      ),
    },
    visitUnassignedReason: {
      groupBy: jest.fn(({ where }: any) => {
        const counts = new Map<string, number>();
        for (const row of select(where.generatedVisit)) {
          for (const code of row.reasonCodes) {
            counts.set(code, (counts.get(code) ?? 0) + 1);
          }
        }
        return Promise.resolve(
          [...counts.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([code, count]) => ({ code, _count: { code: count } })),
        );
      }),
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Everything the request does after it leaves the browser. */
async function get(
  rows: FakeVisit[],
  rawQuery: Record<string, unknown>,
): Promise<PaginatedUnassignedVisitsDto> {
  const prisma = fakePrisma(rows);
  const controller = new AssignmentsController(
    new AssignmentsService(prisma as never, {} as never, {} as never),
  );
  const query = (await pipe.transform(
    rawQuery,
    asQuery,
  )) as UnassignedVisitQueryDto;
  return controller.queue(query);
}

describe('GET /unassigned-visits?visitId= (the "Why?" deep link)', () => {
  const FOCUS = uuid(1);

  // A full first pageful of today's queue for the focused visit to hide behind.
  const todayQueue = Array.from({ length: 30 }, (_, index) =>
    visit({ id: uuid(100 + index), reasonCodes: ['CREW_TOO_SMALL'] }),
  );

  it('fetches a focused visit dated outside the date filter the queue is using', async () => {
    const rows = [
      ...todayQueue,
      visit({
        id: FOCUS,
        visitDate: ANOTHER_DATE,
        branchCode: 'KANDY',
        customerName: 'Grandview Hotel',
        reasonCodes: ['BRANCH_HAS_NO_PMS_SUPERVISOR'],
      }),
    ];

    // What the queue shows on its own: the focused visit is simply not in it.
    const queue = await get(rows, {
      from: '2026-09-11',
      to: '2026-09-11',
      pageSize: '25',
    });
    expect(queue.items.map((item) => item.visitId)).not.toContain(FOCUS);

    const focused = await get(rows, { visitId: FOCUS });

    expect(focused.items).toHaveLength(1);
    expect(focused.items[0].visitId).toBe(FOCUS);
    expect(focused.items[0].visitDate).toBe('2026-11-24');
    expect(focused.total).toBe(1);
  });

  it('fetches a focused visit that would fall beyond the first page', async () => {
    // Same date as the rest of the queue, but thirty-first in order.
    const beyond = visit({
      id: FOCUS,
      customerName: 'Cinnamon Grand Colombo',
      reasonCodes: ['SKILL_NOT_HELD'],
    });
    const rows = [...todayQueue, beyond];

    const firstPage = await get(rows, {
      from: '2026-09-11',
      to: '2026-09-11',
      page: '1',
      pageSize: '25',
    });
    expect(firstPage.items).toHaveLength(25);
    expect(firstPage.items.map((item) => item.visitId)).not.toContain(FOCUS);

    const focused = await get(rows, { visitId: FOCUS });

    expect(focused.items.map((item) => item.visitId)).toEqual([FOCUS]);
    expect(focused.total).toBe(1);
  });

  it('ignores every other filter rather than intersecting with them', async () => {
    // The manager may have left the queue on Kandy exceptions for one date.
    // The visit asked for by name is an unchecked Colombo visit on another
    // date entirely, and it is still the answer.
    const rows = [
      ...todayQueue,
      visit({ id: FOCUS, visitDate: ANOTHER_DATE, branchCode: 'COLOMBO' }),
    ];

    const focused = await get(rows, {
      visitId: FOCUS,
      branchCode: 'KANDY',
      from: '2026-09-11',
      to: '2026-09-11',
      operationState: 'EXCEPTION',
      conflictGroup: 'MISSING_PMS',
      page: '3',
      pageSize: '25',
    });

    expect(focused.items.map((item) => item.visitId)).toEqual([FOCUS]);
    // A focused answer reports itself as the single-row page it is.
    expect(focused.page).toBe(1);
    expect(focused.pageSize).toBe(1);
    expect(focused.hasNextPage).toBe(false);
  });

  it('answers an unknown visit id with nothing, never with the queue', async () => {
    const focused = await get(todayQueue, { visitId: uuid(999) });

    expect(focused.items).toEqual([]);
    expect(focused.total).toBe(0);
    expect(focused.hasNextPage).toBe(false);
    // The facets describe that same empty set, so nothing in the response can
    // be mistaken for an answer made of somebody else's rows.
    expect(focused.conflictFacets).toEqual({});
  });

  it('answers a visit that is no longer unassigned with nothing', async () => {
    const staffed = visit({ id: FOCUS, hasLiveAssignment: true });
    const completed = visit({ id: uuid(2), status: VisitStatus.COMPLETED });

    expect(
      (await get([...todayQueue, staffed], { visitId: FOCUS })).items,
    ).toEqual([]);
    expect(
      (await get([...todayQueue, completed], { visitId: uuid(2) })).items,
    ).toEqual([]);
  });

  it('refuses a malformed visit id at the boundary instead of guessing', async () => {
    await expect(
      pipe.transform({ visitId: 'not-a-visit-id' }, asQuery),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await refusalMessages({ visitId: 'not-a-visit-id' })).toEqual(
      expect.arrayContaining([expect.stringContaining('visitId')]),
    );
  });

  it("accepts the deep link's visit id as a parameter the API defines", async () => {
    const query = (await pipe.transform(
      { visitId: FOCUS },
      asQuery,
    )) as UnassignedVisitQueryDto;

    expect(query.visitId).toBe(FOCUS);
  });

  it('leaves the ordinary paginated queue untouched when no visit is named', async () => {
    const kandy = visit({
      id: uuid(3),
      branchCode: 'KANDY',
      reasonCodes: ['BRANCH_HAS_NO_PMS_SUPERVISOR'],
    });
    const unchecked = visit({ id: uuid(4) });
    const rows = [...todayQueue, kandy, unchecked];

    const first = await get(rows, {
      from: '2026-09-11',
      to: '2026-09-11',
      page: '1',
      pageSize: '25',
    });
    expect(first.items).toHaveLength(25);
    expect(first.total).toBe(32);
    expect(first.page).toBe(1);
    expect(first.pageSize).toBe(25);
    expect(first.hasNextPage).toBe(true);

    const second = await get(rows, {
      from: '2026-09-11',
      to: '2026-09-11',
      page: '2',
      pageSize: '25',
    });
    expect(second.items).toHaveLength(7);
    expect(second.page).toBe(2);
    expect(second.hasNextPage).toBe(false);

    // The filters and the facets still answer exactly as they did.
    const kandyOnly = await get(rows, { branchCode: 'KANDY' });
    expect(kandyOnly.items.map((item) => item.visitId)).toEqual([kandy.id]);

    const exceptions = await get(rows, { operationState: 'EXCEPTION' });
    expect(exceptions.total).toBe(31);
    expect(
      exceptions.items.every((item) => item.operationState === 'EXCEPTION'),
    ).toBe(true);

    const untried = await get(rows, { operationState: 'UNASSIGNED' });
    expect(untried.items.map((item) => item.visitId)).toEqual([unchecked.id]);

    // Facets stay scoped to the other filters, not to the conflict choice.
    expect(first.conflictFacets).toEqual({
      BRANCH_HAS_NO_PMS_SUPERVISOR: 1,
      CREW_TOO_SMALL: 30,
    });
  });
});

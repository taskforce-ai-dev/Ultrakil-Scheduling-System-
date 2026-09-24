import { ErrorCode } from '../../common/errors/error-codes';
import { AssignmentsService } from './assignments.service';

describe('AssignmentsService assignment read model', () => {
  it('returns active lock scopes, reasons, creation times and manager names in a stable order', async () => {
    const assignment = {
      id: 'assignment-1', generatedVisitId: 'visit-1', status: 'DRAFT', branchCode: 'COLOMBO',
      supersedesAssignmentId: null, publishedByRepairId: null,
      plannedStart: new Date('2026-09-09T09:00:00Z'),
      plannedEnd: new Date('2026-09-09T10:00:00Z'),
      createdAt: new Date('2026-09-08T00:00:00Z'),
      updatedAt: new Date('2026-09-08T01:00:00Z'),
      crewMembers: [], vehicles: [],
      locks: [
        { id: 'lock-vehicle', scope: 'VEHICLE', reason: null, lockedByUserId: null, createdAt: new Date('2026-09-08T11:00:00Z') },
        { id: 'lock-crew', scope: 'CREW', reason: 'Requested crew', lockedByUserId: 'manager-1', createdAt: new Date('2026-09-08T10:00:00Z') },
      ],
    };
    const prisma = {
      assignment: { findFirst: jest.fn().mockResolvedValue(assignment) },
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'manager-1', fullName: 'Fixture Manager' }]) },
    };
    const service = new AssignmentsService(prisma as never, {} as never, {} as never);

    const result = await service.get('visit-1');

    expect(prisma.assignment.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({ locks: { where: { releasedAt: null } } }),
    }));
    expect(result).toMatchObject({ isLocked: true, locks: [
      { id: 'lock-crew', scope: 'CREW', reason: 'Requested crew', lockedByUserId: 'manager-1', lockedByName: 'Fixture Manager', createdAt: '2026-09-08T10:00:00.000Z' },
      { id: 'lock-vehicle', scope: 'VEHICLE', reason: null, lockedByUserId: null, lockedByName: null, createdAt: '2026-09-08T11:00:00.000Z' },
    ] });
  });
});
describe('AssignmentsService candidates', () => {
  it('rejects an invalid candidate window before reading the visit', async () => {
    const prisma = { assignment: { findMany: jest.fn() } };
    const service = new AssignmentsService(prisma as never, {} as never, {} as never);

    await expect(service.candidates('visit', { plannedStartMinute: 1440, plannedEndMinute: 1440 }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(prisma.assignment.findMany).not.toHaveBeenCalled();
  });
  it('uses the same editability gate as check and delegates availability to EligibilityService', async () => {
    const prisma = {
      assignment: { findMany: jest.fn().mockResolvedValue([
        { id: 'draft', status: 'DRAFT', publishedAt: null, _count: { notificationOutboxEntries: 0 } },
      ]) },
    };
    const eligibility = { candidates: jest.fn().mockResolvedValue({ employees: [], vehicles: [] }) };
    const service = new AssignmentsService(prisma as never, eligibility as never, {} as never);

    await expect(service.candidates('visit', { plannedStartMinute: 540, plannedEndMinute: 660 }))
      .resolves.toEqual({ employees: [], vehicles: [] });
    expect(eligibility.candidates).toHaveBeenCalledWith('visit', {
      plannedStartMinute: 540,
      plannedEndMinute: 660,
    }, 'draft');
  });

  it('refuses multiple editable assignments with the same 409 as check', async () => {
    const prisma = {
      assignment: { findMany: jest.fn().mockResolvedValue([
        { id: 'draft-a', status: 'DRAFT', publishedAt: null, _count: { notificationOutboxEntries: 0 } },
        { id: 'draft-b', status: 'PROPOSED', publishedAt: null, _count: { notificationOutboxEntries: 0 } },
      ]) },
    };
    const service = new AssignmentsService(prisma as never, { candidates: jest.fn() } as never, {} as never);

    await expect(service.candidates('visit', { plannedStartMinute: 540, plannedEndMinute: 660 }))
      .rejects.toMatchObject({ code: 'RESOURCE_CONFLICT', message: 'This visit has multiple assignments. Refresh and resolve the conflicting schedule before changing its crew.' });
  });

  it('refuses published history before calling EligibilityService.candidates', async () => {
    const prisma = { assignment: { findMany: jest.fn().mockResolvedValue([
      { id: 'published', status: 'PUBLISHED', publishedAt: new Date(), _count: { notificationOutboxEntries: 1 } },
    ]) } };
    const eligibility = { candidates: jest.fn() };
    const service = new AssignmentsService(prisma as never, eligibility as never, {} as never);

    await expect(service.candidates('visit', { plannedStartMinute: 540, plannedEndMinute: 660 }))
      .rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(eligibility.candidates).not.toHaveBeenCalled();
  });
});

describe('AssignmentsService unassignedQueue', () => {
  it('keeps checked and conflict filters conjunctive and returns stable conflict facets', async () => {
    const prisma = {
      generatedVisit: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      visitUnassignedReason: {
        groupBy: jest.fn().mockResolvedValue([
          { code: ErrorCode.CREW_TOO_SMALL, _count: { code: 2 } },
          { code: ErrorCode.SKILL_NOT_HELD, _count: { code: 1 } },
        ]),
      },
    };
    const service = new AssignmentsService(prisma as never, {} as never, {} as never);

    const result = await service.unassignedQueue({
      checked: false,
      conflictCode: ErrorCode.CREW_TOO_SMALL,
      page: 2,
      pageSize: 10,
    });

    expect(prisma.generatedVisit.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        AND: expect.arrayContaining([
          { unassignedReasons: { none: {} } },
          { unassignedReasons: { some: { code: ErrorCode.CREW_TOO_SMALL } } },
        ]),
      }),
    });
    expect(prisma.visitUnassignedReason.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: { code: 'asc' },
    }));
    expect(result).toEqual({
      items: [], total: 0, page: 2, pageSize: 10, hasNextPage: false,
      conflictFacets: { [ErrorCode.CREW_TOO_SMALL]: 2, [ErrorCode.SKILL_NOT_HELD]: 1 },
    });
  });

  it('turns the operation state and conflict group into Prisma reason filters', async () => {
    const prisma = emptyQueuePrisma();
    const service = new AssignmentsService(prisma as never, {} as never, {} as never);

    await service.unassignedQueue({
      operationState: 'EXCEPTION',
      conflictGroup: 'MISSING_SKILL',
    });

    const expected = expect.objectContaining({
      AND: expect.arrayContaining([
        { unassignedReasons: { some: {} } },
        {
          unassignedReasons: {
            some: { code: { in: [ErrorCode.SKILL_NOT_HELD] } },
          },
        },
      ]),
    });
    // The list and the total are counted over the very same filter, which is
    // the whole point of filtering here instead of in the browser.
    expect(prisma.generatedVisit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expected }),
    );
    expect(prisma.generatedVisit.count).toHaveBeenCalledWith({ where: expected });
  });

  it('reads the UNASSIGNED state as "no conflicts recorded"', async () => {
    const prisma = emptyQueuePrisma();
    const service = new AssignmentsService(prisma as never, {} as never, {} as never);

    await service.unassignedQueue({ operationState: 'UNASSIGNED' });

    expect(prisma.generatedVisit.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        AND: [{ unassignedReasons: { none: {} } }],
      }),
    });
  });

  it('filters OTHER as everything outside the named groups', async () => {
    // Written as a complement so a stored code this catalogue has never seen
    // — which the UI shows under Other — is found by asking for Other.
    const prisma = emptyQueuePrisma();
    const service = new AssignmentsService(prisma as never, {} as never, {} as never);

    await service.unassignedQueue({ conflictGroup: 'OTHER' });

    const where = prisma.generatedVisit.count.mock.calls[0][0].where;
    const codeFilter = where.AND[0].unassignedReasons.some.code;
    expect(codeFilter.notIn).toContain(ErrorCode.SKILL_NOT_HELD);
    expect(codeFilter.notIn).not.toContain(ErrorCode.NO_FEASIBLE_CREW);
    expect(codeFilter.in).toBeUndefined();
  });

  it('leaves the conflict facets unnarrowed by the conflict-group filter', async () => {
    // The facets exist to say what the other groups would show; narrowing
    // them to the chosen group would answer only the question already asked.
    const prisma = emptyQueuePrisma();
    const service = new AssignmentsService(prisma as never, {} as never, {} as never);

    await service.unassignedQueue({
      operationState: 'EXCEPTION',
      conflictGroup: 'MISSING_SKILL',
    });

    expect(prisma.visitUnassignedReason.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          generatedVisit: expect.objectContaining({
            AND: [{ unassignedReasons: { some: {} } }],
          }),
        },
      }),
    );
  });

  it('tells each row its server-calculated operation state', async () => {
    const prisma = emptyQueuePrisma();
    prisma.generatedVisit.findMany.mockResolvedValue([
      queueRow('visit-checked', [
        { code: ErrorCode.SKILL_NOT_HELD, message: 'No skill', details: null, createdAt: new Date('2026-09-01T00:00:00.000Z') },
      ]),
      queueRow('visit-untried', []),
    ]);
    const service = new AssignmentsService(prisma as never, {} as never, {} as never);

    const result = await service.unassignedQueue({});

    expect(result.items.map((item) => item.operationState)).toEqual([
      'EXCEPTION',
      'UNASSIGNED',
    ]);
    expect(result.items.map((item) => item.hasBeenChecked)).toEqual([true, false]);
  });

  it('asks for the named visit alone, with none of the queue\'s filters on it', async () => {
    // The "Why?" deep link. Every other parameter is deliberately dropped:
    // keeping the date range or the page is precisely what hid a visit that
    // was not today's and not in the first pageful.
    const prisma = emptyQueuePrisma();
    const service = new AssignmentsService(prisma as never, {} as never, {} as never);

    await service.unassignedQueue({
      visitId: 'visit-asked-for',
      from: '2026-09-11',
      to: '2026-09-11',
      branchCode: 'KANDY',
      operationState: 'EXCEPTION',
      conflictGroup: 'MISSING_SKILL',
      page: 4,
      pageSize: 25,
    });

    const where = prisma.generatedVisit.count.mock.calls[0][0].where;
    expect(where.id).toBe('visit-asked-for');
    expect(where.visitDate).toBeUndefined();
    expect(where.branchCode).toBeUndefined();
    expect(where.AND).toBeUndefined();
    // Still only work that needs a crew — which is what lets an already
    // staffed or finished visit answer "not found" rather than turning up.
    expect(where.status.notIn).toEqual(
      expect.arrayContaining(['COMPLETED', 'CANCELLED']),
    );
    // And it reads the first row, not row 76 of a page nobody asked for.
    expect(prisma.generatedVisit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 1 }),
    );
    // The facets describe that same single visit.
    expect(prisma.visitUnassignedReason.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { generatedVisit: where } }),
    );
  });

  it('reports a focused answer as the single-row page it is', async () => {
    const prisma = emptyQueuePrisma();
    const service = new AssignmentsService(prisma as never, {} as never, {} as never);

    const result = await service.unassignedQueue({
      visitId: 'visit-asked-for',
      page: 9,
      pageSize: 25,
    });

    expect(result).toMatchObject({
      items: [],
      total: 0,
      page: 1,
      pageSize: 1,
      hasNextPage: false,
    });
  });
});

function emptyQueuePrisma() {
  return {
    generatedVisit: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    visitUnassignedReason: {
      groupBy: jest.fn().mockResolvedValue([]),
    },
  };
}

function queueRow(
  id: string,
  unassignedReasons: Array<{
    code: string;
    message: string;
    details: unknown;
    createdAt: Date;
  }>,
) {
  return {
    id,
    visitDate: new Date('2026-09-11T00:00:00.000Z'),
    branchCode: 'KANDY',
    requiredCrewSize: 2,
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    serviceAgreement: {
      customer: { name: 'Grandview Hotel' },
      serviceSite: { name: 'Main Kitchen' },
    },
    unassignedReasons,
  };
}

import { ErrorCode } from '../../common/errors/error-codes';
import { AssignmentsService } from './assignments.service';

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
});

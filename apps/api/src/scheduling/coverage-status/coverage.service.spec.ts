import { BranchCode } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { CoverageService, CoverageSweepReader } from './coverage.service';

const query = { from: '2026-09-26', to: '2026-10-25' };

function setup(visits: unknown[] = [], sweeps: unknown[] = []) {
  const findMany = jest.fn().mockResolvedValue(visits);
  const reader: CoverageSweepReader = { list: jest.fn().mockResolvedValue(sweeps) };
  const service = new CoverageService(
    { generatedVisit: { findMany } } as unknown as PrismaService,
    reader,
  );
  return { service, findMany, reader };
}

describe('read-only rolling coverage', () => {
  it('rejects reversed and wider-than-31-day ranges before touching the database', async () => {
    const { service, findMany } = setup();
    await expect(service.list({ from: query.to, to: query.from })).rejects.toThrow();
    await expect(service.list({ from: query.from, to: '2026-10-27' })).rejects.toThrow();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('does not claim coverage when no sweep has verified an empty window', async () => {
    const { service, findMany } = setup();
    const result = await service.list(query);
    expect(result.days).toHaveLength(30);
    expect(result.fullyPublished).toBe(false);
    expect(result.coveredThrough).toBeNull();
    expect(result.boundaryDay).toMatchObject({ date: query.to, state: 'UNCHECKED' });
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('requires both branches to verify even a no-due day', async () => {
    const sweeps = [BranchCode.COLOMBO, BranchCode.KANDY].map((branchCode) => ({
      date: query.from, branchCode,
      state: 'NOTHING_DUE' as const, verifiedAgainstCurrentData: true, shortfallCodes: [],
    }));
    const { service } = setup([], sweeps);
    const result = await service.list({ from: query.from, to: query.from });
    expect(result).toMatchObject({
      coveredThrough: query.from, fullyPublished: true,
      boundaryDay: { state: 'NOTHING_DUE', visitsDue: 0 },
    });
  });

  it('never counts a draft as a published dispatch', async () => {
    const { service } = setup([{
      id: 'visit-1', visitDate: new Date(`${query.from}T00:00:00Z`), branchCode: BranchCode.COLOMBO,
      assignments: [{ status: 'DRAFT' }], unassignedReasons: [],
    }], [{
      date: query.from, branchCode: BranchCode.COLOMBO,
      state: 'PREPARED_AWAITING_MANAGER', verifiedAgainstCurrentData: true, shortfallCodes: [],
    }]);
    const result = await service.list({ from: query.from, to: query.from, branchCode: BranchCode.COLOMBO });
    expect(result.boundaryDay).toMatchObject({
      state: 'PREPARED_AWAITING_MANAGER', visitsDue: 1, visitsPublished: 0, visitsPrepared: 1,
    });
  });

  it('does not let stale unassigned reasons override a now-published dispatch', async () => {
    const { service } = setup([{
      id: 'visit-1', visitDate: new Date(`${query.from}T00:00:00Z`), branchCode: BranchCode.COLOMBO,
      assignments: [{ status: 'PUBLISHED' }],
      unassignedReasons: [{ code: 'NO_CREW_AVAILABLE' }],
    }], [{
      date: query.from, branchCode: BranchCode.COLOMBO,
      state: 'COVERED_PUBLISHED', verifiedAgainstCurrentData: true, shortfallCodes: [],
    }]);
    const result = await service.list({ from: query.from, to: query.from, branchCode: BranchCode.COLOMBO });
    expect(result.boundaryDay.state).toBe('COVERED_PUBLISHED');
  });
});

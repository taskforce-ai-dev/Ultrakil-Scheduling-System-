import { BranchCode, Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { VehiclesService } from './vehicles.service';

type FindManyArgs = { where: Prisma.VehicleWhereInput };

function fixture() {
  const prisma = {
    vehicle: {
      count: jest.fn<Promise<number>, [{ where: Prisma.VehicleWhereInput }]>(async () => 0),
      findMany: jest.fn<Promise<unknown[]>, [FindManyArgs]>(async () => []),
    },
  };
  const audit = {} as AuditService;
  return { prisma, service: new VehiclesService(prisma as unknown as PrismaService, audit) };
}

describe('VehiclesService list', () => {
  it('filters an exact branch when asked for one', async () => {
    const { prisma, service } = fixture();

    await service.list({ branch: BranchCode.COLOMBO });

    expect(prisma.vehicle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ branch: { code: BranchCode.COLOMBO } }),
      }),
    );
  });

  // The Technician Matrix does not state a vehicle's branch, so imported
  // vehicles have none. The eligibility engine treats that as unknown, not
  // wrong; the list a picker offers must answer the same question.
  it('offers vehicles recorded in the branch or with no recorded branch when asked what can serve it', async () => {
    const { prisma, service } = fixture();

    await service.list({ servesBranch: BranchCode.KANDY });

    const where = prisma.vehicle.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([
      { OR: [{ branch: { code: BranchCode.KANDY } }, { branchId: null }] },
    ]);
    expect(where).not.toHaveProperty('branch');
    expect(prisma.vehicle.count).toHaveBeenCalledWith({ where });
  });

  // Two filters that are each a disjunction must both hold. Spreading them
  // onto one object let the second overwrite the first's OR, so a search
  // silently dropped the branch restriction.
  it('keeps the serving-branch restriction when a search is also given', async () => {
    const { prisma, service } = fixture();

    await service.list({ servesBranch: BranchCode.KANDY, search: 'van' });

    const where = prisma.vehicle.findMany.mock.calls[0][0].where;
    expect(where.AND).toHaveLength(2);
    expect(where.AND).toEqual(
      expect.arrayContaining([
        { OR: [{ branch: { code: BranchCode.KANDY } }, { branchId: null }] },
      ]),
    );
  });

  it('keeps an exact branch filter exact even when a serving branch is also given', async () => {
    const { prisma, service } = fixture();

    await service.list({ branch: BranchCode.KANDY, servesBranch: BranchCode.KANDY });

    const where = prisma.vehicle.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ branch: { code: BranchCode.KANDY } });
  });
});

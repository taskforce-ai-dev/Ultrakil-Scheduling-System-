import {
  BranchCode,
  DataProvenance,
  SiteBranchConfidence,
  SiteBranchSource,
  UserRole,
  Weekday,
} from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { CustomersService } from './customers.service';

const actor = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'admin@example.test',
  fullName: 'Admin',
  role: UserRole.ADMIN,
} as AuthenticatedUser;

describe('CustomersService manager provenance', () => {
  it('records a manager-created site branch and opening hours as confirmed', async () => {
    const customer = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Customer',
      branchCode: BranchCode.COLOMBO,
      isActive: true,
      serviceSites: [],
    };
    const tx = {
      serviceSite: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: '22222222-2222-4222-8222-222222222222',
          customerId: customer.id,
          name: 'Site',
          addressLine: null,
          city: null,
          branchCode: BranchCode.COLOMBO,
          isActive: true,
          operatingHours: [],
          _count: { serviceAgreements: 0 },
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
          updatedAt: new Date('2026-09-01T00:00:00.000Z'),
          ...data,
        })),
      },
    };
    const prisma = {
      customer: { findUnique: jest.fn(async () => customer) },
      branch: {
        findUnique: jest.fn(async () => ({
          id: '33333333-3333-4333-8333-333333333333',
          code: BranchCode.COLOMBO,
        })),
      },
      $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const service = new CustomersService(
      prisma as unknown as PrismaService,
      { record: jest.fn() } as unknown as AuditService,
    );

    await service.createSite(
      customer.id,
      {
        name: 'Site',
        operatingHours: [
          { weekday: Weekday.MONDAY, opensAtMinute: 540, closesAtMinute: 1020 },
        ],
      },
      actor,
    );

    expect(tx.serviceSite.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          branchConfidence: SiteBranchConfidence.CONFIRMED,
          branchSource: SiteBranchSource.MANAGER_CONFIRMED,
          operatingHours: {
            create: [
              expect.objectContaining({
                provenance: DataProvenance.MANAGER_CONFIRMED,
              }),
            ],
          },
        }),
      }),
    );
  });
});

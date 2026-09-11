import {
  AgreementStatus,
  BranchCode,
  DataProvenance,
  FrequencyUnit,
  UserRole,
  Weekday,
} from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { AgreementsService } from './agreements.service';

const actor = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'admin@example.test',
  fullName: 'Admin',
  role: UserRole.ADMIN,
} as AuthenticatedUser;

const agreementId = '11111111-1111-4111-8111-111111111111';

function agreement(overrides: Record<string, unknown> = {}) {
  return {
    id: agreementId,
    customerId: '22222222-2222-4222-8222-222222222222',
    serviceSiteId: '33333333-3333-4333-8333-333333333333',
    jobTypeId: '44444444-4444-4444-8444-444444444444',
    branchId: '55555555-5555-4555-8555-555555555555',
    branchCode: BranchCode.COLOMBO,
    frequencyCount: 1,
    frequencyUnit: FrequencyUnit.WEEK,
    frequencyInterval: 1,
    crewSize: 2,
    durationMinutes: 60,
    crewSizeProvenance: DataProvenance.SOURCE,
    durationProvenance: DataProvenance.SOURCE,
    dayRuleProvenance: DataProvenance.SOURCE,
    serviceWindowStartMinute: null,
    serviceWindowEndMinute: null,
    startDate: new Date('2026-09-07T00:00:00.000Z'),
    endDate: null,
    status: AgreementStatus.ACTIVE,
    importedInactiveAt: null,
    currentVersion: 1,
    notes: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    customer: { id: '22222222-2222-4222-8222-222222222222', name: 'Customer' },
    serviceSite: { id: '33333333-3333-4333-8333-333333333333', name: 'Site' },
    jobType: { id: '44444444-4444-4444-8444-444444444444', name: 'Job' },
    dayRules: [{ id: 'day', weekday: Weekday.MONDAY, kind: 'ALLOWED' }],
    requiredSkills: [],
    ...overrides,
  };
}

function fixture(row = agreement()) {
  const tx = {
    serviceAgreement: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...row,
        ...data,
      })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...row,
        ...data,
        currentVersion:
          typeof data.currentVersion === 'object' ? row.currentVersion + 1 : row.currentVersion,
      })),
    },
    serviceAgreementVersion: { create: jest.fn() },
  };
  const prisma = {
    serviceAgreement: { findUnique: jest.fn(async () => row) },
    serviceSite: {
      findUnique: jest.fn(async () => ({
        id: row.serviceSiteId,
        customerId: row.customerId,
        branchId: row.branchId,
        branchCode: row.branchCode,
        name: 'Site',
        isActive: true,
        operatingHours: [],
        customer: { name: 'Customer', isActive: true },
      })),
    },
    jobType: {
      findUnique: jest.fn(async () => ({
        id: row.jobTypeId,
        name: 'Job',
        isActive: true,
        defaultCrewSize: 2,
        defaultDurationMinutes: 60,
      })),
    },
    $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const audit = { record: jest.fn() };
  const service = new AgreementsService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
  );
  return { service, tx };
}

describe('AgreementsService manager provenance', () => {
  it('records every value of a manager-created agreement as manager confirmed', async () => {
    const { service, tx } = fixture();

    await service.create(
      {
        serviceSiteId: '33333333-3333-4333-8333-333333333333',
        jobTypeId: '44444444-4444-4444-8444-444444444444',
        frequencyCount: 1,
        frequencyUnit: FrequencyUnit.WEEK,
        allowedDays: [Weekday.MONDAY],
        startDate: '2026-09-07',
      },
      actor,
    );

    expect(tx.serviceAgreement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          crewSizeProvenance: DataProvenance.MANAGER_CONFIRMED,
          durationProvenance: DataProvenance.MANAGER_CONFIRMED,
          dayRuleProvenance: DataProvenance.MANAGER_CONFIRMED,
        }),
      }),
    );
  });

  it('reactivates only an importer-archived agreement and preserves its inactive timestamp', async () => {
    const importedInactiveAt = new Date('2026-09-03T00:00:00.000Z');
    const row = agreement({ status: AgreementStatus.ARCHIVED, importedInactiveAt });
    const { service, tx } = fixture(row);

    await (
      service as unknown as {
        reactivateImported(id: string, actor: AuthenticatedUser): Promise<unknown>;
      }
    ).reactivateImported(agreementId, actor);

    expect(tx.serviceAgreement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: agreementId },
        data: {
          status: AgreementStatus.ACTIVE,
          currentVersion: { increment: 1 },
        },
      }),
    );
    expect(row.importedInactiveAt).toBe(importedInactiveAt);
  });
});

/**
 * A hand-corrected visit window is a manager's fact, not an assumption.
 *
 * Generation stamps `windowProvenance` DEFAULTED when it had to fall back to
 * the disclosed 08:00-17:00 assumption, and the operations read model turns
 * that into a source-data warning. Once a manager has actually set the window,
 * the warning is wrong — so the correction has to say so.
 */
import { DataProvenance, UserRole, VisitStatus } from '@prisma/client';

import { AuditService } from '../../audit/audit.service';
import { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../prisma/prisma.service';
import { EligibilityService } from '../eligibility/eligibility.service';
import { VisitsService } from './visits.service';

const actor = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'admin@example.test',
  fullName: 'Admin',
  role: UserRole.ADMIN,
} as AuthenticatedUser;

const VISIT_ID = '11111111-1111-4111-8111-111111111111';

function visitRow(overrides: Record<string, unknown> = {}) {
  return {
    id: VISIT_ID,
    serviceAgreementId: '22222222-2222-4222-8222-222222222222',
    branchId: '33333333-3333-4333-8333-333333333333',
    branchCode: 'COLOMBO',
    visitDate: new Date('2026-09-07T00:00:00.000Z'),
    windowStartMinute: 480,
    windowEndMinute: 1020,
    durationMinutes: 60,
    requiredCrewSize: 2,
    // What the importer's silence leaves behind.
    windowProvenance: DataProvenance.DEFAULTED,
    status: VisitStatus.PENDING,
    isManuallyAdjusted: false,
    manuallyAdjustedAt: null,
    manuallyAdjustedBy: null,
    lockedAt: null,
    lockedByUserId: null,
    lockReason: null,
    generatedByRunId: null,
    agreementVersionId: null,
    agreementVersion: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    serviceAgreement: {
      id: '22222222-2222-4222-8222-222222222222',
      frequencyCount: 1,
      frequencyUnit: 'WEEK',
      frequencyInterval: 1,
      customer: { id: '44444444-4444-4444-8444-444444444444', name: 'Customer' },
      serviceSite: {
        id: '55555555-5555-4555-8555-555555555555',
        name: 'Site',
        _count: { operatingHours: 0 },
      },
      jobType: { name: 'Job' },
    },
    _count: { assignments: 0 },
    ...overrides,
  };
}

function fixture(row = visitRow()) {
  const tx = {
    // The row locks the real transaction takes; nothing to fence in a unit test.
    $queryRaw: jest.fn(async () => [{ id: VISIT_ID }]),
    assignment: { findMany: jest.fn(async () => []) },
    generatedVisit: {
      findUnique: jest.fn(async () => row),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...row,
        ...data,
      })),
    },
  };

  const prisma = {
    $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) =>
      work(tx),
    ),
  };

  const service = new VisitsService(
    prisma as unknown as PrismaService,
    { record: jest.fn() } as unknown as AuditService,
    { evaluate: jest.fn() } as unknown as EligibilityService,
  );

  return { service, tx };
}

function dataOf(mock: jest.Mock): Record<string, unknown> {
  expect(mock).toHaveBeenCalledTimes(1);
  return (mock.mock.calls[0][0] as { data: Record<string, unknown> }).data;
}

describe('VisitsService window provenance', () => {
  it('records a hand-corrected window as manager confirmed', async () => {
    const { service, tx } = fixture();

    await service.adjust(VISIT_ID, { windowStartMinute: 600 }, actor);

    expect(dataOf(tx.generatedVisit.update as jest.Mock)).toMatchObject({
      windowStartMinute: 600,
      windowProvenance: DataProvenance.MANAGER_CONFIRMED,
      isManuallyAdjusted: true,
    });
  });

  it('leaves the window unconfirmed when the edit never touched it', async () => {
    // Changing how many people a visit needs says nothing about whether the
    // assumed opening hours behind its window were right.
    const { service, tx } = fixture();

    await service.adjust(VISIT_ID, { requiredCrewSize: 3 }, actor);

    const data = dataOf(tx.generatedVisit.update as jest.Mock);
    expect(data).toMatchObject({ requiredCrewSize: 3, isManuallyAdjusted: true });
    expect(data).not.toHaveProperty('windowProvenance');
  });
});

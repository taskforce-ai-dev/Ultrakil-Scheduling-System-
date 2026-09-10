import { AssignmentRepairAction, UserRole } from '@prisma/client';

import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EligibilityService } from '../eligibility/eligibility.service';
import { PublishedAssignmentRepairService } from './published-assignment-repair.service';
import { CONFLICT_CODES } from '../eligibility/conflict-codes';

function fixture() {
  const prisma = {
    publishedAssignmentRepair: { findUnique: jest.fn() },
  };
  return {
    prisma,
    service: new PublishedAssignmentRepairService(
      prisma as unknown as PrismaService,
      {} as EligibilityService,
      {} as AuditService,
    ),
  };
}

const validRequest = {
  operations: [
    {
      sourceAssignmentId: '11111111-1111-4111-8111-111111111111',
      action: AssignmentRepairAction.WITHDRAWN,
      unassignedReasons: [{ code: 'CREW_CANNOT_TRAVEL', message: 'Unsafe.' }],
    },
  ],
  planHash: 'a'.repeat(64),
  sourceFingerprints: [
    {
      sourceAssignmentId: '11111111-1111-4111-8111-111111111111',
      fingerprint: 'b'.repeat(64),
    },
  ],
  confirmation: true,
  reason: 'Correct legacy assignment',
  idempotencyKey: 'repair-1',
};

const admin = {
  id: 'admin',
  email: 'admin@example.test',
  fullName: 'Admin',
  role: UserRole.ADMIN,
};

describe('PublishedAssignmentRepairService apply gates', () => {
  it('keeps NO_FEASIBLE_CREW as a stable manager-facing reason code', () => {
    expect(CONFLICT_CODES).toContain('NO_FEASIBLE_CREW');
  });
  it('rejects a non-admin before reading or writing repair state', async () => {
    const { service, prisma } = fixture();

    await expect(
      service.apply(validRequest, { ...admin, role: UserRole.MANAGER }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
    expect(prisma.publishedAssignmentRepair.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    { confirmation: false },
    { reason: '   ' },
    { idempotencyKey: '' },
    { planHash: 'not-a-hash' },
  ])('rejects a missing apply gate before database access', async (override) => {
    const { service, prisma } = fixture();

    await expect(service.apply({ ...validRequest, ...override }, admin)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(prisma.publishedAssignmentRepair.findUnique).not.toHaveBeenCalled();
  });
});

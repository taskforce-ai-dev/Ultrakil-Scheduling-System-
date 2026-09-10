import { UserRole } from '@prisma/client';

import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import { PublishedAssignmentRepairController } from './published-assignment-repair.controller';
import { PublishedAssignmentRepairService } from './published-assignment-repair.service';

describe('PublishedAssignmentRepairController', () => {
  it('exposes findings and preview to managers but reserves apply for administrators', () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, PublishedAssignmentRepairController.prototype.findings),
    ).toEqual([UserRole.ADMIN, UserRole.MANAGER]);
    expect(
      Reflect.getMetadata(ROLES_KEY, PublishedAssignmentRepairController.prototype.preview),
    ).toEqual([UserRole.ADMIN, UserRole.MANAGER]);
    expect(
      Reflect.getMetadata(ROLES_KEY, PublishedAssignmentRepairController.prototype.apply),
    ).toEqual([UserRole.ADMIN]);
  });

  it('delegates apply with the authenticated administrator', async () => {
    const result = { repairId: 'repair-id', items: [] };
    const repairs = {
      apply: jest.fn(async () => result),
    };
    const controller = new PublishedAssignmentRepairController(
      repairs as unknown as PublishedAssignmentRepairService,
    );
    const request = {
      operations: [],
      planHash: 'a'.repeat(64),
      sourceFingerprints: [],
      confirmation: true,
      reason: 'Correct legacy data',
      idempotencyKey: 'repair-1',
    };
    const actor = {
      id: 'actor',
      email: 'admin@example.test',
      fullName: 'Admin',
      role: UserRole.ADMIN,
    };

    await expect(controller.apply(request, actor)).resolves.toBe(result);
    expect(repairs.apply).toHaveBeenCalledWith(request, actor);
  });
});

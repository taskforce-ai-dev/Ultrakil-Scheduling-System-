import { UserRole } from '@prisma/client';

import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import { PublishedAssignmentRepairController } from './published-assignment-repair.controller';
import { PublishedAssignmentRepairPlannerService } from './published-assignment-repair-planner.service';
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
      Reflect.getMetadata(ROLES_KEY, PublishedAssignmentRepairController.prototype.plan),
    ).toEqual([UserRole.ADMIN, UserRole.MANAGER]);
    expect(
      Reflect.getMetadata(ROLES_KEY, PublishedAssignmentRepairController.prototype.apply),
    ).toEqual([UserRole.ADMIN]);
  });

  it('delegates automatic planning without an actor or write command', async () => {
    const result = { planHash: 'a'.repeat(64), operations: [] };
    const repairs = { apply: jest.fn() };
    const planner = { plan: jest.fn(async () => result) };
    const controller = new PublishedAssignmentRepairController(
      repairs as unknown as PublishedAssignmentRepairService,
      planner as unknown as PublishedAssignmentRepairPlannerService,
    );
    const request = {
      sourceAssignmentIds: ['11111111-1111-4111-8111-111111111111'],
      acknowledgeCurrentDay: true,
    };

    await expect(controller.plan(request)).resolves.toBe(result);
    expect(planner.plan).toHaveBeenCalledWith(request);
    expect(repairs.apply).not.toHaveBeenCalled();
  });

  it('delegates apply with the authenticated administrator', async () => {
    const result = { repairId: 'repair-id', items: [] };
    const repairs = {
      apply: jest.fn(async () => result),
    };
    const controller = new PublishedAssignmentRepairController(
      repairs as unknown as PublishedAssignmentRepairService,
      {} as PublishedAssignmentRepairPlannerService,
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

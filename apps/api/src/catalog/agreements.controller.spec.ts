/**
 * The reactivation an importer-archived agreement needs is its own route.
 *
 * Exercised here as a controller rather than only as a service, because the
 * defect being fixed was that the workflow had no supported API path at all —
 * it was only ever reachable by writing to the database directly.
 */
import { AgreementStatus, UserRole } from '@prisma/client';

import { AuthenticatedUser } from '../auth/auth.types';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { AgreementsController } from './agreements.controller';
import { AgreementsService } from './agreements.service';

const actor = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'admin@example.test',
  fullName: 'Admin',
  role: UserRole.ADMIN,
} as AuthenticatedUser;

describe('AgreementsController importer reactivation', () => {
  it('delegates to the dedicated service action', async () => {
    const result = { id: 'agreement-id', status: AgreementStatus.ACTIVE };
    const agreements = { reactivateImported: jest.fn(async () => result) };
    const controller = new AgreementsController(
      agreements as unknown as AgreementsService,
    );

    await expect(
      controller.reactivateImported('agreement-id', actor),
    ).resolves.toBe(result);
    expect(agreements.reactivateImported).toHaveBeenCalledWith('agreement-id', actor);
  });

  it('is restricted to administrators', async () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, AgreementsController.prototype.reactivateImported),
    ).toEqual([UserRole.ADMIN]);
  });

  it('does not reach the ordinary status route, which still refuses to revive', async () => {
    // Two separate handlers on purpose: changeStatus keeps enforcing that
    // archiving is final, and the reactivation never travels through it.
    const agreements = {
      reactivateImported: jest.fn(async () => ({ id: 'agreement-id' })),
      changeStatus: jest.fn(),
    };
    const controller = new AgreementsController(
      agreements as unknown as AgreementsService,
    );

    await controller.reactivateImported('agreement-id', actor);

    expect(agreements.changeStatus).not.toHaveBeenCalled();
  });
});

import { AgreementStatus, UserRole } from '@prisma/client';

import { AuthenticatedUser } from '../auth/auth.types';
import { AgreementsController } from './agreements.controller';
import { AgreementsService } from './agreements.service';

describe('AgreementsController imported reactivation', () => {
  it('exposes a dedicated manager action instead of weakening ordinary archive semantics', async () => {
    const result = { id: 'agreement-id', status: AgreementStatus.ACTIVE };
    const agreements = { reactivateImported: jest.fn(async () => result) };
    const controller = new AgreementsController(
      agreements as unknown as AgreementsService,
    ) as unknown as {
      reactivateImported(id: string, actor: AuthenticatedUser): Promise<unknown>;
    };
    const actor = {
      id: 'actor-id',
      email: 'admin@example.test',
      fullName: 'Admin',
      role: UserRole.ADMIN,
    } as AuthenticatedUser;

    await expect(controller.reactivateImported('agreement-id', actor)).resolves.toBe(result);
    expect(agreements.reactivateImported).toHaveBeenCalledWith('agreement-id', actor);
  });
});

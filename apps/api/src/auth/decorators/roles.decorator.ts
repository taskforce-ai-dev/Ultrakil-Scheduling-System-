import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@prisma/client';

export const ROLES_KEY = 'ultrakil:roles';

/** Restricts a route to the listed roles. Without it, any signed-in user passes. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

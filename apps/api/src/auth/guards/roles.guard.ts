import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import type { Request } from 'express';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AuthenticatedUser } from '../auth.types';

/**
 * Runs after JwtAuthGuard. A route with no @Roles() is open to any signed-in
 * user; one with @Roles() requires a matching role.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    const user = request.user;

    if (!user || !required.includes(user.role)) {
      throw new ForbiddenException({
        code: 'INSUFFICIENT_ROLE',
        message: `This action needs the ${required.join(' or ')} role. Ask an administrator if you need access.`,
        details: { requiredRoles: required, yourRole: user?.role ?? null },
      });
    }

    return true;
  }
}

import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { User, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AccessTokenPayload, AuthenticatedUser } from './auth.types';

/** Cost factor for password hashing. 12 is ~250ms, slow enough to matter. */
const BCRYPT_ROUNDS = 12;

export interface LoginResult {
  accessToken: string;
  expiresIn: string;
  user: AuthenticatedUser;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  static hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, BCRYPT_ROUNDS);
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });

    // One message and one code for "no such account", "wrong password" and
    // "account disabled". Distinguishing them tells an attacker which emails
    // are real.
    const ok = user
      ? await bcrypt.compare(password, user.passwordHash)
      : // Still spend the time when the account does not exist, so response
        // timing does not reveal which emails are registered.
        await bcrypt
          .compare(password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv')
          .then(() => false);

    if (!user || !ok || !user.isActive) {
      this.logger.warn(`Failed sign-in for "${email}"`);
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Email or password is incorrect.',
      });
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      accessToken: await this.issueToken(user),
      expiresIn: this.config.getOrThrow<string>('auth.jwtExpiresIn'),
      user: AuthService.toAuthenticatedUser(user),
    };
  }

  async verify(token: string): Promise<AuthenticatedUser> {
    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
    } catch {
      throw new UnauthorizedException({
        code: 'INVALID_TOKEN',
        message: 'Your session is not valid. Sign in again.',
      });
    }

    // Re-read the user on every request rather than trusting the token's copy.
    // A token issued before someone was deactivated must stop working
    // immediately, not when it happens to expire.
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException({
        code: 'ACCOUNT_INACTIVE',
        message: 'This account is no longer active. Contact an administrator.',
      });
    }

    return AuthService.toAuthenticatedUser(user);
  }

  private issueToken(user: User): Promise<string> {
    const payload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
      name: user.fullName,
      role: user.role,
    };
    return this.jwt.signAsync(payload);
  }

  static toAuthenticatedUser(user: User): AuthenticatedUser {
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role as UserRole,
    };
  }
}

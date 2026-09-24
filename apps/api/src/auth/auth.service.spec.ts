import { Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';

describe('AuthService failed sign-in logging', () => {
  it('records a failed sign-in without logging the submitted identity', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const auth = new AuthService(prisma, {} as JwtService, {} as ConfigService);
    const submittedEmail = 'private.person@example.test';

    try {
      await expect(auth.login(submittedEmail, 'wrong-password')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(warn).toHaveBeenCalledWith('Failed sign-in');
      expect(JSON.stringify(warn.mock.calls)).not.toContain(submittedEmail);
    } finally {
      warn.mockRestore();
    }
  });
});

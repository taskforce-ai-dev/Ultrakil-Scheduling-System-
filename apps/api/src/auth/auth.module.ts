import { Global, Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const configured = config.get<string>('auth.jwtSecret');

        // No shipped default. In development a random per-boot secret keeps
        // local setup to zero configuration, at the cost of being signed out on
        // restart. Production refuses to start without a real one — see
        // env.validation.ts.
        const secret = configured || randomBytes(32).toString('hex');
        if (!configured) {
          new Logger('AuthModule').warn(
            'JWT_SECRET is not set — using a random secret for this run. Tokens will stop working when the API restarts. Set JWT_SECRET in .env to avoid that.',
          );
        }

        // `expiresIn` is typed more narrowly than string (it accepts "12h" and
        // friends via the ms library). Derive the type from the module rather
        // than casting to something it is not.
        type ExpiresIn = NonNullable<
          JwtModuleOptions['signOptions']
        >['expiresIn'];

        return {
          secret,
          signOptions: {
            expiresIn: config.getOrThrow<string>('auth.jwtExpiresIn') as ExpiresIn,
            issuer: 'ultrakil-api',
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    // Order matters: authentication runs before the role check, so RolesGuard
    // can rely on request.user being present.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}

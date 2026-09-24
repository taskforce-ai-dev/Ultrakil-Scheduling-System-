import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { Observable } from 'rxjs';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';

/** Protected route data must not be kept by browsers or intermediary caches. */
@Injectable()
export class AuthenticatedResponseCacheInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!isPublic) {
      context.switchToHttp().getResponse<Response>().setHeader('Cache-Control', 'no-store');
    }
    return next.handle();
  }
}

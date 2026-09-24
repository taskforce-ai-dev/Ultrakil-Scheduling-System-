import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { AuthenticatedResponseCacheInterceptor } from './authenticated-response-cache.interceptor';

describe('AuthenticatedResponseCacheInterceptor', () => {
  const next = { handle: () => of({ ok: true }) } as CallHandler;

  it('sets no-store on protected responses', () => {
    const setHeader = jest.fn();
    const context = {
      getHandler: () => function protectedRoute() {},
      getClass: () => class ProtectedController {},
      switchToHttp: () => ({ getResponse: () => ({ setHeader }) }),
    } as unknown as ExecutionContext;
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector;

    new AuthenticatedResponseCacheInterceptor(reflector).intercept(context, next);

    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it('leaves public response caching unchanged', () => {
    const setHeader = jest.fn();
    const context = {
      getHandler: () => function publicRoute() {},
      getClass: () => class PublicController {},
      switchToHttp: () => ({ getResponse: () => ({ setHeader }) }),
    } as unknown as ExecutionContext;
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(true) } as unknown as Reflector;

    new AuthenticatedResponseCacheInterceptor(reflector).intercept(context, next);

    expect(setHeader).not.toHaveBeenCalled();
  });
});

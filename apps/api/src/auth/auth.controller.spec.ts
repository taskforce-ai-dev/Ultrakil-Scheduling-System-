import { HEADERS_METADATA } from '@nestjs/common/constants';
import { AuthController } from './auth.controller';

describe('login response cache policy', () => {
  it('prevents a successful token exchange from being cached', () => {
    const headers = Reflect.getMetadata(HEADERS_METADATA, AuthController.prototype.login) as
      | Array<{ name: string; value: string }>
      | undefined;
    expect(headers).toContainEqual({ name: 'Cache-Control', value: 'no-store' });
  });
});

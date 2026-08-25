import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'ultrakil:isPublic';

/**
 * Marks a route as reachable without a token.
 *
 * Authentication is applied globally and opted *out* of here, rather than
 * applied per-controller. Forgetting to add a guard silently exposes an
 * endpoint; forgetting to add @Public() merely makes one return 401, which is
 * noticed immediately.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

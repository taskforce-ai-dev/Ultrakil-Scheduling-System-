import { UserRole } from '@prisma/client';

/** What the guard puts on the request after verifying a token. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
}

/** Claims carried inside the access token. */
export interface AccessTokenPayload {
  sub: string;
  email: string;
  name: string;
  role: UserRole;
}

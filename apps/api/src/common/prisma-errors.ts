import { Prisma } from '@prisma/client';

/** True for a Postgres unique-constraint violation — e.g. a raced idempotency key. */
export function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

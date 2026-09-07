import { assertTestDatabaseUrl } from '../support/test-database';

// Jest runs this before importing each integration suite, so even top-level
// Prisma clients and afterAll hooks cannot target the ordinary workforce DB.
assertTestDatabaseUrl(process.env.DATABASE_URL);

/**
 * Integration tests talk to a real PostgreSQL and Redis. A cold container or a
 * first connection can easily exceed Jest's 5 second default, so give them room
 * — a timeout here means "the dependency never came up", not "the test is slow".
 */
jest.setTimeout(60_000);

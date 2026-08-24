/**
 * Integration tests talk to a real PostgreSQL and Redis. A cold container or a
 * first connection can easily exceed Jest's 5 second default, so give them room
 * — a timeout here means "the dependency never came up", not "the test is slow".
 */
jest.setTimeout(60_000);

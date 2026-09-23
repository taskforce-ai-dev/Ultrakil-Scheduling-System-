import { PrismaClient } from '@prisma/client';

import {
  assertSyntheticDatabaseUrl,
  executeSyntheticCapacity,
  parseSyntheticCapacityArgs,
  verifyCurrentDatabase,
} from './synthetic-capacity';

async function main(): Promise<void> {
  // Validate URL and all arguments before constructing or connecting Prisma.
  const { databaseName } = assertSyntheticDatabaseUrl(process.env.DATABASE_URL);
  const args = parseSyntheticCapacityArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
    await verifyCurrentDatabase(prisma, databaseName);
    const result = await executeSyntheticCapacity(prisma, args);
    // The shared operator record is deliberately counts only: no source data,
    // IDs, names, hosts or credentials are emitted.
    console.log(JSON.stringify(result));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const knownCode = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
    ? error.message
    : 'SYNTHETIC_CAPACITY_FAILED';
  console.error(knownCode);
  process.exitCode = 1;
});

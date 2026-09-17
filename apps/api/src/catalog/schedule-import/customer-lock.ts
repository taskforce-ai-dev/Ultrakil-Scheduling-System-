import { Prisma } from '@prisma/client';

/**
 * Serializes two imports racing to create the same customer.
 *
 * `importSchedule` decides whether a customer already exists with a plain
 * `findFirst`, before choosing `create` or `update` for it. Postgres runs
 * that at READ COMMITTED, and a `findFirst` takes no lock. Two imports that
 * both mention the same customer — an admin re-running one that has not
 * finished, or two admins importing at once — can both read no existing row
 * and both reach `create`. `customers.name` carries no unique constraint
 * (`customerCode` is optional and usually blank), so Postgres lets both
 * inserts stand: not an error, not a deadlock, just two customers with the
 * same name, each with its own sites and agreements, quietly double-booking
 * the same client's work.
 *
 * `pg_advisory_xact_lock` gives the name Postgres places no constraint on a
 * lock instead. Taken first, before the `findFirst`, it serializes
 * everything the rest of the per-customer transaction does — the customer
 * row, its sites, its agreements, its bookings — not only the create/update
 * choice: the second import to reach a given customer waits for the first's
 * whole per-customer transaction to commit, and its own `findFirst` then
 * sees exactly what the first one wrote.
 *
 * The key is `hashtext(name)`, not the name encoded exactly the way
 * `branch-day-lock.ts` encodes a date. A customer name has no bounded form
 * to fit losslessly into an integer; a hash collision only serializes two
 * unrelated customers that needn't wait on one another, which costs nothing
 * anyone would notice.
 *
 * The single-`bigint` form of `pg_advisory_xact_lock`, not the two-`int4`
 * form the branch-day lock uses — a different key space in Postgres, so the
 * two schemes can never collide with one another.
 */
export async function lockCustomerImport(
  tx: Prisma.TransactionClient,
  customerName: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${customerName})::bigint)`;
}

/** True for the unique-constraint violation Prisma raises as `P2002`. */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Creates a row, or reads the one a concurrent writer just committed.
 *
 * `ensureJobTypes` runs before any customer's transaction and checks
 * `code` — which **is** unique — the same unlocked way: `findUnique` then
 * `create`. Two imports sharing a treatment-code combination race the
 * `create`, and unlike the customer case Postgres does reject the loser —
 * with a raw `P2002` that reached the operator as a crashed import instead
 * of the row the winner already made. Catching it and reading that row back
 * turns the crash into what the loser wanted all along.
 */
export async function createOrRaceToExisting<T>(
  create: () => Promise<T>,
  readExisting: () => Promise<T>,
): Promise<{ record: T; created: boolean }> {
  try {
    return { record: await create(), created: true };
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) throw error;
    return { record: await readExisting(), created: false };
  }
}

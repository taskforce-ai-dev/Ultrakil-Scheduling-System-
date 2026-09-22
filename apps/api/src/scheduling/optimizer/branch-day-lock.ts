import { BranchCode, Prisma } from '@prisma/client';

/**
 * The lock that makes `VISIT_GENERATION_DAILY_CAP` an invariant rather than a
 * hope.
 *
 * Both writers that can put work on a branch-day — generation's `apply` and
 * the optimizer's `persistResult` — decide whether a day has room by counting
 * what already stands on it. A count is a plain aggregate: it takes no
 * predicate lock, and Postgres runs these transactions at READ COMMITTED, so
 * two of them can both read "eleven, room for one" and both commit their
 * twelfth. The row locks already taken do not help, because they are taken on
 * the visits, agreements and resources each writer is *changing*: two runs
 * over disjoint agreements and crews share none of them, and an addition
 * creates a brand-new row that no one could have locked. The day itself is
 * what the two writers contend for, and until now nothing in the database
 * stood for it.
 *
 * `pg_advisory_xact_lock` gives that day a name. It locks nothing real — no
 * row, no table — only an agreed pair of integers, held until the transaction
 * commits or rolls back, which is exactly the shape of the thing being
 * guarded: "whoever is deciding how full COLOMBO's 5th of March is, decide one
 * at a time".
 *
 * ## The key
 *
 * `pg_advisory_xact_lock(int4, int4)`: the first integer names the scheme, the
 * second the day.
 *
 * The scheme constant exists so this can never collide with another advisory
 * lock. There are no others in the codebase today — every other lock here is a
 * `SELECT … FOR UPDATE` on a real row — so the constant is really a promise to
 * whoever adds the second scheme: pick your own, and the two spaces stay
 * apart. The two-integer form is its own space in Postgres, distinct from the
 * single-`bigint` form, which leaves that one free as well.
 *
 * The day is encoded exactly, not hashed. A hash would be shorter and would
 * make two unrelated days collide now and then — harmless, since a collision
 * only means two days serialise that needn't, but not worth the doubt when
 * arithmetic settles it: the branch takes the high digits, the date takes the
 * low ones, and no two branch-days can ever land on the same key.
 */

/**
 * ASCII `UKLD` — UltraKIL load-day. Arbitrary, but arbitrary on purpose: it is
 * not 1, or 42, or any number another scheme would reach for by accident.
 */
const BRANCH_DAY_LOCK_SCHEME = 0x554b4c44;

/**
 * Room for every date this system can hold. Days are counted from 1970, so
 * 2026 is about 20,500 and the year 4700 is the first that would not fit;
 * `int4` then leaves room for two thousand branches above that. The company
 * has two.
 */
const BRANCH_STRIDE = 1_000_000;

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * Which block of the key each branch owns.
 *
 * Written out rather than derived from the enum's order, so that adding a
 * branch cannot silently renumber the others — during a rolling deploy the two
 * halves would then disagree about which integer means which day, and the lock
 * would stop being a lock. Because the type is exhaustive, a new `BranchCode`
 * fails to compile until someone gives it a number of its own.
 */
const BRANCH_LOCK_BLOCK: Record<BranchCode, number> = {
  [BranchCode.COLOMBO]: 1,
  [BranchCode.KANDY]: 2,
};

export interface BranchDay {
  branchCode: BranchCode;
  /** YYYY-MM-DD. */
  date: string;
}

/** The second half of the advisory key: one integer per branch-day, exactly. */
export function branchDayLockKey(branchCode: BranchCode, date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new Error(`Branch-day lock needs a YYYY-MM-DD date, not "${date}".`);
  }
  const days =
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) /
    MILLISECONDS_PER_DAY;
  return BRANCH_LOCK_BLOCK[branchCode] * BRANCH_STRIDE + days;
}

/** The scheme half, exported so a test can look the lock up in `pg_locks`. */
export const BRANCH_DAY_LOCK_CLASS = BRANCH_DAY_LOCK_SCHEME;

/**
 * Hold these branch-days for the rest of the transaction.
 *
 * Take this **after** the visit, agreement and resource row locks and before
 * reading how full the days are. Both writers do it in that order, and the
 * order is the whole point: a solve that took the day first and the visits
 * second, meeting a generation that took them the other way round, would
 * deadlock rather than queue.
 *
 * The days are locked in ascending key order for the same reason. A run
 * touching the 5th and the 6th, meeting one touching the 6th and the 5th,
 * deadlocks if each takes them in the order it happens to have listed them;
 * sorted, the second simply waits for the first. The sort is on the key rather
 * than on branch-and-date so that the order is the one Postgres sees, not one
 * that merely looks tidy in TypeScript.
 *
 * One statement per day, rather than one statement over a list: the order
 * within a single statement is a planner's choice, and this order is a
 * correctness property. Days are few — a week's solve touches a handful, the
 * longest generation a month or so — and a round trip that cannot deadlock is
 * worth more than one that saves a millisecond.
 *
 * The wait is unbounded here and bounded by the caller: both transactions run
 * under Prisma's 30 second ceiling, so a pathological wait ends as a rolled
 * back transaction and a manager who tries again, never as a half-applied one.
 */
export async function lockBranchDays(
  tx: Prisma.TransactionClient,
  days: BranchDay[],
): Promise<void> {
  const keys = [
    ...new Set(days.map((day) => branchDayLockKey(day.branchCode, day.date))),
  ].sort((a, b) => a - b);

  for (const key of keys) {
    // `$executeRaw`, not `$queryRaw`: the function returns `void`, and Prisma
    // cannot deserialize a void column.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BRANCH_DAY_LOCK_SCHEME}::int, ${key}::int)`;
  }
}

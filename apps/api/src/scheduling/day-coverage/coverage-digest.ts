import { createHash } from 'node:crypto';

/**
 * The two fingerprints that decide whether a resolved day is still resolved.
 *
 * ## Why two, and why not the due-set ids
 *
 * The first design hashed the sorted ids of the visits due on a day. That
 * catches a visit appearing or disappearing and nothing else, and it misses
 * both of the ways a finished day actually goes stale.
 *
 * **An edit that keeps the id.** A visit's duration, crew size, service
 * window or lock can change after the day was staffed. The id set is
 * identical, so an id-only hash reads as unchanged, while the work a crew was
 * assigned to is no longer the work that was checked.
 *
 * **Demand that is not a visit yet.** A new agreement creates demand for a
 * date the moment it exists, but no visit until generation runs. There is no
 * id to hash, so an id-only digest over visits cannot see it at all — the day
 * stays covered while real work is missing from it.
 *
 * So coverage has two preconditions, not one: generation must be current
 * against the agreements that bear on the date, and the visits it produced
 * must all be staffed. One hash cannot express both, and collapsing them
 * would also throw away the distinction reconciliation needs — demand drift
 * means generation must run again before the day can be prepared, supply
 * drift means only preparation must run again.
 *
 * ## What makes them sensitive
 *
 * `updatedAt` is Prisma's `@updatedAt` on every model involved, so any write
 * through the client moves it, and the digest does not have to enumerate
 * every field that might matter — a list that would silently fall behind the
 * schema. A raw SQL write that bypasses Prisma would not bump it; there are
 * none on these tables today, and that is the assumption this rests on.
 *
 * Both digests are order-independent, because the order rows come back in is
 * not a fact about the day.
 */

const HASH = 'sha256';

/** One agreement that could place work on the date being fingerprinted. */
export interface DemandInput {
  id: string;
  /** Bumped by a versioned change, so a new version is visible here. */
  currentVersion: number;
  updatedAt: Date;
}

/** Everything actually standing on the date being fingerprinted. */
export interface SupplyInput {
  visits: readonly { id: string; status: string; updatedAt: Date }[];
  assignments: readonly { id: string; status: string; updatedAt: Date }[];
}

/**
 * `\u0000` and `\u0001` rather than `|` and `\n`: a separator has to be a
 * character that cannot occur in any field it separates, or two different
 * inputs can hash the same. Ids are UUIDs and statuses are enum names today,
 * so almost anything would do — but "almost" is how ambiguity gets in later,
 * when a field that can hold arbitrary text joins the list.
 */
const FIELD = '\u0000';
const ROW = '\u0001';

function digestOf(kind: string, rows: readonly string[]): string {
  const hash = createHash(HASH);
  hash.update(kind);
  hash.update(ROW);
  // Sorted here rather than at every call site, so a caller cannot make two
  // equal days hash differently by reading them in a different order.
  for (const row of [...rows].sort()) {
    hash.update(row);
    hash.update(ROW);
  }
  return hash.digest('hex');
}

/**
 * The agreements bearing on a date, fingerprinted.
 *
 * Changes when an agreement appears, is edited, gains a version, or stops
 * applying — including before generation has produced any visit for it.
 */
export function demandDigest(agreements: readonly DemandInput[]): string {
  return digestOf(
    'demand',
    agreements.map((agreement) =>
      [
        agreement.id,
        String(agreement.currentVersion),
        agreement.updatedAt.toISOString(),
      ].join(FIELD),
    ),
  );
}

/**
 * The visits and assignments standing on a date, fingerprinted.
 *
 * Changes when either is added, removed, edited in place, or moved to another
 * status. Visits and assignments are tagged so a row of one kind can never
 * hash as a row of the other.
 */
export function supplyDigest(supply: SupplyInput): string {
  return digestOf('supply', [
    ...supply.visits.map((visit) =>
      ['visit', visit.id, visit.status, visit.updatedAt.toISOString()].join(FIELD),
    ),
    ...supply.assignments.map((assignment) =>
      [
        'assignment',
        assignment.id,
        assignment.status,
        assignment.updatedAt.toISOString(),
      ].join(FIELD),
    ),
  ]);
}

/** Why a resolved day is no longer resolved, or null when it still is. */
export type CoverageDrift = 'DEMAND_CHANGED' | 'SUPPLY_CHANGED' | null;

/**
 * Compares a recorded evaluation against the day as it stands now.
 *
 * Demand is reported ahead of supply when both moved: a new or edited
 * agreement usually explains the visit change underneath it, and generation
 * has to run before preparation can mean anything either way.
 *
 * A day with no recorded digest has never completed an evaluation, so it is
 * not stale — it is unfinished, which is a different state and a different
 * fix.
 */
export function coverageDrift(
  recorded: { demandDigest: string | null; supplyDigest: string | null },
  current: { demandDigest: string; supplyDigest: string },
): CoverageDrift {
  if (recorded.demandDigest === null || recorded.supplyDigest === null) {
    return null;
  }
  if (recorded.demandDigest !== current.demandDigest) return 'DEMAND_CHANGED';
  if (recorded.supplyDigest !== current.supplyDigest) return 'SUPPLY_CHANGED';
  return null;
}

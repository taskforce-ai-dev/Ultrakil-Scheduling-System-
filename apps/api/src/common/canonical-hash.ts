import { createHash } from 'node:crypto';

/**
 * A stable SHA-256 over `value`: object keys sorted, `Date`s turned into
 * ISO strings, `undefined` entries dropped. Two calls with the same data —
 * built in a different order, or read back from the database — hash the
 * same, which is what lets a plan hash or a request hash be compared safely.
 */
export function hashCanonical(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

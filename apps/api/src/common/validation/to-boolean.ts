/**
 * Reads a boolean out of an HTTP query string.
 *
 * `@Type(() => Boolean)` cannot do this: a query value arrives as a string and
 * `Boolean('false')` is `true`, so every `?flag=false` filter silently inverts
 * and answers with the opposite of what was asked for.
 *
 * An unrecognised spelling is passed through untouched so `@IsBoolean()`
 * refuses it by name at the boundary, rather than it being quietly coerced.
 */
export const toBoolean = ({ obj, key }: { obj: Record<string, unknown>; key: string }) => {
  const raw = obj?.[key];
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return raw;
};

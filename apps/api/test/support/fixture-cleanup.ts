/** Missing IDs from a partially failed setup must never widen a Prisma filter. */
export async function cleanupCapturedIds(
  candidates: readonly (string | null | undefined)[],
  remove: (ids: string[]) => Promise<unknown>,
): Promise<void> {
  const ids = candidates.filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (ids.length > 0) await remove(ids);
}

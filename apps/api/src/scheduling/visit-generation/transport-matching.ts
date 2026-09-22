/**
 * Maximum bipartite matching between a list of "resources" — each needing
 * exactly one distinct person to operate it — and the people eligible for
 * each one. One person can operate at most one resource at once; a resource
 * with several eligible people only needs one of them.
 *
 * This is what "how many of these vehicles can actually be driven right
 * now" and "how many crews can this branch transport at once" both reduce
 * to, once a person is allowed to be authorized for more than one vehicle
 * (or to be both a driver and someone who could otherwise walk): counting
 * resources with at least one eligible person overcounts, because the same
 * person can cover more than one resource's "at least one" independently —
 * they just cannot actually do both at the same time.
 *
 * This answers the *aggregate* question `branch-day-capacity.ts` asks — how
 * much this branch could carry on a day, in the abstract. Whether one
 * concrete set of visits can actually be transported is a different and
 * harder question, because it depends on each crew's size and each
 * vehicle's seats; `transport-allocation.ts` owns that one.
 *
 * Branch-sized inputs (tens of vehicles and employees, not thousands), so a
 * standard Kuhn's-algorithm augmenting-path search — O(resources × edges) —
 * is fast enough and simple enough to read and verify by hand; there is no
 * need for Hopcroft–Karp here.
 */

/**
 * Tries to give `resourceIndex` a person from its own eligible list,
 * displacing whoever currently holds one of them onto a different resource
 * if that frees the one this call needs — the standard augmenting-path
 * step. Mutates `matchedResourceOf` (person -> resource index) in place on
 * success; leaves it untouched on failure.
 */
function augmentFrom(
  resourceEligiblePeople: readonly (readonly string[])[],
  matchedResourceOf: Map<string, number>,
  resourceIndex: number,
  seen: Set<string> = new Set(),
): boolean {
  for (const person of resourceEligiblePeople[resourceIndex]) {
    if (seen.has(person)) continue;
    seen.add(person);
    const holder = matchedResourceOf.get(person);
    if (holder === undefined || augmentFrom(resourceEligiblePeople, matchedResourceOf, holder, seen)) {
      matchedResourceOf.set(person, resourceIndex);
      return true;
    }
  }
  return false;
}

/** How many resources can be simultaneously staffed, each by a distinct person. */
export function maxBipartiteMatching(resourceEligiblePeople: readonly (readonly string[])[]): number {
  const matchedResourceOf = new Map<string, number>();
  let matched = 0;
  for (let resourceIndex = 0; resourceIndex < resourceEligiblePeople.length; resourceIndex += 1) {
    if (augmentFrom(resourceEligiblePeople, matchedResourceOf, resourceIndex)) matched += 1;
  }
  return matched;
}

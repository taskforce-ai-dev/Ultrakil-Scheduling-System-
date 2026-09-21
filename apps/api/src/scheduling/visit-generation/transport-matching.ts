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

/**
 * A maximum matching that also uses as few `costly` people as possible,
 * among every matching of that maximum size — not a heuristic ordering, an
 * exact two-phase technique. Phase one finds the largest matching possible
 * using only non-costly people. Phase two keeps that matching and augments
 * it, now allowing costly people too, for whichever resources are still
 * unmatched.
 *
 * Every augmenting path phase two adds must use at least one costly edge:
 * if a path existed using only non-costly edges, phase one's exhaustive
 * non-costly-only search would already have found it. So a costly person
 * is only ever drawn on for a resource nothing else could have covered —
 * which is exactly "prefer a non-walker as a vehicle's driver, so as many
 * walkers as possible stay free to walk."
 *
 * @returns resource index -> the person matched to it. `.size` is the
 *   matching's total size, same as `maxBipartiteMatching` would report.
 */
export function preferredBipartiteMatching(
  resourceEligiblePeople: readonly (readonly string[])[],
  costly: ReadonlySet<string>,
): Map<number, string> {
  const matchedResourceOf = new Map<string, number>();
  const nonCostlyOnly = resourceEligiblePeople.map((people) => people.filter((person) => !costly.has(person)));

  const matchedResourceIndexes = new Set<number>();
  for (let resourceIndex = 0; resourceIndex < nonCostlyOnly.length; resourceIndex += 1) {
    if (augmentFrom(nonCostlyOnly, matchedResourceOf, resourceIndex)) matchedResourceIndexes.add(resourceIndex);
  }
  for (let resourceIndex = 0; resourceIndex < resourceEligiblePeople.length; resourceIndex += 1) {
    if (matchedResourceIndexes.has(resourceIndex)) continue;
    if (augmentFrom(resourceEligiblePeople, matchedResourceOf, resourceIndex)) matchedResourceIndexes.add(resourceIndex);
  }

  const personByResource = new Map<number, string>();
  for (const [person, resourceIndex] of matchedResourceOf) personByResource.set(resourceIndex, person);
  return personByResource;
}

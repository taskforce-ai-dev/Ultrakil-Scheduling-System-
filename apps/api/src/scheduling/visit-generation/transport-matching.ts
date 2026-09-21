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
export function maxBipartiteMatching(resourceEligiblePeople: readonly (readonly string[])[]): number {
  // personId -> index of the resource currently matched to them.
  const matchedResourceOf = new Map<string, number>();

  function tryAssign(resourceIndex: number, seen: Set<string>): boolean {
    for (const person of resourceEligiblePeople[resourceIndex]) {
      if (seen.has(person)) continue;
      seen.add(person);
      const holder = matchedResourceOf.get(person);
      // Free, or the augmenting path can bump whoever holds this person to
      // a different resource, freeing them up for this one.
      if (holder === undefined || tryAssign(holder, seen)) {
        matchedResourceOf.set(person, resourceIndex);
        return true;
      }
    }
    return false;
  }

  let matched = 0;
  for (let resourceIndex = 0; resourceIndex < resourceEligiblePeople.length; resourceIndex += 1) {
    if (tryAssign(resourceIndex, new Set())) matched += 1;
  }
  return matched;
}

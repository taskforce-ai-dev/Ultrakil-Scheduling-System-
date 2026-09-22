/**
 * Can a branch get every crew in a concurrent demand set to its site at once?
 *
 * Each visit is either **driven** — one vehicle whose seats hold the crew,
 * with one driver from that vehicle's own eligible list — or **walked**, which
 * costs `requiredCrewSize` distinct public-transport-capable employees, since
 * a walker carries only themselves. A vehicle, a driver and a walker are each
 * spent on at most one visit, and one person is never both a driver and a
 * walker at the same instant.
 *
 * ## Why this is one decision, not a sequence of matchings
 *
 * Which visit gets which vehicle, which vehicles are worth activating, and who
 * drives them are coupled. Choosing a vehicle for a visit without knowing
 * driver availability can pick a set that turns out undrivable; choosing
 * drivers without knowing which vehicles the visits need can spend a shared
 * driver on a vehicle too small to help, or reserve a walker as the driver of
 * a vehicle nobody ends up using. Earlier versions of this check tried both
 * orderings as two independent matchings, and each had a false-infeasible
 * case; the regression tests in `day-feasibility.spec.ts` keep them pinned.
 *
 * An exhaustive backtracking search over vehicle reservations fixed the
 * correctness, but its cost grows combinatorially in the number of visits —
 * the Technical Director benchmarked 6 visits against 12 vehicles at ~4.8s,
 * roughly 22x the 5-visit case, which is not safe against a real 17-vehicle
 * fleet re-checked for every candidate placement.
 *
 * ## The bounded exact formulation
 *
 * The whole question is a **minimum-cost flow** on a small unit-capacity
 * network, which is exact and polynomial — no search tree, so nothing to
 * prune, bound or memoize:
 *
 * ```
 *   source --(cap 1, cost -crewSize)--> visit
 *   visit  --(cap 1, cost 0)---------->  vehicle-in     (only if seats fit)
 *   vehicle-in --(cap 1, cost 0)------>  vehicle-out    (one visit per vehicle)
 *   vehicle-out --(cap 1, cost 0)----->  driver         (only if authorized)
 *   driver --(cap 1, cost +1 if walker, else 0)--> sink
 * ```
 *
 * One unit of flow is exactly one (visit, vehicle, driver) triple, and the
 * unit capacities are exactly the distinctness rules. A triple's total cost is
 * `-crewSize(visit) + (driver is a walker ? 1 : 0)`, so the **negated** cost
 * of a flow is the quantity that decides the answer:
 *
 * ```
 *   profit  =  crew freed from walking  -  walkers spent as drivers
 * ```
 *
 * The set is transportable exactly when some allocation reaches
 * `profit >= totalCrew - walkerCount`, since that rearranges to
 * `walkerCount - walkersSpentDriving >= crew still walking`. So we compute the
 * maximum achievable profit and compare once.
 *
 * Every triple's profit is `crewSize - (0 or 1) >= 0`, so adding a triple can
 * never hurt; the maximum-profit flow is found by the textbook successive
 * shortest path method — repeatedly augment along a minimum-cost
 * source-to-sink path in the residual network, stopping when the cheapest
 * remaining path no longer has negative cost (i.e. no longer adds profit).
 * Augmenting along a minimum-cost path keeps the flow optimal for its own
 * value, and the marginal profit per unit is non-increasing, so that stopping
 * rule lands on the global optimum. Unit capacities make the optimum integral,
 * and an integral flow decomposes into vertex-disjoint source-to-sink paths —
 * which is to say, back into a concrete allocation.
 *
 * Because the answer is an optimum rather than the first success of a walk
 * over the inputs, it cannot depend on the order vehicles, visits or drivers
 * happen to arrive in.
 *
 * Bellman-Ford does the path search, since residual (reversed) edges carry
 * negative cost. Branch-sized inputs keep it cheap — with V visits, M vehicles
 * and D drivers the network has `2 + V + 2M + D` nodes, and there are at most
 * `min(V, M, D)` augmentations, each `O(nodes x edges)`.
 */

/** Just the part of a visit that transport cares about. */
export interface TransportVisitDemand {
  /** How many people must reach the site. */
  requiredCrewSize: number;
}

/** An active vehicle, its seats, and who may drive it right now. */
export interface TransportVehicleResource {
  id: string;
  /** `null` when the workbook never stated one — treated as unlimited. */
  seatCapacity: number | null;
  eligibleDriverIds: readonly string[];
}

export interface TransportAllocationResult {
  /** Whether every visit in the set can be transported at once. */
  feasible: boolean;
  /**
   * Work actually performed: augmenting paths found (one per visit the
   * optimum drives rather than walks), and edge relaxations across every
   * Bellman-Ford pass. Reported so a regression test can hold the cost of
   * this check to a polynomial bound directly, rather than by timing it on
   * whichever machine CI happens to run.
   */
  augmentations: number;
  relaxations: number;
}

interface FlowEdge {
  to: number;
  capacity: number;
  cost: number;
  /** Index of the paired residual edge inside `graph[to]`. */
  reverse: number;
}

function connect(
  graph: FlowEdge[][],
  from: number,
  to: number,
  capacity: number,
  cost: number,
): void {
  graph[from].push({ to, capacity, cost, reverse: graph[to].length });
  graph[to].push({ to: from, capacity: 0, cost: -cost, reverse: graph[from].length - 1 });
}

/** A vehicle can only ever help if someone may drive it and some crew fits. */
function seatsFit(vehicle: TransportVehicleResource, crewSize: number): boolean {
  return vehicle.seatCapacity === null || vehicle.seatCapacity >= crewSize;
}

/**
 * @returns whether `visits` can all reach their sites at once, plus the work
 *   the computation took. See the module comment for the formulation.
 */
export function allocateTransport(
  visits: readonly TransportVisitDemand[],
  vehicleResources: readonly TransportVehicleResource[],
  walkerIds: ReadonlySet<string>,
): TransportAllocationResult {
  const idle: TransportAllocationResult = {
    feasible: true,
    augmentations: 0,
    relaxations: 0,
  };
  if (visits.length === 0) return idle;

  const totalCrew = visits.reduce((sum, visit) => sum + visit.requiredCrewSize, 0);
  // Everyone can walk; no vehicle is needed, so no allocation has to be found.
  if (walkerIds.size >= totalCrew) return idle;

  // Only vehicles that could conceivably carry one of *these* crews, driven by
  // someone who is actually allowed to, are worth putting in the network.
  const vehicles = vehicleResources.filter(
    (vehicle) =>
      vehicle.eligibleDriverIds.length > 0 &&
      visits.some((visit) => seatsFit(vehicle, visit.requiredCrewSize)),
  );
  const driverIds = [...new Set(vehicles.flatMap((vehicle) => [...vehicle.eligibleDriverIds]))];
  // No drivable vehicle at all: it is walkers or nothing, and they are short.
  if (vehicles.length === 0 || driverIds.length === 0) {
    return { ...idle, feasible: false };
  }

  const driverNodeOf = new Map(driverIds.map((id, index) => [id, index]));
  const source = 0;
  const visitNode = (index: number): number => 1 + index;
  const vehicleInNode = (index: number): number => 1 + visits.length + index;
  const vehicleOutNode = (index: number): number => 1 + visits.length + vehicles.length + index;
  const driverNode = (index: number): number =>
    1 + visits.length + 2 * vehicles.length + index;
  const sink = 1 + visits.length + 2 * vehicles.length + driverIds.length;
  const nodeCount = sink + 1;

  const graph: FlowEdge[][] = Array.from({ length: nodeCount }, () => []);
  visits.forEach((visit, visitIndex) => {
    // Driving this visit frees its whole crew from needing to walk.
    connect(graph, source, visitNode(visitIndex), 1, -visit.requiredCrewSize);
    vehicles.forEach((vehicle, vehicleIndex) => {
      if (!seatsFit(vehicle, visit.requiredCrewSize)) return;
      connect(graph, visitNode(visitIndex), vehicleInNode(vehicleIndex), 1, 0);
    });
  });
  vehicles.forEach((vehicle, vehicleIndex) => {
    // One visit per vehicle, and one driver for it.
    connect(graph, vehicleInNode(vehicleIndex), vehicleOutNode(vehicleIndex), 1, 0);
    for (const driverId of vehicle.eligibleDriverIds) {
      const driverIndex = driverNodeOf.get(driverId);
      if (driverIndex === undefined) continue;
      connect(graph, vehicleOutNode(vehicleIndex), driverNode(driverIndex), 1, 0);
    }
  });
  driverIds.forEach((driverId, driverIndex) => {
    // Spending a walker behind a wheel costs the walker pool one person.
    connect(graph, driverNode(driverIndex), sink, 1, walkerIds.has(driverId) ? 1 : 0);
  });

  let profit = 0;
  let augmentations = 0;
  let relaxations = 0;

  // Successive shortest (here: most negative, i.e. most profitable) path.
  for (;;) {
    const distance = new Array<number>(nodeCount).fill(Number.POSITIVE_INFINITY);
    const cameFromNode = new Array<number>(nodeCount).fill(-1);
    const cameFromEdge = new Array<number>(nodeCount).fill(-1);
    distance[source] = 0;

    for (let round = 0; round < nodeCount; round += 1) {
      let improved = false;
      for (let node = 0; node < nodeCount; node += 1) {
        if (distance[node] === Number.POSITIVE_INFINITY) continue;
        const edges = graph[node];
        for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
          const edge = edges[edgeIndex];
          relaxations += 1;
          if (edge.capacity <= 0) continue;
          const reached = distance[node] + edge.cost;
          if (reached < distance[edge.to]) {
            distance[edge.to] = reached;
            cameFromNode[edge.to] = node;
            cameFromEdge[edge.to] = edgeIndex;
            improved = true;
          }
        }
      }
      if (!improved) break;
    }

    // Nothing left that adds profit: this flow is the maximum-profit one.
    if (distance[sink] >= 0 || distance[sink] === Number.POSITIVE_INFINITY) break;

    // Every capacity in this network is 1, so each augmentation is one unit.
    for (let node = sink; node !== source; ) {
      const previous = cameFromNode[node];
      const edge = graph[previous][cameFromEdge[node]];
      edge.capacity -= 1;
      graph[node][edge.reverse].capacity += 1;
      node = previous;
    }
    profit -= distance[sink];
    augmentations += 1;
  }

  return {
    // profit >= crew that still has to walk minus the walkers there are.
    feasible: profit >= totalCrew - walkerIds.size,
    augmentations,
    relaxations,
  };
}

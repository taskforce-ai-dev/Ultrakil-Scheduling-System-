import {
  TransportVehicleResource,
  TransportVisitDemand,
  allocateTransport,
} from './transport-allocation';

/**
 * `transport-allocation.ts` answers one question — can these crews all reach
 * their sites at once — and it has to answer it both *correctly* and
 * *cheaply*. Those are separate risks, so they are tested separately.
 *
 * Correctness is checked against an independent brute-force oracle over every
 * small instance a seeded generator produces, rather than against hand-picked
 * cases only: the four review rounds this check went through were all
 * false-infeasible answers on shapes nobody had thought to write a test for.
 *
 * Cost is checked by counting the work the algorithm actually does, not by
 * timing it — a wall-clock assertion is a flake on a shared CI runner, and the
 * thing that regressed before was the *shape* of the growth, not the constant.
 */

function visits(...crewSizes: number[]): TransportVisitDemand[] {
  return crewSizes.map((requiredCrewSize) => ({ requiredCrewSize }));
}

function vehicle(
  id: string,
  seatCapacity: number | null,
  ...eligibleDriverIds: string[]
): TransportVehicleResource {
  return { id, seatCapacity, eligibleDriverIds };
}

const feasible = (
  demand: TransportVisitDemand[],
  fleet: TransportVehicleResource[],
  walkers: string[],
): boolean => allocateTransport(demand, fleet, new Set(walkers)).feasible;

describe('allocateTransport', () => {
  describe('the basics it has to get right', () => {
    it('calls an empty demand set transportable', () => {
      expect(feasible([], [], [])).toBe(true);
    });

    it('lets a crew walk when there are exactly enough distinct walkers', () => {
      expect(feasible(visits(3), [], ['w1', 'w2', 'w3'])).toBe(true);
      expect(feasible(visits(3), [], ['w1', 'w2'])).toBe(false);
    });

    it('lets one vehicle carry a whole crew, and needs a driver for it', () => {
      expect(feasible(visits(3), [vehicle('v', 4, 'd1')], [])).toBe(true);
      expect(feasible(visits(3), [vehicle('v', 4)], [])).toBe(false);
    });

    it('treats an unknown seat capacity as unlimited', () => {
      expect(feasible(visits(9), [vehicle('v', null, 'd1')], [])).toBe(true);
    });

    it('refuses a crew too big for the only vehicle, with walkers short', () => {
      expect(feasible(visits(3), [vehicle('v', 1, 'd1')], ['w1'])).toBe(false);
    });

    it('never lets one driver cover two vehicles at once', () => {
      expect(feasible(visits(2, 2), [vehicle('a', 4, 'd1'), vehicle('b', 4, 'd1')], [])).toBe(false);
      expect(feasible(visits(2, 2), [vehicle('a', 4, 'd1'), vehicle('b', 4, 'd2')], [])).toBe(true);
    });

    it('never lets one person be both a driver and a walker', () => {
      // 'shared' drives the van (carrying the 1-person crew) or walks, not both.
      expect(feasible(visits(1, 1), [vehicle('v', 4, 'shared')], ['shared'])).toBe(false);
      expect(feasible(visits(1, 1), [vehicle('v', 4, 'shared')], ['shared', 'w2'])).toBe(true);
    });
  });

  describe('the coupled choices earlier two-phase versions got wrong', () => {
    it('does not strand a big-enough vehicle by spending its only driver on a small one', () => {
      const shared = [vehicle('small', 1, 'd1'), vehicle('big', 4, 'd1')];
      expect(feasible(visits(3), shared, [])).toBe(true);
      expect(feasible(visits(3), [...shared].reverse(), [])).toBe(true);
    });

    it('leaves an unusable vehicle parked rather than reserving its driver away from walking', () => {
      // The van seats 1, so it cannot carry this crew of 3. Its driver is one
      // of the three walkers, and is only useful as a walker.
      expect(feasible(visits(3), [vehicle('v', 1, 'w1')], ['w1', 'w2', 'w3'])).toBe(true);
    });

    it('prefers a non-walker driver so walkers stay free to walk', () => {
      // One 2-person crew drives, one 2-person crew walks. If the van takes
      // 'w1' as its driver there are only 1 walkers left for a crew of 2.
      const fleet = [vehicle('v', 4, 'w1', 'd-spare')];
      expect(feasible(visits(2, 2), fleet, ['w1', 'w2'])).toBe(true);
    });
  });

  describe('the answer does not depend on input order', () => {
    const fleet = [
      vehicle('a', 2, 'd1', 'd2'),
      vehicle('b', 4, 'd2'),
      vehicle('c', 1, 'd1'),
      vehicle('d', 3, 'd3', 'd1'),
    ];
    const demand = visits(4, 2, 1);

    it('gives the same verdict for every permutation of the fleet', () => {
      const permutations: TransportVehicleResource[][] = [];
      const permute = (rest: TransportVehicleResource[], built: TransportVehicleResource[]): void => {
        if (rest.length === 0) return void permutations.push(built);
        rest.forEach((item, index) =>
          permute([...rest.slice(0, index), ...rest.slice(index + 1)], [...built, item]),
        );
      };
      permute(fleet, []);
      expect(permutations).toHaveLength(24);

      const verdicts = new Set(permutations.map((order) => feasible(demand, order, ['w1'])));
      expect(verdicts.size).toBe(1);
    });

    it('gives the same verdict for every permutation of the visits', () => {
      const orders = [visits(4, 2, 1), visits(1, 2, 4), visits(2, 4, 1), visits(2, 1, 4)];
      const verdicts = new Set(orders.map((order) => feasible(order, fleet, ['w1'])));
      expect(verdicts.size).toBe(1);
    });
  });

  describe('against an independent brute-force oracle', () => {
    /**
     * Enumerates literally every allocation: each visit walks or takes one
     * distinct seat-compatible vehicle, and every reserved vehicle then takes
     * one distinct authorized driver. Exponential and unusable in production —
     * which is the point. It shares no code or reasoning with the flow
     * formulation, so agreement across thousands of instances is real evidence
     * rather than the same mistake made twice.
     */
    function bruteForceFeasible(
      demand: TransportVisitDemand[],
      fleet: TransportVehicleResource[],
      walkers: ReadonlySet<string>,
    ): boolean {
      const choice: number[] = new Array(demand.length).fill(-1);

      const walkersSufficeFor = (reservedVehicles: number[]): boolean => {
        const taken = new Set<string>();
        let fewestWalkersSpent = Number.POSITIVE_INFINITY;
        const assignDrivers = (index: number, walkersSpent: number): void => {
          if (index === reservedVehicles.length) {
            fewestWalkersSpent = Math.min(fewestWalkersSpent, walkersSpent);
            return;
          }
          for (const driver of fleet[reservedVehicles[index]].eligibleDriverIds) {
            if (taken.has(driver)) continue;
            taken.add(driver);
            assignDrivers(index + 1, walkersSpent + (walkers.has(driver) ? 1 : 0));
            taken.delete(driver);
          }
        };
        assignDrivers(0, 0);
        if (fewestWalkersSpent === Number.POSITIVE_INFINITY) return false;

        const walkDemand = demand.reduce(
          (sum, visit, index) => (choice[index] >= 0 ? sum : sum + visit.requiredCrewSize),
          0,
        );
        return walkers.size - fewestWalkersSpent >= walkDemand;
      };

      const search = (visitIndex: number, usedVehicles: Set<number>): boolean => {
        if (visitIndex === demand.length) {
          return walkersSufficeFor(choice.filter((index) => index >= 0));
        }
        choice[visitIndex] = -1;
        if (search(visitIndex + 1, usedVehicles)) return true;
        for (let index = 0; index < fleet.length; index += 1) {
          if (usedVehicles.has(index)) continue;
          const seats = fleet[index].seatCapacity;
          if (seats !== null && seats < demand[visitIndex].requiredCrewSize) continue;
          usedVehicles.add(index);
          choice[visitIndex] = index;
          if (search(visitIndex + 1, usedVehicles)) return true;
          usedVehicles.delete(index);
        }
        choice[visitIndex] = -1;
        return false;
      };

      return search(0, new Set());
    }

    /** mulberry32 — a fixed generator, so a failure is reproducible by seed. */
    function seeded(seed: number): () => number {
      let state = seed >>> 0;
      return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    it('agrees with brute force on every one of 3000 seeded random instances', () => {
      const random = seeded(20260922);
      const pick = (bound: number): number => Math.floor(random() * bound);
      const disagreements: string[] = [];
      let feasibleSeen = 0;

      for (let instance = 0; instance < 3000; instance += 1) {
        const people = ['p1', 'p2', 'p3', 'p4'];
        const demand = visits(...Array.from({ length: 1 + pick(3) }, () => 1 + pick(3)));
        const fleet = Array.from({ length: pick(4) }, (_unused, index) =>
          vehicle(
            `v${index}`,
            pick(4) === 0 ? null : 1 + pick(3),
            ...people.filter(() => pick(3) === 0),
          ),
        );
        const walkers = new Set(people.filter(() => pick(2) === 0));

        const actual = allocateTransport(demand, fleet, walkers).feasible;
        const expected = bruteForceFeasible(demand, fleet, walkers);
        if (actual) feasibleSeen += 1;
        if (actual !== expected) {
          disagreements.push(
            `${JSON.stringify({ demand, fleet, walkers: [...walkers], actual, expected })}`,
          );
        }
      }

      expect(disagreements).toEqual([]);
      // Guards against a generator that only ever produces trivial instances.
      expect(feasibleSeen).toBeGreaterThan(300);
      expect(feasibleSeen).toBeLessThan(2700);
    });
  });

  describe('cost stays polynomial — the blocker this formulation replaced', () => {
    /**
     * The Technical Director's benchmark shape: every vehicle in the fleet is
     * authorized to the same single driver, nobody can walk, and there are
     * more crews than that one driver can ever move. Infeasible, so nothing
     * can short-circuit — the old backtracking search had to exhaust every
     * reservation, and went from 216ms at 5 visits/10 vehicles to 4,770ms at
     * 6 visits/12 vehicles on the reviewer's machine (312ms -> 7,652ms ->
     * 220,260ms at 7/14 when re-measured in this container). The bounds below
     * are the relaxation counts this formulation actually uses, with roughly
     * 3x headroom; they are exact integers, not timings, so they cannot flake.
     */
    const pathological = (visitCount: number, vehicleCount: number) => ({
      demand: visits(...new Array(visitCount).fill(1)),
      fleet: Array.from({ length: vehicleCount }, (_unused, index) =>
        vehicle(`v${index}`, 4, 'the-only-driver'),
      ),
    });

    const workFor = (visitCount: number, vehicleCount: number): number => {
      const { demand, fleet } = pathological(visitCount, vehicleCount);
      const result = allocateTransport(demand, fleet, new Set());
      expect(result.feasible).toBe(false);
      return result.relaxations;
    };

    it('settles the 5-visit/10-vehicle benchmark (was 216ms) in under 2000 relaxations', () => {
      expect(workFor(5, 10)).toBeLessThan(2_000);
    });

    it('settles the 6-visit/12-vehicle benchmark (was 4,770ms) in under 2500 relaxations', () => {
      expect(workFor(6, 12)).toBeLessThan(2_500);
    });

    it('settles 7 visits/14 vehicles, where the old search took over three minutes', () => {
      expect(workFor(7, 14)).toBeLessThan(3_500);
    });

    it('does not blow up between the two — the 22x jump that blocked the PR', () => {
      // Polynomial growth on this shape is well under 2x for one extra visit
      // and two extra vehicles. The old search grew ~22x here.
      expect(workFor(6, 12)).toBeLessThan(workFor(5, 10) * 2);
      expect(workFor(7, 14)).toBeLessThan(workFor(6, 12) * 2);
    });

    it('stays bounded on a real-sized fleet with far more concurrency than a day has', () => {
      // 17 vehicles is the actual imported Colombo fleet; 12 crews forced to
      // one instant is far beyond anything generation produces.
      expect(workFor(12, 17)).toBeLessThan(10_000);
    });

    it('needs at most one augmenting path per visit', () => {
      const { demand, fleet } = pathological(12, 17);
      expect(allocateTransport(demand, fleet, new Set()).augmentations).toBeLessThanOrEqual(12);
    });

    it('is just as cheap when the answer is feasible', () => {
      const demand = visits(...new Array(12).fill(2));
      const fleet = Array.from({ length: 17 }, (_unused, index) =>
        vehicle(`v${index}`, 4, `driver-${index}`),
      );
      expect(allocateTransport(demand, fleet, new Set()).relaxations).toBeLessThan(200_000);
    });
  });
});

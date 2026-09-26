import {
  type DemandInput,
  type SupplyInput,
  coverageDrift,
  demandDigest,
  supplyDigest,
} from './coverage-digest';

const AGREEMENT: DemandInput = {
  id: '11111111-1111-4111-8111-111111111111',
  currentVersion: 1,
  updatedAt: new Date('2026-09-20T10:00:00.000Z'),
};

const VISIT: SupplyInput['visits'][number] = {
  id: '22222222-2222-4222-8222-222222222222',
  status: 'PENDING',
  updatedAt: new Date('2026-09-20T10:00:00.000Z'),
};

const ASSIGNMENT: SupplyInput['assignments'][number] = {
  id: '33333333-3333-4333-8333-333333333333',
  status: 'DRAFT',
  updatedAt: new Date('2026-09-20T10:00:00.000Z'),
};

const supply = (over: Partial<SupplyInput> = {}): SupplyInput => ({
  visits: [VISIT],
  assignments: [ASSIGNMENT],
  ...over,
});

describe('demandDigest', () => {
  it('is stable for the same agreements', () => {
    expect(demandDigest([AGREEMENT])).toBe(demandDigest([AGREEMENT]));
  });

  it('does not depend on the order they were read in', () => {
    const other: DemandInput = { ...AGREEMENT, id: '44444444-4444-4444-8444-444444444444' };
    expect(demandDigest([AGREEMENT, other])).toBe(demandDigest([other, AGREEMENT]));
  });

  // The case an id-only due-set digest cannot see at all: a new agreement
  // whose visit generation has not produced yet. There is no visit id to
  // hash, so the day would stay "covered" while real demand exists.
  it('changes when a new agreement appears, before any visit exists for it', () => {
    const before = demandDigest([AGREEMENT]);
    const added: DemandInput = {
      id: '55555555-5555-4555-8555-555555555555',
      currentVersion: 1,
      updatedAt: new Date('2026-09-26T08:00:00.000Z'),
    };

    expect(demandDigest([AGREEMENT, added])).not.toBe(before);
  });

  it('changes when an agreement is edited in place', () => {
    const edited: DemandInput = {
      ...AGREEMENT,
      updatedAt: new Date('2026-09-26T08:00:00.000Z'),
    };
    expect(demandDigest([edited])).not.toBe(demandDigest([AGREEMENT]));
  });

  it('changes when an agreement gains a new version', () => {
    expect(demandDigest([{ ...AGREEMENT, currentVersion: 2 }])).not.toBe(
      demandDigest([AGREEMENT]),
    );
  });

  it('changes when an agreement stops applying to the date', () => {
    expect(demandDigest([])).not.toBe(demandDigest([AGREEMENT]));
  });

  it('has a defined value for no demand at all', () => {
    expect(demandDigest([])).toEqual(expect.any(String));
    expect(demandDigest([])).toHaveLength(64);
  });
});

describe('supplyDigest', () => {
  it('is stable for the same visits and assignments', () => {
    expect(supplyDigest(supply())).toBe(supplyDigest(supply()));
  });

  it('does not depend on read order', () => {
    const second = { ...VISIT, id: '66666666-6666-4666-8666-666666666666' };
    expect(supplyDigest(supply({ visits: [VISIT, second] }))).toBe(
      supplyDigest(supply({ visits: [second, VISIT] })),
    );
  });

  // The other case an id-only digest misses: the ids are identical, so it
  // reads as unchanged, while the visit a crew was staffed for has actually
  // changed underneath.
  it('changes when a visit is edited but keeps its id', () => {
    const edited = { ...VISIT, updatedAt: new Date('2026-09-26T09:00:00.000Z') };
    expect(supplyDigest(supply({ visits: [edited] }))).not.toBe(
      supplyDigest(supply()),
    );
  });

  it('changes when a visit changes status', () => {
    expect(
      supplyDigest(supply({ visits: [{ ...VISIT, status: 'CANCELLED' }] })),
    ).not.toBe(supplyDigest(supply()));
  });

  it('changes when an assignment is edited but keeps its id', () => {
    const edited = { ...ASSIGNMENT, updatedAt: new Date('2026-09-26T09:00:00.000Z') };
    expect(supplyDigest(supply({ assignments: [edited] }))).not.toBe(
      supplyDigest(supply()),
    );
  });

  it('changes when an assignment is superseded', () => {
    expect(
      supplyDigest(supply({ assignments: [{ ...ASSIGNMENT, status: 'SUPERSEDED' }] })),
    ).not.toBe(supplyDigest(supply()));
  });

  it('changes when an assignment disappears', () => {
    expect(supplyDigest(supply({ assignments: [] }))).not.toBe(supplyDigest(supply()));
  });

  // A visit and an assignment are different things and must not be able to
  // cancel each other out in the hash.
  it('does not confuse a visit with an assignment carrying the same values', () => {
    const shared = { id: VISIT.id, status: 'DRAFT', updatedAt: VISIT.updatedAt };
    expect(supplyDigest({ visits: [shared], assignments: [] })).not.toBe(
      supplyDigest({ visits: [], assignments: [shared] }),
    );
  });
});

describe('the two digests together', () => {
  // They answer different questions and are stored separately so a
  // reconciliation can tell them apart: demand drift means generation must
  // run again first, supply drift means only re-preparation is needed.
  it('are independent — demand can drift while supply is unchanged', () => {
    const supplyBefore = supplyDigest(supply());
    const demandBefore = demandDigest([AGREEMENT]);

    const added: DemandInput = {
      id: '77777777-7777-4777-8777-777777777777',
      currentVersion: 1,
      updatedAt: new Date('2026-09-26T08:00:00.000Z'),
    };

    expect(demandDigest([AGREEMENT, added])).not.toBe(demandBefore);
    expect(supplyDigest(supply())).toBe(supplyBefore);
  });
});

describe('coverageDrift', () => {
  const recorded = { demandDigest: 'd1', supplyDigest: 's1' };

  it('reports no drift when both match', () => {
    expect(coverageDrift(recorded, { demandDigest: 'd1', supplyDigest: 's1' })).toBeNull();
  });

  it('reports demand drift', () => {
    expect(coverageDrift(recorded, { demandDigest: 'd2', supplyDigest: 's1' })).toBe(
      'DEMAND_CHANGED',
    );
  });

  it('reports supply drift', () => {
    expect(coverageDrift(recorded, { demandDigest: 'd1', supplyDigest: 's2' })).toBe(
      'SUPPLY_CHANGED',
    );
  });

  it('reports demand first when both moved, because generation must run before preparation', () => {
    expect(coverageDrift(recorded, { demandDigest: 'd2', supplyDigest: 's2' })).toBe(
      'DEMAND_CHANGED',
    );
  });

  // A day that never finished an evaluation is unfinished, not stale. Calling
  // it stale would send it down the re-preparation path instead of the
  // finish-the-attempt path.
  it('treats an unrecorded digest as not-yet-evaluated rather than stale', () => {
    expect(
      coverageDrift({ demandDigest: null, supplyDigest: null }, { demandDigest: 'd1', supplyDigest: 's1' }),
    ).toBeNull();
    expect(
      coverageDrift({ demandDigest: 'd1', supplyDigest: null }, { demandDigest: 'd2', supplyDigest: 's1' }),
    ).toBeNull();
  });
});

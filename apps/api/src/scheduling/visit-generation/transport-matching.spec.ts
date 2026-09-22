import { maxBipartiteMatching } from './transport-matching';

describe('maxBipartiteMatching', () => {
  it('matches nothing when there are no resources', () => {
    expect(maxBipartiteMatching([])).toBe(0);
  });

  it('leaves a resource unmatched when nobody is eligible for it', () => {
    expect(maxBipartiteMatching([[]])).toBe(0);
  });

  it('matches two resources to two different eligible people', () => {
    expect(maxBipartiteMatching([['a'], ['b']])).toBe(2);
  });

  // The case driver-count-by-filter gets wrong: the same person eligible
  // for both resources does not make both resources usable at once.
  it('does not double-count one person eligible for several resources', () => {
    expect(maxBipartiteMatching([['a'], ['a']])).toBe(1);
    expect(maxBipartiteMatching([['a'], ['a'], ['a']])).toBe(1);
  });

  it('finds the augmenting path that frees up a shared person for a resource that needs them specifically', () => {
    // Resource 0 can use a or b; resource 1 can only use a. A greedy scan
    // that assigns resource 0 to a first would strand resource 1 — the
    // correct match reassigns a to resource 1 and gives resource 0 to b.
    expect(maxBipartiteMatching([['a', 'b'], ['a']])).toBe(2);
  });

  it('matches every resource when authorization is one-to-one, DAG-3284/DAC-2485-style', () => {
    expect(
      maxBipartiteMatching([
        ['driver-1', 'driver-2', 'driver-3'],
        ['driver-2', 'driver-3'],
      ]),
    ).toBe(2);
  });

  it('caps the match at however many distinct people exist, however many resources ask for them', () => {
    expect(maxBipartiteMatching([['a'], ['a'], ['b'], ['b']])).toBe(2);
  });
});

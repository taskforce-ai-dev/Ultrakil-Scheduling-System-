import { BranchCode } from '@prisma/client';

import { decideBranch } from './branch-match';

/** Place names taken from the real master schedule workbook. */
describe('decideBranch', () => {
  it.each([
    ['Kandy City Centre'],
    ['Peradeniya'],
    ['Katugastota'],
    ['Gampola'],
    ['Nawalapitiya'],
    ['Matale'],
    ['Nuwara Eliya'],
    ['Dambulla'],
  ])('puts %s in Kandy', (name) => {
    const decision = decideBranch([name]);

    expect(decision.branchCode).toBe(BranchCode.KANDY);
    expect(decision.confidence).toBe('matched');
  });

  it.each([
    ['Borella'],
    ['Kottawa, Horana Road'],
    ['Maharagama'],
    ['Mt.Lavinia'],
    ['Ja Ela Old'],
    ['Peliyagoda Stores'],
    ['Rajagiriya Branch'],
    ['Galle'],
  ])('puts %s in Colombo', (name) => {
    const decision = decideBranch([name]);

    expect(decision.branchCode).toBe(BranchCode.COLOMBO);
    expect(decision.confidence).toBe('matched');
  });

  it('reads the town out of an address when the name has none', () => {
    const decision = decideBranch(['Union Bank', '21, Dolosbage Road, Nawalapitiya.']);

    expect(decision.branchCode).toBe(BranchCode.KANDY);
    expect(decision.matchedOn).toBe('nawalapitiya');
  });

  it('prefers the longer town name, so Nuwara Eliya is not mistaken', () => {
    const decision = decideBranch(['Nuwara Eliya Town Branch']);

    expect(decision.matchedOn).toBe('nuwara eliya');
    expect(decision.branchCode).toBe(BranchCode.KANDY);
  });

  // Sri Lankan addresses are full of roads named after the town they lead to.
  // Matching those put Western Province sites in Kandy.
  it.each([
    ['Kadawatha', '315F, Kandy Road, Kadawatha.', BranchCode.COLOMBO],
    ['Kiribathgoda', 'No 12, Kandy Rd, Kiribathgoda', BranchCode.COLOMBO],
    ['Kandy', 'No 5, Peradeniya Road, Kandy', BranchCode.KANDY],
    ['Matale', 'Kandy Road, Matale', BranchCode.KANDY],
  ])('reads %s correctly despite the road name', (name, address, expected) => {
    expect(decideBranch([name, address]).branchCode).toBe(expected);
  });

  it('matches a hyphenated town name, as the workbook sometimes writes it', () => {
    // Real row from the workbook: "Nuwara- Eliya", not "Nuwara Eliya".
    const decision = decideBranch(['Nuwara- Eliya']);

    expect(decision.branchCode).toBe(BranchCode.KANDY);
    expect(decision.confidence).toBe('matched');
  });

  it('falls back to Colombo but says it is uncertain', () => {
    // A name with no recognisable town must never look like a confident match.
    const decision = decideBranch(['J & J Agencies']);

    expect(decision.branchCode).toBe(BranchCode.COLOMBO);
    expect(decision.confidence).toBe('uncertain');
    expect(decision.matchedOn).toBeNull();
  });

  it('is uncertain for an empty site, rather than throwing', () => {
    expect(decideBranch([null, undefined, ''])).toMatchObject({
      confidence: 'uncertain',
      branchCode: BranchCode.COLOMBO,
    });
  });
});

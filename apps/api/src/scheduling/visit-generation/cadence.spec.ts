import { FrequencyUnit } from '@prisma/client';

import { cadenceName, cadenceNoun, spansOf } from './cadence';

describe('cadence wording', () => {
  it('spells a cycle length in words, never in digits', () => {
    // "a range covering a whole 2 months" mixes a word and a digit in one
    // phrase and reads like a field name rather than a sentence.
    expect(cadenceNoun(FrequencyUnit.MONTH, 2)).toBe('two months');
    expect(cadenceNoun(FrequencyUnit.WEEK, 3)).toBe('three weeks');
    expect(cadenceNoun(FrequencyUnit.MONTH, 6)).toBe('six months');
    expect(cadenceName(FrequencyUnit.WEEK, 5)).toBe('Every five weeks');
  });

  it('keeps the words UltraKIL actually sells these by', () => {
    expect(cadenceNoun(FrequencyUnit.WEEK, 2)).toBe('fortnight');
    expect(cadenceNoun(FrequencyUnit.MONTH, 3)).toBe('quarter');
    expect(cadenceNoun(FrequencyUnit.MONTH, 12)).toBe('year');
    expect(cadenceName(FrequencyUnit.MONTH, 2)).toBe('Two-monthly');
  });

  it('names the first span and counts the rest', () => {
    expect(spansOf([{ start: '2026-04-20', end: '2026-05-10' }])).toBe(
      '2026-04-20 to 2026-05-10',
    );
    expect(
      spansOf([
        { start: '2026-04-20', end: '2026-05-10' },
        { start: '2026-06-22', end: '2026-07-12' },
      ]),
    ).toBe('2026-04-20 to 2026-05-10 (and 1 more)');
  });
});

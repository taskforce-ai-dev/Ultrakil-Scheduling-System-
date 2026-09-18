import { FrequencyUnit } from '@prisma/client';

import {
  cadenceName,
  cadenceNoun,
  describeFrequency,
  spansOf,
} from './cadence';

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

describe('describeFrequency', () => {
  it('names a cadence with the words the rest of the portal uses', () => {
    // One vocabulary, not two. These are `cadenceName`'s words, reached
    // through the label every agreement screen reads.
    expect(describeFrequency(1, 'WEEK', 1)).toBe('Weekly');
    expect(describeFrequency(1, 'WEEK', 2)).toBe('Fortnightly');
    expect(describeFrequency(1, 'MONTH', 2)).toBe('Two-monthly');
    expect(describeFrequency(1, 'MONTH', 3)).toBe('Quarterly');
    expect(describeFrequency(1, 'MONTH', 6)).toBe('Six-monthly');
    expect(describeFrequency(1, 'MONTH', 12)).toBe('Yearly');
    expect(describeFrequency(1, 'WEEK', 5)).toBe('Every five weeks');
  });

  it('counts repeats inside the cycle the agreement is sold on', () => {
    expect(describeFrequency(2, 'WEEK', 1)).toBe('2 times a week');
    expect(describeFrequency(3, 'MONTH', 1)).toBe('3 times a month');
    expect(describeFrequency(2, 'WEEK', 2)).toBe('2 times a fortnight');
    expect(describeFrequency(2, 'MONTH', 3)).toBe('2 times a quarter');
    // The fallback span is already a plural phrase — "2 times a two months"
    // is not a sentence anyone says.
    expect(describeFrequency(2, 'MONTH', 2)).toBe('2 times every two months');
  });

  it('never reports an interval it was given as if it were 1', () => {
    // The defect this covers: a fortnightly agreement read as weekly on the
    // screen a manager answers "how often do we serve this customer" from.
    expect(describeFrequency(1, 'WEEK', 2)).not.toBe(
      describeFrequency(1, 'WEEK', 1),
    );
    expect(describeFrequency(1, 'MONTH', 2)).not.toBe(
      describeFrequency(1, 'MONTH', 1),
    );
  });
});

import { FrequencyUnit } from '@prisma/client';

/**
 * How a cadence is named to a manager.
 *
 * Every string here is read by someone deciding what to do about a calendar,
 * so a cycle length is spelled the way it is spoken: "a whole two months", not
 * "a whole 2 months", which mixes a word and a digit in one phrase and reads
 * like a field name.
 */

const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
];

/** "two", "three"… falling back to the digits past the ones anyone says. */
export function inWords(count: number): string {
  return NUMBER_WORDS[count] ?? String(count);
}

/** "Quarterly", "Fortnightly" — the word UltraKIL sells the cadence by. */
export function cadenceName(unit: FrequencyUnit, interval: number): string {
  const named: Record<string, string> = {
    'WEEK|1': 'Weekly',
    'WEEK|2': 'Fortnightly',
    'MONTH|1': 'Monthly',
    'MONTH|2': 'Two-monthly',
    'MONTH|3': 'Quarterly',
    'MONTH|6': 'Six-monthly',
    'MONTH|12': 'Yearly',
  };
  return (
    named[`${unit}|${interval}`] ??
    `Every ${inWords(interval)} ${unit === FrequencyUnit.WEEK ? 'weeks' : 'months'}`
  );
}

/** The span such an agreement needs a run to hold whole. */
export function cadenceNoun(unit: FrequencyUnit, interval: number): string {
  const named: Record<string, string> = {
    'WEEK|1': 'week',
    'WEEK|2': 'fortnight',
    'MONTH|1': 'month',
    'MONTH|3': 'quarter',
    'MONTH|12': 'year',
  };
  return (
    named[`${unit}|${interval}`] ??
    `${inWords(interval)} ${unit === FrequencyUnit.WEEK ? 'weeks' : 'months'}`
  );
}

/** "2026-05-25 to 2026-06-07", and the rest counted. */
export function spansOf(periods: Array<{ start: string; end: string }>): string {
  const [first, ...rest] = periods;
  const named = `${first.start} to ${first.end}`;
  if (rest.length === 0) return named;
  return `${named} (and ${rest.length} more)`;
}

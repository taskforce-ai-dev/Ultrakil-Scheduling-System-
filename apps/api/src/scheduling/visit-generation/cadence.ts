/**
 * How a cadence is named to a manager.
 *
 * Every string here is read by someone deciding what to do about a calendar,
 * so a cycle length is spelled the way it is spoken: "a whole two months", not
 * "a whole 2 months", which mixes a word and a digit in one phrase and reads
 * like a field name.
 *
 * This is the only cadence vocabulary the system has. The manager portal keeps
 * a copy at `apps/manager-web/src/lib/cadence.ts` because the portal cannot
 * import from the API package (the API's release image never copies
 * `packages/`, so a shared workspace module could not be published with it);
 * `cadence.contract.test.ts` over there imports this file directly and fails
 * the moment the two disagree about a single word.
 *
 * The unit is spelled as a string union rather than Prisma's `FrequencyUnit`
 * so that the portal's copy can be checked against this one without pulling a
 * database client into a browser test. `FrequencyUnit` is exactly this union,
 * so every API call site still passes it unchanged.
 */

export type CadenceUnit = 'WEEK' | 'MONTH';

const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
];

/** "two", "three"… falling back to the digits past the ones anyone says. */
export function inWords(count: number): string {
  return NUMBER_WORDS[count] ?? String(count);
}

/** "Quarterly", "Fortnightly" — the word UltraKIL sells the cadence by. */
export function cadenceName(unit: CadenceUnit, interval: number): string {
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
    `Every ${inWords(interval)} ${unit === 'WEEK' ? 'weeks' : 'months'}`
  );
}

/** The span such an agreement needs a run to hold whole. */
export function cadenceNoun(unit: CadenceUnit, interval: number): string {
  const named: Record<string, string> = {
    'WEEK|1': 'week',
    'WEEK|2': 'fortnight',
    'MONTH|1': 'month',
    'MONTH|3': 'quarter',
    'MONTH|12': 'year',
  };
  return (
    named[`${unit}|${interval}`] ??
    `${inWords(interval)} ${unit === 'WEEK' ? 'weeks' : 'months'}`
  );
}

/** "2026-05-25 to 2026-06-07", and the rest counted. */
export function spansOf(periods: Array<{ start: string; end: string }>): string {
  const [first, ...rest] = periods;
  const named = `${first.start} to ${first.end}`;
  if (rest.length === 0) return named;
  return `${named} (and ${rest.length} more)`;
}

/**
 * The whole commitment in one phrase: "Fortnightly", "2 times a week".
 *
 * A cadence is two numbers and a unit — one visit per cycle, two weeks to the
 * cycle — and a screen that shows only the first number and the unit turns
 * every fortnightly contract into a weekly one and every two-monthly contract
 * into a monthly one. Nothing that renders a frequency may take a shortcut
 * past this function.
 */
export function describeFrequency(
  count: number,
  unit: CadenceUnit,
  interval: number,
): string {
  if (count === 1) return cadenceName(unit, interval);

  // `cadenceNoun` names a cycle whose length has a word of its own ("week",
  // "fortnight", "quarter") as one word, and every other cycle as a plural
  // phrase ("two months"). "2 times a two months" is not a sentence anybody
  // says, so a phrase takes "every" where a word takes "a".
  const span = cadenceNoun(unit, interval);
  return `${count} times ${span.includes(' ') ? 'every' : 'a'} ${span}`;
}

/**
 * How a cadence is named to a manager, in the portal.
 *
 * This is a deliberate copy of `apps/api/src/scheduling/visit-generation/cadence.ts`.
 * The portal cannot import from the API package — the API's release image
 * never copies `packages/`, so a shared workspace module could not ship with
 * it — and a cadence is also something the portal has to name *before* a
 * manager has saved anything, which no server response can answer.
 *
 * `__tests__/cadence.contract.test.ts` imports the API's module directly and
 * fails the moment these two disagree about a single word, the same way
 * `conflict-groups.contract.test.ts` holds the conflict catalogues together.
 *
 * Note what this is *not* for: an agreement that already exists carries the
 * API's own `frequencyLabel`, and screens listing saved agreements render that
 * rather than recomputing it here. One fact, one author.
 */

export type CadenceUnit = "WEEK" | "MONTH";

const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six",
  "seven", "eight", "nine", "ten", "eleven", "twelve",
];

/** "two", "three"… falling back to the digits past the ones anyone says. */
export function inWords(count: number): string {
  return NUMBER_WORDS[count] ?? String(count);
}

/** "Quarterly", "Fortnightly" — the word UltraKIL sells the cadence by. */
export function cadenceName(unit: CadenceUnit, interval: number): string {
  const named: Record<string, string> = {
    "WEEK|1": "Weekly",
    "WEEK|2": "Fortnightly",
    "MONTH|1": "Monthly",
    "MONTH|2": "Two-monthly",
    "MONTH|3": "Quarterly",
    "MONTH|6": "Six-monthly",
    "MONTH|12": "Yearly",
  };
  return (
    named[`${unit}|${interval}`] ??
    `Every ${inWords(interval)} ${unit === "WEEK" ? "weeks" : "months"}`
  );
}

/** The span such an agreement needs a run to hold whole. */
export function cadenceNoun(unit: CadenceUnit, interval: number): string {
  const named: Record<string, string> = {
    "WEEK|1": "week",
    "WEEK|2": "fortnight",
    "MONTH|1": "month",
    "MONTH|3": "quarter",
    "MONTH|12": "year",
  };
  return (
    named[`${unit}|${interval}`] ??
    `${inWords(interval)} ${unit === "WEEK" ? "weeks" : "months"}`
  );
}

/**
 * Several of those spans: "fortnights", "two months".
 *
 * Portal-only — the API never counts cycles in a sentence. Appending an "s" at
 * the call site worked for "fortnight" and produced "2 three weekss" for every
 * span that is already a plural phrase.
 */
export function cadenceSpans(unit: CadenceUnit, interval: number): string {
  const span = cadenceNoun(unit, interval);
  return span.includes(" ") ? span : `${span}s`;
}

/**
 * The whole commitment in one phrase: "Fortnightly", "2 times a week".
 *
 * A cadence is two numbers and a unit — one visit per cycle, two weeks to the
 * cycle — and a screen that shows only the first number and the unit turns
 * every fortnightly contract into a weekly one.
 */
export function describeFrequency(
  count: number,
  unit: CadenceUnit,
  interval: number,
): string {
  if (count === 1) return cadenceName(unit, interval);
  const span = cadenceNoun(unit, interval);
  return `${count} times ${span.includes(" ") ? "every" : "a"} ${span}`;
}

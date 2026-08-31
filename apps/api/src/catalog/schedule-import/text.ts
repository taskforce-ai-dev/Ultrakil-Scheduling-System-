import { FrequencyUnit, Weekday } from '@prisma/client';

import {
  DayRuleOutcome,
  FrequencyOutcome,
  ParsedEffort,
  ParsedFrequency,
} from './types';

/**
 * Readers for the free-text columns of the master schedule workbook.
 *
 * Every pattern here was taken from the real 2026 workbook, not invented. The
 * guiding rule is that an unreadable value is reported, never guessed: an
 * agreement given the wrong frequency looks correct on screen and quietly
 * delivers the wrong service all year.
 */

export function normalise(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

const WEEKDAY_WORDS: [RegExp, Weekday][] = [
  [/\bmon(day)?\b/, Weekday.MONDAY],
  [/\btue(s|sday)?\b/, Weekday.TUESDAY],
  [/\bwed(nesday)?\b/, Weekday.WEDNESDAY],
  [/\bthu(r|rs|rsday)?\b/, Weekday.THURSDAY],
  [/\bfri(day)?\b/, Weekday.FRIDAY],
  [/\bsat(urday)?\b/, Weekday.SATURDAY],
  [/\bsun(day)?\b/, Weekday.SUNDAY],
];

const WEEKDAYS_MON_TO_FRI = [
  Weekday.MONDAY,
  Weekday.TUESDAY,
  Weekday.WEDNESDAY,
  Weekday.THURSDAY,
  Weekday.FRIDAY,
];

/**
 * Phrases that name a real scheduling rule the data model cannot hold.
 *
 * Kept apart from "unreadable" on purpose. These are not mistakes in the
 * workbook — they are commitments UltraKIL has genuinely made, and the report
 * has to say so rather than implying the row is junk.
 */
const UNSUPPORTED_DAY_PATTERNS: [RegExp, string][] = [
  [
    /\b(1st|2nd|3rd|4th|last)\b.*\b(week|mon|tue|wed|thu|fri|sat|sun)/,
    'names an ordinal weekday (such as "2nd and Last Friday"), which the model cannot hold — it stores which weekdays are allowed, not which occurrence of them',
  ],
  [
    /\d\s*(st|nd|rd|th)\b/,
    'names days of the month (such as "9th, 29th") rather than weekdays, which the model cannot hold',
  ],
];

const UNSUPPORTED_FREQUENCY_PATTERNS: [RegExp, string][] = [
  [
    /^(on request|or|as required|adhoc|ad hoc)$/,
    'on-request work has no recurring schedule, so it cannot become a recurring agreement',
  ],
  [
    /on request/,
    'the frequency mixes a schedule with on-request work, so which part recurs is ambiguous',
  ],
];

/** Words for a count, as the workbook writes them. */
const COUNT_WORDS: Record<string, number> = {
  once: 1,
  one: 1,
  twice: 2,
  two: 2,
  thrice: 3,
  three: 3,
  four: 4,
  '01': 1,
  '02': 2,
  '03': 3,
  '04': 4,
};

function readCount(token: string | undefined): number | null {
  if (!token) return null;
  const word = COUNT_WORDS[token];
  if (word !== undefined) return word;
  const digits = Number.parseInt(token, 10);
  return Number.isFinite(digits) && digits > 0 && digits <= 31 ? digits : null;
}

/**
 * Reads the workbook's FREQUENCY column.
 *
 * Real values it must cope with include "Monthly", "Weekly", "Twice a Week",
 * "02 times in month", "3 times per month", "Fortnightly", "Quarterly",
 * "On Request", and a handful that describe two treatments at once.
 */
export function parseFrequency(raw: string | null | undefined): FrequencyOutcome {
  const source = (raw ?? '').trim();
  if (!source) return { kind: 'absent' };

  const text = normalise(source);

  // A row describing two treatments at different rates ("RC - 2 times in month
  // GPC - Monthly") is one agreement in the workbook but two in the model.
  // Splitting it would invent a commitment nobody made.
  if (/\b(rc|gpc|mc|fly)\b\s*-.*\b(rc|gpc|mc|fly)\b\s*-/.test(text)) {
    return {
      kind: 'unsupported',
      source,
      reason:
        'gives different frequencies for different treatments in one row, which is two agreements rather than one',
    };
  }

  for (const [pattern, reason] of UNSUPPORTED_FREQUENCY_PATTERNS) {
    if (pattern.test(text)) return { kind: 'unsupported', source, reason };
  }

  // Cycles longer than one unit. UltraKIL sells these by name, so they are
  // matched by name rather than reconstructed from a count.
  const CYCLES: [RegExp, ParsedFrequency][] = [
    [/fortnight|bi-?weekly|every (two|2) weeks?/, { count: 1, unit: FrequencyUnit.WEEK, interval: 2 }],
    [/quarter/, { count: 1, unit: FrequencyUnit.MONTH, interval: 3 }],
    [
      /once in (two|2) month|every (two|2) months?|bi-?month/,
      { count: 1, unit: FrequencyUnit.MONTH, interval: 2 },
    ],
  ];
  for (const [pattern, frequency] of CYCLES) {
    if (pattern.test(text)) return { kind: 'parsed', frequency, source };
  }

  if (/^weekly$/.test(text) || /^once a week$/.test(text)) {
    return { kind: 'parsed', frequency: { count: 1, unit: FrequencyUnit.WEEK, interval: 1 }, source };
  }
  if (/^monthly$/.test(text) || /^once a month$/.test(text)) {
    return { kind: 'parsed', frequency: { count: 1, unit: FrequencyUnit.MONTH, interval: 1 }, source };
  }

  // "Weekly Thursday" — a frequency with the day appended.
  if (/^weekly\b/.test(text) && WEEKDAY_WORDS.some(([p]) => p.test(text))) {
    return { kind: 'parsed', frequency: { count: 1, unit: FrequencyUnit.WEEK, interval: 1 }, source };
  }

  // "Twice a Week", "3 times per month", "02 times in month", "2 Twice Month".
  const perPeriod = text.match(
    /\b(once|twice|thrice|one|two|three|four|\d{1,2})\b[^a-z0-9]*(?:times?)?\s*(?:a|per|in|each)?\s*(week|month)\b/,
  );
  if (perPeriod) {
    const count = readCount(perPeriod[1]);
    if (count !== null) {
      return {
        kind: 'parsed',
        frequency: {
          count,
          unit: perPeriod[2] === 'week' ? FrequencyUnit.WEEK : FrequencyUnit.MONTH,
          interval: 1,
        },
        source,
      };
    }
  }

  // A bare list of weekdays sitting in the frequency column, e.g.
  // "Monday Wednesday Friday" — the count is how many days were named.
  const namedDays = WEEKDAY_WORDS.filter(([pattern]) => pattern.test(text));
  if (namedDays.length > 0 && !/\d/.test(text)) {
    return {
      kind: 'parsed',
      frequency: { count: namedDays.length, unit: FrequencyUnit.WEEK, interval: 1 },
      source,
    };
  }

  return { kind: 'unreadable', source };
}

/**
 * Reads the workbook's Day column into a set of allowed weekdays.
 *
 * "Weekday" means Monday to Friday. A rule naming an occurrence rather than a
 * weekday ("2nd Week Saturday") or a day of the month ("9th, 29th") is
 * reported as unsupported, because the model stores neither.
 */
export function parseDayRule(raw: string | null | undefined): DayRuleOutcome {
  const source = (raw ?? '').trim();
  if (!source) return { kind: 'absent' };

  const text = normalise(source);

  for (const [pattern, reason] of UNSUPPORTED_DAY_PATTERNS) {
    if (pattern.test(text)) return { kind: 'unsupported', source, reason };
  }

  const named = WEEKDAY_WORDS.filter(([pattern]) => pattern.test(text)).map(
    ([, weekday]) => weekday,
  );
  if (named.length > 0) return { kind: 'parsed', allowedDays: named, source };

  // "Weekday" / "Week days" — Monday to Friday. Checked after the named days so
  // "Weekday 10 PM" still resolves, and "Wednesday" is never mistaken for it.
  if (/\bweek\s?days?\b/.test(text)) {
    return { kind: 'parsed', allowedDays: [...WEEKDAYS_MON_TO_FRI], source };
  }

  return { kind: 'unreadable', source };
}

/**
 * Reads "Duration and PCT" — visit length and crew size in one cell.
 *
 * PCT is a pest control technician, so "05hrs - 02 PCT" is a five-hour visit
 * for a crew of two. Where a cell describes two treatments ("GPC- 01hrs - 02
 * PCT MC-0.5hrs - 02 PCT") the first duration is taken and the crew is the
 * largest named, since the crew has to be big enough for the heaviest task.
 */
export function parseEffort(raw: string | null | undefined): ParsedEffort {
  const source = (raw ?? '').trim();
  if (!source) return { durationMinutes: null, crewSize: null };

  const text = normalise(source);

  const hours = text.match(/(\d+(?:\.\d+)?)\s*hrs?\b/);
  const durationMinutes = hours ? Math.round(Number.parseFloat(hours[1]) * 60) : null;

  const crews = [...text.matchAll(/(\d{1,2})\s*pct\b/g)]
    .map((match) => Number.parseInt(match[1], 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  const crewSize = crews.length > 0 ? Math.max(...crews) : null;

  return {
    durationMinutes: durationMinutes && durationMinutes > 0 ? durationMinutes : null,
    crewSize,
  };
}

/**
 * Splits the Treatment column into codes.
 *
 * Written every which way: "GPC RC", "RC,GPC", "GPC - 1 MC - 6". Digits and
 * separators are dropped; whatever words remain are the treatment codes, kept
 * exactly as the workbook spells them so nothing is silently renamed.
 */
export function parseTreatmentCodes(raw: string | null | undefined): string[] {
  const source = (raw ?? '').trim();
  if (!source) return [];

  return [
    ...new Set(
      source
        .split(/[,/&+]|\s+/)
        .map((token) => token.replace(/[^A-Za-z]/g, '').toUpperCase())
        .filter((token) => token.length > 0 && token.length <= 12),
    ),
  ];
}

/**
 * Works out which weekdays a site is actually serviced on, from the visit
 * dates the workbook has already booked.
 *
 * Most rows leave the Day column empty but fill in the month columns with the
 * dates actually planned. Those dates are a record of what UltraKIL really
 * does, so reading the weekdays back out of them is evidence rather than
 * invention — and without it almost nothing in the workbook can be imported.
 *
 * A weekday appearing once among many is dropped: across a year of bookings a
 * single Tuesday among forty Fridays is a one-off or a typo, not a standing
 * arrangement. Fewer than three dates is too little to conclude anything from.
 */
export function deriveAllowedDaysFromDates(
  bookings: { month: number; day: number }[],
  year: number,
): { allowedDays: Weekday[]; sampleSize: number; evidence: string } | null {
  const ORDER: Weekday[] = [
    Weekday.SUNDAY,
    Weekday.MONDAY,
    Weekday.TUESDAY,
    Weekday.WEDNESDAY,
    Weekday.THURSDAY,
    Weekday.FRIDAY,
    Weekday.SATURDAY,
  ];

  const counts = new Map<Weekday, number>();
  let total = 0;

  for (const { month, day } of bookings) {
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const date = new Date(Date.UTC(year, month - 1, day));
    // Rejects the 31st of a 30-day month, which JavaScript would roll forward.
    if (date.getUTCMonth() !== month - 1) continue;

    const weekday = ORDER[date.getUTCDay()];
    counts.set(weekday, (counts.get(weekday) ?? 0) + 1);
    total += 1;
  }

  if (total < 3) return null;

  const threshold = Math.max(2, Math.ceil(total * 0.1));
  const kept = ORDER.filter((weekday) => (counts.get(weekday) ?? 0) >= threshold);
  if (kept.length === 0) return null;

  const evidence = kept
    .map((weekday) => `${weekday.slice(0, 3)}×${counts.get(weekday)}`)
    .join(' ');

  return { allowedDays: kept, sampleSize: total, evidence };
}

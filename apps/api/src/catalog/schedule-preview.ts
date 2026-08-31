import { FrequencyUnit, Weekday } from '@prisma/client';

/**
 * Works out which dates an agreement asks for, and says so when it cannot.
 *
 * This is not the scheduler. It assigns nobody and books nothing — it answers
 * "what does this commitment actually demand?" so a manager can see the
 * consequences of an agreement before saving it, and so ULK-C04 has one
 * definition of the required visits to generate.
 *
 * The rule that shapes everything here: allowed weekdays are hard, preferred
 * weekdays are soft. Within a period we take preferred days first, then merely
 * allowed ones, earliest first. And when a period cannot hold the promised
 * number of visits, that is reported as a shortfall — never quietly dropped.
 * A schedule that looks complete because the impossible parts were discarded
 * is worse than one that admits the gap.
 */

/** One window inside a day, as minutes from midnight. */
export interface DayWindow {
  startMinute: number;
  endMinute: number;
}

export interface SiteWindow extends DayWindow {
  weekday: Weekday;
}

export interface SchedulePreviewInput {
  frequencyCount: number;
  frequencyUnit: FrequencyUnit;
  /**
   * How many units make one cycle. 1 is the ordinary case; 2 with WEEK is
   * fortnightly, 3 with MONTH is quarterly. Defaults to 1 so every existing
   * caller keeps its meaning.
   */
  frequencyInterval?: number;
  allowedDays: Weekday[];
  preferredDays: Weekday[];
  /** Inclusive, YYYY-MM-DD. */
  startDate: string;
  /** Inclusive, YYYY-MM-DD. Null means open-ended. */
  endDate: string | null;
  /** The site's opening windows. A weekday with no window is closed. */
  siteWindows: SiteWindow[];
  /** Optional narrowing of the site's hours, applied to every day. */
  agreementWindowStartMinute: number | null;
  agreementWindowEndMinute: number | null;
  durationMinutes: number;
  /** How far ahead to look. Defaults to 4 weeks. */
  horizonWeeks?: number;
  /** Where the horizon begins. Defaults to the agreement's start date. */
  from?: string;
}

export interface PreviewVisit {
  /** YYYY-MM-DD. */
  date: string;
  weekday: Weekday;
  windowStartMinute: number;
  windowEndMinute: number;
  /** True when the date fell on a preferred weekday, not merely an allowed one. */
  isPreferredDay: boolean;
}

export type ShortfallReason =
  /** The period had allowed weekdays, but not enough of them. */
  | 'NOT_ENOUGH_ALLOWED_DAYS'
  /** Allowed weekdays existed but the site is shut on all of them. */
  | 'SITE_CLOSED_ON_ALLOWED_DAYS'
  /** The site is open, but never long enough for one visit. */
  | 'WINDOW_TOO_SHORT_FOR_VISIT';

export interface PreviewShortfall {
  /** First date of the period that came up short. */
  periodStart: string;
  periodEnd: string;
  requested: number;
  scheduled: number;
  reason: ShortfallReason;
  message: string;
}

export interface SchedulePreview {
  visits: PreviewVisit[];
  shortfalls: PreviewShortfall[];
  horizonStart: string;
  horizonEnd: string;
}

const WEEKDAY_BY_INDEX: Weekday[] = [
  Weekday.SUNDAY,
  Weekday.MONDAY,
  Weekday.TUESDAY,
  Weekday.WEDNESDAY,
  Weekday.THURSDAY,
  Weekday.FRIDAY,
  Weekday.SATURDAY,
];

const DAY_MS = 24 * 60 * 60 * 1000;

export function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export function weekdayOf(date: Date): Weekday {
  return WEEKDAY_BY_INDEX[date.getUTCDay()];
}

/**
 * Narrows the site's opening windows by the agreement's own window.
 *
 * The agreement can only ever restrict: a customer who opens 09:00–17:00 does
 * not become reachable at 08:00 because an agreement says so.
 */
export function effectiveWindows(
  siteWindows: DayWindow[],
  agreementStart: number | null,
  agreementEnd: number | null,
): DayWindow[] {
  const windows: DayWindow[] = [];

  for (const window of siteWindows) {
    const startMinute = Math.max(window.startMinute, agreementStart ?? window.startMinute);
    const endMinute = Math.min(window.endMinute, agreementEnd ?? window.endMinute);
    if (endMinute > startMinute) windows.push({ startMinute, endMinute });
  }

  return windows.sort((a, b) => a.startMinute - b.startMinute);
}

/**
 * Identifies the cycle a date belongs to, relative to the horizon.
 *
 * With an interval of 1 this is simply the week or month. With a larger one
 * the periods are grouped: an interval of 2 on WEEK puts a fortnight in one
 * bucket, so "one visit per fortnight" places one visit across both weeks
 * rather than one in each.
 */
function periodIndex(
  date: Date,
  horizonStart: Date,
  unit: FrequencyUnit,
  interval: number,
): number {
  if (unit === FrequencyUnit.MONTH) {
    const monthsFromStart =
      (date.getUTCFullYear() - horizonStart.getUTCFullYear()) * 12 +
      (date.getUTCMonth() - horizonStart.getUTCMonth());
    return Math.floor(monthsFromStart / interval);
  }

  const weeksFromStart = Math.floor(
    (date.getTime() - horizonStart.getTime()) / DAY_MS / 7,
  );
  return Math.floor(weeksFromStart / interval);
}

interface Candidate extends PreviewVisit {
  period: number;
}

export function computeSchedulePreview(input: SchedulePreviewInput): SchedulePreview {
  const allowed = new Set(input.allowedDays);
  const preferred = new Set(input.preferredDays);
  const interval = Math.max(1, input.frequencyInterval ?? 1);

  const agreementStart = parseDateOnly(input.startDate);
  const horizonStart = input.from ? parseDateOnly(input.from) : agreementStart;
  const effectiveStart = horizonStart > agreementStart ? horizonStart : agreementStart;

  const horizonWeeks = input.horizonWeeks ?? 4;
  const horizonEnd = new Date(effectiveStart.getTime() + horizonWeeks * 7 * DAY_MS - DAY_MS);
  const agreementEnd = input.endDate ? parseDateOnly(input.endDate) : null;
  const lastDate =
    agreementEnd && agreementEnd < horizonEnd ? agreementEnd : horizonEnd;

  const windowsByWeekday = new Map<Weekday, DayWindow[]>();
  for (const window of input.siteWindows) {
    const list = windowsByWeekday.get(window.weekday) ?? [];
    list.push({ startMinute: window.startMinute, endMinute: window.endMinute });
    windowsByWeekday.set(window.weekday, list);
  }

  const candidates: Candidate[] = [];
  // Tracked separately so a shortfall can say *why*: no allowed weekday at all
  // reads very differently from a site that is simply shut that week.
  const periodsWithAllowedDay = new Set<number>();
  const periodsWithOpenDay = new Set<number>();
  const periodBounds = new Map<number, { start: string; end: string }>();

  for (
    let cursor = new Date(effectiveStart);
    cursor <= lastDate;
    cursor = new Date(cursor.getTime() + DAY_MS)
  ) {
    const period = periodIndex(cursor, effectiveStart, input.frequencyUnit, interval);
    const date = toDateOnly(cursor);

    const bounds = periodBounds.get(period);
    if (!bounds) periodBounds.set(period, { start: date, end: date });
    else bounds.end = date;

    const weekday = weekdayOf(cursor);
    if (!allowed.has(weekday)) continue;
    periodsWithAllowedDay.add(period);

    const windows = effectiveWindows(
      windowsByWeekday.get(weekday) ?? [],
      input.agreementWindowStartMinute,
      input.agreementWindowEndMinute,
    );
    if (windows.length > 0) periodsWithOpenDay.add(period);

    for (const window of windows) {
      if (window.endMinute - window.startMinute < input.durationMinutes) continue;
      candidates.push({
        date,
        weekday,
        windowStartMinute: window.startMinute,
        windowEndMinute: window.endMinute,
        isPreferredDay: preferred.has(weekday),
        period,
      });
    }
  }

  const byPeriod = new Map<number, Candidate[]>();
  for (const candidate of candidates) {
    const list = byPeriod.get(candidate.period) ?? [];
    list.push(candidate);
    byPeriod.set(candidate.period, list);
  }

  const visits: PreviewVisit[] = [];
  const shortfalls: PreviewShortfall[] = [];

  for (const [period, bounds] of [...periodBounds.entries()].sort((a, b) => a[0] - b[0])) {
    const inPeriod = byPeriod.get(period) ?? [];

    // Preferred weekdays first, then earliest. At most one visit per calendar
    // day: two visits on one Tuesday is a different commitment from two visits
    // in a week, and the agreement asked for the latter.
    const chosen: Candidate[] = [];
    const usedDates = new Set<string>();
    for (const candidate of [...inPeriod].sort(rankCandidates)) {
      if (usedDates.has(candidate.date)) continue;
      usedDates.add(candidate.date);
      chosen.push(candidate);
      if (chosen.length === input.frequencyCount) break;
    }

    visits.push(...chosen.map(stripPeriod));

    if (chosen.length < input.frequencyCount) {
      const isLastPeriod = bounds.end === toDateOnly(lastDate);
      const isFirstPeriod = bounds.start === toDateOnly(effectiveStart);
      // A clipped first or last period was never a whole week or month, so it
      // was never promised the full count. Reporting it would cry wolf.
      if (isLastPeriod || isFirstPeriod) {
        const spansWholePeriod = coversWholePeriod(bounds, input.frequencyUnit, interval);
        if (!spansWholePeriod) continue;
      }

      shortfalls.push({
        periodStart: bounds.start,
        periodEnd: bounds.end,
        requested: input.frequencyCount,
        scheduled: chosen.length,
        ...explainShortfall({
          period,
          requested: input.frequencyCount,
          scheduled: chosen.length,
          bounds,
          hadAllowedDay: periodsWithAllowedDay.has(period),
          hadOpenDay: periodsWithOpenDay.has(period),
          durationMinutes: input.durationMinutes,
        }),
      });
    }
  }

  return {
    visits: visits.sort((a, b) => a.date.localeCompare(b.date)),
    shortfalls,
    horizonStart: toDateOnly(effectiveStart),
    horizonEnd: toDateOnly(lastDate),
  };
}

function rankCandidates(a: Candidate, b: Candidate): number {
  if (a.isPreferredDay !== b.isPreferredDay) return a.isPreferredDay ? -1 : 1;
  if (a.date !== b.date) return a.date.localeCompare(b.date);
  return a.windowStartMinute - b.windowStartMinute;
}

function stripPeriod(candidate: Candidate): PreviewVisit {
  const { period: _period, ...visit } = candidate;
  return visit;
}

/** True when the bounds cover a whole cycle, not a clipped piece of one. */
function coversWholePeriod(
  bounds: { start: string; end: string },
  unit: FrequencyUnit,
  interval: number,
): boolean {
  const start = parseDateOnly(bounds.start);
  const end = parseDateOnly(bounds.end);
  const days = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;

  if (unit === FrequencyUnit.WEEK) return days >= 7 * interval;

  let daysInCycle = 0;
  for (let offset = 0; offset < interval; offset += 1) {
    daysInCycle += new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset + 1, 0),
    ).getUTCDate();
  }
  return days >= daysInCycle;
}

function explainShortfall(context: {
  period: number;
  requested: number;
  scheduled: number;
  bounds: { start: string; end: string };
  hadAllowedDay: boolean;
  hadOpenDay: boolean;
  durationMinutes: number;
}): { reason: ShortfallReason; message: string } {
  const span = `${context.bounds.start} to ${context.bounds.end}`;
  const shortBy = context.requested - context.scheduled;

  if (!context.hadAllowedDay) {
    return {
      reason: 'NOT_ENOUGH_ALLOWED_DAYS',
      message: `No allowed weekday falls between ${span}, so none of the ${context.requested} visit(s) can be placed. Allow more weekdays.`,
    };
  }

  if (!context.hadOpenDay) {
    return {
      reason: 'SITE_CLOSED_ON_ALLOWED_DAYS',
      message: `The site is closed on every allowed weekday between ${span}. Add opening hours for an allowed day, or allow a day the site is open.`,
    };
  }

  if (context.scheduled === 0) {
    return {
      reason: 'WINDOW_TOO_SHORT_FOR_VISIT',
      message: `The site is open on an allowed day between ${span}, but never for the ${context.durationMinutes} minutes this visit needs. Widen the hours or shorten the visit.`,
    };
  }

  return {
    reason: 'NOT_ENOUGH_ALLOWED_DAYS',
    message: `Only ${context.scheduled} of ${context.requested} visit(s) fit between ${span} — short by ${shortBy}. Allow more weekdays, or lower the frequency.`,
  };
}

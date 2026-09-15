import { DataProvenance, FrequencyUnit, Weekday } from '@prisma/client';

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

/**
 * The window assumed when a site's opening hours are unknown.
 *
 * Only used when a site has *no* recorded hours whatsoever. It is always
 * disclosed — every visit placed on it is flagged "hours unconfirmed" — so a
 * manager can tell an assumption from a fact, and the flag clears itself the
 * moment real hours are entered.
 */
export const ASSUMED_DAY_WINDOW = { startMinute: 8 * 60, endMinute: 17 * 60 };

/** One window inside a day, as minutes from midnight. */
export interface DayWindow {
  startMinute: number;
  endMinute: number;
}

export interface SiteWindow extends DayWindow {
  weekday: Weekday;
  /**
   * Provenance of the opening-hours row this window was read from. Carried
   * through so a generated visit records where its window actually came from,
   * rather than every visit with any recorded hours being called derived.
   */
  provenance?: DataProvenance;
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
  /**
   * The site's opening windows. A weekday with no window is closed —
   * *provided the site has some hours recorded at all*. An empty list means
   * nobody has told us the hours, which is not the same as "never open": the
   * master schedule workbook has no opening-hours column, so 907 of 999
   * imported sites arrive with none, and treating that as closed refuses to
   * schedule work UltraKIL demonstrably performs. See `ASSUMED_DAY_WINDOW`.
   */
  siteWindows: SiteWindow[];
  /** Optional narrowing of the site's hours, applied to every day. */
  agreementWindowStartMinute: number | null;
  agreementWindowEndMinute: number | null;
  durationMinutes: number;
  /** How far ahead to look. Defaults to 4 weeks. */
  horizonWeeks?: number;
  /** Where the horizon begins. Defaults to the agreement's start date. */
  from?: string;
  /**
   * Dates already agreed with the customer, as YYYY-MM-DD.
   *
   * A period holding one or more of these is not planned at all: its visits
   * are exactly those dates. A booking outranks the allowed-weekday rule,
   * because the rule is usually inferred from these very dates and a fact
   * cannot be overruled by an inference drawn from it.
   */
  bookedDates?: string[];
  /**
   * Days of the month this agreement is usually served on, in order.
   *
   * Used only for periods no booking covers. One anchor means "around the
   * 17th"; two mean "around the 5th and around the 20th". Passed in rather
   * than worked out here so this function stays a pure statement of the
   * agreement's dates — the caller owns where the anchors come from.
   */
  anchorDays?: number[];
}

/**
 * Why a visit sits on the date it does.
 *
 * SPREAD is never produced here: it is what the cross-agreement load guard
 * writes when it moves a visit off a day that was already full. This function
 * plans one agreement at a time and cannot see the other agreements' days.
 */
export type VisitPlacementKind = 'BOOKED' | 'ANCHORED' | 'EARLIEST';

/** Another day in the same period this visit could have used instead. */
export interface PreviewAlternative {
  /** YYYY-MM-DD. */
  date: string;
  weekday: Weekday;
  windowStartMinute: number;
  windowEndMinute: number;
  isPreferredDay: boolean;
  windowProvenance: DataProvenance;
}

export interface PreviewVisit {
  /** YYYY-MM-DD. */
  date: string;
  weekday: Weekday;
  windowStartMinute: number;
  windowEndMinute: number;
  /** True when the date fell on a preferred weekday, not merely an allowed one. */
  isPreferredDay: boolean;
  /** Where this date came from. */
  placement: VisitPlacementKind;
  /**
   * Which cycle of the horizon this visit belongs to, counted from the
   * agreement's own first day. Two visits sharing a period are the same
   * week's or month's work, which is what the load guard needs to know before
   * it moves one of them.
   */
  periodIndex: number;
  /**
   * The other days of the same period this visit could sit on instead, free
   * of the dates its own period already uses. Empty for a booked visit: a
   * booking is a commitment, not a candidate.
   */
  alternatives: PreviewAlternative[];
  /**
   * Where this visit's window came from: the provenance of the opening-hours
   * row it was read from, MANAGER_CONFIRMED when the agreement's own service
   * window determined it outright, or DEFAULTED when it rests on the
   * disclosed 08:00-17:00 assumption.
   */
  windowProvenance: DataProvenance;
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
export function effectiveWindows<T extends DayWindow>(
  siteWindows: T[],
  agreementStart: number | null,
  agreementEnd: number | null,
): Array<T & DayWindow> {
  const windows: Array<T & DayWindow> = [];

  for (const window of siteWindows) {
    const startMinute = Math.max(window.startMinute, agreementStart ?? window.startMinute);
    const endMinute = Math.min(window.endMinute, agreementEnd ?? window.endMinute);
    if (endMinute > startMinute) windows.push({ ...window, startMinute, endMinute });
  }

  return windows.sort((a, b) => a.startMinute - b.startMinute);
}

/**
 * Where a visit's window came from.
 *
 * Recorded hours speak for themselves: a manager-confirmed row yields a
 * confirmed window, and an imported one stays imported. Narrowing by the
 * agreement's own service window does not weaken that — the agreement is
 * manager-entered too, and it can only restrict.
 *
 * With no hours recorded at all the 08:00-17:00 assumption is in play and the
 * window is DEFAULTED — unless the agreement stated both bounds and they sit
 * inside the assumption, in which case the assumption contributed nothing to
 * the answer and the window is exactly what a manager asked for.
 */
export function windowProvenanceOf(input: {
  hoursRecorded: boolean;
  hoursProvenance?: DataProvenance;
  agreementStart: number | null;
  agreementEnd: number | null;
  startMinute: number;
  endMinute: number;
}): DataProvenance {
  if (input.hoursRecorded) return input.hoursProvenance ?? DataProvenance.DERIVED;
  const statedByAgreement =
    input.agreementStart !== null &&
    input.agreementEnd !== null &&
    input.startMinute === input.agreementStart &&
    input.endMinute === input.agreementEnd;
  return statedByAgreement ? DataProvenance.MANAGER_CONFIRMED : DataProvenance.DEFAULTED;
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

/** One placeable day, before anything has been chosen. */
interface Candidate {
  date: string;
  weekday: Weekday;
  windowStartMinute: number;
  windowEndMinute: number;
  isPreferredDay: boolean;
  windowProvenance: DataProvenance;
  period: number;
  /**
   * False for a day reached only because it is booked. Such a day is a fact
   * to be honoured, never a candidate for an unbooked period to be planned
   * onto, and it must not count towards the shortfall reasoning either.
   */
  isAllowedDay: boolean;
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

  // No hours anywhere for this site means unknown, not shut.
  const hoursUnconfirmed = input.siteWindows.length === 0;

  type SourcedWindow = DayWindow & { provenance?: DataProvenance };
  const windowsByWeekday = new Map<Weekday, SourcedWindow[]>();
  for (const window of input.siteWindows) {
    const list = windowsByWeekday.get(window.weekday) ?? [];
    list.push({
      startMinute: window.startMinute,
      endMinute: window.endMinute,
      provenance: window.provenance,
    });
    windowsByWeekday.set(window.weekday, list);
  }

  // Only the bookings that fall inside the horizon. A date further out is a
  // commitment for a run that covers it, not this one.
  const horizonStartText = toDateOnly(effectiveStart);
  const horizonEndText = toDateOnly(lastDate);
  const bookedInRange = [
    ...new Set(
      (input.bookedDates ?? []).filter(
        (date) => date >= horizonStartText && date <= horizonEndText,
      ),
    ),
  ].sort();
  const bookedSet = new Set(bookedInRange);

  const candidates: Candidate[] = [];
  // Tracked separately so a shortfall can say *why*: no allowed weekday at all
  // reads very differently from a site that is simply shut that week.
  const periodsWithAllowedDay = new Set<number>();
  const periodsWithOpenDay = new Set<number>();
  const periodBounds = new Map<number, { start: string; end: string }>();
  const bookedByPeriod = new Map<number, string[]>();

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
    const isAllowedDay = allowed.has(weekday);
    const isBookedDay = bookedSet.has(date);

    if (isBookedDay) {
      const list = bookedByPeriod.get(period) ?? [];
      list.push(date);
      bookedByPeriod.set(period, list);
    }

    if (!isAllowedDay && !isBookedDay) continue;
    if (isAllowedDay) periodsWithAllowedDay.add(period);

    const windows = effectiveWindows<SourcedWindow>(
      hoursUnconfirmed ? [ASSUMED_DAY_WINDOW] : (windowsByWeekday.get(weekday) ?? []),
      input.agreementWindowStartMinute,
      input.agreementWindowEndMinute,
    );
    if (isAllowedDay && windows.length > 0) periodsWithOpenDay.add(period);

    for (const window of windows) {
      if (window.endMinute - window.startMinute < input.durationMinutes) continue;
      candidates.push({
        date,
        weekday,
        windowStartMinute: window.startMinute,
        windowEndMinute: window.endMinute,
        isPreferredDay: preferred.has(weekday),
        windowProvenance: windowProvenanceOf({
          hoursRecorded: !hoursUnconfirmed,
          hoursProvenance: window.provenance,
          agreementStart: input.agreementWindowStartMinute,
          agreementEnd: input.agreementWindowEndMinute,
          startMinute: window.startMinute,
          endMinute: window.endMinute,
        }),
        period,
        isAllowedDay,
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
    const booked = bookedByPeriod.get(period) ?? [];

    // A period the workbook has already booked is not planned at all. Its
    // visits are those dates, in that order, whatever the frequency says —
    // the frequency is a summary of what UltraKIL sells, the bookings are
    // what it actually agreed with this customer for these weeks.
    if (booked.length > 0) {
      const byDate = new Map<string, Candidate>();
      for (const candidate of [...inPeriod].sort(
        (a, b) => a.windowStartMinute - b.windowStartMinute,
      )) {
        if (!byDate.has(candidate.date)) byDate.set(candidate.date, candidate);
      }

      for (const date of booked) {
        const candidate = byDate.get(date);
        visits.push(
          candidate
            ? { ...toVisit(candidate), placement: 'BOOKED' }
            : bookedVisitOnAClosedDay(date, period, input, preferred),
        );
      }
      // Deliberately no shortfall. The workbook booked what it booked; calling
      // that short of the frequency would raise an alarm on every agreement
      // whose written frequency rounds its real pattern up.
      continue;
    }

    // Preferred weekdays first, then closest to an anchor, then earliest. At
    // most one visit per calendar day: two visits on one Tuesday is a
    // different commitment from two visits in a week, and the agreement asked
    // for the latter.
    const placeable = inPeriod.filter((candidate) => candidate.isAllowedDay);
    const { chosen, anchored } = chooseForPeriod(
      placeable,
      input.frequencyCount,
      input.anchorDays ?? [],
    );
    const chosenDates = new Set(chosen.map((candidate) => candidate.date));
    const alternatives = alternativesFrom(placeable, chosenDates);

    visits.push(
      ...chosen.map((candidate) => ({
        ...toVisit(candidate),
        placement: anchored ? ('ANCHORED' as const) : ('EARLIEST' as const),
        alternatives,
      })),
    );

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

/** The day of the month a YYYY-MM-DD string names. */
function dayOfMonth(date: string): number {
  return Number.parseInt(date.slice(8, 10), 10);
}

/**
 * Picks this period's days.
 *
 * With no anchors this is the old behaviour exactly: preferred weekday first,
 * then earliest. With anchors, each one takes its own turn — so an agreement
 * served on the 5th and the 20th keeps both, rather than the second visit
 * crowding onto the day after the first. A preferred weekday still outranks
 * closeness to an anchor: the weekday is what the customer agreed to, the
 * anchor only describes where in the month the work usually falls.
 */
function chooseForPeriod(
  placeable: Candidate[],
  count: number,
  anchorDays: number[],
): { chosen: Candidate[]; anchored: boolean } {
  const chosen: Candidate[] = [];
  const usedDates = new Set<string>();
  let anchored = false;

  const take = (candidate: Candidate) => {
    usedDates.add(candidate.date);
    chosen.push(candidate);
  };

  for (const anchor of [...anchorDays].sort((a, b) => a - b)) {
    if (chosen.length >= count) break;

    const best = placeable
      .filter((candidate) => !usedDates.has(candidate.date))
      .sort((a, b) => {
        if (a.isPreferredDay !== b.isPreferredDay) return a.isPreferredDay ? -1 : 1;
        const distance =
          Math.abs(dayOfMonth(a.date) - anchor) - Math.abs(dayOfMonth(b.date) - anchor);
        if (distance !== 0) return distance;
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        return a.windowStartMinute - b.windowStartMinute;
      })[0];

    if (!best) break;
    anchored = true;
    take(best);
  }

  for (const candidate of [...placeable].sort(rankCandidates)) {
    if (chosen.length >= count) break;
    if (usedDates.has(candidate.date)) continue;
    take(candidate);
  }

  return { chosen: chosen.sort((a, b) => a.date.localeCompare(b.date)), anchored };
}

/** The period's other days, one entry per date, in date order. */
function alternativesFrom(
  placeable: Candidate[],
  chosenDates: Set<string>,
): PreviewAlternative[] {
  const byDate = new Map<string, PreviewAlternative>();

  for (const candidate of [...placeable].sort(
    (a, b) =>
      a.date.localeCompare(b.date) || a.windowStartMinute - b.windowStartMinute,
  )) {
    if (chosenDates.has(candidate.date)) continue;
    if (byDate.has(candidate.date)) continue;
    byDate.set(candidate.date, {
      date: candidate.date,
      weekday: candidate.weekday,
      windowStartMinute: candidate.windowStartMinute,
      windowEndMinute: candidate.windowEndMinute,
      isPreferredDay: candidate.isPreferredDay,
      windowProvenance: candidate.windowProvenance,
    });
  }

  return [...byDate.values()];
}

function toVisit(candidate: Candidate): PreviewVisit {
  return {
    date: candidate.date,
    weekday: candidate.weekday,
    windowStartMinute: candidate.windowStartMinute,
    windowEndMinute: candidate.windowEndMinute,
    isPreferredDay: candidate.isPreferredDay,
    windowProvenance: candidate.windowProvenance,
    placement: 'EARLIEST',
    periodIndex: candidate.period,
    alternatives: [],
  };
}

/**
 * A booked date the site has no usable window on.
 *
 * The customer has agreed the day; refusing to plan it would hide a visit
 * UltraKIL is committed to. So the disclosed 08:00-17:00 assumption is used
 * and the window is flagged DEFAULTED, exactly as it is for a site with no
 * recorded hours at all — visible as an assumption, never as a fact.
 */
function bookedVisitOnAClosedDay(
  date: string,
  period: number,
  input: SchedulePreviewInput,
  preferred: Set<Weekday>,
): PreviewVisit {
  const narrowed = effectiveWindows(
    [ASSUMED_DAY_WINDOW],
    input.agreementWindowStartMinute,
    input.agreementWindowEndMinute,
  );
  const window = narrowed[0] ?? ASSUMED_DAY_WINDOW;
  const weekday = weekdayOf(parseDateOnly(date));

  return {
    date,
    weekday,
    windowStartMinute: window.startMinute,
    windowEndMinute: window.endMinute,
    isPreferredDay: preferred.has(weekday),
    windowProvenance: DataProvenance.DEFAULTED,
    placement: 'BOOKED',
    periodIndex: period,
    alternatives: [],
  };
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

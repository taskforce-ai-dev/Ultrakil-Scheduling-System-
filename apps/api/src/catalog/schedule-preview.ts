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
  /**
   * How far ahead to look. Defaults to 4 weeks.
   *
   * A convenience for the agreement screen, which asks "the next few weeks"
   * and has no end date in mind. Generation knows exactly which day its range
   * ends on and passes `to` instead — rounding 1-30 September up to five weeks
   * would have the run believe it held the first days of October whole.
   */
  horizonWeeks?: number;
  /** Where the horizon begins. Defaults to the agreement's start date. */
  from?: string;
  /** Last day of the horizon, inclusive, YYYY-MM-DD. Overrides `horizonWeeks`. */
  to?: string;
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
  /**
   * Plan only the periods this horizon contains whole.
   *
   * Two callers ask two different questions. The agreement screen asks "when
   * would we visit over the next few weeks?", and the honest answer for a
   * monthly agreement previewed over four weeks is "once, around the 5th" —
   * the horizon is a window onto the commitment, not a boundary of it.
   *
   * Generation asks "which visits does this range owe?", and there the edges
   * matter: a run given the calendar *grid* for September starts on the 31st
   * of August, and planning that one-day stub as though it were the month put
   * a visit on the 31st while the August visit already published on the 17th
   * lay outside the range, invisible to the pinning and to the load guard.
   * The customer got two August visits every time the button was pressed.
   *
   * So generation sets this, and a period the run cannot see whole is left to
   * the run that can — and named in `skippedPeriods`, so a range that holds no
   * whole period for an agreement reports why rather than a bare zero. A
   * period clipped by the agreement's *own* first or last day is not affected:
   * the agreement really does begin, or end, there.
   *
   * Because periods are calendar-aligned, "whole" is a property of the range
   * and the cadence alone. A whole ISO week is whole for every weekly
   * agreement, a whole calendar month for every monthly one, and the portal's
   * two views can therefore be made to plan exactly the same periods.
   */
  wholePeriodsOnly?: boolean;
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
   * Which cycle this visit belongs to: the ISO week or calendar month counted
   * from the agreement's own start. Two visits sharing a period are the same
   * week's or month's work, which is what the load guard needs to know before
   * it moves one of them — and, because the index does not depend on the range
   * being generated, two runs over different ranges agree about it.
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
  | 'WINDOW_TOO_SHORT_FOR_VISIT'
  /**
   * The workbook booked this period, but booked it fewer times than the
   * agreement's frequency promises. The bookings still stand — they are what
   * was actually agreed — but the gap is said out loud rather than left for a
   * manager to notice a quarter later.
   */
  | 'BOOKED_BELOW_FREQUENCY';

export interface PreviewShortfall {
  /** First date of the period that came up short. */
  periodStart: string;
  periodEnd: string;
  requested: number;
  scheduled: number;
  reason: ShortfallReason;
  message: string;
}

/**
 * Why a booked date could not be honoured on the site's own recorded hours.
 *
 * A booking is a commitment: the visit is planned whatever the hours say. But
 * planning it on hours nobody recorded, or inside a window too short to do the
 * work, is a fact a manager has to be told — the alternative is a calendar
 * that looks fine and a crew that arrives to a locked door.
 */
export type BookingIssueReason =
  /** The site has hours on record, but none for that weekday. */
  | 'SITE_CLOSED_ON_BOOKED_DAY'
  /** The recorded window that day is shorter than the visit needs. */
  | 'WINDOW_TOO_SHORT_FOR_BOOKED_VISIT'
  /**
   * The site is open long enough, but not while the agreement allows work.
   *
   * A distinct case, because the fix is a distinct one. Reporting it as a
   * window too short sends a manager to widen opening hours that were never
   * the problem — what has to move is the agreement's own service window.
   */
  | 'AGREEMENT_WINDOW_OUTSIDE_SITE_HOURS';

export interface PreviewBookingIssue {
  /** YYYY-MM-DD. */
  date: string;
  reason: BookingIssueReason;
  /** The window the visit was actually planned on. */
  windowStartMinute: number;
  windowEndMinute: number;
  /** True when that window is the disclosed 08:00-17:00 assumption. */
  windowAssumed: boolean;
  message: string;
}

/** A period, by index and by the whole calendar span it covers. */
export interface PreviewPeriod {
  periodIndex: number;
  /** YYYY-MM-DD, the period's own first day — not the range's. */
  start: string;
  /** YYYY-MM-DD, the period's own last day — not the range's. */
  end: string;
}

/** A period this run left to the run that can see it whole. */
export interface PreviewSkippedPeriod extends PreviewPeriod {
  reason: 'CLIPPED_BY_THE_HORIZON';
}

export interface SchedulePreview {
  visits: PreviewVisit[];
  shortfalls: PreviewShortfall[];
  /**
   * Booked dates the site's recorded hours do not support. Never a reason to
   * drop the visit; always a reason to say so.
   */
  bookingIssues: PreviewBookingIssue[];
  /**
   * The periods this preview actually planned, whole spans and all.
   *
   * Generation compares what it requires against what already exists, and a
   * visit outside the periods it planned is not its to judge: left in the
   * comparison, an untouched visit sitting in a period the run skipped reads
   * as no longer required and is proposed for removal.
   */
  plannedPeriods: PreviewPeriod[];
  /**
   * The periods the range holds only a slice of, so this run planned none of
   * them. Empty unless `wholePeriodsOnly` is set.
   *
   * Reported rather than silently dropped: a quarterly agreement asked about
   * from a week view can plan nothing at all, and a zero with no explanation
   * is indistinguishable from a calendar that is already correct.
   */
  skippedPeriods: PreviewSkippedPeriod[];
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

/** Monday of the ISO week `date` falls in. UltraKIL's week starts Monday. */
export function startOfIsoWeek(date: Date): Date {
  const backToMonday = (date.getUTCDay() + 6) % 7;
  return new Date(date.getTime() - backToMonday * DAY_MS);
}

/**
 * Identifies the cycle a date belongs to.
 *
 * Periods are **calendar-aligned and anchored to the agreement**, never to the
 * range somebody happened to generate under. A WEEK period is a whole ISO week,
 * Monday to Sunday; a MONTH period is a whole calendar month. With an interval
 * above 1 the periods are grouped from the agreement's own start — a
 * fortnightly agreement's fortnights are the two ISO weeks counted from the
 * week it began in, and a quarterly agreement's quarters are the three-month
 * blocks counted from the month it began in.
 *
 * Phasing them from the run's `from` instead is what made the portal's week and
 * month views disagree: a weekly Mon-Fri agreement got Monday from a week view
 * and, from a month view starting on a Tuesday, the following Tuesday — a
 * duplicate where the Monday was protected, and churn where it was not.
 *
 * `anchor` is therefore the agreement's `startDate`. Dates before it yield
 * negative indices, which is correct and never collides with a later period.
 */
export function periodIndexOf(
  date: Date,
  anchor: Date,
  unit: FrequencyUnit,
  interval: number,
): number {
  if (unit === FrequencyUnit.MONTH) {
    const monthsFromAnchor =
      (date.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
      (date.getUTCMonth() - anchor.getUTCMonth());
    return Math.floor(monthsFromAnchor / interval);
  }

  const weeksFromAnchor = Math.round(
    (startOfIsoWeek(date).getTime() - startOfIsoWeek(anchor).getTime()) / DAY_MS / 7,
  );
  return Math.floor(weeksFromAnchor / interval);
}

/**
 * The whole calendar span a period covers, whatever range is being generated.
 *
 * The counterpart to `periodIndexOf`, and the reason a run can tell a period it
 * holds whole from one it has only a slice of: the slice's first and last day
 * inside the range say nothing on their own.
 */
export function periodBoundsOf(
  periodIndex: number,
  anchor: Date,
  unit: FrequencyUnit,
  interval: number,
): { start: string; end: string } {
  if (unit === FrequencyUnit.MONTH) {
    const first = new Date(
      Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + periodIndex * interval, 1),
    );
    const last = new Date(
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + interval, 0),
    );
    return { start: toDateOnly(first), end: toDateOnly(last) };
  }

  const first = new Date(
    startOfIsoWeek(anchor).getTime() + periodIndex * interval * 7 * DAY_MS,
  );
  const last = new Date(first.getTime() + (interval * 7 - 1) * DAY_MS);
  return { start: toDateOnly(first), end: toDateOnly(last) };
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

  // The range's real last day when generation states it, and otherwise "a few
  // weeks from here" for the agreement screen. Rounding the former up to whole
  // weeks would have a run over 1-30 September believe it held October's first
  // days whole.
  const horizonEnd = input.to
    ? parseDateOnly(input.to)
    : new Date(effectiveStart.getTime() + (input.horizonWeeks ?? 4) * 7 * DAY_MS - DAY_MS);
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
    // Anchored to the agreement, never to the range: a fortnight belongs to
    // the agreement that sells it, not to whoever pressed Generate.
    const period = periodIndexOf(cursor, agreementStart, input.frequencyUnit, interval);
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
  const bookingIssues: PreviewBookingIssue[] = [];
  const plannedPeriods: PreviewPeriod[] = [];
  const skippedPeriods: PreviewSkippedPeriod[] = [];

  const firstDay = toDateOnly(effectiveStart);
  const finalDay = toDateOnly(lastDate);
  // Whether the range's own ends are the agreement's. A period cut short
  // because the agreement begins or ends there is a real period; one cut short
  // because the horizon does is a slice of somebody else's.
  const startsWithTheAgreement = firstDay === toDateOnly(agreementStart);
  const endsWithTheAgreement =
    agreementEnd !== null && finalDay === toDateOnly(agreementEnd);

  /**
   * True when the range holds only a slice of this period. Such a period was
   * never promised the full count, so counting its visits against the
   * frequency would cry wolf.
   */
  const isClipped = (whole: PreviewPeriod): boolean =>
    whole.start < firstDay || whole.end > finalDay;

  /**
   * True when a caller that plans only whole periods must skip this one.
   *
   * That is: the range holds only a slice of the period, and what clipped it
   * was the horizon rather than the agreement's own first or last day. See
   * `wholePeriodsOnly` for why generation asks for this and the agreement
   * screen does not.
   */
  const clippedByTheHorizon = (whole: PreviewPeriod): boolean => {
    if (!input.wholePeriodsOnly) return false;
    if (whole.start < firstDay && !startsWithTheAgreement) return true;
    if (whole.end > finalDay && !endsWithTheAgreement) return true;
    return false;
  };

  for (const [period, bounds] of [...periodBounds.entries()].sort((a, b) => a[0] - b[0])) {
    const inPeriod = byPeriod.get(period) ?? [];
    const booked = bookedByPeriod.get(period) ?? [];
    const whole: PreviewPeriod = {
      periodIndex: period,
      ...periodBoundsOf(period, agreementStart, input.frequencyUnit, interval),
    };

    // A period the workbook has already booked is not planned at all. Its
    // visits are those dates, in that order, whatever the frequency says —
    // the frequency is a summary of what UltraKIL sells, the bookings are
    // what it actually agreed with this customer for these weeks.
    if (booked.length > 0) {
      // A booked period is planned whatever the range holds of it: a booked
      // date is a commitment to a day, not a plan the run made.
      plannedPeriods.push(whole);
      const byDate = new Map<string, Candidate>();
      for (const candidate of [...inPeriod].sort(
        (a, b) => a.windowStartMinute - b.windowStartMinute,
      )) {
        if (!byDate.has(candidate.date)) byDate.set(candidate.date, candidate);
      }

      for (const date of booked) {
        const candidate = byDate.get(date);
        if (candidate) {
          visits.push({ ...toVisit(candidate), placement: 'BOOKED' });
          continue;
        }
        const fallback = bookedVisitWithoutAUsableWindow(
          date,
          period,
          input,
          preferred,
          windowsByWeekday.get(weekdayOf(parseDateOnly(date))) ?? [],
          hoursUnconfirmed,
        );
        visits.push(fallback.visit);
        if (fallback.issue) bookingIssues.push(fallback.issue);
      }

      // The bookings are honoured exactly as written — this is deliberately
      // not re-planned. But a period booked fewer times than the agreement
      // promises is a gap the customer is paying for, so it is reported.
      if (booked.length < input.frequencyCount && !isClipped(whole)) {
        shortfalls.push({
          periodStart: bounds.start,
          periodEnd: bounds.end,
          requested: input.frequencyCount,
          scheduled: booked.length,
          reason: 'BOOKED_BELOW_FREQUENCY',
          message: `Only ${booked.length} of the ${input.frequencyCount} visit(s) this agreement promises between ${bounds.start} and ${bounds.end} are booked in the workbook. The booked dates are used exactly as written and no extra visit is planned — add the missing date to the workbook, or lower the frequency.`,
        });
      }
      continue;
    }

    // A slice of a period the horizon cut belongs to the run that can see it
    // whole. Bookings above are exempt: a booked date is a commitment to a
    // day, not a plan the run made, and honouring it invents nothing.
    if (clippedByTheHorizon(whole)) {
      skippedPeriods.push({ ...whole, reason: 'CLIPPED_BY_THE_HORIZON' });
      continue;
    }
    plannedPeriods.push(whole);

    // Preferred weekdays first, then closest to an anchor, then earliest. At
    // most one visit per calendar day: two visits on one Tuesday is a
    // different commitment from two visits in a week, and the agreement asked
    // for the latter.
    const placeable = inPeriod.filter((candidate) => candidate.isAllowedDay);
    const picks = chooseForPeriod(
      placeable,
      input.frequencyCount,
      input.anchorDays ?? [],
    );
    const chosenDates = new Set(picks.map((pick) => pick.candidate.date));
    const alternatives = alternativesFrom(placeable, chosenDates);

    visits.push(
      ...picks.map((pick) => ({
        ...toVisit(pick.candidate),
        placement: pick.placement,
        alternatives,
      })),
    );

    if (picks.length < input.frequencyCount) {
      if (isClipped(whole)) continue;

      shortfalls.push({
        periodStart: bounds.start,
        periodEnd: bounds.end,
        requested: input.frequencyCount,
        scheduled: picks.length,
        ...explainShortfall({
          period,
          requested: input.frequencyCount,
          scheduled: picks.length,
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
    bookingIssues: bookingIssues.sort((a, b) => a.date.localeCompare(b.date)),
    plannedPeriods: plannedPeriods.sort((a, b) => a.periodIndex - b.periodIndex),
    skippedPeriods: skippedPeriods.sort((a, b) => a.periodIndex - b.periodIndex),
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

/** One chosen day, and the reason it was chosen. */
interface Pick {
  candidate: Candidate;
  placement: 'ANCHORED' | 'EARLIEST';
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
 *
 * The reason is recorded per day, not per period. An agreement served four
 * times a month with one known anchor gets one ANCHORED visit and three the
 * anchors said nothing about; labelling all four ANCHORED would tell a manager
 * the site's usual day explains a date it had no part in choosing.
 */
function chooseForPeriod(
  placeable: Candidate[],
  count: number,
  anchorDays: number[],
): Pick[] {
  const picks: Pick[] = [];
  const usedDates = new Set<string>();

  const take = (candidate: Candidate, placement: 'ANCHORED' | 'EARLIEST') => {
    usedDates.add(candidate.date);
    picks.push({ candidate, placement });
  };

  for (const anchor of [...anchorDays].sort((a, b) => a - b)) {
    if (picks.length >= count) break;

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
    take(best, 'ANCHORED');
  }

  for (const candidate of [...placeable].sort(rankCandidates)) {
    if (picks.length >= count) break;
    if (usedDates.has(candidate.date)) continue;
    take(candidate, 'EARLIEST');
  }

  return picks.sort((a, b) => a.candidate.date.localeCompare(b.candidate.date));
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

/** Minutes-from-midnight as HH:MM, for a message a manager reads. */
function clockText(minute: number): string {
  const hours = Math.floor(minute / 60);
  return `${String(hours).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/**
 * A booked date no candidate was produced for.
 *
 * The customer has agreed the day; refusing to plan it would hide a visit
 * UltraKIL is committed to. What the visit must *not* do is quietly swap the
 * site's own recorded hours for the 08:00-17:00 assumption — a window recorded
 * as 09:00-10:00 is a fact, and overwriting it with a made-up nine-hour day
 * tells a manager the crew has all day when it has an hour.
 *
 * So: hours recorded for that weekday are used as they stand, however short,
 * and keep their own provenance. Only a weekday with no recorded hours at all
 * falls back to the assumption, flagged DEFAULTED. Either way the reason is
 * returned as an issue, because neither case should be discovered on the day.
 *
 * Three reasons, not two. A site open 09:00-10:00 under an agreement that only
 * allows 12:00-17:00 has hours long enough for the work and no overlap with
 * the agreement at all; calling that "the recorded hours are shorter than the
 * visit" sends a manager to widen hours that were never the problem.
 */
function bookedVisitWithoutAUsableWindow(
  date: string,
  period: number,
  input: SchedulePreviewInput,
  preferred: Set<Weekday>,
  recorded: Array<DayWindow & { provenance?: DataProvenance }>,
  hoursUnconfirmed: boolean,
): { visit: PreviewVisit; issue: PreviewBookingIssue | null } {
  const weekday = weekdayOf(parseDateOnly(date));

  // The longest recorded window gives the visit its best chance; earliest
  // start breaks a tie, so two runs pick the same one.
  const best = [...recorded].sort(
    (a, b) =>
      b.endMinute - b.startMinute - (a.endMinute - a.startMinute) ||
      a.startMinute - b.startMinute,
  )[0];

  const useRecorded = !hoursUnconfirmed && best !== undefined;
  const source = useRecorded ? best : ASSUMED_DAY_WINDOW;
  const narrowed = effectiveWindows(
    [source],
    input.agreementWindowStartMinute,
    input.agreementWindowEndMinute,
  )[0];
  // The agreement can only restrict, and here it has restricted the recorded
  // window out of existence. The recorded window is still the truthful answer
  // to "when is this site open?", so the visit keeps it — and the mismatch is
  // reported as itself rather than as hours that are too short.
  const window = narrowed ?? source;
  const agreementMissesTheHours = narrowed === undefined;

  const windowProvenance = useRecorded
    ? windowProvenanceOf({
        hoursRecorded: true,
        hoursProvenance: best.provenance,
        agreementStart: input.agreementWindowStartMinute,
        agreementEnd: input.agreementWindowEndMinute,
        startMinute: window.startMinute,
        endMinute: window.endMinute,
      })
    : DataProvenance.DEFAULTED;

  const visit: PreviewVisit = {
    date,
    weekday,
    windowStartMinute: window.startMinute,
    windowEndMinute: window.endMinute,
    isPreferredDay: preferred.has(weekday),
    windowProvenance,
    placement: 'BOOKED',
    periodIndex: period,
    alternatives: [],
  };

  // A site with no hours on record anywhere is already disclosed on every one
  // of its visits; that is not news. The two cases worth a warning are a site
  // whose hours say it is shut that weekday, and one whose hours are simply
  // too short for the work.
  if (hoursUnconfirmed) return { visit, issue: null };

  if (useRecorded && agreementMissesTheHours) {
    return {
      visit,
      issue: {
        date,
        reason: 'AGREEMENT_WINDOW_OUTSIDE_SITE_HOURS',
        windowStartMinute: window.startMinute,
        windowEndMinute: window.endMinute,
        windowAssumed: false,
        message: `${date} is booked with the customer, but this agreement's service window of ${clockText(input.agreementWindowStartMinute ?? 0)}-${clockText(input.agreementWindowEndMinute ?? 0)} and the site's recorded hours that day of ${clockText(window.startMinute)}-${clockText(window.endMinute)} do not overlap. The visit is planned on the site's recorded window. Widen the agreement's service window, or correct the hours.`,
      },
    };
  }

  const issue: PreviewBookingIssue = useRecorded
    ? {
        date,
        reason: 'WINDOW_TOO_SHORT_FOR_BOOKED_VISIT',
        windowStartMinute: window.startMinute,
        windowEndMinute: window.endMinute,
        windowAssumed: false,
        message: `${date} is booked with the customer, but the site's recorded hours that day are only ${clockText(window.startMinute)}-${clockText(window.endMinute)} — less than the ${input.durationMinutes} minutes this visit needs. The visit is planned on the recorded window as it stands. Correct the hours or shorten the visit.`,
      }
    : {
        date,
        reason: 'SITE_CLOSED_ON_BOOKED_DAY',
        windowStartMinute: window.startMinute,
        windowEndMinute: window.endMinute,
        windowAssumed: true,
        message: `${date} is booked with the customer, but the site has no recorded opening hours on a ${weekday.toLowerCase()}. The visit is planned on the assumed ${clockText(ASSUMED_DAY_WINDOW.startMinute)}-${clockText(ASSUMED_DAY_WINDOW.endMinute)} day and marked unconfirmed. Record the site's hours for that day.`,
      };

  return { visit, issue };
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

/**
 * The rolling 30-day window the manager sees, and the day replenishment has
 * to prepare so that window is never visible-but-unstaffed.
 *
 * ## Why this file exists rather than reusing `toDateOnly`
 *
 * `toDateOnly` (catalog/schedule-preview.ts) is `toISOString().slice(0, 10)`
 * — the **UTC** date. The application runs at `TZ: Asia/Colombo`
 * (config/env.validation.ts, deploy/compose.staging.yml), which is UTC+5:30,
 * so from local midnight until 05:30 the UTC date is still yesterday's. The
 * existing horizon sweep's cron hour, 03:00 local, sits inside that band: its
 * `today` is reliably the wrong day. A replenishment step built on the same
 * helper would prepare day 28 of a 30-day window and never prepare the day
 * that actually rolls into view.
 *
 * `toDateOnly` is deliberately left alone. It is used across generation and
 * preview, its behaviour is load-bearing in places this change has not
 * audited, and a silent global date shift must not ride along inside a
 * feature. Its wider use is being raised separately, with evidence.
 *
 * ## Civil dates, not instants
 *
 * Everything here is a `YYYY-MM-DD` civil date. `GeneratedVisit.visitDate` is
 * documented in the schema as "the calendar date of the visit, in
 * Asia/Colombo terms", so the window arithmetic belongs in the same terms.
 * Only {@link civilDateInZone} touches a zone at all; the rest is calendar
 * arithmetic with no offset anywhere in it.
 */

/** Days in the manager's rolling window, inclusive of today. */
export const ROLLING_WINDOW_DAYS = 30;

const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A `YYYY-MM-DD` civil date. Not a `Date`, and deliberately not an instant. */
export type CivilDate = string;

export interface RollingWindow {
  /** Inclusive first day: today, in the operating zone. */
  start: CivilDate;
  /** Inclusive last day. */
  end: CivilDate;
}

/**
 * The civil date at `instant` in `zone`.
 *
 * `en-CA` formats as `YYYY-MM-DD`, so the parts need no reassembly — and
 * reassembling them by hand is where this kind of helper usually goes wrong.
 * The zone is resolved by the runtime's own tz database, so a zone with
 * daylight saving is handled for free; Colombo has none, which is exactly why
 * a Colombo-only implementation could be wrong and still look right.
 */
export function civilDateInZone(instant: Date, zone: string): CivilDate {
  if (Number.isNaN(instant.getTime())) {
    throw new Error('civilDateInZone needs a valid Date.');
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/**
 * `date` shifted by `days`, still a civil date.
 *
 * Done in UTC on purpose: a civil date has no zone, so the arithmetic must
 * not acquire one. UTC has no daylight saving, which makes "add a day" mean
 * exactly one day here, always — the property that fails if this were done in
 * local time.
 */
export function addCivilDays(date: CivilDate, days: number): CivilDate {
  const match = CIVIL_DATE.exec(date);
  if (!match) {
    throw new Error(`Expected a YYYY-MM-DD civil date, got "${date}".`);
  }
  const shifted = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** The window a manager sees on `today`: `today` through `today + 29`. */
export function rollingWindow(today: CivilDate): RollingWindow {
  return {
    start: today,
    end: addCivilDays(today, ROLLING_WINDOW_DAYS - 1),
  };
}

/**
 * The day replenishment must prepare when it runs on `today`.
 *
 * Tomorrow's window end, not today's — one day of buffer.
 *
 * The window rolls at local midnight, not when the job happens to run. A job
 * running at 06:00 and preparing today's window end would leave that day
 * visible and unstaffed from 00:00 until it ran; a job running at 03:00 would
 * leave a shorter gap, not no gap. Preparing tomorrow's window end instead
 * means the day that rolls into view at midnight was already prepared during
 * the previous day, and there is no hour at which the window contains a day
 * replenishment has not yet considered.
 *
 * It also makes the schedule's exact hour a tuning decision rather than a
 * correctness one, which is the property worth having: the next person to
 * move the cron cannot reintroduce the gap.
 */
export function replenishmentTarget(today: CivilDate): CivilDate {
  return rollingWindow(addCivilDays(today, 1)).end;
}

/**
 * Every day from today's window start through the replenishment target.
 *
 * What a catch-up pass iterates. After downtime, or after a day was left
 * STALE by demand arriving late, more than just the boundary day can be
 * unprepared, and a job that only ever looked at one day would never notice.
 * Bounded by construction at `ROLLING_WINDOW_DAYS + 1` days.
 */
export function coverageHorizon(today: CivilDate): CivilDate[] {
  const days: CivilDate[] = [];
  for (let offset = 0; offset <= ROLLING_WINDOW_DAYS; offset += 1) {
    days.push(addCivilDays(today, offset));
  }
  return days;
}

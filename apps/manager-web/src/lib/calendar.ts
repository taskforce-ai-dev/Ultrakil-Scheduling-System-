/**
 * Date arithmetic for the visit calendar.
 *
 * Every date here is a `YYYY-MM-DD` string, and every calculation goes through
 * UTC. The API stores a visit date as a calendar day with no timezone, so
 * parsing one into a local `Date` would shift it a day backwards for anyone
 * west of UTC — a visit on the 1st would render on the 31st. Keeping the whole
 * pipeline in UTC and formatting explicitly is what prevents that.
 */

export type CalendarView = "month" | "week";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Parses `YYYY-MM-DD` as a UTC midnight instant. */
export function parseDate(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return toIsoDate(new Date(parseDate(iso).getTime() + days * MS_PER_DAY));
}

export function addMonths(iso: string, months: number): string {
  const date = parseDate(iso);
  const target = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1)
  );
  // Clamp: one month on from the 31st has to land on a day that exists.
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return toIsoDate(target);
}

export function todayIso(): string {
  return toIsoDate(new Date());
}

/** Monday of the week containing `iso`. UltraKIL's week starts Monday. */
export function startOfWeek(iso: string): string {
  const date = parseDate(iso);
  const dayOfWeek = date.getUTCDay(); // 0 = Sunday
  const backToMonday = (dayOfWeek + 6) % 7;
  return addDays(iso, -backToMonday);
}

export function startOfMonth(iso: string): string {
  const date = parseDate(iso);
  return toIsoDate(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)));
}

export function endOfMonth(iso: string): string {
  const date = parseDate(iso);
  return toIsoDate(
    new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0))
  );
}

/**
 * The inclusive range the API should be asked for.
 *
 * A month view has to request the *whole grid*, not the whole month: the grid
 * shows the tail of the previous month and the head of the next, and visits in
 * those cells are real. Fetching only the month would leave them blank.
 */
export function rangeForView(
  anchor: string,
  view: CalendarView
): { from: string; to: string } {
  if (view === "week") {
    const from = startOfWeek(anchor);
    return { from, to: addDays(from, 6) };
  }
  const from = startOfWeek(startOfMonth(anchor));
  const lastCellStart = startOfWeek(endOfMonth(anchor));
  return { from, to: addDays(lastCellStart, 6) };
}

/**
 * The inclusive range a generation run should be asked for.
 *
 * A run plans only the periods its range holds **whole**, and periods are
 * calendar-aligned: a week is a Monday-to-Sunday ISO week, a month a calendar
 * month, both counted from the agreement's own start rather than from the
 * range. So the range has to be chosen to hold whole ones.
 *
 * The month view sends the **grid** — the same days it draws. The grid begins
 * on a Monday and ends on a Sunday, so it holds whole ISO weeks for every
 * weekly and fortnightly agreement; and it contains the whole calendar month,
 * so it holds a whole month for every monthly one. The calendar month on its
 * own would do the second but not the first: 1-30 September holds no whole ISO
 * week at either end, and a weekly agreement generated from the month view
 * would plan a different set of weeks from the same agreement generated from
 * the week view — a duplicate where the week view's visit was protected, churn
 * where it was not.
 *
 * The week view sends its own seven days, which are one whole ISO week.
 *
 * Neither view holds a whole quarter, and only a month view holds a whole
 * fortnight. An agreement whose cycle the range cannot hold is not planned and
 * is reported in `skippedPeriods`, never silently.
 */
export function rangeForGeneration(
  anchor: string,
  view: CalendarView
): { from: string; to: string } {
  return rangeForView(anchor, view);
}

/** Every day in the grid, in order. 7 for a week, 35 or 42 for a month. */
export function daysInView(anchor: string, view: CalendarView): string[] {
  const { from, to } = rangeForView(anchor, view);
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

export function isSameMonth(iso: string, anchor: string): boolean {
  return iso.slice(0, 7) === anchor.slice(0, 7);
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function formatMonthYear(iso: string): string {
  const date = parseDate(iso);
  return `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** "7 – 13 September 2026", collapsing the month when both ends share it. */
export function formatWeekRange(iso: string): string {
  const from = parseDate(startOfWeek(iso));
  const to = parseDate(addDays(startOfWeek(iso), 6));
  const sameMonth = from.getUTCMonth() === to.getUTCMonth();
  const left = sameMonth
    ? `${from.getUTCDate()}`
    : `${from.getUTCDate()} ${MONTH_NAMES[from.getUTCMonth()]}`;
  return `${left} – ${to.getUTCDate()} ${MONTH_NAMES[to.getUTCMonth()]} ${to.getUTCFullYear()}`;
}

export function formatLongDate(iso: string): string {
  const date = parseDate(iso);
  return `${WEEKDAY_NAMES[(date.getUTCDay() + 6) % 7]} ${date.getUTCDate()} ${
    MONTH_NAMES[date.getUTCMonth()]
  } ${date.getUTCFullYear()}`;
}

export const WEEKDAY_NAMES = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
];

export const WEEKDAY_INITIALS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Minutes past midnight as a 24-hour clock time. */
export function formatMinuteOfDay(minute: number): string {
  const hour = Math.floor(minute / 60);
  const rest = minute % 60;
  return `${String(hour).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

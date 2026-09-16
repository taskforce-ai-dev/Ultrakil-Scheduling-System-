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
 *
 * One seam has to be sewn shut by hand. A grid normally reaches into the next
 * month — March's runs to 3 May, September's to 4 October — so consecutive
 * month runs overlap and a period straddling the join is held whole by one of
 * them. A month that *begins on a Monday* breaks that: May 2026's grid ends on
 * Sunday 31 May and June's begins on Monday 1 June, with not a day in common.
 * A fortnight straddling the seam — 25 May to 7 June — is clipped by the
 * horizon in both, so neither run plans it, neither is "the run that can see it
 * whole", and the customer loses a visit with nothing said. Where the grid ends
 * the day before a month, the run therefore reaches one whole ISO week further.
 * That week is a whole ISO week, so a weekly agreement plans it exactly as the
 * week view would, and a monthly one still skips it as the stub it is.
 */
export function rangeForGeneration(
  anchor: string,
  view: CalendarView
): { from: string; to: string } {
  const range = rangeForView(anchor, view);
  // The week view asks about its own seven days and no more: a manager who
  // generates a week must not find visits in the next one.
  if (view !== "month") return range;
  const startsAMonth = addDays(range.to, 1).endsWith("-01");
  return startsAMonth ? { ...range, to: addDays(range.to, 7) } : range;
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

const SHORT_MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * The span a schedule run covered, short enough to sit inside a sentence.
 *
 * "15–21 Sep" when the two ends share a month, "28 Sep – 4 Oct" when they do
 * not, and the year said out loud only when the range crosses one — a run over
 * the turn of the year is the one case where "29 Dec – 3 Jan" is ambiguous.
 */
export function formatDayRange(fromIso: string, toIso: string): string {
  const from = parseDate(fromIso);
  const to = parseDate(toIso);
  const sameYear = from.getUTCFullYear() === to.getUTCFullYear();
  const year = (date: Date) => (sameYear ? "" : ` ${date.getUTCFullYear()}`);
  const month = (date: Date) => SHORT_MONTH_NAMES[date.getUTCMonth()];

  if (sameYear && from.getUTCMonth() === to.getUTCMonth()) {
    return `${from.getUTCDate()}–${to.getUTCDate()} ${month(to)}`;
  }
  return `${from.getUTCDate()} ${month(from)}${year(from)} – ${to.getUTCDate()} ${month(to)}${year(to)}`;
}

/**
 * The calendar day of an instant, in the reader's own clock: "15 Sep".
 *
 * Unlike a visit date, a publication is a moment rather than a calendar day,
 * so these two are deliberately *not* held in UTC — "published at 20:05" has
 * to mean 20:05 where the manager is standing.
 */
export function formatStampDay(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return `${at.getDate()} ${SHORT_MONTH_NAMES[at.getMonth()]}`;
}

/** The same instant with the time on it: "15 Sep 20:05". */
export function formatStamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return `${at.getDate()} ${SHORT_MONTH_NAMES[at.getMonth()]} ${time}`;
}

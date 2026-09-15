/**
 * Where in the month an agreement's work actually falls.
 *
 * The frequency says how many visits a month, never which days. Left at that,
 * every monthly agreement takes the first allowed weekday of the month and the
 * whole book piles into week one. The workbook does know the days — it records
 * the dates already booked with each customer — so those are what the months
 * it does not cover are placed around.
 *
 * Each month's bookings are ranked within that month before the medians are
 * taken. That is what keeps "the 5th and the 20th" as two separate anchors: a
 * plain median over every booked day would collapse them into one day near the
 * middle of the month, which is precisely the pile-up being fixed.
 */

/** Day of the month a YYYY-MM-DD string names. */
function dayOfMonth(date: string): number {
  return Number.parseInt(date.slice(8, 10), 10);
}

/** Middle value, or the average of the two middle ones, rounded. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/**
 * The days of the month this agreement is usually served on.
 *
 * `visitsPerPeriod` caps how many anchors are worth having: an agreement
 * serviced once a month has one usual day, however many months are on record.
 * Returned in ascending order, so the caller can hand them to the preview as
 * "around here first, then around there".
 */
export function anchorDaysFrom(
  bookedDates: string[],
  visitsPerPeriod: number,
): number[] {
  if (bookedDates.length === 0 || visitsPerPeriod < 1) return [];

  const byMonth = new Map<string, number[]>();
  for (const date of bookedDates) {
    const month = date.slice(0, 7);
    const days = byMonth.get(month) ?? [];
    days.push(dayOfMonth(date));
    byMonth.set(month, days);
  }

  const ranked = [...byMonth.values()].map((days) => days.sort((a, b) => a - b));

  const anchors: number[] = [];
  for (let rank = 0; rank < visitsPerPeriod; rank += 1) {
    const sample = ranked
      .map((days) => days[rank])
      .filter((day): day is number => day !== undefined);
    // A rank no month reaches is not an anchor. An agreement written as twice
    // a month but booked once is served once, and inventing a second day for
    // it would be the system disagreeing with its own source.
    if (sample.length === 0) continue;
    anchors.push(median(sample));
  }

  return anchors.sort((a, b) => a - b);
}

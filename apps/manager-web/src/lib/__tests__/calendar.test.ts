import { describe, expect, it } from "vitest";

import { addDays, formatDayRange, formatDurationMinutes, rangeForGeneration, todayColomboIso } from "@/lib/calendar";

describe("todayColomboIso", () => {
  it("starts the operational day when Colombo passes midnight, not when UTC does", () => {
    expect(todayColomboIso(new Date("2026-09-25T18:29:00.000Z"))).toBe("2026-09-25");
    expect(todayColomboIso(new Date("2026-09-25T18:30:00.000Z"))).toBe("2026-09-26");
  });
});

/**
 * Consecutive month grids have to overlap, or a fortnight can fall between them.
 *
 * A grid runs from the Monday on or before the 1st to the Sunday on or after
 * the last day, so one month's grid normally reaches into the next. The
 * exception is a month that begins on a Monday: May 2026's grid ends on Sunday
 * 31 May and June's begins on Monday 1 June, with nothing in common. A
 * fortnightly agreement whose fortnight straddles that seam — 25 May to 7 June
 * — is clipped by the horizon in both runs, so neither plans it and neither is
 * the run that can see it whole. The customer simply loses a visit.
 */
describe("rangeForGeneration", () => {
  it("keeps a whole ISO week of overlap between consecutive month grids", () => {
    const may = rangeForGeneration("2026-05-15", "month");
    const june = rangeForGeneration("2026-06-15", "month");

    expect(june).toEqual({ from: "2026-06-01", to: "2026-07-05" });
    // May's own grid ends on the 31st; the run reaches a week past it so the
    // fortnight from 25 May to 7 June is held whole by somebody.
    expect(may).toEqual({ from: "2026-04-27", to: "2026-06-07" });
    expect(may.to >= june.from).toBe(true);
  });

  it("leaves a grid that already reaches into the next month alone", () => {
    // April's grid runs to 3 May of its own accord, and September's to 4
    // October — nothing to fix, and a second week would plan work two months
    // from the one on screen.
    expect(rangeForGeneration("2026-04-15", "month")).toEqual({
      from: "2026-03-30",
      to: "2026-05-03",
    });
    expect(rangeForGeneration("2026-09-15", "month")).toEqual({
      from: "2026-08-31",
      to: "2026-10-04",
    });
  });

  it("never stretches the week view past the week the manager is looking at", () => {
    // 25-31 May is an ISO week that ends the day before a month begins. The
    // week view asks about its own seven days and no more: a manager who
    // generates a week must not find visits in the next one.
    const week = rangeForGeneration("2026-05-27", "week");

    expect(week).toEqual({ from: "2026-05-25", to: "2026-05-31" });
    expect(addDays(week.from, 6)).toBe(week.to);
  });
});

describe("formatDayRange", () => {
  it("collapses the month when both ends share it, and spells the year only across one", () => {
    expect(formatDayRange("2026-09-15", "2026-09-21")).toBe("15–21 Sep");
    expect(formatDayRange("2026-09-28", "2026-10-04")).toBe("28 Sep – 4 Oct");
    expect(formatDayRange("2026-12-28", "2027-01-03")).toBe("28 Dec 2026 – 3 Jan 2027");
  });
});

describe("formatDurationMinutes", () => {
  it("spells out hours and minutes, singular where exactly one, and never rounds", () => {
    expect(formatDurationMinutes(150)).toBe("2 hours 30 minutes");
    expect(formatDurationMinutes(60)).toBe("1 hour");
    expect(formatDurationMinutes(1)).toBe("1 minute");
    expect(formatDurationMinutes(45)).toBe("45 minutes");
    expect(formatDurationMinutes(61)).toBe("1 hour 1 minute");
    // An off-grid value a manager typed by hand, not a multiple of any
    // slider step — said exactly, not rounded to the nearest quarter hour.
    expect(formatDurationMinutes(47)).toBe("47 minutes");
  });
});

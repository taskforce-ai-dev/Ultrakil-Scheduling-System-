import { FrequencyUnit, Weekday } from '@prisma/client';

import {
  SchedulePreviewInput,
  computeSchedulePreview,
  effectiveWindows,
} from './schedule-preview';

/** Mon–Fri 09:00–17:00, the ordinary case, unless a test says otherwise. */
function weekdayHours(
  opensAtMinute = 9 * 60,
  closesAtMinute = 17 * 60,
): SchedulePreviewInput['siteWindows'] {
  return [
    Weekday.MONDAY,
    Weekday.TUESDAY,
    Weekday.WEDNESDAY,
    Weekday.THURSDAY,
    Weekday.FRIDAY,
  ].map((weekday) => ({ weekday, startMinute: opensAtMinute, endMinute: closesAtMinute }));
}

function buildInput(overrides: Partial<SchedulePreviewInput> = {}): SchedulePreviewInput {
  return {
    frequencyCount: 2,
    frequencyUnit: FrequencyUnit.WEEK,
    allowedDays: [Weekday.MONDAY, Weekday.TUESDAY, Weekday.WEDNESDAY, Weekday.THURSDAY],
    preferredDays: [Weekday.TUESDAY, Weekday.THURSDAY],
    // 2026-09-07 is a Monday, so week boundaries line up with the calendar.
    startDate: '2026-09-07',
    endDate: null,
    siteWindows: weekdayHours(),
    agreementWindowStartMinute: null,
    agreementWindowEndMinute: null,
    durationMinutes: 60,
    horizonWeeks: 2,
    ...overrides,
  };
}

describe('schedule preview', () => {
  describe('frequency', () => {
    it('places exactly the requested number of visits per week', () => {
      const preview = computeSchedulePreview(buildInput());

      expect(preview.visits).toHaveLength(4); // 2 per week x 2 weeks
      expect(preview.shortfalls).toEqual([]);
    });

    it('places the requested number per month when the unit is MONTH', () => {
      const preview = computeSchedulePreview(
        buildInput({
          frequencyCount: 3,
          frequencyUnit: FrequencyUnit.MONTH,
          startDate: '2026-09-01',
          horizonWeeks: 4,
        }),
      );

      expect(preview.visits).toHaveLength(3);
    });

    it('never books the same day twice, even at a high frequency', () => {
      const preview = computeSchedulePreview(
        buildInput({ frequencyCount: 3, allowedDays: [Weekday.MONDAY, Weekday.TUESDAY] }),
      );

      const dates = preview.visits.map((visit) => visit.date);
      expect(new Set(dates).size).toBe(dates.length);
    });

    it('stops at the agreement end date', () => {
      const preview = computeSchedulePreview(
        buildInput({ endDate: '2026-09-09', horizonWeeks: 4 }),
      );

      for (const visit of preview.visits) {
        expect(visit.date <= '2026-09-09').toBe(true);
      }
    });
  });

  describe('allowed and preferred days', () => {
    it('only ever books an allowed weekday', () => {
      const preview = computeSchedulePreview(
        buildInput({ allowedDays: [Weekday.WEDNESDAY], preferredDays: [], frequencyCount: 1 }),
      );

      expect(preview.visits.length).toBeGreaterThan(0);
      for (const visit of preview.visits) {
        expect(visit.weekday).toBe(Weekday.WEDNESDAY);
      }
    });

    it('takes preferred days first — preferred is a ranking, not a filter', () => {
      const preview = computeSchedulePreview(
        buildInput({
          frequencyCount: 1,
          allowedDays: [Weekday.MONDAY, Weekday.TUESDAY],
          preferredDays: [Weekday.TUESDAY],
          horizonWeeks: 1,
        }),
      );

      // Monday comes first in the week, but Tuesday is preferred and wins.
      expect(preview.visits).toHaveLength(1);
      expect(preview.visits[0].weekday).toBe(Weekday.TUESDAY);
      expect(preview.visits[0].isPreferredDay).toBe(true);
    });

    it('falls back to a merely-allowed day when preferred days run out', () => {
      const preview = computeSchedulePreview(
        buildInput({
          frequencyCount: 2,
          allowedDays: [Weekday.MONDAY, Weekday.TUESDAY],
          preferredDays: [Weekday.TUESDAY],
          horizonWeeks: 1,
        }),
      );

      expect(preview.visits.map((v) => v.weekday)).toEqual(
        expect.arrayContaining([Weekday.TUESDAY, Weekday.MONDAY]),
      );
      expect(preview.visits.filter((v) => v.isPreferredDay)).toHaveLength(1);
    });
  });

  describe('opening windows', () => {
    it('uses the site window for the weekday', () => {
      const preview = computeSchedulePreview(
        buildInput({
          frequencyCount: 1,
          allowedDays: [Weekday.MONDAY],
          preferredDays: [],
          siteWindows: [
            { weekday: Weekday.MONDAY, startMinute: 6 * 60, endMinute: 10 * 60 },
          ],
          horizonWeeks: 1,
        }),
      );

      expect(preview.visits[0].windowStartMinute).toBe(6 * 60);
      expect(preview.visits[0].windowEndMinute).toBe(10 * 60);
    });

    it('supports several windows on one weekday — a site that shuts for lunch', () => {
      const preview = computeSchedulePreview(
        buildInput({
          frequencyCount: 2,
          allowedDays: [Weekday.MONDAY, Weekday.TUESDAY],
          preferredDays: [],
          siteWindows: [
            { weekday: Weekday.MONDAY, startMinute: 8 * 60, endMinute: 12 * 60 },
            { weekday: Weekday.MONDAY, startMinute: 13 * 60, endMinute: 17 * 60 },
            { weekday: Weekday.TUESDAY, startMinute: 9 * 60, endMinute: 17 * 60 },
          ],
          horizonWeeks: 1,
        }),
      );

      // Both windows are candidates, but one visit per day still holds, so the
      // second visit lands on Tuesday rather than twice on Monday.
      expect(preview.visits.map((v) => v.weekday)).toEqual([
        Weekday.MONDAY,
        Weekday.TUESDAY,
      ]);
    });

    it('narrows the site window by the agreement window, never widens it', () => {
      const windows = effectiveWindows(
        [{ startMinute: 9 * 60, endMinute: 17 * 60 }],
        7 * 60, // agreement asks for 07:00 — the site is still shut
        15 * 60,
      );

      expect(windows).toEqual([{ startMinute: 9 * 60, endMinute: 15 * 60 }]);
    });

    it('drops a window the agreement narrows out of existence', () => {
      const windows = effectiveWindows(
        [{ startMinute: 9 * 60, endMinute: 12 * 60 }],
        13 * 60,
        17 * 60,
      );

      expect(windows).toEqual([]);
    });

    it('skips a day whose window is shorter than the visit', () => {
      const preview = computeSchedulePreview(
        buildInput({
          frequencyCount: 1,
          allowedDays: [Weekday.MONDAY],
          preferredDays: [],
          siteWindows: [
            { weekday: Weekday.MONDAY, startMinute: 9 * 60, endMinute: 9 * 60 + 30 },
          ],
          durationMinutes: 120,
          horizonWeeks: 1,
        }),
      );

      expect(preview.visits).toEqual([]);
      expect(preview.shortfalls[0].reason).toBe('WINDOW_TOO_SHORT_FOR_VISIT');
    });
  });

  describe('shortfalls — an impossible combination is reported, never dropped', () => {
    it('reports asking for more visits than there are allowed days', () => {
      const preview = computeSchedulePreview(
        buildInput({
          frequencyCount: 3,
          allowedDays: [Weekday.MONDAY],
          preferredDays: [],
          horizonWeeks: 1,
        }),
      );

      expect(preview.visits).toHaveLength(1);
      expect(preview.shortfalls).toHaveLength(1);
      expect(preview.shortfalls[0]).toMatchObject({
        requested: 3,
        scheduled: 1,
        reason: 'NOT_ENOUGH_ALLOWED_DAYS',
      });
      expect(preview.shortfalls[0].message).toContain('short by 2');
    });

    it('reports a site closed on every allowed day', () => {
      const preview = computeSchedulePreview(
        buildInput({
          frequencyCount: 1,
          allowedDays: [Weekday.SUNDAY],
          preferredDays: [],
          siteWindows: weekdayHours(), // no Sunday window at all
          horizonWeeks: 1,
        }),
      );

      expect(preview.visits).toEqual([]);
      expect(preview.shortfalls[0].reason).toBe('SITE_CLOSED_ON_ALLOWED_DAYS');
    });

    it('does not cry wolf over a part-week at the end of the horizon', () => {
      // Starting mid-week means the first bucket is a partial week. It was never
      // promised two visits, so it must not be reported as a shortfall.
      const preview = computeSchedulePreview(
        buildInput({ startDate: '2026-09-10', horizonWeeks: 1 }), // a Thursday
      );

      expect(preview.shortfalls).toEqual([]);
    });
  });

  describe('acceptance scenario — a Starbucks New Jersey-style site', () => {
    // Termite control twice weekly, selectable allowed days, preferred days,
    // and different service hours per weekday.
    const input = buildInput({
      frequencyCount: 2,
      frequencyUnit: FrequencyUnit.WEEK,
      allowedDays: [Weekday.MONDAY, Weekday.WEDNESDAY, Weekday.FRIDAY, Weekday.SATURDAY],
      preferredDays: [Weekday.WEDNESDAY, Weekday.SATURDAY],
      startDate: '2026-09-07',
      horizonWeeks: 2,
      durationMinutes: 90,
      siteWindows: [
        // A coffee shop: early on weekdays, later and longer at the weekend.
        { weekday: Weekday.MONDAY, startMinute: 6 * 60, endMinute: 8 * 60 },
        { weekday: Weekday.WEDNESDAY, startMinute: 6 * 60, endMinute: 9 * 60 },
        { weekday: Weekday.FRIDAY, startMinute: 5 * 60 + 30, endMinute: 7 * 60 + 30 },
        { weekday: Weekday.SATURDAY, startMinute: 7 * 60, endMinute: 11 * 60 },
      ],
    });

    it('books exactly twice a week', () => {
      const preview = computeSchedulePreview(input);

      expect(preview.visits).toHaveLength(4);
      expect(preview.shortfalls).toEqual([]);
    });

    it('prefers Wednesday and Saturday over Monday and Friday', () => {
      const preview = computeSchedulePreview(input);

      expect(preview.visits.every((visit) => visit.isPreferredDay)).toBe(true);
      expect(new Set(preview.visits.map((v) => v.weekday))).toEqual(
        new Set([Weekday.WEDNESDAY, Weekday.SATURDAY]),
      );
    });

    it('carries each weekday its own service hours', () => {
      const preview = computeSchedulePreview(input);

      const wednesday = preview.visits.find((v) => v.weekday === Weekday.WEDNESDAY);
      const saturday = preview.visits.find((v) => v.weekday === Weekday.SATURDAY);

      expect(wednesday).toMatchObject({ windowStartMinute: 360, windowEndMinute: 540 });
      expect(saturday).toMatchObject({ windowStartMinute: 420, windowEndMinute: 660 });
    });
  });
});

describe('frequency intervals — the cycles UltraKIL actually sells', () => {
  it('places one visit per fortnight, not one per week', () => {
    const preview = computeSchedulePreview(
      buildInput({
        frequencyCount: 1,
        frequencyUnit: FrequencyUnit.WEEK,
        frequencyInterval: 2,
        allowedDays: [Weekday.WEDNESDAY],
        preferredDays: [],
        horizonWeeks: 4,
      }),
    );

    // Four weeks is two fortnights, so two visits — not four.
    expect(preview.visits).toHaveLength(2);
    expect(preview.shortfalls).toEqual([]);

    // And they really are a fortnight apart.
    const [first, second] = preview.visits.map((v) => new Date(`${v.date}T00:00:00Z`));
    const daysApart = (second.getTime() - first.getTime()) / (24 * 60 * 60 * 1000);
    expect(daysApart).toBe(14);
  });

  it('places one visit per quarter', () => {
    const preview = computeSchedulePreview(
      buildInput({
        frequencyCount: 1,
        frequencyUnit: FrequencyUnit.MONTH,
        frequencyInterval: 3,
        allowedDays: [Weekday.WEDNESDAY],
        preferredDays: [],
        startDate: '2026-09-01',
        horizonWeeks: 26, // roughly six months — two quarters
      }),
    );

    expect(preview.visits).toHaveLength(2);
  });

  it('places one visit every two months', () => {
    const preview = computeSchedulePreview(
      buildInput({
        frequencyCount: 1,
        frequencyUnit: FrequencyUnit.MONTH,
        frequencyInterval: 2,
        allowedDays: [Weekday.WEDNESDAY],
        preferredDays: [],
        startDate: '2026-09-01',
        horizonWeeks: 26,
      }),
    );

    expect(preview.visits).toHaveLength(3);
  });

  it('treats an interval of 1 exactly as before', () => {
    const withoutInterval = computeSchedulePreview(buildInput());
    const withExplicitOne = computeSchedulePreview(buildInput({ frequencyInterval: 1 }));

    expect(withExplicitOne).toEqual(withoutInterval);
  });

  it('does not report a shortfall for a fortnight that is genuinely served', () => {
    // The trap: grouping two weeks into one cycle must not make the second
    // week look like a period that received no visit.
    const preview = computeSchedulePreview(
      buildInput({
        frequencyCount: 1,
        frequencyUnit: FrequencyUnit.WEEK,
        frequencyInterval: 2,
        allowedDays: [Weekday.MONDAY],
        preferredDays: [],
        horizonWeeks: 8,
      }),
    );

    expect(preview.shortfalls).toEqual([]);
    expect(preview.visits).toHaveLength(4);
  });
});

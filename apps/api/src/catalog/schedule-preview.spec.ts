import { DataProvenance, FrequencyUnit, Weekday } from '@prisma/client';

import {
  SchedulePreviewInput,
  ASSUMED_DAY_WINDOW,
  computeSchedulePreview,
  effectiveWindows,
  parseDateOnly,
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
  describe('a period the run cannot see whole', () => {
    /**
     * The calendar grid for September starts on 2026-08-31, so the portal's
     * month view used to hand generation a range whose first period is one
     * day of August. The run plans that stub as if it were the month, and the
     * August visit already published on the 17th lies outside the range —
     * invisible to the pinning and to the load guard. The customer gets two
     * August visits.
     */
    const monthly = (overrides = {}) =>
      buildInput({
        frequencyCount: 1,
        frequencyUnit: FrequencyUnit.MONTH,
        startDate: '2026-01-05',
        allowedDays: [
          Weekday.MONDAY,
          Weekday.TUESDAY,
          Weekday.WEDNESDAY,
          Weekday.THURSDAY,
          Weekday.FRIDAY,
        ],
        preferredDays: [],
        from: '2026-08-31',
        horizonWeeks: 5,
        // The question generation asks: which visits does this range owe?
        wholePeriodsOnly: true,
        ...overrides,
      });

    it('plans nothing in a one-day stub at the start of the range', () => {
      const preview = computeSchedulePreview(monthly());

      expect(preview.visits.filter((visit) => visit.date < '2026-09-01')).toEqual([]);
    });

    it('still plans the whole month that follows it', () => {
      const preview = computeSchedulePreview(monthly());

      expect(
        preview.visits.filter(
          (visit) => visit.date >= '2026-09-01' && visit.date <= '2026-09-30',
        ),
      ).toHaveLength(1);
    });

    it('plans nothing in the stub the range ends on either', () => {
      const preview = computeSchedulePreview(monthly());

      expect(preview.visits.filter((visit) => visit.date > '2026-09-30')).toEqual([]);
    });

    it('says nothing about a stub it did not plan', () => {
      // A period nobody promised anything for is not a shortfall.
      const preview = computeSchedulePreview(monthly());

      expect(preview.shortfalls).toEqual([]);
    });

    it('plans a short first period when the agreement itself starts there', () => {
      // Not a stub: the agreement genuinely begins on the 31st, and its first
      // month is the piece of August it is in force for.
      const preview = computeSchedulePreview(
        monthly({ startDate: '2026-08-31' }),
      );

      expect(preview.visits.map((visit) => visit.date)).toContain('2026-08-31');
    });

    it('plans a short last period when the agreement itself ends there', () => {
      const preview = computeSchedulePreview(
        monthly({ from: '2026-09-01', endDate: '2026-10-02' }),
      );

      expect(preview.visits.filter((visit) => visit.date > '2026-09-30')).toHaveLength(1);
    });

    it('leaves the agreement screen alone: a window onto a month still shows it', () => {
      // The agreement screen asks a different question — "when would we visit
      // over the next few weeks?" — and "nothing, the month is only half in
      // view" is not an answer a manager can use.
      const preview = computeSchedulePreview(monthly({ wholePeriodsOnly: false }));

      expect(preview.visits.length).toBeGreaterThan(1);
    });

    it('still honours a booking inside a stub, because a booking is not a plan', () => {
      const preview = computeSchedulePreview(
        monthly({ bookedDates: ['2026-08-31'] }),
      );

      expect(preview.visits).toContainEqual(
        expect.objectContaining({ date: '2026-08-31', placement: 'BOOKED' }),
      );
    });
  });


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

  describe('window provenance — where a visit\'s hours actually came from', () => {
    it('keeps manager-confirmed hours confirmed', () => {
      const preview = computeSchedulePreview(
        buildInput({
          siteWindows: weekdayHours().map((window) => ({
            ...window,
            provenance: DataProvenance.MANAGER_CONFIRMED,
          })),
        }),
      );

      expect(preview.visits.length).toBeGreaterThan(0);
      expect(
        preview.visits.every(
          (visit) => visit.windowProvenance === DataProvenance.MANAGER_CONFIRMED,
        ),
      ).toBe(true);
    });

    it('keeps imported hours imported rather than promoting them', () => {
      const preview = computeSchedulePreview(
        buildInput({
          siteWindows: weekdayHours().map((window) => ({
            ...window,
            provenance: DataProvenance.SOURCE,
          })),
        }),
      );

      expect(
        preview.visits.every((visit) => visit.windowProvenance === DataProvenance.SOURCE),
      ).toBe(true);
    });

    it('leaves unconfirmed recorded hours unconfirmed', () => {
      const preview = computeSchedulePreview(
        buildInput({
          siteWindows: weekdayHours().map((window) => ({
            ...window,
            provenance: DataProvenance.UNKNOWN,
          })),
        }),
      );

      expect(
        preview.visits.every((visit) => visit.windowProvenance === DataProvenance.UNKNOWN),
      ).toBe(true);
    });

    it('marks the disclosed 08:00-17:00 fallback as defaulted', () => {
      const preview = computeSchedulePreview(buildInput({ siteWindows: [] }));

      expect(preview.visits.length).toBeGreaterThan(0);
      expect(preview.visits.every((visit) => visit.windowProvenance === DataProvenance.DEFAULTED))
        .toBe(true);
      expect(preview.visits[0].windowStartMinute).toBe(ASSUMED_DAY_WINDOW.startMinute);
    });

    it('treats an explicit agreement window with no site hours as manager-stated', () => {
      const preview = computeSchedulePreview(
        buildInput({
          siteWindows: [],
          agreementWindowStartMinute: 10 * 60,
          agreementWindowEndMinute: 15 * 60,
        }),
      );

      expect(preview.visits.length).toBeGreaterThan(0);
      expect(
        preview.visits.every(
          (visit) => visit.windowProvenance === DataProvenance.MANAGER_CONFIRMED,
        ),
      ).toBe(true);
      expect(preview.visits[0]).toMatchObject({
        windowStartMinute: 10 * 60,
        windowEndMinute: 15 * 60,
      });
    });

    it('stays defaulted when the agreement window is wider than the assumption', () => {
      // The assumption still decides one of the bounds, so the window is not
      // something a manager actually stated.
      const preview = computeSchedulePreview(
        buildInput({
          siteWindows: [],
          agreementWindowStartMinute: 7 * 60,
          agreementWindowEndMinute: 15 * 60,
        }),
      );

      expect(preview.visits.every((visit) => visit.windowProvenance === DataProvenance.DEFAULTED))
        .toBe(true);
      expect(preview.visits[0].windowStartMinute).toBe(ASSUMED_DAY_WINDOW.startMinute);
    });

    it('does not let an agreement window weaken confirmed site hours', () => {
      const preview = computeSchedulePreview(
        buildInput({
          siteWindows: weekdayHours().map((window) => ({
            ...window,
            provenance: DataProvenance.MANAGER_CONFIRMED,
          })),
          agreementWindowStartMinute: 10 * 60,
          agreementWindowEndMinute: 15 * 60,
        }),
      );

      expect(
        preview.visits.every(
          (visit) => visit.windowProvenance === DataProvenance.MANAGER_CONFIRMED,
        ),
      ).toBe(true);
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

  describe('a site whose opening hours nobody has recorded', () => {
    // The master schedule workbook has no opening-hours column, so 907 of 999
    // imported sites arrive with none. Reading that as "never open" refused to
    // schedule work UltraKIL demonstrably performs.
    it('treats no hours at all as unknown, not as closed', () => {
      const preview = computeSchedulePreview(buildInput({ siteWindows: [] }));

      expect(preview.visits).toHaveLength(4);
      expect(preview.shortfalls).toEqual([]);
      expect(preview.visits[0]).toMatchObject({
        windowStartMinute: ASSUMED_DAY_WINDOW.startMinute,
        windowEndMinute: ASSUMED_DAY_WINDOW.endMinute,
      });
    });

    it('still lets the agreement narrow the assumed day', () => {
      const preview = computeSchedulePreview(
        buildInput({
          siteWindows: [],
          agreementWindowStartMinute: 10 * 60,
          agreementWindowEndMinute: 12 * 60,
        }),
      );

      expect(preview.visits[0]).toMatchObject({
        windowStartMinute: 10 * 60,
        windowEndMinute: 12 * 60,
      });
    });

    it('keeps treating a missing weekday as closed when the site does have hours', () => {
      // Absence of Saturday from a site that reports Mon-Fri is real
      // information, unlike a site that reports nothing at all.
      const preview = computeSchedulePreview(
        buildInput({
          allowedDays: [Weekday.SATURDAY],
          preferredDays: [],
          frequencyCount: 1,
        }),
      );

      expect(preview.visits).toEqual([]);
      expect(preview.shortfalls[0]).toMatchObject({
        reason: 'SITE_CLOSED_ON_ALLOWED_DAYS',
      });
    });
  });
});
/**
 * Placement — where in the period a visit lands.
 *
 * Before this, every period took its earliest allowed weekday, so every
 * monthly agreement in the book landed in the first week of the month. The
 * workbook itself never worked that way: it names the days it has booked, and
 * those days are spread right across the month.
 */
describe('booked dates', () => {
  const monthly = (overrides: Partial<SchedulePreviewInput> = {}) =>
    buildInput({
      frequencyCount: 1,
      frequencyUnit: FrequencyUnit.MONTH,
      allowedDays: [
        Weekday.MONDAY,
        Weekday.TUESDAY,
        Weekday.WEDNESDAY,
        Weekday.THURSDAY,
        Weekday.FRIDAY,
      ],
      preferredDays: [],
      startDate: '2026-09-01',
      // One whole month, so the assertions read as "this month's visits".
      endDate: '2026-09-30',
      horizonWeeks: 5,
      ...overrides,
    });

  it('places exactly the booked date when the period has one', () => {
    const preview = computeSchedulePreview(
      monthly({ bookedDates: ['2026-09-17'] }),
    );

    expect(preview.visits.map((visit) => visit.date)).toEqual(['2026-09-17']);
    expect(preview.visits[0].placement).toBe('BOOKED');
  });

  it('places every booked date in the period, not just the first', () => {
    const preview = computeSchedulePreview(
      monthly({ frequencyCount: 2, bookedDates: ['2026-09-04', '2026-09-21'] }),
    );

    expect(preview.visits.map((visit) => visit.date)).toEqual([
      '2026-09-04',
      '2026-09-21',
    ]);
  });

  it('honours a booked date even when the agreement does not allow that weekday', () => {
    // The booking is a fact. A weekday rule inferred from other months does
    // not get to overrule a day the customer has already agreed.
    const preview = computeSchedulePreview(
      monthly({ allowedDays: [Weekday.MONDAY], bookedDates: ['2026-09-19'] }),
    );

    expect(preview.visits.map((visit) => visit.date)).toEqual(['2026-09-19']);
  });

  it('uses the assumed window, disclosed as such, when the site is shut that day', () => {
    const preview = computeSchedulePreview(
      monthly({
        // Saturday: no operating hours row at all.
        bookedDates: ['2026-09-19'],
      }),
    );

    expect(preview.visits[0].windowStartMinute).toBe(ASSUMED_DAY_WINDOW.startMinute);
    expect(preview.visits[0].windowEndMinute).toBe(ASSUMED_DAY_WINDOW.endMinute);
    expect(preview.visits[0].windowProvenance).toBe(DataProvenance.DEFAULTED);
  });

  it('keeps the site window for a booked date the site is open on', () => {
    const preview = computeSchedulePreview(
      monthly({ bookedDates: ['2026-09-17'] }),
    );

    expect(preview.visits[0].windowStartMinute).toBe(9 * 60);
    expect(preview.visits[0].windowEndMinute).toBe(17 * 60);
  });

  it('ignores a booked date outside the horizon', () => {
    const preview = computeSchedulePreview(
      monthly({ bookedDates: ['2026-12-17'] }),
    );

    expect(preview.visits.every((visit) => visit.date <= '2026-09-30')).toBe(true);
    expect(preview.visits.some((visit) => visit.placement === 'BOOKED')).toBe(false);
  });

  it('never offers a booked visit an alternative day to be moved to', () => {
    const preview = computeSchedulePreview(
      monthly({ bookedDates: ['2026-09-17'] }),
    );

    expect(preview.visits[0].alternatives).toEqual([]);
  });

  describe('a period booked fewer times than the frequency promises', () => {
    it('reports the gap rather than letting it pass unnoticed', () => {
      // Twice a week, booked once a week. Before, this read as a fully
      // delivered agreement on every screen it appeared on.
      const preview = computeSchedulePreview(
        buildInput({
          frequencyCount: 2,
          frequencyUnit: FrequencyUnit.WEEK,
          startDate: '2026-09-07',
          endDate: '2026-09-20',
          horizonWeeks: 2,
          bookedDates: ['2026-09-08', '2026-09-15'],
        }),
      );

      expect(preview.visits.map((visit) => visit.date)).toEqual([
        '2026-09-08',
        '2026-09-15',
      ]);
      expect(preview.shortfalls).toHaveLength(2);
      expect(preview.shortfalls[0]).toMatchObject({
        reason: 'BOOKED_BELOW_FREQUENCY',
        requested: 2,
        scheduled: 1,
        periodStart: '2026-09-07',
      });
      expect(preview.shortfalls[0].message).toContain('booked in the workbook');
    });

    it('still plans nothing extra — the bookings stand exactly as written', () => {
      const preview = computeSchedulePreview(
        buildInput({
          frequencyCount: 2,
          frequencyUnit: FrequencyUnit.WEEK,
          startDate: '2026-09-07',
          endDate: '2026-09-13',
          horizonWeeks: 1,
          bookedDates: ['2026-09-08'],
        }),
      );

      expect(preview.visits).toHaveLength(1);
      expect(preview.visits[0].placement).toBe('BOOKED');
    });

    it('says nothing when the bookings meet the frequency', () => {
      const preview = computeSchedulePreview(
        buildInput({
          frequencyCount: 2,
          frequencyUnit: FrequencyUnit.WEEK,
          startDate: '2026-09-07',
          endDate: '2026-09-13',
          horizonWeeks: 1,
          bookedDates: ['2026-09-08', '2026-09-10'],
        }),
      );

      expect(preview.shortfalls).toEqual([]);
    });
  });

  describe('a booked day the site\'s own hours do not support', () => {
    it('keeps the recorded window when it is too short, rather than assuming a full day', () => {
      const preview = computeSchedulePreview(
        monthly({
          durationMinutes: 180,
          // Thursday 09:00-10:00 is on record. One hour is a fact; the
          // 08:00-17:00 assumption in its place would be an invention.
          siteWindows: [
            {
              weekday: Weekday.THURSDAY,
              startMinute: 9 * 60,
              endMinute: 10 * 60,
              provenance: DataProvenance.SOURCE,
            },
          ],
          bookedDates: ['2026-09-17'],
        }),
      );

      expect(preview.visits).toHaveLength(1);
      expect(preview.visits[0]).toMatchObject({
        date: '2026-09-17',
        placement: 'BOOKED',
        windowStartMinute: 9 * 60,
        windowEndMinute: 10 * 60,
        windowProvenance: DataProvenance.SOURCE,
      });
      expect(preview.bookingIssues).toHaveLength(1);
      expect(preview.bookingIssues[0]).toMatchObject({
        date: '2026-09-17',
        reason: 'WINDOW_TOO_SHORT_FOR_BOOKED_VISIT',
        windowAssumed: false,
      });
      expect(preview.bookingIssues[0].message).toContain('2026-09-17');
      expect(preview.bookingIssues[0].message).toContain('09:00-10:00');
    });

    it('warns by date when the booking falls on a weekday the site is shut', () => {
      const preview = computeSchedulePreview(
        // 2026-09-19 is a Saturday, and the site's hours are Mon-Fri.
        monthly({ bookedDates: ['2026-09-19'] }),
      );

      expect(preview.visits[0].windowProvenance).toBe(DataProvenance.DEFAULTED);
      expect(preview.bookingIssues).toEqual([
        expect.objectContaining({
          date: '2026-09-19',
          reason: 'SITE_CLOSED_ON_BOOKED_DAY',
          windowAssumed: true,
        }),
      ]);
      expect(preview.bookingIssues[0].message).toContain('2026-09-19');
      expect(preview.bookingIssues[0].message).toContain('saturday');
    });

    it('says the agreement window and the site hours do not overlap, when that is what happened', () => {
      // 09:00-10:00 on record, and an agreement that only allows 12:00-17:00.
      // The hour is long enough for the visit; the two windows simply do not
      // meet. Calling that "the recorded hours are shorter than the visit"
      // sends a manager to widen hours that were never the problem.
      const preview = computeSchedulePreview(
        monthly({
          durationMinutes: 60,
          siteWindows: [
            {
              weekday: Weekday.THURSDAY,
              startMinute: 9 * 60,
              endMinute: 10 * 60,
              provenance: DataProvenance.SOURCE,
            },
          ],
          agreementWindowStartMinute: 12 * 60,
          agreementWindowEndMinute: 17 * 60,
          bookedDates: ['2026-09-17'],
        }),
      );

      // The visit still stands, on the site's own recorded window.
      expect(preview.visits).toContainEqual(
        expect.objectContaining({
          date: '2026-09-17',
          placement: 'BOOKED',
          windowStartMinute: 9 * 60,
          windowEndMinute: 10 * 60,
        }),
      );
      expect(preview.bookingIssues).toHaveLength(1);
      expect(preview.bookingIssues[0].reason).toBe('AGREEMENT_WINDOW_OUTSIDE_SITE_HOURS');
      expect(preview.bookingIssues[0].message).toContain('12:00-17:00');
      expect(preview.bookingIssues[0].message).toContain('09:00-10:00');
      expect(preview.bookingIssues[0].message).not.toContain('less than');
    });

    it('says nothing for a site whose hours nobody has recorded at all', () => {
      // Already disclosed on every visit that site has; repeating it per
      // booked date would bury the two cases that are actually news.
      const preview = computeSchedulePreview(
        monthly({ siteWindows: [], bookedDates: ['2026-09-19'] }),
      );

      expect(preview.visits[0].windowProvenance).toBe(DataProvenance.DEFAULTED);
      expect(preview.bookingIssues).toEqual([]);
    });

    it('says nothing when the recorded window comfortably holds the visit', () => {
      const preview = computeSchedulePreview(monthly({ bookedDates: ['2026-09-17'] }));

      expect(preview.bookingIssues).toEqual([]);
    });
  });
});

describe('anchors', () => {
  const monthly = (overrides: Partial<SchedulePreviewInput> = {}) =>
    buildInput({
      frequencyCount: 1,
      frequencyUnit: FrequencyUnit.MONTH,
      allowedDays: [
        Weekday.MONDAY,
        Weekday.TUESDAY,
        Weekday.WEDNESDAY,
        Weekday.THURSDAY,
        Weekday.FRIDAY,
      ],
      preferredDays: [],
      startDate: '2026-09-01',
      // One whole month, so the assertions read as "this month's visits".
      endDate: '2026-09-30',
      horizonWeeks: 5,
      ...overrides,
    });

  it('places an unbooked month near the anchor rather than at the earliest day', () => {
    const preview = computeSchedulePreview(monthly({ anchorDays: [17] }));

    expect(preview.visits.map((visit) => visit.date)).toEqual(['2026-09-17']);
    expect(preview.visits[0].placement).toBe('ANCHORED');
  });

  it('keeps "the 5th and the 20th" as two separate anchors', () => {
    const preview = computeSchedulePreview(
      monthly({ frequencyCount: 2, anchorDays: [5, 20] }),
    );

    // 2026-09-05 is a Saturday and 2026-09-20 a Sunday, so the nearest
    // allowed weekdays are the Friday before and the Monday after.
    expect(preview.visits.map((visit) => visit.date)).toEqual([
      '2026-09-04',
      '2026-09-21',
    ]);
  });

  it('still prefers a preferred weekday over a day closer to the anchor', () => {
    const preview = computeSchedulePreview(
      monthly({ preferredDays: [Weekday.WEDNESDAY], anchorDays: [17] }),
    );

    expect(preview.visits[0].weekday).toBe(Weekday.WEDNESDAY);
  });

  it('falls back to the earliest allowed day when there is no anchor', () => {
    const preview = computeSchedulePreview(monthly());

    expect(preview.visits.map((visit) => visit.date)).toEqual(['2026-09-01']);
    expect(preview.visits[0].placement).toBe('EARLIEST');
  });

  it('anchors the months a booking does not cover, and books the ones it does', () => {
    const preview = computeSchedulePreview(
      monthly({
        endDate: '2026-10-31',
        horizonWeeks: 9,
        bookedDates: ['2026-09-17'],
        anchorDays: [17],
      }),
    );

    expect(preview.visits.map((visit) => visit.date)).toEqual([
      '2026-09-17',
      '2026-10-16',
    ]);
    expect(preview.visits.map((visit) => visit.placement)).toEqual([
      'BOOKED',
      'ANCHORED',
    ]);
  });

  it('offers the other allowed days of the period as alternatives', () => {
    const preview = computeSchedulePreview(monthly({ anchorDays: [17] }));

    const alternatives = preview.visits[0].alternatives.map((day) => day.date);
    expect(alternatives).toContain('2026-09-16');
    expect(alternatives).toContain('2026-09-18');
    expect(alternatives).not.toContain('2026-09-17');
  });

  it('never offers an alternative another visit of the same period already holds', () => {
    const preview = computeSchedulePreview(
      monthly({ frequencyCount: 2, anchorDays: [5, 20] }),
    );

    const chosen = preview.visits.map((visit) => visit.date);
    for (const visit of preview.visits) {
      for (const alternative of visit.alternatives) {
        expect(chosen).not.toContain(alternative.date);
      }
    }
  });

  it('labels only the visits an anchor actually placed', () => {
    // Four a month with one known usual day: the anchor explains one date and
    // had no part in choosing the other three.
    const preview = computeSchedulePreview(
      monthly({ frequencyCount: 4, anchorDays: [17] }),
    );

    expect(preview.visits).toHaveLength(4);
    const anchored = preview.visits.filter((visit) => visit.placement === 'ANCHORED');
    expect(anchored.map((visit) => visit.date)).toEqual(['2026-09-17']);
    expect(
      preview.visits.filter((visit) => visit.placement === 'EARLIEST'),
    ).toHaveLength(3);
  });

  it('labels every anchor it used, when it used them all', () => {
    const preview = computeSchedulePreview(
      monthly({ frequencyCount: 2, anchorDays: [5, 20] }),
    );

    expect(preview.visits.map((visit) => visit.placement)).toEqual([
      'ANCHORED',
      'ANCHORED',
    ]);
  });
});

describe('periods are the calendar\'s, not the range\'s', () => {
  /**
   * The regression this suite exists for.
   *
   * Periods used to be counted from the run's own `from`. The portal's week
   * view sent its Monday-to-Sunday week and the month view sent the calendar
   * month, so a weekly Mon-Fri agreement got Monday the 14th from one and —
   * September starting on a Tuesday, which made the buckets run Tuesday to
   * Monday — Tuesday the 15th from the other. Where the Monday was protected
   * that was a duplicate; where it was not, the two views pushed the visit
   * back and forth for ever.
   *
   * Periods are now whole ISO weeks and whole calendar months, anchored to the
   * agreement's own start date, so no range can move them.
   */
  const weekly = (overrides: Partial<SchedulePreviewInput> = {}) =>
    buildInput({
      frequencyCount: 1,
      frequencyUnit: FrequencyUnit.WEEK,
      allowedDays: [
        Weekday.MONDAY,
        Weekday.TUESDAY,
        Weekday.WEDNESDAY,
        Weekday.THURSDAY,
        Weekday.FRIDAY,
      ],
      preferredDays: [],
      startDate: '2026-01-05',
      wholePeriodsOnly: true,
      ...overrides,
    });

  /** The week view: one ISO week. */
  const weekView = { from: '2026-09-14', to: '2026-09-20' };
  /** The month view: the grid September is drawn on, whole ISO weeks and all. */
  const monthView = { from: '2026-08-31', to: '2026-10-04' };

  it('gives the week view and the month view the same day for the same week', () => {
    const fromTheWeek = computeSchedulePreview(weekly(weekView));
    const fromTheMonth = computeSchedulePreview(weekly(monthView));

    expect(fromTheWeek.visits.map((visit) => visit.date)).toEqual(['2026-09-14']);
    expect(
      fromTheMonth.visits
        .map((visit) => visit.date)
        .filter((date) => date >= weekView.from && date <= weekView.to),
    ).toEqual(['2026-09-14']);
  });

  it('gives them the same period index too, so pinning and the guard agree', () => {
    const fromTheWeek = computeSchedulePreview(weekly(weekView));
    const fromTheMonth = computeSchedulePreview(weekly(monthView));
    const inThatWeek = fromTheMonth.visits.find((visit) => visit.date === '2026-09-14');

    expect(inThatWeek?.periodIndex).toBe(fromTheWeek.visits[0].periodIndex);
  });

  it('plans every whole week of the grid, and no slice of one', () => {
    const preview = computeSchedulePreview(weekly(monthView));

    expect(preview.visits.map((visit) => visit.date)).toEqual([
      '2026-08-31',
      '2026-09-07',
      '2026-09-14',
      '2026-09-21',
      '2026-09-28',
    ]);
    expect(preview.skippedPeriods).toEqual([]);
  });

  it('phases a fortnight from the agreement, so two month runs do not reset it', () => {
    const fortnightly = (range: { from: string; to: string }) =>
      computeSchedulePreview(
        weekly({ ...range, frequencyInterval: 2, allowedDays: [Weekday.MONDAY] }),
      );

    const september = fortnightly({ from: '2026-08-31', to: '2026-10-04' });
    const october = fortnightly({ from: '2026-09-28', to: '2026-11-01' });

    const dates = [
      ...september.visits.map((visit) => visit.date),
      ...october.visits.map((visit) => visit.date),
    ];
    // The October run re-plans the fortnight it shares with September on the
    // same day, and carries on fourteen days at a time from there.
    expect(dates).toEqual([
      '2026-08-31',
      '2026-09-14',
      '2026-09-28',
      '2026-10-12',
    ]);

    const daysApart = dates
      .slice(1)
      .map(
        (date, index) =>
          (parseDateOnly(date).getTime() - parseDateOnly(dates[index]).getTime()) /
          (24 * 60 * 60 * 1000),
      );
    expect(daysApart).toEqual([14, 14, 14]);
  });

  it('plans a quarterly agreement exactly once per quarter over six months', () => {
    const preview = computeSchedulePreview(
      weekly({
        frequencyUnit: FrequencyUnit.MONTH,
        frequencyInterval: 3,
        from: '2026-07-01',
        to: '2026-12-31',
      }),
    );

    expect(preview.visits.map((visit) => visit.date)).toEqual([
      '2026-07-01',
      '2026-10-01',
    ]);
    // Quarters counted from January, the month the agreement began in.
    expect(preview.plannedPeriods.map((period) => [period.start, period.end])).toEqual([
      ['2026-07-01', '2026-09-30'],
      ['2026-10-01', '2026-12-31'],
    ]);
  });

  it('plans nothing for a quarterly agreement from a week view, and says why', () => {
    const preview = computeSchedulePreview(
      weekly({ frequencyUnit: FrequencyUnit.MONTH, frequencyInterval: 3, ...weekView }),
    );

    expect(preview.visits).toEqual([]);
    expect(preview.plannedPeriods).toEqual([]);
    expect(preview.skippedPeriods).toEqual([
      {
        periodIndex: 2,
        start: '2026-07-01',
        end: '2026-09-30',
        reason: 'CLIPPED_BY_THE_HORIZON',
      },
    ]);
  });

  it('plans nothing for a fortnightly agreement from a week view either', () => {
    const preview = computeSchedulePreview(
      weekly({ frequencyInterval: 2, ...weekView }),
    );

    expect(preview.visits).toEqual([]);
    expect(preview.skippedPeriods).toHaveLength(1);
  });

  it('plans a monthly agreement from the month view, and says nothing was skipped', () => {
    const preview = computeSchedulePreview(
      weekly({ frequencyUnit: FrequencyUnit.MONTH, ...monthView }),
    );

    // September is whole inside the grid; August and October are not, and are
    // left to the runs that hold them.
    expect(preview.visits.map((visit) => visit.date)).toEqual(['2026-09-01']);
    expect(preview.plannedPeriods).toEqual([
      { periodIndex: 8, start: '2026-09-01', end: '2026-09-30' },
    ]);
  });

  it('reports the periods a monthly agreement plans, not the range it was given', () => {
    const preview = computeSchedulePreview(
      weekly({ frequencyUnit: FrequencyUnit.MONTH, ...monthView }),
    );

    expect(preview.plannedPeriods[0].start).toBe('2026-09-01');
    expect(preview.plannedPeriods[0].end).toBe('2026-09-30');
  });
});

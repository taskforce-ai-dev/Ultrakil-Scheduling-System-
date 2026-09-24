import { DayRuleKind, FrequencyUnit, Weekday } from '@prisma/client';

import { buildCandidateSlots, splitDayRules } from './candidate-slots';

/** 2026-09-07 is a Monday, so this week runs Monday to Sunday. */
const WEEK = {
  from: new Date('2026-09-07T00:00:00.000Z'),
  to: new Date('2026-09-13T00:00:00.000Z'),
};

function slots(overrides: Partial<Parameters<typeof buildCandidateSlots>[0]> = {}) {
  return buildCandidateSlots({
    allowedDays: [Weekday.TUESDAY, Weekday.THURSDAY],
    preferredDays: [],
    siteWindows: [],
    agreementStartMinute: null,
    agreementEndMinute: null,
    durationMinutes: 90,
    visitDate: new Date('2026-09-08T00:00:00.000Z'),
    agreementStartDate: WEEK.from,
    agreementEndDate: null,
    frequencyUnit: FrequencyUnit.WEEK,
    frequencyInterval: 1,
    ...WEEK,
    ...overrides,
  });
}

describe('buildCandidateSlots', () => {
  it('offers one slot per allowed weekday in the horizon', () => {
    expect(slots().map((slot) => slot.date)).toEqual(['2026-09-08', '2026-09-10']);
  });

  it('offers nothing when the agreement allows no days', () => {
    // Without a day rule there is no legal placement at all — and inventing one
    // would put a crew somewhere the customer never agreed to.
    expect(slots({ allowedDays: [] })).toEqual([]);
  });

  it('treats a site with no recorded hours as open for the working day', () => {
    // Unknown is not closed. Reading it as closed is what silently emptied
    // whole generated weeks before ULK-C04's fix, and the same trap is here.
    const [first] = slots();
    expect(first.earliestStartMinute).toBe(8 * 60);
    expect(first.latestStartMinute).toBe(17 * 60 - 90);
  });

  it('uses the site opening hours for that weekday', () => {
    const [first] = slots({
      siteWindows: [
        { weekday: Weekday.TUESDAY, startMinute: 10 * 60, endMinute: 15 * 60 },
        { weekday: Weekday.THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60 },
      ],
    });

    expect(first.date).toBe('2026-09-08');
    expect(first.earliestStartMinute).toBe(10 * 60);
    expect(first.latestStartMinute).toBe(15 * 60 - 90);
  });

  it('skips an allowed day the site is shut on', () => {
    const result = slots({
      siteWindows: [{ weekday: Weekday.THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60 }],
    });

    expect(result.map((slot) => slot.date)).toEqual(['2026-09-10']);
  });

  it('skips a day whose window is shorter than the job', () => {
    const result = slots({
      durationMinutes: 4 * 60,
      siteWindows: [
        { weekday: Weekday.TUESDAY, startMinute: 9 * 60, endMinute: 11 * 60 },
        { weekday: Weekday.THURSDAY, startMinute: 9 * 60, endMinute: 17 * 60 },
      ],
    });

    expect(result.map((slot) => slot.date)).toEqual(['2026-09-10']);
  });

  it('gives a site that shuts for lunch both of its windows', () => {
    const result = slots({
      allowedDays: [Weekday.TUESDAY],
      siteWindows: [
        { weekday: Weekday.TUESDAY, startMinute: 9 * 60, endMinute: 12 * 60 },
        { weekday: Weekday.TUESDAY, startMinute: 13 * 60, endMinute: 17 * 60 },
      ],
    });

    expect(result).toHaveLength(2);
    expect(result.map((slot) => slot.earliestStartMinute)).toEqual([9 * 60, 13 * 60]);
  });

  it('lets the agreement narrow the site hours but never widen them', () => {
    const result = slots({
      allowedDays: [Weekday.TUESDAY],
      siteWindows: [{ weekday: Weekday.TUESDAY, startMinute: 9 * 60, endMinute: 17 * 60 }],
      agreementStartMinute: 7 * 60,
      agreementEndMinute: 14 * 60,
    });

    // 07:00 is ignored: the customer is shut. 14:00 is honoured.
    expect(result[0].earliestStartMinute).toBe(9 * 60);
    expect(result[0].latestStartMinute).toBe(14 * 60 - 90);
  });

  it('marks the days the customer prefers without excluding the others', () => {
    const result = slots({ preferredDays: [Weekday.THURSDAY] });

    expect(result.map((slot) => [slot.date, slot.isPreferred])).toEqual([
      ['2026-09-08', false],
      ['2026-09-10', true],
    ]);
  });

  it('keeps a weekly visit inside its own ISO week even across a longer run', () => {
    const result = slots({
      allowedDays: [Weekday.TUESDAY],
      to: new Date('2026-09-27T00:00:00.000Z'),
    });

    expect(result.map((slot) => slot.date)).toEqual(['2026-09-08']);
  });

  it('keeps a monthly visit in its own calendar month', () => {
    const result = slots({
      frequencyUnit: FrequencyUnit.MONTH,
      to: new Date('2026-10-10T00:00:00.000Z'),
    });

    expect(result.map((slot) => slot.date)).toEqual([
      '2026-09-08', '2026-09-10', '2026-09-15', '2026-09-17',
      '2026-09-22', '2026-09-24', '2026-09-29',
    ]);
  });

  it('clips a visit to the agreement start and end dates', () => {
    const result = slots({
      frequencyUnit: FrequencyUnit.MONTH,
      visitDate: new Date('2026-09-10T00:00:00.000Z'),
      agreementStartDate: new Date('2026-09-09T00:00:00.000Z'),
      agreementEndDate: new Date('2026-09-16T00:00:00.000Z'),
      to: new Date('2026-09-30T00:00:00.000Z'),
    });

    expect(result.map((slot) => slot.date)).toEqual(['2026-09-10', '2026-09-15']);
  });

  it('keeps a fortnightly visit inside the agreement-anchored two-week cycle', () => {
    const result = slots({
      visitDate: new Date('2026-09-17T00:00:00.000Z'),
      frequencyInterval: 2,
      to: new Date('2026-10-04T00:00:00.000Z'),
    });

    expect(result.map((slot) => slot.date)).toEqual([
      '2026-09-08', '2026-09-10', '2026-09-15', '2026-09-17',
    ]);
  });
});

describe('splitDayRules', () => {
  it('separates the hard rule from the preference', () => {
    expect(
      splitDayRules([
        { weekday: Weekday.MONDAY, kind: DayRuleKind.ALLOWED },
        { weekday: Weekday.FRIDAY, kind: DayRuleKind.ALLOWED },
        { weekday: Weekday.FRIDAY, kind: DayRuleKind.PREFERRED },
      ]),
    ).toEqual({
      allowedDays: [Weekday.MONDAY, Weekday.FRIDAY],
      preferredDays: [Weekday.FRIDAY],
    });
  });
});

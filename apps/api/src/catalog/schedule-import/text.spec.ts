import { FrequencyUnit, Weekday } from '@prisma/client';

import {
  deriveAllowedDaysFromDates,
  parseDayRule,
  parseEffort,
  parseFrequency,
  parseTreatmentCodes,
} from './text';

/**
 * Every string in these tests was taken from UltraKIL's real 2026 master
 * schedule workbook, not invented. That is the point: the parser exists to cope
 * with how the workbook is actually written, and a test built from imagined
 * inputs would prove nothing about the file it has to read.
 */

describe('parseFrequency', () => {
  it.each([
    ['Weekly', 1, FrequencyUnit.WEEK],
    ['Monthly', 1, FrequencyUnit.MONTH],
    ['Twice a Week', 2, FrequencyUnit.WEEK],
    ['Twice a month', 2, FrequencyUnit.MONTH],
    ['02 times in month', 2, FrequencyUnit.MONTH],
    ['02 times per Month', 2, FrequencyUnit.MONTH],
    ['2 times per month', 2, FrequencyUnit.MONTH],
    ['3 times per month', 3, FrequencyUnit.MONTH],
    ['Weekly Thursday', 1, FrequencyUnit.WEEK],
  ])('reads %s as %i per %s', (source, count, unit) => {
    const result = parseFrequency(source);

    expect(result).toEqual({
      kind: 'parsed',
      frequency: { count, unit, interval: 1 },
      source,
    });
  });

  it('counts the weekdays when the frequency column lists days instead', () => {
    const result = parseFrequency('Monday Wednesday Friday');

    expect(result).toEqual({
      kind: 'parsed',
      frequency: { count: 3, unit: FrequencyUnit.WEEK, interval: 1 },
      source: 'Monday Wednesday Friday',
    });
  });

  // These are real commitments UltraKIL has made. They must be reported as
  // unsupported rather than unreadable — the workbook is not at fault, the
  // model simply cannot express them yet.
  // The cycles UltraKIL sells by name. Each is one visit per N units, which
  // is why the model needed an interval rather than another unit.
  it.each([
    ['Fortnightly', 1, FrequencyUnit.WEEK, 2],
    ['Once in Two Months', 1, FrequencyUnit.MONTH, 2],
    ['Once in 2 Months', 1, FrequencyUnit.MONTH, 2],
    ['Quarterly', 1, FrequencyUnit.MONTH, 3],
  ])('reads %s as %i per %s every %i', (source, count, unit, interval) => {
    const result = parseFrequency(source);

    expect(result).toEqual({
      kind: 'parsed',
      frequency: { count, unit, interval },
      source,
    });
  });

  it.each([
    ['On Request', /on-request/i],
    ['OR', /on-request/i],
    ['Weekly/On Request', /ambiguous/i],
  ])('reports %s as unsupported, with a reason', (source, reasonPattern) => {
    const result = parseFrequency(source);

    expect(result.kind).toBe('unsupported');
    if (result.kind !== 'unsupported') throw new Error('expected unsupported');
    expect(result.reason).toMatch(reasonPattern);
  });

  it('refuses a row that gives two treatments different frequencies', () => {
    const result = parseFrequency('RC - 2 times in month GPC - Monthly');

    expect(result.kind).toBe('unsupported');
    if (result.kind !== 'unsupported') throw new Error('expected unsupported');
    expect(result.reason).toMatch(/two agreements rather than one/);
  });

  it('reports an empty cell as absent, not as an error', () => {
    expect(parseFrequency('')).toEqual({ kind: 'absent' });
    expect(parseFrequency(null)).toEqual({ kind: 'absent' });
  });

  it('reports something it cannot read rather than guessing', () => {
    const result = parseFrequency('Hold Due to Payment');

    expect(result.kind).toBe('unreadable');
  });
});

describe('parseDayRule', () => {
  it.each([
    ['Saturday', [Weekday.SATURDAY]],
    ['Friday', [Weekday.FRIDAY]],
    ['Tuesday', [Weekday.TUESDAY]],
    ['Sunday', [Weekday.SUNDAY]],
    ['Thursday', [Weekday.THURSDAY]],
    ['Wednesday, Saturday', [Weekday.WEDNESDAY, Weekday.SATURDAY]],
  ])('reads %s', (source, expected) => {
    const result = parseDayRule(source);

    expect(result).toEqual({ kind: 'parsed', allowedDays: expected, source });
  });

  it('reads "Weekday" as Monday to Friday', () => {
    const result = parseDayRule('Weekday');

    expect(result).toEqual({
      kind: 'parsed',
      allowedDays: [
        Weekday.MONDAY,
        Weekday.TUESDAY,
        Weekday.WEDNESDAY,
        Weekday.THURSDAY,
        Weekday.FRIDAY,
      ],
      source: 'Weekday',
    });
  });

  it('still reads the weekday when a time is appended', () => {
    const result = parseDayRule('Saturday 5.00pm');

    expect(result.kind).toBe('parsed');
    if (result.kind !== 'parsed') throw new Error('expected parsed');
    expect(result.allowedDays).toEqual([Weekday.SATURDAY]);
  });

  it.each([
    ['Every 2nd and Last Friday', /ordinal weekday/],
    ['2nd Week Saturday', /ordinal weekday/],
    ['9th, 29th', /days of the month/],
    ['ex-9th, 19th, 29th', /days of the month/],
  ])('reports %s as unsupported, with a reason', (source, reasonPattern) => {
    const result = parseDayRule(source);

    expect(result.kind).toBe('unsupported');
    if (result.kind !== 'unsupported') throw new Error('expected unsupported');
    expect(result.reason).toMatch(reasonPattern);
  });

  it('does not mistake Wednesday for the word "weekday"', () => {
    const result = parseDayRule('Wednesday');

    expect(result.kind).toBe('parsed');
    if (result.kind !== 'parsed') throw new Error('expected parsed');
    expect(result.allowedDays).toEqual([Weekday.WEDNESDAY]);
  });

  it('reports a note that is not a day rule at all', () => {
    expect(parseDayRule('Hold Due to Payment').kind).toBe('unreadable');
  });

  it('reports an empty cell as absent', () => {
    expect(parseDayRule('')).toEqual({ kind: 'absent' });
  });
});

describe('parseEffort', () => {
  it.each([
    ['05hrs -02 PCT', 300, 2],
    ['04hrs - 02PCT', 240, 2],
    ['06hrs - 02 PCT', 360, 2],
    ['01hrs - 01PCT - CR', 60, 1],
    ['03hrs - 02 PCT - CR....', 180, 2],
    ['06hrs - 09 PCT', 360, 9],
  ])('reads %s as %i minutes for a crew of %i', (source, minutes, crew) => {
    expect(parseEffort(source)).toEqual({ durationMinutes: minutes, crewSize: crew });
  });

  it('handles a fractional hour', () => {
    expect(parseEffort('1.5hrs - 02PCT')).toEqual({
      durationMinutes: 90,
      crewSize: 2,
    });
  });

  it('takes the largest crew when one cell describes two treatments', () => {
    // The crew has to be big enough for the heaviest task in the visit.
    expect(parseEffort('GPC- 01hrs - 02 PCT MC-0.5hrs - 04 PCT')).toEqual({
      durationMinutes: 60,
      crewSize: 4,
    });
  });

  it('returns nulls for an empty cell rather than inventing a default', () => {
    expect(parseEffort('')).toEqual({ durationMinutes: null, crewSize: null });
  });
});

describe('parseTreatmentCodes', () => {
  it.each([
    ['GPC RC', ['GPC', 'RC']],
    ['RC', ['RC']],
    ['GPC RC MC', ['GPC', 'RC', 'MC']],
    ['RC,GPC', ['RC', 'GPC']],
    ['Fly,RC', ['FLY', 'RC']],
  ])('splits %s', (source, expected) => {
    expect(parseTreatmentCodes(source)).toEqual(expected);
  });

  it('drops the quantities in "GPC - 1 MC - 6"', () => {
    expect(parseTreatmentCodes('GPC - 1 MC - 6')).toEqual(['GPC', 'MC']);
  });

  it('does not repeat a code written twice', () => {
    expect(parseTreatmentCodes('RC RC GPC')).toEqual(['RC', 'GPC']);
  });

  it('returns nothing for an empty cell', () => {
    expect(parseTreatmentCodes('')).toEqual([]);
  });
});

describe('deriveAllowedDaysFromDates', () => {
  // 2026: 2 January is a Friday, and every 7 days after is another Friday.
  const januaryFridays = [
    { month: 1, day: 2 },
    { month: 1, day: 9 },
    { month: 1, day: 16 },
    { month: 1, day: 23 },
  ];

  it('reads a single weekday out of a run of bookings', () => {
    const result = deriveAllowedDaysFromDates(januaryFridays, 2026);

    expect(result).not.toBeNull();
    expect(result?.allowedDays).toEqual([Weekday.FRIDAY]);
    expect(result?.sampleSize).toBe(4);
    expect(result?.evidence).toBe('FRI×4');
  });

  it('keeps every weekday genuinely in use', () => {
    const result = deriveAllowedDaysFromDates(
      [
        ...januaryFridays,
        { month: 1, day: 5 }, // Monday
        { month: 1, day: 12 },
        { month: 1, day: 19 },
      ],
      2026,
    );

    expect(result?.allowedDays).toEqual([Weekday.MONDAY, Weekday.FRIDAY]);
  });

  it('drops a lone outlier among many bookings', () => {
    // One Tuesday among a year of Fridays is a one-off, not an arrangement.
    const manyFridays = Array.from({ length: 20 }, (_, index) => ({
      month: 1 + Math.floor(index / 4),
      day: [2, 9, 16, 23][index % 4],
    }));
    const result = deriveAllowedDaysFromDates(
      [...manyFridays, { month: 1, day: 6 }],
      2026,
    );

    expect(result?.allowedDays).not.toContain(Weekday.TUESDAY);
  });

  it('refuses to conclude anything from fewer than three dates', () => {
    expect(deriveAllowedDaysFromDates([{ month: 1, day: 2 }], 2026)).toBeNull();
    expect(
      deriveAllowedDaysFromDates([{ month: 1, day: 2 }, { month: 1, day: 9 }], 2026),
    ).toBeNull();
  });

  it('ignores a date that does not exist, rather than rolling it into next month', () => {
    // The 31st of February would otherwise silently become early March.
    const result = deriveAllowedDaysFromDates(
      [
        { month: 2, day: 31 },
        { month: 2, day: 30 },
        { month: 1, day: 2 },
        { month: 1, day: 9 },
        { month: 1, day: 16 },
      ],
      2026,
    );

    expect(result?.sampleSize).toBe(3);
    expect(result?.allowedDays).toEqual([Weekday.FRIDAY]);
  });

  it('ignores an out-of-range day number', () => {
    expect(
      deriveAllowedDaysFromDates(
        [{ month: 1, day: 0 }, { month: 13, day: 5 }, { month: 1, day: 99 }],
        2026,
      ),
    ).toBeNull();
  });
});

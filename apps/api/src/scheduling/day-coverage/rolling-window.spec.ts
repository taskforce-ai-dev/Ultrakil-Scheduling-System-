import { toDateOnly } from '../../catalog/schedule-preview';
import {
  ROLLING_WINDOW_DAYS,
  addCivilDays,
  civilDateInZone,
  replenishmentTarget,
  rollingWindow,
} from './rolling-window';

const COLOMBO = 'Asia/Colombo';

describe('civilDateInZone', () => {
  // The defect this helper exists to fix. `toDateOnly` reads the UTC date, the
  // application runs at UTC+5:30, and the horizon sweep's cron hour (03:00
  // local) sits inside the window where those two disagree. Left unfixed, the
  // replenishment job's "today" is yesterday and it prepares the wrong day
  // every single time it runs.
  it('names the local civil date at 03:00 Colombo, where toDateOnly names the day before', () => {
    const at0300Colombo = new Date('2026-09-25T21:30:00.000Z');

    expect(civilDateInZone(at0300Colombo, COLOMBO)).toBe('2026-09-26');
    expect(toDateOnly(at0300Colombo)).toBe('2026-09-25');
  });

  it.each([
    // The whole 00:00-05:29 local band where the UTC date lags.
    ['2026-09-25T18:30:00.000Z', '2026-09-26'], // 00:00 local
    ['2026-09-25T21:30:00.000Z', '2026-09-26'], // 03:00 local
    ['2026-09-25T23:59:00.000Z', '2026-09-26'], // 05:29 local
    // And the rest of the day, where they happen to agree.
    ['2026-09-26T00:00:00.000Z', '2026-09-26'], // 05:30 local
    ['2026-09-26T18:29:00.000Z', '2026-09-26'], // 23:59 local
  ])('resolves %s to %s in Colombo', (instant, expected) => {
    expect(civilDateInZone(new Date(instant), COLOMBO)).toBe(expected);
  });

  it('agrees either side of local midnight', () => {
    // 23:59:59 on the 26th and 00:00:01 on the 27th, local.
    expect(civilDateInZone(new Date('2026-09-26T18:29:59.000Z'), COLOMBO)).toBe(
      '2026-09-26',
    );
    expect(civilDateInZone(new Date('2026-09-26T18:30:01.000Z'), COLOMBO)).toBe(
      '2026-09-27',
    );
  });

  // Colombo has no DST, so a Colombo-only helper could pass by accident. A
  // zone that does have it proves the resolution is real and not arithmetic
  // with a fixed offset baked in.
  it('handles a zone with daylight saving', () => {
    // 2026-03-29 01:00 UTC is 02:00 in London — the instant BST begins.
    expect(civilDateInZone(new Date('2026-03-29T00:30:00.000Z'), 'Europe/London')).toBe(
      '2026-03-29',
    );
    expect(civilDateInZone(new Date('2026-03-28T23:30:00.000Z'), 'Europe/London')).toBe(
      '2026-03-28',
    );
  });
});

describe('addCivilDays', () => {
  it('adds days without a timezone anywhere near it', () => {
    expect(addCivilDays('2026-09-26', 29)).toBe('2026-10-25');
  });

  it('crosses a month end', () => {
    expect(addCivilDays('2026-09-30', 1)).toBe('2026-10-01');
  });

  it('crosses a year end', () => {
    expect(addCivilDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('handles February in a leap year', () => {
    expect(addCivilDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addCivilDays('2028-02-29', 1)).toBe('2028-03-01');
  });

  it('goes backwards', () => {
    expect(addCivilDays('2026-10-01', -1)).toBe('2026-09-30');
  });

  it('rejects anything that is not a civil date', () => {
    expect(() => addCivilDays('2026-9-26', 1)).toThrow();
    expect(() => addCivilDays('26-09-2026', 1)).toThrow();
  });
});

describe('rollingWindow', () => {
  it('is 30 days inclusive, starting today', () => {
    const window = rollingWindow('2026-09-26');

    expect(window.start).toBe('2026-09-26');
    expect(window.end).toBe('2026-10-25');
  });

  it('matches the window the deployed Calendar shows', () => {
    // Thivarrakesh's own description of the deployed build: the default plan
    // was 25 Sep - 24 Oct, and the next rolling view is 26 Sep - 25 Oct.
    expect(rollingWindow('2026-09-25')).toEqual({
      start: '2026-09-25',
      end: '2026-10-24',
    });
    expect(rollingWindow('2026-09-26')).toEqual({
      start: '2026-09-26',
      end: '2026-10-25',
    });
  });

  it('keeps the constant and the arithmetic in step', () => {
    const window = rollingWindow('2026-09-26');
    expect(addCivilDays(window.start, ROLLING_WINDOW_DAYS - 1)).toBe(window.end);
  });
});

describe('replenishmentTarget', () => {
  // The rollover gap. A job that runs during the day and targets today's
  // window end leaves 00:00 to whenever-it-runs uncovered, because the window
  // has already rolled by then. Targeting tomorrow's window end closes it:
  // the day is prepared before it becomes visible.
  it('targets tomorrow window end, one day beyond today window end', () => {
    expect(replenishmentTarget('2026-09-26')).toBe('2026-10-26');
    expect(rollingWindow('2026-09-26').end).toBe('2026-10-25');
  });

  it('leaves the day already visible at midnight already prepared', () => {
    const today = '2026-09-26';
    const tomorrow = addCivilDays(today, 1);

    // What replenishment prepared yesterday is exactly what rolls into view
    // today, so nothing is ever visible-but-unprepared.
    expect(replenishmentTarget(addCivilDays(today, -1))).toBe(
      rollingWindow(today).end,
    );
    expect(replenishmentTarget(today)).toBe(rollingWindow(tomorrow).end);
  });

  it('crosses a month end', () => {
    expect(replenishmentTarget('2026-10-02')).toBe('2026-11-01');
  });
});

import { FrequencyUnit } from '@prisma/client';

import { PreviewSkippedPeriod } from '../../catalog/schedule-preview';
import { clippedPeriodsAtRisk, clippingOneMayLoseIt } from './clipped-periods';

const period = (
  periodIndex: number,
  start: string,
  end: string,
): PreviewSkippedPeriod => ({
  periodIndex,
  start,
  end,
  reason: 'CLIPPED_BY_THE_HORIZON',
});

describe('clippingOneMayLoseIt', () => {
  it('is true only for a cadence of several weeks', () => {
    expect(clippingOneMayLoseIt(FrequencyUnit.WEEK, 1)).toBe(false);
    expect(clippingOneMayLoseIt(FrequencyUnit.WEEK, 2)).toBe(true);
    expect(clippingOneMayLoseIt(FrequencyUnit.WEEK, 3)).toBe(true);
    expect(clippingOneMayLoseIt(FrequencyUnit.MONTH, 1)).toBe(false);
    expect(clippingOneMayLoseIt(FrequencyUnit.MONTH, 3)).toBe(false);
  });
});

describe('clippedPeriodsAtRisk', () => {
  it('leaves an end-clipped fortnight alone when it starts inside the week of overlap', () => {
    // May 2026's generation range is 27 April to 7 June: the grid ends on
    // Sunday 31 May, and because June begins the next day the range reaches a
    // whole ISO week further. A fortnightly agreement anchored on Monday
    // 2026-01-12 has a fortnight running 1-14 June, clipped by that last day —
    // but it begins on 1 June, which is the Monday of the range's final week,
    // and June's own grid begins on exactly that Monday. June plans it whole.
    expect(
      clippedPeriodsAtRisk([period(10, '2026-06-01', '2026-06-14')], {
        from: '2026-04-27',
        to: '2026-06-07',
        periodsHoldingAVisit: new Set(),
      }),
    ).toEqual([]);
  });

  it('reports an end-clipped period that begins before the range\'s final week', () => {
    // A three-weekly agreement anchored on Monday 2026-01-05. April's grid
    // runs 30 March to 3 May; the period 20 April to 10 May is cut by its last
    // day and begins on 20 April, a week before the Monday (27 April) that
    // May's grid starts on. No later range reaches back to 20 April, so this
    // one really is the last run that could have planned it.
    expect(
      clippedPeriodsAtRisk([period(5, '2026-04-20', '2026-05-10')], {
        from: '2026-03-30',
        to: '2026-05-03',
        periodsHoldingAVisit: new Set(),
      }),
    ).toEqual([period(5, '2026-04-20', '2026-05-10')]);
  });

  it('reports a start-clipped period nothing stands in yet', () => {
    // A fortnightly agreement created on 28 May, starting 27 May. May's grid
    // was generated on the 1st, before the agreement existed, so its first
    // fortnight — 25 May to 7 June — was never planned by anybody. June's run
    // meets it clipped at the start, and the run that "owns" it has already
    // been and gone.
    expect(
      clippedPeriodsAtRisk([period(0, '2026-05-25', '2026-06-07')], {
        from: '2026-06-01',
        to: '2026-07-05',
        periodsHoldingAVisit: new Set(),
      }),
    ).toEqual([period(0, '2026-05-25', '2026-06-07')]);
  });

  it('reports an end-clipped period when the range is not a month grid at all', () => {
    // The overlap argument is a fact about the ranges the portal sends, not
    // about every range the API will accept: `from` a Monday, `to` a Sunday,
    // and a whole calendar month in between. A contract client may ask for
    // 27 April to 31 May — May's raw grid, which the portal itself stopped
    // sending once it reached a week further — and there the fortnight from 25
    // May to 7 June really is nobody's: June's grid begins on 1 June, after it
    // started. Nothing may be suppressed on an assumption the caller has not
    // met.
    expect(
      clippedPeriodsAtRisk([period(10, '2026-05-25', '2026-06-07')], {
        from: '2026-04-27',
        to: '2026-05-31',
        periodsHoldingAVisit: new Set(),
      }),
    ).toEqual([period(10, '2026-05-25', '2026-06-07')]);
  });

  it('still suppresses it for the grid the portal actually sends', () => {
    // 27 April to 7 June: Monday to Sunday, May entire. The next grid begins
    // on 1 June, the Monday of the final week, so a fortnight cut by the end
    // is always held whole by it.
    expect(
      clippedPeriodsAtRisk([period(10, '2026-06-01', '2026-06-14')], {
        from: '2026-04-27',
        to: '2026-06-07',
        periodsHoldingAVisit: new Set(),
      }),
    ).toEqual([]);
  });

  it('leaves a clipped period alone when a visit of that agreement already stands in it', () => {
    // The ordinary hand-off: May's run planned this fortnight, so June meeting
    // it clipped at the start is not a loss, it is the overlap working.
    expect(
      clippedPeriodsAtRisk([period(10, '2026-05-25', '2026-06-07')], {
        from: '2026-06-01',
        to: '2026-07-05',
        periodsHoldingAVisit: new Set([10]),
      }),
    ).toEqual([]);

    // And the same for an end-clipped one, so the rule needs no assumption
    // about which run comes next.
    expect(
      clippedPeriodsAtRisk([period(5, '2026-04-20', '2026-05-10')], {
        from: '2026-03-30',
        to: '2026-05-03',
        periodsHoldingAVisit: new Set([5]),
      }),
    ).toEqual([]);
  });
});

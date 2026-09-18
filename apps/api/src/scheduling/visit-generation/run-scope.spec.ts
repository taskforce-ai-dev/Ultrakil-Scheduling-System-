import { FrequencyUnit, Weekday } from '@prisma/client';

import { AgreementPeriodShape } from './protected-periods';
import { AgreementLifetime, leftStandingBy, thisRunsToJudge } from './run-scope';

const WEEKLY = 'weekly-agreement';
const MONTHLY = 'monthly-agreement';

const shapes = new Map<string, AgreementPeriodShape>([
  [
    WEEKLY,
    {
      serviceAgreementId: WEEKLY,
      anchor: '2026-01-05',
      frequencyUnit: FrequencyUnit.WEEK,
      frequencyInterval: 1,
      allowedDays: [Weekday.MONDAY],
    },
  ],
  [
    MONTHLY,
    {
      serviceAgreementId: MONTHLY,
      anchor: '2026-01-05',
      frequencyUnit: FrequencyUnit.MONTH,
      frequencyInterval: 1,
      allowedDays: [Weekday.MONDAY],
    },
  ],
]);

const lives = new Map<string, AgreementLifetime>([
  [WEEKLY, { start: '2026-01-05', end: null }],
  [MONTHLY, { start: '2026-01-05', end: null }],
]);

/** A week view over 1-7 June 2026: it holds that ISO week, and no month. */
const WEEK_RUN = { from: '2026-06-01', to: '2026-06-07' };
/** The June grid: whole ISO weeks, and the whole calendar month inside them. */
const MONTH_RUN = { from: '2026-06-01', to: '2026-07-05' };

/** June's week 23 for the weekly agreement, June itself for the monthly one. */
const weekRunPlanned = new Map([[WEEKLY, new Set([21])]]);
const monthRunPlanned = new Map([
  [WEEKLY, new Set([21, 22, 23, 24, 25])],
  [MONTHLY, new Set([5])],
]);

describe('leftStandingBy', () => {
  it('leaves standing a visit whose period this run did not plan', () => {
    // The monthly visit on 1 June, seen from the week view. The week holds no
    // whole month, so the run plans nothing for it and proposes nothing about
    // it — and it still occupies the Monday it is on.
    const visit = { serviceAgreementId: MONTHLY, visitDate: '2026-06-01' };

    expect(thisRunsToJudge(visit, WEEK_RUN, shapes, weekRunPlanned, lives)).toBe(false);
    expect(
      leftStandingBy(
        { ...visit, isProtected: false, isInScope: true },
        WEEK_RUN,
        shapes,
        weekRunPlanned,
        lives,
      ),
    ).toBe(true);
  });

  it('does not leave standing a visit this run is re-planning', () => {
    // The same Monday, but the weekly agreement's own visit: the week view
    // planned that period, so the run owns the visit and must not count it
    // twice — once as its own plan and once as somebody else's work.
    const visit = { serviceAgreementId: WEEKLY, visitDate: '2026-06-01' };

    expect(thisRunsToJudge(visit, WEEK_RUN, shapes, weekRunPlanned, lives)).toBe(true);
    expect(
      leftStandingBy(
        { ...visit, isProtected: false, isInScope: true },
        WEEK_RUN,
        shapes,
        weekRunPlanned,
        lives,
      ),
    ).toBe(false);
  });

  it('leaves the monthly visit standing for a week run and re-plans it for a month run', () => {
    const visit = { serviceAgreementId: MONTHLY, visitDate: '2026-06-01' };

    expect(
      leftStandingBy(
        { ...visit, isProtected: false, isInScope: true },
        MONTH_RUN,
        shapes,
        monthRunPlanned,
        lives,
      ),
    ).toBe(false);
  });

  it('leaves standing an out-of-scope agreement and a protected visit alike', () => {
    const visit = { serviceAgreementId: WEEKLY, visitDate: '2026-06-01' };

    expect(
      leftStandingBy(
        { ...visit, isProtected: false, isInScope: false },
        WEEK_RUN,
        shapes,
        weekRunPlanned,
        lives,
      ),
    ).toBe(true);
    expect(
      leftStandingBy(
        { ...visit, isProtected: true, isInScope: true },
        WEEK_RUN,
        shapes,
        weekRunPlanned,
        lives,
      ),
    ).toBe(true);
  });
});

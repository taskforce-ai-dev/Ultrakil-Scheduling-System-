import { DayRuleKind, Weekday } from '@prisma/client';

import {
  ASSUMED_DAY_WINDOW,
  DayWindow,
  effectiveWindows,
  toDateOnly,
  weekdayOf,
} from '../../catalog/schedule-preview';

/**
 * Every legal date and time a visit could take.
 *
 * This is the input that lets the optimizer choose *when*, not only *who*.
 * Before it, generation fixed the date and the solver could do nothing but
 * find people to fit around it — so a Tuesday visit with no free supervisor
 * stayed unstaffed while Thursday sat empty, and managers ended up with a
 * board where some visits had a date but no crew and others had a crew but no
 * vehicle. Handing the solver the whole legal space instead lets one
 * optimisation settle date, time, crew and vehicle together.
 *
 * Only the API can work these out: the allowed weekdays live on the agreement
 * and the opening hours on the site. The solver is told the answer, never the
 * rules — which keeps the constraint model free of business vocabulary and
 * keeps this decision unit-testable without a solver at all.
 */

/** One day the visit may take, and the earliest and latest it could start. */
export interface CandidateSlot {
  date: string;
  earliestStartMinute: number;
  /** The last start that still finishes before the site closes. */
  latestStartMinute: number;
  /** A weekday the customer prefers, rather than merely allows. */
  isPreferred: boolean;
}

export interface SlotInput {
  /** Days the agreement allows. A hard rule: nothing may be placed elsewhere. */
  allowedDays: Weekday[];
  /** Days the customer would rather have. A preference the solver scores. */
  preferredDays: Weekday[];
  /** The site's opening windows, by weekday. Empty means hours unknown. */
  siteWindows: { weekday: Weekday; startMinute: number; endMinute: number }[];
  /** The agreement's own narrower window, when it states one. */
  agreementStartMinute: number | null;
  agreementEndMinute: number | null;
  durationMinutes: number;
  /** The run's horizon, inclusive. */
  from: Date;
  to: Date;
}

/** Every date in the horizon, inclusive of both ends. */
function* datesBetween(from: Date, to: Date): Generator<Date> {
  const cursor = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
  );
  const last = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());

  while (cursor.getTime() <= last) {
    yield new Date(cursor);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

/**
 * Builds the slots for one visit.
 *
 * A day contributes nothing unless the agreement allows it *and* the site is
 * open long enough for the job to finish. A site with no recorded hours is
 * treated as open for the assumed working day rather than as closed — an
 * unknown is not a refusal, and treating it as one silently emptied whole
 * weeks the last time this distinction was got wrong.
 */
export function buildCandidateSlots(input: SlotInput): CandidateSlot[] {
  const allowed = new Set(input.allowedDays);
  if (allowed.size === 0) return [];

  const preferred = new Set(input.preferredDays);
  const windowsByDay = new Map<Weekday, DayWindow[]>();
  for (const window of input.siteWindows) {
    const list = windowsByDay.get(window.weekday) ?? [];
    list.push({ startMinute: window.startMinute, endMinute: window.endMinute });
    windowsByDay.set(window.weekday, list);
  }

  const slots: CandidateSlot[] = [];

  for (const date of datesBetween(input.from, input.to)) {
    const weekday = weekdayOf(date);
    if (!allowed.has(weekday)) continue;

    const recorded = windowsByDay.get(weekday);
    const dayWindows =
      recorded && recorded.length > 0
        ? recorded
        : input.siteWindows.length === 0
          ? [ASSUMED_DAY_WINDOW]
          : [];

    const usable = effectiveWindows(
      dayWindows,
      input.agreementStartMinute,
      input.agreementEndMinute,
    );

    for (const window of usable) {
      const latest = window.endMinute - input.durationMinutes;
      if (latest < window.startMinute) continue;

      slots.push({
        date: toDateOnly(date),
        earliestStartMinute: window.startMinute,
        latestStartMinute: latest,
        isPreferred: preferred.has(weekday),
      });
    }
  }

  return slots;
}

/** Splits an agreement's day rules into the two lists the builder wants. */
export function splitDayRules(rules: { weekday: Weekday; kind: DayRuleKind }[]): {
  allowedDays: Weekday[];
  preferredDays: Weekday[];
} {
  return {
    allowedDays: rules
      .filter((rule) => rule.kind === DayRuleKind.ALLOWED)
      .map((rule) => rule.weekday),
    preferredDays: rules
      .filter((rule) => rule.kind === DayRuleKind.PREFERRED)
      .map((rule) => rule.weekday),
  };
}

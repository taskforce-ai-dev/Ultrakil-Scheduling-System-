import { BranchCode } from '@prisma/client';

import { Conflict } from '../eligibility/conflict-codes';

/**
 * How full each branch-day is, kept current as a solve's moves are applied.
 *
 * `VISIT_GENERATION_DAILY_CAP` used to be a promise generation made and the
 * optimizer silently revoked. Generation spread a September grid so no day
 * carried more than twelve; one solve over a single week of it then moved
 * eight visits off the 21st onto the 17th and left the manager looking at a
 * twenty-job day — the very complaint the cap was introduced to answer.
 *
 * The solver is not the place to fix that on its own. It runs in another
 * process, it is handed crews and vehicles rather than the branch's book of
 * work, and an invariant that holds only while a remote service behaves is not
 * an invariant. So the cap is enforced where the move is actually committed:
 * in the guarded persistence transaction, against a count of the day read
 * inside that transaction.
 *
 * Two things this deliberately does **not** do.
 *
 * It does not refuse an *assignment*. A day that was already over the cap
 * before the solve — a week of protected work a manager stacked up by hand —
 * still needs crews, and refusing to staff what is already standing there
 * would punish the visits for the day's history. Only a move *onto* a day is
 * ever refused.
 *
 * And it does not re-plan. A refused move leaves the visit exactly where
 * generation put it; whether the solver's crew can still serve it there is the
 * eligibility engine's question, asked immediately afterwards.
 */
export class DailyLoadLedger {
  private readonly counts: Map<string, number>;

  /**
   * @param counts How many visits each branch-day carries right now, keyed by
   *   {@link branchDayKey}. A day absent from the map is read as empty, which
   *   is the truth for any day the run never asked about.
   * @param cap The most visits one branch-day may carry.
   */
  constructor(counts: Map<string, number>, private readonly cap: number) {
    this.counts = new Map(counts);
  }

  /** How many visits that branch-day carries as the run stands. */
  countOn(branchCode: BranchCode, date: string): number {
    return this.counts.get(branchDayKey(branchCode, date)) ?? 0;
  }

  /**
   * Whether work may still be moved on to that branch-day.
   *
   * At the cap is already refused, not merely over it: a day holding exactly
   * twelve is a full day, and the thirteenth is the one the manager complained
   * about. This is the same reading generation's own guard uses when it
   * chooses somewhere to spread a visit to — "a day already at the cap is no
   * help" — so the two halves of the system agree on what "full" means.
   */
  admitsMoveOnto(branchCode: BranchCode, date: string): boolean {
    return this.countOn(branchCode, date) < this.cap;
  }

  /**
   * Records a move that has actually been committed.
   *
   * Called only after the move is applied, never on the strength of one being
   * proposed: a move that the eligibility engine then refuses leaves its visit
   * on the day it started, and a ledger that had already credited the
   * departure would let the next proposal overfill that day.
   */
  recordMove(branchCode: BranchCode, from: string, to: string): void {
    if (from === to) return;
    const origin = branchDayKey(branchCode, from);
    const target = branchDayKey(branchCode, to);
    this.counts.set(origin, Math.max(0, (this.counts.get(origin) ?? 0) - 1));
    this.counts.set(target, (this.counts.get(target) ?? 0) + 1);
  }
}

/** Branch and date together, because a Kandy day says nothing about a Colombo one. */
export function branchDayKey(branchCode: BranchCode, date: string): string {
  return `${branchCode}|${date}`;
}

/**
 * Why the visit is not on the day the scheduler chose for it.
 *
 * Worded for the Unassigned queue, which is where a manager meets it: it names
 * the day that was full, what it was full of, and where the visit stayed. The
 * remediation offers both ways out, because either one genuinely works —
 * empty the day the scheduler wanted, or crew the visit where it is.
 *
 * The day the visit is actually on comes first, and is the only date in the
 * opening sentence. Leading with the proposed date — "The scheduler planned
 * this visit for 2026-09-16…" — put a day the visit is *not* on in the first
 * six words, and read beside a visit dated the 18th that date registered as
 * the visit's own.
 */
export function dailyCapRefusal(input: {
  visitId: string;
  branchCode: BranchCode;
  /** The day the solver proposed moving the visit to. */
  proposedDate: string;
  /** The day the visit keeps, because the move was refused. */
  keptDate: string;
  /** How many visits the proposed day already carries. */
  carrying: number;
  cap: number;
}): Conflict {
  return {
    code: 'DAILY_VISIT_CAP_REACHED',
    message: `This visit is on ${input.keptDate}, where it was generated. The scheduler wanted to move it to ${input.proposedDate}, but that day already carries ${input.carrying} ${input.carrying === 1 ? 'visit' : 'visits'} in ${input.branchCode}, the ${input.cap} a day this branch plans for, so the move was refused.`,
    remediation: `Move or cancel work already on ${input.proposedDate} to make room, or assign a crew that can serve this visit on ${input.keptDate}.`,
    resources: { visitId: input.visitId },
  };
}

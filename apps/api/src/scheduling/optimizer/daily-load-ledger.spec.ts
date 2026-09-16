import { BranchCode } from '@prisma/client';

import {
  branchDayKey,
  dailyCapRefusal,
  DailyLoadLedger,
} from './daily-load-ledger';

const CAP = 12;

const ledgerOf = (counts: Record<string, number>, cap = CAP) =>
  new DailyLoadLedger(
    new Map(
      Object.entries(counts).map(([date, count]) => [
        branchDayKey(BranchCode.COLOMBO, date),
        count,
      ]),
    ),
    cap,
  );

describe('DailyLoadLedger', () => {
  it('reads a day nobody has planned as empty', () => {
    const ledger = ledgerOf({});

    expect(ledger.countOn(BranchCode.COLOMBO, '2026-09-17')).toBe(0);
    expect(ledger.admitsMoveOnto(BranchCode.COLOMBO, '2026-09-17')).toBe(true);
  });

  it('refuses a move on to a day standing exactly at the cap', () => {
    const ledger = ledgerOf({ '2026-09-17': CAP });

    // At the cap, not merely over it. Twelve is a full day; the thirteenth is
    // the visit the manager complained about.
    expect(ledger.admitsMoveOnto(BranchCode.COLOMBO, '2026-09-17')).toBe(false);
  });

  it('refuses a move on to a day that was already over the cap before the run', () => {
    const ledger = ledgerOf({ '2026-09-17': 20 });

    expect(ledger.admitsMoveOnto(BranchCode.COLOMBO, '2026-09-17')).toBe(false);
  });

  it('accepts a move on to the last free slot of a day', () => {
    const ledger = ledgerOf({ '2026-09-17': CAP - 1 });

    expect(ledger.admitsMoveOnto(BranchCode.COLOMBO, '2026-09-17')).toBe(true);
  });

  it('keeps one branch-day out of another branch', () => {
    const ledger = ledgerOf({ '2026-09-17': CAP });

    // A Colombo day says nothing about a Kandy one; branch isolation is as
    // true of the load guard as of everything else.
    expect(ledger.admitsMoveOnto(BranchCode.KANDY, '2026-09-17')).toBe(true);
  });

  it('closes a day once the run has filled it', () => {
    const ledger = ledgerOf({ '2026-09-17': CAP - 1, '2026-09-21': 11 });

    expect(ledger.admitsMoveOnto(BranchCode.COLOMBO, '2026-09-17')).toBe(true);
    ledger.recordMove(BranchCode.COLOMBO, '2026-09-21', '2026-09-17');

    // The move the run just committed is the twelfth. Nothing else may follow
    // it on to that day, which is what stops eight visits arriving one by one.
    expect(ledger.countOn(BranchCode.COLOMBO, '2026-09-17')).toBe(CAP);
    expect(ledger.admitsMoveOnto(BranchCode.COLOMBO, '2026-09-17')).toBe(false);
    expect(ledger.countOn(BranchCode.COLOMBO, '2026-09-21')).toBe(10);
  });

  it('opens a day again when the run moves work off it', () => {
    const ledger = ledgerOf({ '2026-09-17': CAP, '2026-09-18': 7 });

    expect(ledger.admitsMoveOnto(BranchCode.COLOMBO, '2026-09-17')).toBe(false);
    ledger.recordMove(BranchCode.COLOMBO, '2026-09-17', '2026-09-18');

    // A day the run emptied a slot on has room for one again. Counting the day
    // as it will stand after the run, rather than as it stood before it, is
    // the same basis generation's own warning uses.
    expect(ledger.admitsMoveOnto(BranchCode.COLOMBO, '2026-09-17')).toBe(true);
    expect(ledger.countOn(BranchCode.COLOMBO, '2026-09-18')).toBe(8);
  });

  it('ignores a move that goes nowhere', () => {
    const ledger = ledgerOf({ '2026-09-17': 5 });

    ledger.recordMove(BranchCode.COLOMBO, '2026-09-17', '2026-09-17');

    expect(ledger.countOn(BranchCode.COLOMBO, '2026-09-17')).toBe(5);
  });

  it('never counts a day below zero', () => {
    const ledger = ledgerOf({});

    ledger.recordMove(BranchCode.COLOMBO, '2026-09-17', '2026-09-18');

    expect(ledger.countOn(BranchCode.COLOMBO, '2026-09-17')).toBe(0);
    expect(ledger.countOn(BranchCode.COLOMBO, '2026-09-18')).toBe(1);
  });

  it('does not write through to the counts it was given', () => {
    const counts = new Map([[branchDayKey(BranchCode.COLOMBO, '2026-09-17'), 5]]);
    const ledger = new DailyLoadLedger(counts, CAP);

    ledger.recordMove(BranchCode.COLOMBO, '2026-09-18', '2026-09-17');

    expect(counts.get(branchDayKey(BranchCode.COLOMBO, '2026-09-17'))).toBe(5);
    expect(ledger.countOn(BranchCode.COLOMBO, '2026-09-17')).toBe(6);
  });
});

describe('dailyCapRefusal', () => {
  const refusal = dailyCapRefusal({
    visitId: 'visit-1',
    branchCode: BranchCode.COLOMBO,
    proposedDate: '2026-09-17',
    keptDate: '2026-09-21',
    carrying: 12,
    cap: 12,
  });

  it('names the full day, what it carries, and where the visit stayed', () => {
    expect(refusal.code).toBe('DAILY_VISIT_CAP_REACHED');
    expect(refusal.message).toContain('2026-09-17');
    expect(refusal.message).toContain('12 visits in COLOMBO');
    expect(refusal.message).toContain('stayed on 2026-09-21');
  });

  it('offers both ways out, because either one actually works', () => {
    expect(refusal.remediation).toContain('2026-09-17');
    expect(refusal.remediation).toContain('2026-09-21');
  });

  it('points at the visit, so the queue can highlight it', () => {
    expect(refusal.resources).toEqual({ visitId: 'visit-1' });
  });

  it('says "visit" rather than "visits" when a cap of one is reached', () => {
    const single = dailyCapRefusal({
      visitId: 'visit-1',
      branchCode: BranchCode.KANDY,
      proposedDate: '2026-09-17',
      keptDate: '2026-09-21',
      carrying: 1,
      cap: 1,
    });

    expect(single.message).toContain('1 visit in KANDY');
  });
});

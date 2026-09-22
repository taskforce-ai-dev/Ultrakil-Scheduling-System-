import { BranchCode } from '@prisma/client';

import {
  branchDayKey,
  dailyCapRefusal,
  DailyLoadLedger,
} from './daily-load-ledger';

// A reference visit's own crew-minutes cost: one hour, one crew member. The
// cap and every existing load below are expressed as a whole number of these,
// so the tests read the same way the old count-based ones did.
const UNIT = 60;
const CAP = 12 * UNIT;

const ledgerOf = (unitsByDate: Record<string, number>, capMinutes = CAP) =>
  new DailyLoadLedger(
    new Map(
      Object.entries(unitsByDate).map(([date, units]) => [
        branchDayKey(BranchCode.COLOMBO, date),
        units * UNIT,
      ]),
    ),
    capMinutes,
  );

describe('DailyLoadLedger', () => {
  it('reads a day nobody has planned as empty', () => {
    const ledger = ledgerOf({});

    expect(ledger.minutesOn(BranchCode.COLOMBO, '2026-09-17')).toBe(0);
    expect(ledger.admitsMoveOnto(BranchCode.COLOMBO, '2026-09-17', UNIT)).toBe(true);
  });

  it('refuses a move on to a day standing exactly at the cap', () => {
    const ledger = ledgerOf({ '2026-09-17': 12 });

    // At the cap, not merely over it. Twelve hours of crew-minutes is a full
    // day; the thirteenth unit is the visit the manager complained about.
    expect(ledger.admitsMoveOnto(BranchCode.COLOMBO, '2026-09-17', UNIT)).toBe(false);
  });

  it('refuses a move on to a day that was already over the cap before the run', () => {
    const ledger = ledgerOf({ '2026-09-17': 20 });

    expect(ledger.admitsMoveOnto(BranchCode.COLOMBO, '2026-09-17', UNIT)).toBe(false);
  });

  it('accepts a move on to the last free slot of a day', () => {
    const ledger = ledgerOf({ '2026-09-17': 11 });

    expect(ledger.admitsMoveOnto(BranchCode.COLOMBO, '2026-09-17', UNIT)).toBe(true);
  });

  it('refuses a move whose own crew-minutes alone would push the day over the cap', () => {
    // Ten hours standing, two hours of room — a reference one-hour visit
    // fits, but a two-crew, ninety-minute visit (three hours) does not.
    const ledger = ledgerOf({ '2026-09-17': 10 });

    expect(ledger.admitsMoveOnto(BranchCode.COLOMBO, '2026-09-17', 2 * UNIT)).toBe(true);
    expect(ledger.admitsMoveOnto(BranchCode.COLOMBO, '2026-09-17', 3 * UNIT)).toBe(false);
  });

  it('keeps one branch-day out of another branch', () => {
    const ledger = ledgerOf({ '2026-09-17': 12 });

    // A Colombo day says nothing about a Kandy one; branch isolation is as
    // true of the load guard as of everything else.
    expect(ledger.admitsMoveOnto(BranchCode.KANDY, '2026-09-17', UNIT)).toBe(true);
  });

  it('closes a day once the run has filled it', () => {
    const ledger = ledgerOf({ '2026-09-17': 11, '2026-09-21': 11 });

    expect(ledger.admitsMoveOnto(BranchCode.COLOMBO, '2026-09-17', UNIT)).toBe(true);
    ledger.recordMove(BranchCode.COLOMBO, '2026-09-21', '2026-09-17', UNIT);

    // The move the run just committed is the twelfth hour. Nothing else may
    // follow it on to that day, which is what stops eight visits arriving one
    // by one.
    expect(ledger.minutesOn(BranchCode.COLOMBO, '2026-09-17')).toBe(CAP);
    expect(ledger.admitsMoveOnto(BranchCode.COLOMBO, '2026-09-17', UNIT)).toBe(false);
    expect(ledger.minutesOn(BranchCode.COLOMBO, '2026-09-21')).toBe(10 * UNIT);
  });

  it('opens a day again when the run moves work off it', () => {
    const ledger = ledgerOf({ '2026-09-17': 12, '2026-09-18': 7 });

    expect(ledger.admitsMoveOnto(BranchCode.COLOMBO, '2026-09-17', UNIT)).toBe(false);
    ledger.recordMove(BranchCode.COLOMBO, '2026-09-17', '2026-09-18', UNIT);

    // A day the run emptied a slot on has room for one again. Counting the day
    // as it will stand after the run, rather than as it stood before it, is
    // the same basis generation's own warning uses.
    expect(ledger.admitsMoveOnto(BranchCode.COLOMBO, '2026-09-17', UNIT)).toBe(true);
    expect(ledger.minutesOn(BranchCode.COLOMBO, '2026-09-18')).toBe(8 * UNIT);
  });

  it('moves a visit by its own crew-minutes, not a flat unit', () => {
    // A two-crew, ninety-minute visit costs three hours of crew-minutes, not
    // one — the whole reason the ledger moved off counting visits.
    const ledger = ledgerOf({ '2026-09-17': 5, '2026-09-18': 5 });
    const visitMinutes = 2 * 90;

    ledger.recordMove(BranchCode.COLOMBO, '2026-09-17', '2026-09-18', visitMinutes);

    expect(ledger.minutesOn(BranchCode.COLOMBO, '2026-09-17')).toBe(5 * UNIT - visitMinutes);
    expect(ledger.minutesOn(BranchCode.COLOMBO, '2026-09-18')).toBe(5 * UNIT + visitMinutes);
  });

  it('ignores a move that goes nowhere', () => {
    const ledger = ledgerOf({ '2026-09-17': 5 });

    ledger.recordMove(BranchCode.COLOMBO, '2026-09-17', '2026-09-17', UNIT);

    expect(ledger.minutesOn(BranchCode.COLOMBO, '2026-09-17')).toBe(5 * UNIT);
  });

  it('never counts a day below zero', () => {
    const ledger = ledgerOf({});

    ledger.recordMove(BranchCode.COLOMBO, '2026-09-17', '2026-09-18', UNIT);

    expect(ledger.minutesOn(BranchCode.COLOMBO, '2026-09-17')).toBe(0);
    expect(ledger.minutesOn(BranchCode.COLOMBO, '2026-09-18')).toBe(UNIT);
  });

  it('does not write through to the map it was given', () => {
    const minutes = new Map([[branchDayKey(BranchCode.COLOMBO, '2026-09-17'), 5 * UNIT]]);
    const ledger = new DailyLoadLedger(minutes, CAP);

    ledger.recordMove(BranchCode.COLOMBO, '2026-09-18', '2026-09-17', UNIT);

    expect(minutes.get(branchDayKey(BranchCode.COLOMBO, '2026-09-17'))).toBe(5 * UNIT);
    expect(ledger.minutesOn(BranchCode.COLOMBO, '2026-09-17')).toBe(6 * UNIT);
  });
});

describe('dailyCapRefusal', () => {
  const refusal = dailyCapRefusal({
    visitId: 'visit-1',
    branchCode: BranchCode.COLOMBO,
    proposedDate: '2026-09-17',
    keptDate: '2026-09-21',
    carryingMinutes: 720,
    visitMinutes: 60,
    capMinutes: 720,
  });

  it('names the full day, what it carries, and where the visit stayed', () => {
    expect(refusal.code).toBe('DAILY_VISIT_CAP_REACHED');
    expect(refusal.message).toContain('2026-09-17');
    expect(refusal.message).toContain('720 crew-minutes of work in COLOMBO');
    expect(refusal.message).toContain('2026-09-21');
  });

  it('leads with the day the visit is actually on', () => {
    // Read beside a visit dated the 21st, "The scheduler planned this visit
    // for 2026-09-17…" put a date the visit is not on in the first six words,
    // and it registered as the visit's own. The day it is on comes first.
    expect(refusal.message.indexOf('2026-09-21')).toBeLessThan(
      refusal.message.indexOf('2026-09-17'),
    );
    expect(refusal.message.startsWith('This visit is on 2026-09-21')).toBe(true);
  });

  it('offers both ways out, because either one actually works', () => {
    expect(refusal.remediation).toContain('2026-09-17');
    expect(refusal.remediation).toContain('2026-09-21');
  });

  it('points at the visit, so the queue can highlight it', () => {
    expect(refusal.resources).toEqual({ visitId: 'visit-1' });
  });

  it('names the visit\'s own crew-minutes alongside what the day already carries', () => {
    const multiCrew = dailyCapRefusal({
      visitId: 'visit-1',
      branchCode: BranchCode.KANDY,
      proposedDate: '2026-09-17',
      keptDate: '2026-09-21',
      carryingMinutes: 700,
      visitMinutes: 180,
      capMinutes: 720,
    });

    expect(multiCrew.message).toContain('700 crew-minutes of work in KANDY');
    expect(multiCrew.message).toContain("visit's own 180");
    expect(multiCrew.message).toContain('720 crew-minutes a day');
  });
});

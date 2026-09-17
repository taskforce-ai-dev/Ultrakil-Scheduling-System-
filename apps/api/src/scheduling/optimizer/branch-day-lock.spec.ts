import { BranchCode, Prisma } from '@prisma/client';

import {
  BRANCH_DAY_LOCK_CLASS,
  branchDayLockKey,
  lockBranchDays,
} from './branch-day-lock';

/** A transaction client that records the lock statements rather than running them. */
function recordingTx() {
  const executeRaw = jest.fn().mockResolvedValue(1);
  return {
    executeRaw,
    tx: { $executeRaw: executeRaw } as unknown as Prisma.TransactionClient,
    /** The day half of each key, in the order the locks were asked for. */
    keys: () =>
      executeRaw.mock.calls.map((call) => call[2] as number),
    schemes: () => executeRaw.mock.calls.map((call) => call[1] as number),
  };
}

describe('branchDayLockKey', () => {
  it('gives every branch-day its own number, and the same one every time', () => {
    const colomboMonday = branchDayLockKey(BranchCode.COLOMBO, '2026-09-21');
    expect(branchDayLockKey(BranchCode.COLOMBO, '2026-09-21')).toBe(colomboMonday);

    // A different day, and the same day in the other branch. A Kandy day says
    // nothing about a Colombo one, so the two must never share a lock.
    expect(branchDayLockKey(BranchCode.COLOMBO, '2026-09-22')).not.toBe(
      colomboMonday,
    );
    expect(branchDayLockKey(BranchCode.KANDY, '2026-09-21')).not.toBe(
      colomboMonday,
    );
  });

  it('keeps every key inside the int4 the advisory lock takes', () => {
    for (const date of ['1970-01-01', '2026-09-21', '2099-12-31']) {
      for (const branchCode of [BranchCode.COLOMBO, BranchCode.KANDY]) {
        const key = branchDayLockKey(branchCode, date);
        expect(Number.isInteger(key)).toBe(true);
        expect(key).toBeGreaterThan(0);
        expect(key).toBeLessThan(2_147_483_647);
      }
    }
  });

  it('refuses anything that is not a calendar date', () => {
    // A date with a time on it would hash to a key nobody else computes, and
    // the lock would silently stop being shared.
    expect(() =>
      branchDayLockKey(BranchCode.COLOMBO, '2026-09-21T00:00:00.000Z'),
    ).toThrow(/YYYY-MM-DD/);
  });
});

describe('lockBranchDays', () => {
  it('takes every day once, in ascending key order', async () => {
    const recorder = recordingTx();

    await lockBranchDays(recorder.tx, [
      { branchCode: BranchCode.KANDY, date: '2026-09-21' },
      { branchCode: BranchCode.COLOMBO, date: '2026-09-22' },
      { branchCode: BranchCode.COLOMBO, date: '2026-09-21' },
      { branchCode: BranchCode.COLOMBO, date: '2026-09-22' },
    ]);

    // Three statements, not four: one day named twice is one lock. And in
    // ascending order, which is the only thing keeping two runs that touch the
    // same days in opposite orders from deadlocking on each other.
    const keys = recorder.keys();
    expect(keys).toHaveLength(3);
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
    expect(new Set(keys)).toEqual(
      new Set([
        branchDayLockKey(BranchCode.COLOMBO, '2026-09-21'),
        branchDayLockKey(BranchCode.COLOMBO, '2026-09-22'),
        branchDayLockKey(BranchCode.KANDY, '2026-09-21'),
      ]),
    );
  });

  it('asks for a transaction-scoped advisory lock in the scheme this codebase owns', async () => {
    const recorder = recordingTx();

    await lockBranchDays(recorder.tx, [
      { branchCode: BranchCode.COLOMBO, date: '2026-09-21' },
    ]);

    const [statement] = recorder.executeRaw.mock.calls[0] as [string[]];
    expect(statement.join('?')).toContain('pg_advisory_xact_lock');
    // Transaction-scoped: `pg_advisory_lock` would outlive the transaction and
    // leak the day for the life of the connection.
    expect(statement.join('?')).not.toContain('pg_advisory_lock(');
    expect(recorder.schemes()).toEqual([BRANCH_DAY_LOCK_CLASS]);
  });

  it('locks nothing when there is no day to lock', async () => {
    const recorder = recordingTx();
    await lockBranchDays(recorder.tx, []);
    // A run that moves nothing changes no day's load, and has no business
    // queueing behind one that does.
    expect(recorder.executeRaw).not.toHaveBeenCalled();
  });
});

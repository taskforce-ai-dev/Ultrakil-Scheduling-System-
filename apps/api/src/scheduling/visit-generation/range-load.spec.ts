import { ConfigService } from '@nestjs/config';
import {
  BranchCode,
  FrequencyUnit,
  VisitStatus,
  Weekday,
} from '@prisma/client';

import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { branchDayKey } from '../optimizer/daily-load-ledger';
import { VisitGenerationService } from './visit-generation.service';

/**
 * The plan-time half of the daily cap's concurrency check.
 *
 * `apply` refuses a plan when a day it is adding to has grown since the plan
 * was made. That comparison is only as good as its baseline: the baseline has
 * to be the very calendar the load guard planned against, counted on the same
 * basis the transaction will count it on, or the comparison quietly answers a
 * different question.
 *
 * Two things can break it, and each broke it in a different way while this was
 * being written. Counting from a *second* read taken a moment later made a
 * removal in between invisible: the baseline said twelve, the guard saw
 * eleven, another planner took the freed slot, and the commit read twelve
 * against a baseline of twelve and called that no growth — a thirteenth visit
 * on a day capped at twelve, with no warning. And counting only the *standing*
 * rows would leave the run's own work out of a number the transaction counts
 * it into, so every run would look to itself like the calendar had grown.
 */

type RangeReader = {
  readTheRange(
    dto: { from: string; to: string; branchCode?: BranchCode },
    agreements: { id: string }[],
    from: Date,
    to: Date,
    scope: {
      shapes: Map<string, unknown>;
      plannedPeriods: Map<string, Set<number>>;
      lives: Map<string, { start: string; end: string | null }>;
    },
  ): Promise<{
    standing: { serviceAgreementId: string; visitDate: string }[];
    loadByDay: Map<string, number>;
  }>;
};

const WEEK = { from: '2029-05-07', to: '2029-05-13' };
const DAY = '2029-05-07';
const IN_SCOPE = 'agreement-in-scope';
const SOMEBODY_ELSE = 'agreement-elsewhere';

/** One row per visit, exactly as the range read selects them. One hour, one crew member. */
function visitRow(serviceAgreementId: string, startMinute: number) {
  return {
    serviceAgreementId,
    branchCode: BranchCode.COLOMBO,
    visitDate: new Date(`${DAY}T00:00:00.000Z`),
    windowStartMinute: startMinute,
    durationMinutes: 60,
    requiredCrewSize: 1,
    status: VisitStatus.PENDING,
    isManuallyAdjusted: false,
    lockedAt: null,
    _count: { assignments: 0 },
  };
}

function reader(rows: ReturnType<typeof visitRow>[]) {
  const findMany = jest.fn(async () => rows);
  const prisma = {
    generatedVisit: { findMany },
  } as unknown as PrismaService;
  const service = new VisitGenerationService(
    prisma,
    {} as unknown as AuditService,
    { get: () => undefined } as unknown as ConfigService,
  );
  return { findMany, range: service as unknown as RangeReader };
}

describe('the horizon as one read', () => {
  const scope = {
    // A weekly agreement anchored on the Monday, whose only period this run
    // planned. Its visit is therefore this run's to judge, and stands for
    // nobody.
    shapes: new Map<string, unknown>([
      [
        IN_SCOPE,
        {
          serviceAgreementId: IN_SCOPE,
          anchor: WEEK.from,
          frequencyUnit: FrequencyUnit.WEEK,
          frequencyInterval: 1,
          allowedDays: [Weekday.MONDAY],
        },
      ],
    ]),
    plannedPeriods: new Map([[IN_SCOPE, new Set([0])]]),
    lives: new Map([[IN_SCOPE, { start: WEEK.from, end: null }]]),
  };

  it('counts the day on every visit standing on it, including its own', async () => {
    const { range } = reader([visitRow(IN_SCOPE, 480), visitRow(SOMEBODY_ELSE, 540)]);

    const answer = await range.readTheRange(
      WEEK,
      [{ id: IN_SCOPE }],
      new Date(`${WEEK.from}T00:00:00.000Z`),
      new Date(`${WEEK.to}T00:00:00.000Z`),
      scope,
    );

    // One of the two stands: the other belongs to this run and will be judged.
    expect(answer.standing.map((visit) => visit.serviceAgreementId)).toEqual([
      SOMEBODY_ELSE,
    ]);
    // The day still carries two visits' worth of crew-minutes — 120, at one
    // hour and one crew member each. The cap is a fact about the day, not
    // about whose work is on it, and the transaction will count it the same
    // way — so a baseline built out of `standing` alone would read every run
    // as having been raced by itself.
    expect(answer.loadByDay.get(branchDayKey(BranchCode.COLOMBO, DAY))).toBe(120);
  });

  it('asks the database once, so the two answers are one calendar', async () => {
    const { findMany, range } = reader([visitRow(SOMEBODY_ELSE, 540)]);

    await range.readTheRange(
      WEEK,
      [{ id: IN_SCOPE }],
      new Date(`${WEEK.from}T00:00:00.000Z`),
      new Date(`${WEEK.to}T00:00:00.000Z`),
      scope,
    );

    // One statement is one snapshot. Two reads a moment apart are two
    // calendars, and the difference between them is where a thirteenth visit
    // got through.
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});

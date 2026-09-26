import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AssignmentStatus, BranchCode, Prisma, VisitStatus } from '@prisma/client';

import { parseDateOnly, toDateOnly } from '../../catalog/schedule-preview';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../prisma/prisma.service';
import {
  combineCoverageDays,
  CoverageDay,
  CoverageSweepFact,
  CoverageVisitFact,
  projectCoverageDay,
} from './coverage-projection';
import { CoverageQueryDto, CoverageResponseDto } from './dto';

const MAX_RANGE_DAYS = 31;
const MAX_VISITS = 5000;
const LIVE_DISPATCH: AssignmentStatus[] = [
  AssignmentStatus.PUBLISHED,
  AssignmentStatus.ACKNOWLEDGED,
  AssignmentStatus.IN_PROGRESS,
  AssignmentStatus.COMPLETED,
];
const PREPARED: AssignmentStatus[] = [AssignmentStatus.DRAFT, AssignmentStatus.PROPOSED];

export const COVERAGE_SWEEP_READER = Symbol('COVERAGE_SWEEP_READER');

export interface CoverageSweepRecord extends CoverageSweepFact {
  date: string;
  branchCode: BranchCode;
}

export interface CoverageSweepReader {
  list(from: Date, to: Date, branchCode?: BranchCode): Promise<CoverageSweepRecord[]>;
}

/** Safe until the C13 durable sweep table and reader are integrated. */
@Injectable()
export class UnavailableCoverageSweepReader implements CoverageSweepReader {
  async list(): Promise<CoverageSweepRecord[]> { return []; }
}

const VISIT_SELECT = {
  id: true,
  visitDate: true,
  branchCode: true,
  assignments: {
    where: { status: { in: [...LIVE_DISPATCH, ...PREPARED] } },
    select: { status: true },
  },
  unassignedReasons: { select: { code: true } },
} satisfies Prisma.GeneratedVisitSelect;

type VisitRow = Prisma.GeneratedVisitGetPayload<{ select: typeof VISIT_SELECT }>;

@Injectable()
export class CoverageService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(COVERAGE_SWEEP_READER) private readonly sweeps: CoverageSweepReader,
  ) {}

  async list(query: CoverageQueryDto): Promise<CoverageResponseDto> {
    const from = parseDateOnly(query.from);
    const to = parseDateOnly(query.to);
    const rangeDays = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (rangeDays < 1 || rangeDays > MAX_RANGE_DAYS) {
      throw new AppException(
        'VALIDATION_FAILED',
        `Coverage requires an ordered range of at most ${MAX_RANGE_DAYS} days.`,
        HttpStatus.BAD_REQUEST,
        { from: query.from, to: query.to, maxRangeDays: MAX_RANGE_DAYS },
      );
    }

    const where: Prisma.GeneratedVisitWhereInput = {
      visitDate: { gte: from, lte: to },
      status: { not: VisitStatus.CANCELLED },
      ...(query.branchCode ? { branchCode: query.branchCode } : {}),
    };
    const [visits, sweepRows] = await Promise.all([
      this.prisma.generatedVisit.findMany({
        where,
        select: VISIT_SELECT,
        orderBy: [{ visitDate: 'asc' }, { id: 'asc' }],
        take: MAX_VISITS + 1,
      }),
      this.sweeps.list(from, to, query.branchCode),
    ]);
    if (visits.length > MAX_VISITS) {
      throw new AppException(
        'VALIDATION_FAILED',
        'This coverage range is too busy; narrow the date range or select a branch.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const visitMap = new Map<string, CoverageVisitFact[]>();
    for (const visit of visits) {
      const key = `${toDateOnly(visit.visitDate)}:${visit.branchCode}`;
      const bucket = visitMap.get(key) ?? [];
      bucket.push(toFact(visit));
      visitMap.set(key, bucket);
    }
    const sweepMap = new Map(sweepRows.map((row) => [`${row.date}:${row.branchCode}`, row]));
    const branchCodes = query.branchCode ? [query.branchCode] : Object.values(BranchCode);
    const days: CoverageDay[] = [];
    for (let index = 0; index < rangeDays; index += 1) {
      const date = toDateOnly(new Date(from.getTime() + index * 86_400_000));
      days.push(combineCoverageDays(date, branchCodes.map((branchCode) => {
        const key = `${date}:${branchCode}`;
        return projectCoverageDay(date, visitMap.get(key) ?? [], sweepMap.get(key) ?? null);
      })));
    }

    let coveredThrough: string | null = null;
    for (const day of days) {
      if (day.state !== 'COVERED_PUBLISHED' && day.state !== 'NOTHING_DUE') break;
      coveredThrough = day.date;
    }
    return {
      windowStart: query.from,
      windowEnd: query.to,
      branchCode: query.branchCode ?? null,
      coveredThrough,
      fullyPublished: coveredThrough === query.to,
      boundaryDay: days[days.length - 1],
      days,
    };
  }
}

function toFact(visit: VisitRow): CoverageVisitFact {
  const published = visit.assignments.some((row) => LIVE_DISPATCH.includes(row.status));
  return {
    id: visit.id,
    published,
    prepared: visit.assignments.some((row) => PREPARED.includes(row.status)),
    // An earlier run's reason may remain after a valid assignment publishes.
    reasonCodes: published ? [] : visit.unassignedReasons.map((reason) => reason.code),
  };
}

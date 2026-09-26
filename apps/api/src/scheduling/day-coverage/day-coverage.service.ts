import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BranchCode,
  DayCoverageState,
  Prisma,
  UserRole,
} from '@prisma/client';

import { AuthenticatedUser } from '../../auth/auth.types';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  coverageDrift,
  demandDigest,
  supplyDigest,
} from './coverage-digest';
import {
  assignmentsOnDayWhere,
  demandAgreementsWhere,
  dueVisitsWhere,
} from './due-set';
import {
  type CivilDate,
  civilDateInZone,
  coverageHorizon,
  replenishmentTarget,
} from './rolling-window';
import {
  type GuardVerdict,
  evaluateDueSet,
} from './publication-guard';

/**
 * Daily replenishment of the rolling 30-day window (ULK-C13).
 *
 * ## What it does, and what it refuses to do
 *
 * Prepares the day that is about to roll into the manager's window, and
 * publishes it **only** when the whole due set is valid and the existing
 * publication gate is READY on confirmed provenance. Otherwise it publishes
 * nothing, records the state, and leaves the day for a manager.
 *
 * It never supplies `acknowledgePartial` or `acknowledgeProvenance`, and
 * never a synthetic reason. Those are a manager's judgement and a machine
 * asserting them would hollow out the gate rather than pass it. On today's
 * data that means every day carrying work resolves to
 * PREPARED_AWAITING_MANAGER — no site branch or service window in the
 * database is confirmed — which is the approved policy working, not failing.
 *
 * ## Staffing is a port
 *
 * The solve is reached through {@link DayStaffingPort} rather than by calling
 * the optimizer directly. The real adapter delegates to `ScheduleRunService`;
 * a test supplies a stub. That keeps the state machine, the claim and the
 * all-or-nothing decision testable against a real PostgreSQL without a
 * running Python solver, so a failure in these tests is about this service
 * rather than about a dependency that did not start.
 *
 * ## Not scheduled
 *
 * No repeatable job is registered anywhere for this service. Preparing the
 * window automatically is a deployment decision that is explicitly held until
 * review and release approval, so the capability exists and nothing invokes
 * it unattended.
 */

/** The actor an unattended replenishment runs as. Mirrors the horizon sweep's. */
export const DAY_COVERAGE_SYSTEM_ACTOR: AuthenticatedUser = {
  id: '00000000-0000-0000-0000-000000000002',
  email: 'rolling-coverage@ultrakil.internal',
  fullName: 'Rolling Coverage Replenishment',
  role: UserRole.ADMIN,
};

/** How long a claim on a branch-day is held before another attempt may take it. */
export const CLAIM_LEASE_SECONDS = 15 * 60;

export const DAY_STAFFING_PORT = Symbol('DAY_STAFFING_PORT');

export interface StaffedDay {
  scheduleRunId: string;
  assignments: readonly {
    id: string;
    generatedVisitId: string;
    crewEmployeeIds: readonly string[];
    vehicleIds: readonly string[];
  }[];
  /** True when the run finished cleanly; false means the day is FAILED. */
  succeeded: boolean;
}

export interface DayStaffingPort {
  staffDay(input: {
    branchCode: BranchCode;
    date: CivilDate;
    actor: AuthenticatedUser;
  }): Promise<StaffedDay>;

  /**
   * Whether this run may publish without a manager: the existing readiness
   * gate, READY only on confirmed provenance with nothing unassigned.
   */
  isPublishableWithoutManager(scheduleRunId: string): Promise<boolean>;

  /** Publishes with no acknowledgement and no reason. Both are a manager's to give. */
  publish(scheduleRunId: string, actor: AuthenticatedUser): Promise<void>;
}

export interface CoverageOutcome {
  branchCode: BranchCode;
  coverageDate: CivilDate;
  state: DayCoverageState;
  visitsDue: number;
  visitsStaffed: number;
  /** Absent when another attempt held the claim and this one stood aside. */
  skipped?: 'ALREADY_CLAIMED';
}

const asDate = (date: CivilDate): Date => new Date(`${date}T00:00:00.000Z`);

@Injectable()
export class DayCoverageService {
  private readonly logger = new Logger(DayCoverageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(DAY_STAFFING_PORT) private readonly staffing: DayStaffingPort,
  ) {}

  /**
   * Prepares the boundary day for every branch.
   *
   * `now` and `zone` are injectable so the boundary can be tested either side
   * of local midnight without waiting for it.
   */
  async replenish(options: {
    now?: Date;
    zone?: string;
    branches?: readonly BranchCode[];
    actor?: AuthenticatedUser;
  } = {}): Promise<CoverageOutcome[]> {
    const zone = options.zone ?? process.env.TZ ?? 'Asia/Colombo';
    const today = civilDateInZone(options.now ?? new Date(), zone);
    const target = replenishmentTarget(today);
    const actor = options.actor ?? DAY_COVERAGE_SYSTEM_ACTOR;
    const branches = options.branches ?? Object.values(BranchCode);

    const outcomes: CoverageOutcome[] = [];
    for (const branchCode of branches) {
      // One branch's difficult day is not a reason the others never get their
      // turn — the same reasoning the horizon sweep already applies.
      try {
        outcomes.push(await this.prepareDay(branchCode, target, actor));
      } catch (error) {
        this.logger.error(
          `Replenishment failed for ${branchCode} on ${target}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        outcomes.push(await this.markFailed(branchCode, target));
      }
    }
    return outcomes;
  }

  /**
   * Claims one branch-day and prepares it.
   *
   * The claim is an insert against the unique `(branchCode, coverageDate)`
   * index, not a status read followed by a write: two replenishers racing the
   * same day both insert, exactly one wins, and the loser stands aside
   * without having read a stale status in between.
   */
  async prepareDay(
    branchCode: BranchCode,
    date: CivilDate,
    actor: AuthenticatedUser = DAY_COVERAGE_SYSTEM_ACTOR,
  ): Promise<CoverageOutcome> {
    const claim = await this.claim(branchCode, date);
    if (!claim) {
      return {
        branchCode,
        coverageDate: date,
        state: DayCoverageState.IN_PROGRESS,
        visitsDue: 0,
        visitsStaffed: 0,
        skipped: 'ALREADY_CLAIMED',
      };
    }

    const day = asDate(date);
    const due = await this.prisma.generatedVisit.findMany({
      where: dueVisitsWhere(branchCode, day),
      select: { id: true, requiredCrewSize: true },
    });

    const digests = await this.digestsFor(branchCode, day);

    if (due.length === 0) {
      return this.resolve(claim.id, {
        branchCode,
        date,
        state: DayCoverageState.NOTHING_DUE,
        visitsDue: 0,
        visitsStaffed: 0,
        digests,
        actor,
      });
    }

    const staffed = await this.staffing.staffDay({ branchCode, date, actor });
    if (!staffed.succeeded) {
      return this.resolve(claim.id, {
        branchCode,
        date,
        state: DayCoverageState.FAILED,
        visitsDue: due.length,
        visitsStaffed: 0,
        scheduleRunId: staffed.scheduleRunId,
        digests,
        actor,
      });
    }

    const verdict = await this.judge(branchCode, day, due, staffed);

    if (verdict.decision === 'WITHHOLD') {
      return this.resolve(claim.id, {
        branchCode,
        date,
        state: DayCoverageState.SHORTFALL,
        visitsDue: verdict.visitsDue,
        visitsStaffed: verdict.visitsStaffed,
        scheduleRunId: staffed.scheduleRunId,
        shortfalls: verdict.shortfalls,
        digests: await this.digestsFor(branchCode, day),
        actor,
      });
    }

    // Every due visit is satisfiable. Whether that publishes itself is the
    // existing gate's call, not this one's, and it will say no whenever the
    // source data behind the day is still unconfirmed.
    const publishable = await this.staffing.isPublishableWithoutManager(
      staffed.scheduleRunId,
    );
    if (publishable) {
      await this.staffing.publish(staffed.scheduleRunId, actor);
    }

    return this.resolve(claim.id, {
      branchCode,
      date,
      state: publishable
        ? DayCoverageState.COVERED_PUBLISHED
        : DayCoverageState.PREPARED_AWAITING_MANAGER,
      visitsDue: verdict.visitsDue,
      visitsStaffed: verdict.visitsStaffed,
      scheduleRunId: staffed.scheduleRunId,
      digests: await this.digestsFor(branchCode, day),
      actor,
    });
  }

  /**
   * Re-checks resolved days across the horizon and marks the drifted ones
   * STALE.
   *
   * This is what stops a coverage row meaning "finished forever". A day can
   * be perfectly staffed and then stop being covered because an agreement was
   * created or edited onto it, or because a visit or assignment changed
   * underneath. Neither is visible from the row itself, only from comparing
   * the fingerprints it was resolved against.
   *
   * Days IN_PROGRESS are left alone: an attempt that has not finished is
   * unfinished, not stale, and those are two different repairs.
   */
  async reconcile(options: { now?: Date; zone?: string } = {}): Promise<
    { branchCode: BranchCode; coverageDate: CivilDate; drift: string }[]
  > {
    const zone = options.zone ?? process.env.TZ ?? 'Asia/Colombo';
    const today = civilDateInZone(options.now ?? new Date(), zone);
    const horizon = coverageHorizon(today);

    const rows = await this.prisma.dayCoverage.findMany({
      where: {
        coverageDate: { in: horizon.map(asDate) },
        state: {
          in: [
            DayCoverageState.NOTHING_DUE,
            DayCoverageState.COVERED_PUBLISHED,
            DayCoverageState.PREPARED_AWAITING_MANAGER,
            DayCoverageState.SHORTFALL,
          ],
        },
      },
    });

    const stale: { branchCode: BranchCode; coverageDate: CivilDate; drift: string }[] =
      [];

    for (const row of rows) {
      const date = row.coverageDate.toISOString().slice(0, 10);
      const current = await this.digestsFor(row.branchCode, row.coverageDate);
      const drift = coverageDrift(
        { demandDigest: row.demandDigest, supplyDigest: row.supplyDigest },
        current,
      );
      if (!drift) continue;

      await this.prisma.dayCoverage.update({
        where: { id: row.id },
        data: { state: DayCoverageState.STALE },
      });
      await this.audit.record({
        entityType: 'DayCoverage',
        entityId: row.id,
        action: 'day_coverage.stale',
        actor: DAY_COVERAGE_SYSTEM_ACTOR,
        before: { state: row.state },
        after: { state: DayCoverageState.STALE, drift },
      });
      stale.push({ branchCode: row.branchCode, coverageDate: date, drift });
    }

    return stale;
  }

  /** Both fingerprints for one branch-day, read as they stand now. */
  async digestsFor(
    branchCode: BranchCode,
    day: Date,
  ): Promise<{ demandDigest: string; supplyDigest: string }> {
    const [agreements, visits, assignments] = await Promise.all([
      this.prisma.serviceAgreement.findMany({
        where: demandAgreementsWhere(branchCode, day),
        select: { id: true, currentVersion: true, updatedAt: true },
      }),
      this.prisma.generatedVisit.findMany({
        where: { branchCode, visitDate: day },
        select: { id: true, status: true, updatedAt: true },
      }),
      this.prisma.assignment.findMany({
        where: assignmentsOnDayWhere(branchCode, day),
        select: { id: true, status: true, updatedAt: true },
      }),
    ]);

    return {
      demandDigest: demandDigest(agreements),
      supplyDigest: supplyDigest({ visits, assignments }),
    };
  }

  /**
   * Takes the day, or returns null when another attempt holds it.
   *
   * One statement, so no window exists between deciding the day is free and
   * saying so.
   *
   * Three cases may take a day, and everything else is refused:
   *
   * - it has never been evaluated (the plain insert);
   * - it is STALE or FAILED, so a previous answer is known to be no longer
   *   good;
   * - it is IN_PROGRESS with an expired claim, meaning the worker holding it
   *   died — which is why the claim is a lease and not a flag.
   *
   * A day already *resolved* is not re-prepared, and that is the whole
   * idempotency guarantee. An earlier version refused only days currently
   * IN_PROGRESS, which let a second replenisher redo a day the first had just
   * finished — two solves and a possible double publication for one day. The
   * forced two-connection race in `day-coverage-worker.spec.ts` is what
   * caught it. A resolved day becomes eligible again only when reconciliation
   * marks it STALE, which is the one thing that knows the answer has gone
   * out of date.
   */
  private async claim(
    branchCode: BranchCode,
    date: CivilDate,
  ): Promise<{ id: string } | null> {
    const expires = new Date(Date.now() + CLAIM_LEASE_SECONDS * 1000);
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO day_coverage ("id", "branchCode", "coverageDate", "state",
                                "claimedAt", "claimExpiresAt", "attempt",
                                "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${branchCode}::"BranchCode", ${date}::date,
              'IN_PROGRESS', now(), ${expires}, 1, now(), now())
      ON CONFLICT ("branchCode", "coverageDate") DO UPDATE
        SET "state" = 'IN_PROGRESS',
            "claimedAt" = now(),
            "claimExpiresAt" = ${expires},
            "attempt" = day_coverage."attempt" + 1,
            "updatedAt" = now()
        WHERE day_coverage."state" IN ('STALE', 'FAILED')
           OR (day_coverage."state" = 'IN_PROGRESS'
               AND day_coverage."claimExpiresAt" < now())
      RETURNING "id"
    `;
    return rows[0] ?? null;
  }

  private async judge(
    branchCode: BranchCode,
    day: Date,
    due: readonly { id: string; requiredCrewSize: number }[],
    staffed: StaffedDay,
  ): Promise<GuardVerdict> {
    const vehicleIds = staffed.assignments.flatMap((a) => [...a.vehicleIds]);
    const [vehicles, authorizations] = await Promise.all([
      this.prisma.vehicle.findMany({
        where: { id: { in: vehicleIds } },
        select: { id: true, seatCapacity: true },
      }),
      this.prisma.vehicleAuthorization.findMany({
        where: { vehicleId: { in: vehicleIds } },
        select: { vehicleId: true, employeeId: true },
      }),
    ]);

    const authorizedDrivers = new Map<string, Set<string>>();
    for (const row of authorizations) {
      const set = authorizedDrivers.get(row.vehicleId) ?? new Set<string>();
      set.add(row.employeeId);
      authorizedDrivers.set(row.vehicleId, set);
    }

    return evaluateDueSet({
      dueVisits: due,
      assignments: staffed.assignments,
      vehicles: new Map(
        vehicles.map((v) => [v.id, { seats: v.seatCapacity ?? null }]),
      ),
      authorizedDrivers,
    });
  }

  /** Writes the outcome and its shortfalls in one transaction. */
  private async resolve(
    coverageId: string,
    input: {
      branchCode: BranchCode;
      date: CivilDate;
      state: DayCoverageState;
      visitsDue: number;
      visitsStaffed: number;
      scheduleRunId?: string;
      shortfalls?: readonly {
        generatedVisitId: string;
        code: string;
        message: string;
      }[];
      digests: { demandDigest: string; supplyDigest: string };
      actor: AuthenticatedUser;
    },
  ): Promise<CoverageOutcome> {
    await this.prisma.$transaction(async (tx) => {
      // A re-attempt of a day that previously fell short must not inherit the
      // old reasons; they described a state that no longer exists.
      await tx.dayCoverageShortfall.deleteMany({
        where: { dayCoverageId: coverageId },
      });

      await tx.dayCoverage.update({
        where: { id: coverageId },
        data: {
          state: input.state,
          visitsDue: input.visitsDue,
          visitsStaffed: input.visitsStaffed,
          scheduleRunId: input.scheduleRunId ?? null,
          demandDigest: input.digests.demandDigest,
          supplyDigest: input.digests.supplyDigest,
          resolvedAt: new Date(),
          shortfalls: input.shortfalls?.length
            ? {
                create: input.shortfalls.map((s) => ({
                  generatedVisitId: s.generatedVisitId,
                  reasonCode: s.code,
                  message: s.message,
                })),
              }
            : undefined,
        },
      });

      await this.audit.record(
        {
          entityType: 'DayCoverage',
          entityId: coverageId,
          action: 'day_coverage.resolved',
          actor: input.actor,
          before: null,
          after: {
            branchCode: input.branchCode,
            coverageDate: input.date,
            state: input.state,
            visitsDue: input.visitsDue,
            visitsStaffed: input.visitsStaffed,
            shortfalls: input.shortfalls?.length ?? 0,
          } as Prisma.InputJsonValue,
        },
        tx,
      );
    });

    return {
      branchCode: input.branchCode,
      coverageDate: input.date,
      state: input.state,
      visitsDue: input.visitsDue,
      visitsStaffed: input.visitsStaffed,
    };
  }

  private async markFailed(
    branchCode: BranchCode,
    date: CivilDate,
  ): Promise<CoverageOutcome> {
    await this.prisma.dayCoverage.updateMany({
      where: { branchCode, coverageDate: asDate(date) },
      data: { state: DayCoverageState.FAILED, resolvedAt: new Date() },
    });
    return {
      branchCode,
      coverageDate: date,
      state: DayCoverageState.FAILED,
      visitsDue: 0,
      visitsStaffed: 0,
    };
  }
}

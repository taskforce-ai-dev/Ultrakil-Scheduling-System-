import {
  AgreementStatus,
  AssignmentStatus,
  BranchCode,
  Prisma,
  VisitStatus,
} from '@prisma/client';

/**
 * What is *due* on one branch-day, and what bears on it.
 *
 * ## Excluded by predicate, not by trust
 *
 * Published, acknowledged, in-progress, completed, locked and manually
 * adjusted work is filtered out here, in the `where`, rather than left to the
 * solver to leave alone. The difference matters: a predicate that excludes
 * protected work cannot fail open, whereas "the optimizer does not usually
 * touch published visits" is a property nobody re-checks after the next
 * change to the optimizer. ULK-C13 requires published, locked and manual work
 * to be preserved, so it is preserved by never being selected.
 *
 * ## LIVE
 *
 * A visit already carrying a live assignment is not due. LIVE is
 * PUBLISHED, ACKNOWLEDGED, IN_PROGRESS or COMPLETED — the same four statuses
 * the ULK-C12 audits used, so the job's idea of "already staffed" matches the
 * evidence already on the record. DRAFT and PROPOSED are deliberately *not*
 * live: a prepared-but-unpublished day must remain due, or a second run would
 * decide the day was finished when nothing had been published. This is the
 * same trap `CalendarService` falls into by including DRAFT and PROPOSED in
 * its own status list.
 */

/** The assignment statuses that mean a visit is really staffed. */
export const LIVE_ASSIGNMENT_STATUSES = [
  AssignmentStatus.PUBLISHED,
  AssignmentStatus.ACKNOWLEDGED,
  AssignmentStatus.IN_PROGRESS,
  AssignmentStatus.COMPLETED,
] as const;

/**
 * Statuses a visit may hold and still be waiting for a crew.
 *
 * SCHEDULED is absent on purpose: the optimizer sets it when a visit has been
 * placed, so a SCHEDULED visit without a live assignment is a draft awaiting
 * publication, which the live-assignment test below handles on its own terms.
 */
export const DUE_VISIT_STATUSES = [
  VisitStatus.PENDING,
  VisitStatus.UNASSIGNED,
  VisitStatus.SCHEDULED,
] as const;

/**
 * Visits due on `date` in `branchCode`.
 *
 * `date` is a civil date resolved through `civilDateInZone`, never
 * `toDateOnly`, and is passed as a `Date` at UTC midnight because
 * `GeneratedVisit.visitDate` is a `@db.Date` column.
 */
export function dueVisitsWhere(
  branchCode: BranchCode,
  date: Date,
): Prisma.GeneratedVisitWhereInput {
  return {
    branchCode,
    visitDate: date,
    status: { in: [...DUE_VISIT_STATUSES] },

    // Protected work, excluded rather than relied upon to be left alone.
    isManuallyAdjusted: false,
    lockedAt: null,

    // A visit whose agreement is paused, archived or ended is not demand.
    serviceAgreement: {
      status: AgreementStatus.ACTIVE,
      OR: [{ endDate: null }, { endDate: { gte: date } }],
      serviceSite: {
        isActive: true,
        customer: { isActive: true },
      },
    },

    // Already really staffed. DRAFT and PROPOSED do not count.
    assignments: {
      none: { status: { in: [...LIVE_ASSIGNMENT_STATUSES] } },
    },
  };
}

/**
 * Agreements that could place work on `date` in `branchCode`.
 *
 * Deliberately independent of whether any visit exists yet — that is the
 * whole point. A new agreement creates demand for a date the moment it is
 * active over that date, and generation may not have run since. Fingerprinting
 * this set is how a resolved day notices demand that has no visit id to hash.
 */
export function demandAgreementsWhere(
  branchCode: BranchCode,
  date: Date,
): Prisma.ServiceAgreementWhereInput {
  return {
    branchCode,
    status: AgreementStatus.ACTIVE,
    startDate: { lte: date },
    OR: [{ endDate: null }, { endDate: { gte: date } }],
    serviceSite: {
      isActive: true,
      customer: { isActive: true },
    },
  };
}

/**
 * Assignments standing on `date` in `branchCode`, whatever their status.
 *
 * Unfiltered by status on purpose: this feeds `supplyDigest`, which must
 * notice a draft appearing, a publication happening and a supersession
 * equally. Filtering to live here would blind the fingerprint to exactly the
 * transitions it exists to catch.
 */
export function assignmentsOnDayWhere(
  branchCode: BranchCode,
  date: Date,
): Prisma.AssignmentWhereInput {
  return {
    branchCode,
    generatedVisit: { visitDate: date },
  };
}

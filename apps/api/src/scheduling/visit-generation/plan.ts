import { BranchCode, DataProvenance, VisitPlacement } from '@prisma/client';

import { PreviewAlternative } from '../../catalog/schedule-preview';

/**
 * Decides what a generation run would change, before anything is written.
 *
 * The task's governing rule is that generation must never silently delete
 * work. Everything here exists to honour that: the planner compares what the
 * agreements now require against what is already in the calendar, and sorts
 * every difference into one of five buckets. A manager sees the whole set and
 * confirms it; nothing is applied on a guess.
 *
 * The distinction that matters is *protection*. A visit nobody has touched is
 * the system's to move or drop. A visit a manager has scheduled, edited,
 * locked or completed belongs to them — regeneration reports it and leaves it
 * exactly as it is, even when the agreement now says something different.
 */

/** A visit the agreements require on a given date. */
export interface RequiredVisit {
  serviceAgreementId: string;
  /** YYYY-MM-DD. */
  visitDate: string;
  windowStartMinute: number;
  windowEndMinute: number;
  durationMinutes: number;
  requiredCrewSize: number;
  /**
   * Skill codes the agreement requires. Carried on the requirement itself so
   * placement can ask whether the branch has anyone holding them that day —
   * a question the crew-minutes cap cannot express.
   */
  requiredSkillCodes: string[];
  branchCode: BranchCode;
  /** The agreement version this requirement came from. */
  agreementVersionId: string | null;
  windowProvenance?: DataProvenance;
  isPreferredDay: boolean;
  /** Why this date: a customer booking, an anchor, a spread, or the earliest. */
  placement: VisitPlacement;
  /**
   * Which cycle of the agreement's horizon this visit belongs to. The load
   * guard may only move a visit within its own period — a month's visit
   * pushed into the next month is a different commitment.
   */
  periodIndex: number;
  /** The other days of the same period this visit could sit on. */
  alternatives: PreviewAlternative[];
  /**
   * The day this requirement was planned onto before a protected visit
   * claimed its period, when the two differ.
   *
   * Pinning is what stops a re-planned period becoming one addition and one
   * refused removal. It must not also make the difference invisible: a visit
   * a manager holds on a weekday the agreement no longer allows would
   * otherwise read as "unchanged", and nobody would ever move it.
   */
  pinnedFrom?: string;
}

/** A visit already in the calendar. */
export interface ExistingVisit {
  id: string;
  /** Internal optimistic fence; never part of the impact DTO. */
  updatedAt: Date;
  serviceAgreementId: string;
  visitDate: string;
  windowStartMinute: number;
  windowEndMinute: number;
  durationMinutes: number;
  requiredCrewSize: number;
  status: string;
  placement: VisitPlacement;
  isManuallyAdjusted: boolean;
  isLocked: boolean;
  hasAssignments: boolean;
}

export type ProtectionReason =
  | 'LOCKED'
  | 'MANUALLY_ADJUSTED'
  | 'HAS_ASSIGNMENT'
  | 'ALREADY_SCHEDULED'
  | 'ALREADY_COMPLETED'
  | 'CANCELLED';

/**
 * Statuses whose visits are the manager's, not the generator's.
 *
 * PENDING is freshly generated and untouched. UNASSIGNED means the scheduler
 * tried and could not staff it — still the system's own output, so it may be
 * replaced. Everything else represents a decision someone made.
 */
const PROTECTED_STATUSES: Record<string, ProtectionReason> = {
  SCHEDULED: 'ALREADY_SCHEDULED',
  COMPLETED: 'ALREADY_COMPLETED',
  CANCELLED: 'CANCELLED',
};

/** The handful of fields protection actually turns on. */
export type ProtectableVisit = Pick<
  ExistingVisit,
  'status' | 'isManuallyAdjusted' | 'isLocked' | 'hasAssignments'
>;

/** Why this visit cannot be touched, or null when it can. */
export function protectionReasonFor(
  visit: ProtectableVisit,
): ProtectionReason | null {
  if (visit.isLocked) return 'LOCKED';
  if (visit.isManuallyAdjusted) return 'MANUALLY_ADJUSTED';
  if (PROTECTED_STATUSES[visit.status]) return PROTECTED_STATUSES[visit.status];
  // An assignment can exist while the visit is still PENDING, mid-draft.
  if (visit.hasAssignments) return 'HAS_ASSIGNMENT';
  return null;
}

export interface PlannedAddition {
  required: RequiredVisit;
}

export interface PlannedUpdate {
  visitId: string;
  expectedUpdatedAt: Date;
  required: RequiredVisit;
  /** Field-by-field, so a manager can see exactly what would move. */
  changes: { field: string; from: number | string; to: number | string }[];
}

export interface PlannedRemoval {
  visitId: string;
  expectedUpdatedAt: Date;
  serviceAgreementId: string;
  visitDate: string;
  /** Why the agreement no longer asks for it. */
  reason: 'NO_LONGER_REQUIRED';
}

export interface ProtectedVisit {
  visitId: string;
  serviceAgreementId: string;
  visitDate: string;
  protection: ProtectionReason;
  /** What generation would have done, had the visit not been protected. */
  wouldHave: 'UPDATE' | 'REMOVE';
  changes?: { field: string; from: number | string; to: number | string }[];
}

export interface GenerationPlan {
  additions: PlannedAddition[];
  updates: PlannedUpdate[];
  removals: PlannedRemoval[];
  /** Left exactly as they are, and reported so nobody is surprised. */
  protectedVisits: ProtectedVisit[];
  unchangedCount: number;
}

/** One visit is the same as another when its date and start time match. */
function keyOf(serviceAgreementId: string, visitDate: string, windowStartMinute: number): string {
  return `${serviceAgreementId}|${visitDate}|${windowStartMinute}`;
}

function diff(
  existing: ExistingVisit,
  required: RequiredVisit,
): { field: string; from: number | string; to: number | string }[] {
  const changes: { field: string; from: number | string; to: number | string }[] = [];

  if (existing.windowEndMinute !== required.windowEndMinute) {
    changes.push({
      field: 'windowEndMinute',
      from: existing.windowEndMinute,
      to: required.windowEndMinute,
    });
  }
  if (existing.durationMinutes !== required.durationMinutes) {
    changes.push({
      field: 'durationMinutes',
      from: existing.durationMinutes,
      to: required.durationMinutes,
    });
  }
  if (existing.requiredCrewSize !== required.requiredCrewSize) {
    changes.push({
      field: 'requiredCrewSize',
      from: existing.requiredCrewSize,
      to: required.requiredCrewSize,
    });
  }
  // Placement is only an explanation, but a stale one explains the visit
  // wrongly — and a manager who cannot trust the label will not read it.
  if (existing.placement !== required.placement) {
    changes.push({
      field: 'placement',
      from: existing.placement,
      to: required.placement,
    });
  }

  return changes;
}

/**
 * Works out the difference between what is required and what exists.
 *
 * Both lists must already be limited to the same agreements and the same date
 * range, or a visit outside the window would look obsolete and be proposed for
 * removal.
 */
export function planGeneration(
  required: RequiredVisit[],
  existing: ExistingVisit[],
): GenerationPlan {
  const plan: GenerationPlan = {
    additions: [],
    updates: [],
    removals: [],
    protectedVisits: [],
    unchangedCount: 0,
  };

  const existingByKey = new Map<string, ExistingVisit>();
  for (const visit of existing) {
    existingByKey.set(
      keyOf(visit.serviceAgreementId, visit.visitDate, visit.windowStartMinute),
      visit,
    );
  }

  const matchedIds = new Set<string>();

  for (const want of required) {
    const key = keyOf(want.serviceAgreementId, want.visitDate, want.windowStartMinute);
    const found = existingByKey.get(key);

    if (!found) {
      plan.additions.push({ required: want });
      continue;
    }

    matchedIds.add(found.id);
    const changes = diff(found, want);
    const protection = protectionReasonFor(found);

    if (protection) {
      // The day generation had chosen, before this visit's protection pinned
      // the period to the manager's day. Added here rather than in `diff`
      // because it is only ever reported: an ordinary update would pick it up
      // and promise a move that nothing performs.
      if (want.pinnedFrom && want.pinnedFrom !== found.visitDate) {
        changes.unshift({
          field: 'visitDate',
          from: found.visitDate,
          to: want.pinnedFrom,
        });
      }

      if (changes.length === 0) {
        plan.unchangedCount += 1;
        continue;
      }

      plan.protectedVisits.push({
        visitId: found.id,
        serviceAgreementId: found.serviceAgreementId,
        visitDate: found.visitDate,
        protection,
        wouldHave: 'UPDATE',
        changes,
      });
      continue;
    }

    if (changes.length === 0) {
      plan.unchangedCount += 1;
      continue;
    }

    plan.updates.push({ visitId: found.id, expectedUpdatedAt: found.updatedAt, required: want, changes });
  }

  // Anything left over is no longer required by the agreement.
  for (const visit of existing) {
    if (matchedIds.has(visit.id)) continue;

    const protection = protectionReasonFor(visit);
    if (protection) {
      plan.protectedVisits.push({
        visitId: visit.id,
        serviceAgreementId: visit.serviceAgreementId,
        visitDate: visit.visitDate,
        protection,
        wouldHave: 'REMOVE',
      });
      continue;
    }

    plan.removals.push({
      visitId: visit.id,
      expectedUpdatedAt: visit.updatedAt,
      serviceAgreementId: visit.serviceAgreementId,
      visitDate: visit.visitDate,
      reason: 'NO_LONGER_REQUIRED',
    });
  }

  return plan;
}

/** True when applying this plan would change nothing. */
export function planIsEmpty(plan: GenerationPlan): boolean {
  return (
    plan.additions.length === 0 &&
    plan.updates.length === 0 &&
    plan.removals.length === 0
  );
}

import { HttpStatus } from '@nestjs/common';
import { AssignmentStatus, Prisma } from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';

/** Compare the exact plan/solve revision only after acquiring the visit lock. */
export function assertVisitRevision(visitId: string, expected: Date, current: Date) {
  if (expected.getTime() !== current.getTime()) {
    throw new AppException(
      'RESOURCE_CONFLICT',
      'A visit changed while this schedule was being prepared. Refresh and try again.',
      HttpStatus.CONFLICT,
      { visitId },
    );
  }
}

/** All schedule writers lock visits before changing visits or assignments. */
export async function lockScheduleVisits(
  tx: Prisma.TransactionClient,
  visitIds: string[],
) {
  const ids = [...new Set(visitIds)].sort();
  if (ids.length === 0) return;

  // The visit exists even when the solve snapshot contains no assignment.
  // A shared parent-row lock therefore fences creation as well as replacement.
  const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM generated_visits
    WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY id
    FOR UPDATE
  `);
  if (locked.length !== ids.length) {
    throw new AppException(
      'RESOURCE_CONFLICT',
      'One or more visits changed while the schedule was being prepared. Refresh and try again.',
      HttpStatus.CONFLICT,
      { visitIds: ids },
    );
  }
}

/**
 * Generated-visit uniqueness is scoped by agreement.  Lock these parents in
 * the same sorted order in every writer before changing a date/start key so
 * concurrent solver results cannot both create the same sibling slot.
 */
export async function lockScheduleAgreements(
  tx: Prisma.TransactionClient,
  agreementIds: string[],
) {
  const ids = [...new Set(agreementIds)].sort();
  if (ids.length === 0) return;

  const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM service_agreements
    WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY id
    FOR UPDATE
  `);
  if (locked.length !== ids.length) {
    throw new AppException(
      'RESOURCE_CONFLICT',
      'One or more agreements changed while the schedule was being prepared. Refresh and try again.',
      HttpStatus.CONFLICT,
      { agreementIds: ids },
    );
  }
}

const PUBLISHED_HISTORY: AssignmentStatus[] = [
  AssignmentStatus.PUBLISHED,
  AssignmentStatus.ACKNOWLEDGED,
  AssignmentStatus.IN_PROGRESS,
  AssignmentStatus.COMPLETED,
  AssignmentStatus.SUPERSEDED,
];

type PublicationHistoryAssignment = {
  status: AssignmentStatus;
  publishedAt: Date | null;
  _count: { notificationOutboxEntries: number };
};

/** Publication is lineage, not only a current status. */
export function isPublicationHistory(
  assignment: PublicationHistoryAssignment,
) {
  return (
    PUBLISHED_HISTORY.includes(assignment.status) ||
    assignment.publishedAt !== null ||
    assignment._count.notificationOutboxEntries > 0
  );
}

/** A direct assignment writer must guard its target after taking the visit lock. */
export function assertUnpublishedAssignment(
  assignmentId: string,
  assignment: PublicationHistoryAssignment,
) {
  if (isPublicationHistory(assignment)) {
    throw new AppException(
      'RESOURCE_CONFLICT',
      'This assignment is part of a published schedule and cannot be changed. The published schedule is kept as a record.',
      HttpStatus.CONFLICT,
      { assignmentId },
    );
  }
}

/** Inspect publication history. Writers hold the visit lock; dry-run readers
 * get a point-in-time check and must revalidate before writing. */
export async function assertUnpublishedVisit(
  tx: Prisma.TransactionClient,
  visitId: string,
) {
  const assignments = await tx.assignment.findMany({
    where: { generatedVisitId: visitId },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      status: true,
      publishedAt: true,
      _count: { select: { notificationOutboxEntries: true } },
    },
  });
  if (assignments.some(isPublicationHistory)) {
    throw new AppException(
      'RESOURCE_CONFLICT',
      'This visit is part of a published schedule and cannot be changed. The published schedule is kept as a record.',
      HttpStatus.CONFLICT,
      { visitId },
    );
  }
  return assignments.filter(
    (assignment) =>
      assignment.status === AssignmentStatus.DRAFT ||
      assignment.status === AssignmentStatus.PROPOSED,
  );
}

/** The caller holds the visit lock, including when the expected snapshot is empty. */
export async function assertScheduleSnapshot(
  tx: Prisma.TransactionClient,
  visitId: string,
  assignmentId?: string,
) {
  const current = await assertUnpublishedVisit(tx, visitId);
  if (
    assignmentId
      ? current.length !== 1 || current[0].id !== assignmentId
      : current.length !== 0
  ) {
    throw new AppException(
      'RESOURCE_CONFLICT',
      'An assignment changed while this schedule was being prepared. Refresh and try again.',
      HttpStatus.CONFLICT,
      { visitId, assignmentId },
    );
  }
}

import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AppException } from '../errors/app.exception';

/**
 * The one order agreement rows are ever locked in: **ascending id**.
 *
 * This lives in `common` rather than beside one of its callers on purpose. It
 * is not the scheduler's rule or the importer's rule; it is the database's,
 * and every writer that may touch more than one `service_agreements` row at a
 * time has to keep it. Three do today — the optimizer's `persistResult`,
 * generation's `apply`, and the workbook importer — and they arrived at it the
 * hard way, one deadlock at a time:
 *
 * - the importer updated a customer's agreements in **workbook order**, which
 *   is whatever order a spreadsheet kept by hand happens to list them in. A
 *   generation confirm adding visits for two of the same customer's
 *   agreements locked the lower id and waited for the higher one; the importer
 *   held the higher one and then asked for the lower. Postgres said
 *   "deadlock detected. Process A waits for ShareLock on transaction …;
 *   Process B waits for ShareLock on transaction …" and killed one — which
 *   reached a manager as a 500 on Generate.
 *
 * Why id order rather than, say, customer-and-name: because it is total,
 * stable, and available without reading anything else. Two writers that have
 * never heard of each other can agree on it, which is the only property that
 * matters.
 *
 * ## Using it
 *
 * Take every agreement row the transaction will touch, in one call, **before**
 * touching any of them — an order kept only among the rows a writer happens to
 * lock first is not an order. Take it before the visit rows and before the
 * branch-day advisory locks, which is the sequence every schedule writer uses:
 * agreements, then visits, then resources, then branch-days.
 *
 * The lock is `FOR UPDATE`, the strongest row lock, for the same reason:
 * generated-visit uniqueness is scoped by agreement, so a writer changing a
 * visit's date/start key needs the parent held against a concurrent writer
 * creating the same sibling slot. A weaker lock would let two writers into the
 * same slot and turn a queue into a unique-constraint failure.
 */
export async function lockAgreementRows(
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
      'One or more agreements changed while this change was being prepared. Refresh and try again.',
      HttpStatus.CONFLICT,
      { agreementIds: ids },
    );
  }
}

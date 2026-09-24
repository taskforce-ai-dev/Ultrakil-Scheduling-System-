import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AppException } from '../errors/app.exception';

/**
 * Site-hours serialization point. Take site parents in ascending id order,
 * before reading or replacing their child opening-hour rows.
 *
 * Cross-table order for scheduling writers is agreements -> sites -> visits ->
 * employees/vehicles -> branch-days. The workbook importer keeps that same
 * agreement-before-site order even though it edits sites before agreements.
 * A site-only manager edit begins at the site step.
 */
export async function lockSiteRows(tx: Prisma.TransactionClient, siteIds: string[]) {
  const ids = [...new Set(siteIds)].sort();
  if (ids.length === 0) return;

  const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM service_sites
    WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY id
    FOR UPDATE
  `);
  if (locked.length !== ids.length) {
    throw new AppException(
      'RESOURCE_CONFLICT',
      'One or more sites changed while their opening hours were being checked. Refresh and try again.',
      HttpStatus.CONFLICT,
      { siteIds: ids },
    );
  }
}

import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';

/** All solver/publication writes lock visits before touching their assignments. */
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

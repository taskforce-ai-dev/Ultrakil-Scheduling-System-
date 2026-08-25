import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/auth.types';

/** Anything that can run a query — the client, or a transaction handle. */
export type PrismaLike = PrismaService | Prisma.TransactionClient | PrismaClient;

export interface AuditInput {
  entityType: string;
  entityId: string;
  /** Dotted verb, e.g. "employee.updated". Stable — clients may filter on it. */
  action: string;
  actor?: AuthenticatedUser | null;
  before?: unknown;
  after?: unknown;
  correlationId?: string | null;
}

/**
 * Append-only record of every change a manager makes.
 *
 * Written inside the same transaction as the change itself, so an audit entry
 * cannot exist for a change that was rolled back, and a change cannot land
 * without its entry. The task requires imported values edited by a manager to
 * keep before/after history; that only holds if the two are atomic.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditInput, tx?: PrismaLike): Promise<void> {
    const client = tx ?? this.prisma;

    await client.auditEvent.create({
      data: {
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        actorUserId: input.actor?.id ?? null,
        actorLabel: input.actor
          ? `${input.actor.fullName} <${input.actor.email}>`
          : null,
        before: toJson(input.before),
        after: toJson(input.after),
        correlationId: input.correlationId ?? null,
      },
    });
  }
}

/**
 * Prisma's Json column rejects `undefined` and does not know what to do with a
 * Date or a Decimal, both of which appear all over these models. Round-tripping
 * through JSON normalises them and keeps the audit trail readable.
 *
 * Absent values become SQL NULL (`DbNull`), not JSON null. On a creation there
 * is no "before", and that has to be distinguishable from a before whose value
 * genuinely was null — otherwise `before IS NOT NULL` answers every question
 * wrongly.
 */
function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === undefined || value === null) return Prisma.DbNull;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

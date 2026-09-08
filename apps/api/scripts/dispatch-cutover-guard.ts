import { Prisma, PrismaClient } from '@prisma/client';

type DispatchProvider = 'BULLMQ' | 'QSTASH';
type ActiveScheduleRun = { id: string; status: 'QUEUED' | 'RUNNING' };
type DispatchOutbox = { scheduleRunId: string; provider: DispatchProvider };
type DispatchCutoverOptions = { target: DispatchProvider; fresh: boolean };

export interface DispatchCutoverPrisma {
  scheduleRun: {
    findMany(args: {
      where: { status: { in: ['QUEUED', 'RUNNING'] } };
      select: { id: true; status: true };
      orderBy: { createdAt: 'asc' };
    }): Promise<ActiveScheduleRun[]>;
  };
  scheduleRunDispatchOutbox: {
    findMany(args: {
      where: { scheduleRunId: { in: string[] } };
      select: { scheduleRunId: true; provider: true };
    }): Promise<DispatchOutbox[]>;
  };
  $queryRaw<T>(query: Prisma.Sql): Promise<T>;
}

const TARGETS: Record<string, DispatchProvider> = {
  bullmq: 'BULLMQ',
  qstash: 'QSTASH',
};

/**
 * A provider switch must be explicitly named. Falling back to the process
 * environment could approve a BullMQ cutover when the operator meant QStash.
 */
export function parseCutoverOptions(args: string[]): DispatchCutoverOptions {
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
  const fresh = normalizedArgs.includes('--fresh');
  const targetArgument = normalizedArgs.find((arg) => arg.startsWith('--target='));
  const expectedArgumentCount = fresh ? 2 : 1;
  if (!targetArgument || normalizedArgs.length !== expectedArgumentCount) {
    throw new Error(
      'Use --target=qstash or --target=bullmq, with optional --fresh for a positively empty database.',
    );
  }

  const target = TARGETS[targetArgument.slice('--target='.length)];
  if (!target) {
    throw new Error(
      'Use --target=qstash or --target=bullmq, with optional --fresh for a positively empty database.',
    );
  }
  return { target, fresh };
}

async function confirmFreshDatabase(prisma: DispatchCutoverPrisma): Promise<void> {
  let rows: Array<{ has_user_tables: boolean }>;
  try {
    rows = await prisma.$queryRaw<Array<{ has_user_tables: boolean }>>(
      Prisma.sql`
        SELECT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_class AS relation
          INNER JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
          WHERE relation.relkind IN ('r', 'p')
            AND namespace.nspname = 'public'
        ) AS has_user_tables
      `,
    );
  } catch {
    throw new Error(
      'Fresh database guard could not verify that the target database is fresh. No change was made; inspect database access in a protected operator session.',
    );
  }

  if (rows.length !== 1 || typeof rows[0]?.has_user_tables !== 'boolean') {
    throw new Error(
      'Fresh database guard could not verify that the target database is fresh. No change was made; inspect database access in a protected operator session.',
    );
  }
  if (rows[0].has_user_tables) {
    throw new Error(
      'Fresh database guard blocked: the target public schema contains application tables. Do not run migrations as fresh; use the existing-database guard after maintenance instead.',
    );
  }
}

async function dispatchOutboxExists(prisma: DispatchCutoverPrisma): Promise<boolean> {
  try {
    const rows = await prisma.$queryRaw<Array<{ outbox_table: string | null }>>(
      Prisma.sql`SELECT to_regclass('public.schedule_run_dispatch_outbox') AS outbox_table`,
    );
    return Boolean(rows[0]?.outbox_table);
  } catch {
    throw new Error(
      'Dispatch cutover guard could not determine whether the dispatch outbox exists. No change was made; inspect database access in a protected operator session.',
    );
  }
}

/**
 * Read-only provider cutover gate. It deliberately makes no attempt to create
 * an outbox row for a legacy RUNNING run: only the original worker can settle
 * that run safely. Run this during maintenance, before migrations and routing
 * a new dispatcher-enabled API to the environment.
 */
export async function runDispatchCutoverGuard(
  prisma: DispatchCutoverPrisma,
  args: string[],
): Promise<string> {
  const { target, fresh } = parseCutoverOptions(args);
  if (fresh) {
    await confirmFreshDatabase(prisma);
    return `Fresh database guard passed for ${target}.`;
  }

  const activeRuns = await prisma.scheduleRun.findMany({
    where: { status: { in: ['QUEUED', 'RUNNING'] } },
    select: { id: true, status: true },
    orderBy: { createdAt: 'asc' },
  });

  if (activeRuns.length === 0) {
    return `Dispatch cutover guard passed for ${target}.`;
  }

  const violations = [`${activeRuns.length} schedule run(s) are QUEUED or RUNNING`];
  const runIds = activeRuns.map((run) => run.id);

  if (!(await dispatchOutboxExists(prisma))) {
    violations.push(`${activeRuns.length} active run(s) have no dispatch outbox`);
  } else {
    let outboxes: DispatchOutbox[];
    try {
      outboxes = await prisma.scheduleRunDispatchOutbox.findMany({
        where: { scheduleRunId: { in: runIds } },
        select: { scheduleRunId: true, provider: true },
      });
    } catch {
      throw new Error(
        'Dispatch cutover guard could not read active dispatch outboxes. No change was made; inspect database access in a protected operator session.',
      );
    }

    const byRunId = new Map(outboxes.map((outbox) => [outbox.scheduleRunId, outbox]));
    const missingOutbox = activeRuns.filter((run) => !byRunId.has(run.id));
    if (missingOutbox.length > 0) {
      violations.push(`${missingOutbox.length} active run(s) have no dispatch outbox`);
    }

    const wrongProvider = outboxes.filter((outbox) => outbox.provider !== target);
    if (wrongProvider.length > 0) {
      const providers = [...new Set(wrongProvider.map((outbox) => outbox.provider))].join(', ');
      violations.push(
        `${wrongProvider.length} active dispatch outbox row(s) use ${providers} instead of ${target}`,
      );
    }
  }

  throw new Error(
    `Dispatch cutover guard blocked: ${violations.join('; ')}. Drain or cancel the active work through the supported workflow and rerun this read-only guard; it never backfills RUNNING runs.`,
  );
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    console.log(
      await runDispatchCutoverGuard(
        prisma as unknown as DispatchCutoverPrisma,
        process.argv.slice(2),
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Dispatch cutover guard failed.');
    process.exitCode = 1;
  });
}

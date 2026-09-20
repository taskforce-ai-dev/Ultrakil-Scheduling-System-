/**
 * Count-only regression evidence: the workbook's own months against the
 * months this branch projects.
 *
 * The acceptance gate asks whether generation preserves what the master
 * schedule actually does — its monthly volume, how many days it spreads over,
 * and its busiest booked date — and whether the future it invents contains an
 * artificial pile-up. Both halves are answered here in counts alone: no
 * customer, site, employee or agreement is named or written out, so the
 * output is safe to paste into a review.
 *
 *   pnpm exec tsx scripts/projection-evidence.ts <from> <to>
 *
 * Reads the database as it stands. Run it after importing the real workbook;
 * the projection half calls the same `VisitGenerationService.confirm` the
 * portal's Generate Visits button does, so what is measured is the production
 * path rather than a reimplementation of it.
 */
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { HORIZON_EXTENSION_SYSTEM_ACTOR } from '../src/scheduling/visit-generation/horizon-extension.processor';
import { VisitGenerationService } from '../src/scheduling/visit-generation/visit-generation.service';

interface MonthRow {
  month: string;
  total: number;
  days: number;
  busiest: number;
}

function table(title: string, rows: MonthRow[]): void {
  process.stdout.write(`\n${title}\n`);
  process.stdout.write('  month      visits   days   busiest day\n');
  for (const row of rows) {
    process.stdout.write(
      `  ${row.month}   ${String(row.total).padStart(6)} ${String(row.days).padStart(6)} ${String(
        row.busiest,
      ).padStart(13)}\n`,
    );
  }
}

async function main(): Promise<void> {
  const from = process.argv[2];
  const to = process.argv[3];
  if (!from || !to) throw new Error('usage: projection-evidence.ts <from> <to>');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const prisma = app.get(PrismaService);
  const generation = app.get(VisitGenerationService);

  // --- Baseline: the dates the workbook itself books -----------------------
  const baseline = await prisma.$queryRawUnsafe<MonthRow[]>(`
    select to_char("bookedDate", 'YYYY-MM') as month,
           count(*)::int as total,
           count(distinct "bookedDate")::int as days,
           max(c)::int as busiest
      from (select "bookedDate", count(*) over (partition by "bookedDate") c
              from service_agreement_bookings) t
     group by 1 order by 1
  `);
  table('BASELINE — dates the workbook books', baseline);

  const baselineBusiest = Math.max(0, ...baseline.map((row) => row.busiest));

  // --- Projection: what generation puts on the future ----------------------
  const impact = await generation.confirm({ from, to }, HORIZON_EXTENSION_SYSTEM_ACTOR);

  const projected = await prisma.$queryRawUnsafe<MonthRow[]>(`
    select to_char("visitDate", 'YYYY-MM') as month,
           count(*)::int as total,
           count(distinct "visitDate")::int as days,
           max(c)::int as busiest
      from (select "visitDate", count(*) over (partition by "visitDate") c
              from generated_visits
             where "visitDate" >= '${from}' and "visitDate" <= '${to}'
               and status <> 'CANCELLED') t
     group by 1 order by 1
  `);
  table(`PROJECTED — ${from} to ${to}`, projected);

  const projectedBusiest = Math.max(0, ...projected.map((row) => row.busiest));
  const over25 = projected.filter((row) => row.busiest >= 25);

  process.stdout.write('\nVERDICT\n');
  process.stdout.write(`  agreements considered        ${impact.agreementsConsidered}\n`);
  process.stdout.write(`  visits created               ${impact.additions.length}\n`);
  process.stdout.write(`  periods short of the promise ${impact.shortfalls.length}\n`);
  process.stdout.write(`  days reported over capacity  ${impact.loadWarnings.length}\n`);
  process.stdout.write(`  busiest booked day, workbook ${baselineBusiest}\n`);
  process.stdout.write(`  busiest projected day        ${projectedBusiest}\n`);
  process.stdout.write(
    `  months with a 25+ visit day  ${over25.length}${over25.length ? ` (${over25.map((row) => row.month).join(', ')})` : ''}\n`,
  );

  await app.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

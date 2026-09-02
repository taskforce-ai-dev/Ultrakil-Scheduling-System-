/**
 * Lists every site the master schedule import could not confidently place in
 * Colombo or Kandy — the ones `schedule:import` counted as "uncertain" and
 * put in Colombo for review, without ever writing out which sites those were.
 *
 * Read-only: re-parses the workbook, recomputes the same branch decision the
 * importer makes, and writes every uncertain site to a CSV for review.
 *
 *   pnpm schedule:uncertain-branches
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { decideBranch } from '../src/catalog/schedule-import/branch-match';
import { parseMasterSchedule } from '../src/catalog/schedule-import/parser';

const REPO_ROOT = resolve(__dirname, '../../..');

function log(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function csvField(value: string | null): string {
  const text = value ?? '';
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function main(): Promise<void> {
  const path = resolve(
    REPO_ROOT,
    process.env.MASTER_SCHEDULE_PATH ?? './data/master-schedule-2026.xlsx',
  );

  if (!existsSync(path)) {
    log(`No master schedule workbook at ${path}.`);
    log('See data/README.md for how to supply it.');
    return;
  }

  log(`Reading ${path}`);
  const parsed = await parseMasterSchedule(path);

  const rows: { sheet: string; customer: string; site: string; address: string | null; region: string | null }[] = [];
  for (const customer of parsed.customers) {
    for (const site of customer.sites) {
      const decision = decideBranch([site.name, site.addressLine, site.regionLabel]);
      if (decision.confidence === 'uncertain') {
        rows.push({
          sheet: customer.sourceSheet,
          customer: customer.name,
          site: site.name,
          address: site.addressLine,
          region: site.regionLabel,
        });
      }
    }
  }

  const bySheet = new Map<string, number>();
  for (const row of rows) bySheet.set(row.sheet, (bySheet.get(row.sheet) ?? 0) + 1);

  log();
  log('─'.repeat(78));
  log(`UNCERTAIN BRANCH — ${rows.length} site(s) matched no known town, defaulted to Colombo`);
  log('─'.repeat(78));
  for (const [sheet, count] of [...bySheet.entries()].sort((a, b) => b[1] - a[1])) {
    log(`  ${sheet.padEnd(30)} ${String(count).padStart(4)}`);
  }

  const csvPath = resolve(REPO_ROOT, 'data/uncertain-branch-sites.csv');
  const header = 'sheet,customer,site,address,region';
  const lines = rows.map((r) =>
    [r.sheet, r.customer, r.site, r.address, r.region].map(csvField).join(','),
  );
  await writeFile(csvPath, [header, ...lines].join('\n'), 'utf8');

  log();
  log(`Full list written to ${csvPath}`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `\nFailed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});

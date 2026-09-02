/**
 * Lists every agreement row the schedule import skipped, with every reason it
 * was skipped on one line — the console report groups by issue code, so a row
 * missing both a frequency and a treatment shows up twice there. This groups
 * by row instead, matching `summary.agreementsSkipped` from the real import.
 *
 *   pnpm schedule:skipped-agreements
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { parseMasterSchedule } from '../src/catalog/schedule-import/parser';
import { ParsedAgreement } from '../src/catalog/schedule-import/types';

const REPO_ROOT = resolve(__dirname, '../../..');

function log(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function csvField(value: string | null): string {
  const text = value ?? '';
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function frequencyReason(agreement: ParsedAgreement): string | null {
  const outcome = agreement.frequency;
  if (outcome.kind === 'parsed') return null;
  if (outcome.kind === 'absent') return 'no frequency recorded';
  if (outcome.kind === 'unreadable') return `frequency not understood: "${outcome.source}"`;
  return `frequency not supported: "${outcome.source}" (${outcome.reason})`;
}

function dayRuleReason(agreement: ParsedAgreement): string | null {
  const outcome = agreement.dayRule;
  if (outcome.kind === 'parsed' || outcome.kind === 'derived') {
    return outcome.allowedDays.length > 0 ? null : 'no allowed days recorded';
  }
  if (outcome.kind === 'absent') return 'no allowed days recorded';
  if (outcome.kind === 'unreadable') return `day rule not understood: "${outcome.source}"`;
  return `day rule not supported: "${outcome.source}" (${outcome.reason})`;
}

function treatmentReason(agreement: ParsedAgreement): string | null {
  return agreement.treatmentCodes.length > 0 ? null : 'no treatment recorded';
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

  const rows: {
    sheet: string;
    customer: string;
    site: string;
    reasons: string;
  }[] = [];

  for (const customer of parsed.customers) {
    for (const agreement of customer.agreements) {
      const reasons = [
        frequencyReason(agreement),
        dayRuleReason(agreement),
        treatmentReason(agreement),
      ].filter((r): r is string => r !== null);

      if (reasons.length > 0) {
        rows.push({
          sheet: customer.sourceSheet,
          customer: customer.name,
          site: agreement.siteName,
          reasons: reasons.join(' | '),
        });
      }
    }
  }

  const bySheet = new Map<string, number>();
  for (const row of rows) bySheet.set(row.sheet, (bySheet.get(row.sheet) ?? 0) + 1);

  log();
  log('─'.repeat(78));
  log(`SKIPPED AGREEMENT ROWS — ${rows.length} row(s), one line each`);
  log('─'.repeat(78));
  for (const [sheet, count] of [...bySheet.entries()].sort((a, b) => b[1] - a[1])) {
    log(`  ${sheet.padEnd(30)} ${String(count).padStart(4)}`);
  }

  const csvPath = resolve(REPO_ROOT, 'data/skipped-agreement-rows.csv');
  const header = 'sheet,customer,site,reasons';
  const lines = rows.map((r) =>
    [r.sheet, r.customer, r.site, r.reasons].map(csvField).join(','),
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

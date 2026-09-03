/**
 * Imports UltraKIL's master schedule workbook.
 *
 *   pnpm schedule:import -- --dry-run    read and report, write nothing
 *   pnpm schedule:import                 import what fits
 *
 * The workbook holds real customer names and addresses and is never committed.
 * See data/README.md.
 *
 * The importing rule throughout: load what the data model can hold faithfully,
 * and report everything else with the text the workbook actually used, so
 * UltraKIL can answer the open questions. Nothing is guessed — a customer
 * quietly given the wrong visit frequency looks right on screen and delivers
 * the wrong service all year.
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';

import { importSchedule } from '../src/catalog/schedule-import/importer';
import { parseMasterSchedule } from '../src/catalog/schedule-import/parser';
import { ImportIssue, ParsedSchedule } from '../src/catalog/schedule-import/types';

const REPO_ROOT = resolve(__dirname, '../../..');
const prisma = new PrismaClient();

function log(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function groupIssues(issues: ImportIssue[]): Map<string, ImportIssue[]> {
  const grouped = new Map<string, ImportIssue[]>();
  for (const issue of issues) {
    const list = grouped.get(issue.code) ?? [];
    list.push(issue);
    grouped.set(issue.code, list);
  }
  return grouped;
}

const ISSUE_HEADINGS: Record<ImportIssue['code'], string> = {
  FREQUENCY_UNSUPPORTED:
    'Frequencies the system cannot express yet — real commitments, not mistakes',
  FREQUENCY_UNREADABLE: 'Frequencies that could not be read',
  FREQUENCY_MISSING: 'Rows with no frequency recorded',
  DAY_RULE_UNSUPPORTED: 'Day rules the system cannot express yet',
  DAY_RULE_UNREADABLE: 'Day rules that could not be read',
  DAY_RULE_MISSING: 'Rows with no allowed days recorded',
  DAY_RULE_DERIVED:
    'Allowed days worked out from the dates already booked — please confirm',
  TREATMENT_MISSING: 'Rows with no treatment recorded',
  TREATMENT_UNKNOWN: 'Treatment codes not recognised',
  SITE_NAME_MISSING: 'Rows with no location',
  BRANCH_UNKNOWN: 'Sites whose UltraKIL branch needs confirming',
  SHEET_NOT_MAPPED: 'Sheets not in the import mapping',
  RECORD_INACTIVE: 'Marked red — imported as no longer serviced, history kept',
  RECORD_MARKING_AMBIGUOUS:
    'Red on some identity cells but not others — left serviced, needs a decision',
};

function report(parsed: ParsedSchedule): void {
  log();
  log('─'.repeat(78));
  log('WHAT WAS READ');
  log('─'.repeat(78));
  for (const sheet of parsed.sheetSummary) {
    log(`  ${sheet.sheet.padEnd(30)} ${String(sheet.rows).padStart(5)} rows  ${String(sheet.sites).padStart(4)} sites`);
  }

  const totalSites = parsed.customers.reduce((sum, c) => sum + c.sites.length, 0);
  const importable = parsed.customers.flatMap((c) =>
    c.agreements.filter(
      (a) =>
        a.frequency.kind === 'parsed' &&
        (a.dayRule.kind === 'parsed' || a.dayRule.kind === 'derived') &&
        a.treatmentCodes.length > 0,
    ),
  );

  log();
  log(`  customers            ${parsed.customers.length}`);
  log(`  sites                ${totalSites}`);
  log(`  agreement rows read  ${parsed.customers.reduce((s, c) => s + c.agreements.length, 0)}`);
  log(`  agreements importable ${importable.length}`);

  const grouped = groupIssues(parsed.issues);
  log();
  log('─'.repeat(78));
  log(`NEEDS A HUMAN DECISION — ${parsed.issues.length} item(s)`);
  log('─'.repeat(78));

  for (const [code, list] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)) {
    log();
    log(`${ISSUE_HEADINGS[code as ImportIssue['code']]}  (${list.length})`);
    for (const issue of list.slice(0, 12)) {
      const where = issue.rowNumber ? `${issue.sheet} r${issue.rowNumber}` : issue.sheet;
      log(`  [${where}] ${issue.message}`);
    }
    if (list.length > 12) log(`  … and ${list.length - 12} more (see the JSON report)`);
  }
  log();
  log('─'.repeat(78));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  const path = resolve(
    REPO_ROOT,
    process.env.MASTER_SCHEDULE_PATH ?? './data/master-schedule-2026.xlsx',
  );

  if (!existsSync(path)) {
    log(`No master schedule workbook at ${path}.`);
    log('See data/README.md for how to supply it. Nothing was imported.');
    return;
  }

  log(`Reading ${path}`);
  const parsed = await parseMasterSchedule(path);
  report(parsed);

  // The full list, because the console only shows the first few of each kind.
  const reportPath = resolve(REPO_ROOT, 'data/master-schedule-import-report.json');
  await writeFile(reportPath, JSON.stringify(parsed.issues, null, 2), 'utf8');
  log(`Full report of every open question: ${reportPath}`);

  if (dryRun) {
    log();
    log('Dry run — nothing was written. Re-run without --dry-run to import.');
    return;
  }

  const summary = await importSchedule(prisma, parsed);

  log();
  log('Imported:');
  log(`  customers   ${summary.customersCreated} created, ${summary.customersUpdated} updated`);
  log(`  sites       ${summary.sitesCreated} created, ${summary.sitesUpdated} updated`);
  log(`  job types   ${summary.jobTypesCreated} created`);
  log(`  agreements  ${summary.agreementsCreated} created, ${summary.agreementsUpdated} updated`);
  log(`  skipped     ${summary.agreementsSkipped} agreement row(s) needing a decision`);
  log();
  log('Branches, worked out from each site\'s town:');
  log(`  Colombo   ${summary.sitesInColombo}`);
  log(`  Kandy     ${summary.sitesInKandy}`);
  log(
    `  of which ${summary.sitesUncertain} site(s) had no recognisable town and were put in Colombo — check these.`,
  );
  log();
  log('Run this again any time — it updates rather than duplicating.');
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `\nSchedule import failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

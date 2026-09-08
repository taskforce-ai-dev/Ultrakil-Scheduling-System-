/** Invoked only through deploy/staging-tool.mjs; stdout is numeric evidence only. */
import { lstat, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { seedReferenceData } from '../prisma/reference-data';
import { decideBranch } from '../src/catalog/schedule-import/branch-match';
import { importSchedule } from '../src/catalog/schedule-import/importer';
import { parseMasterSchedule } from '../src/catalog/schedule-import/parser';
import { ParsedSchedule } from '../src/catalog/schedule-import/types';
import { importMatrix } from '../src/workforce/matrix-import/importer';
import { loadMatrixMapping } from '../src/workforce/matrix-import/load-mapping';
import { parseMatrix } from '../src/workforce/matrix-import/parser';
import { readMatrixFile } from '../src/workforce/matrix-import/reader';
import { ParsedMatrix } from '../src/workforce/matrix-import/types';

function issueCounts(issues: { code: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { code } of issues) {
    // Stable codes originate in the parsers; source strings never become keys.
    if (!/^[A-Z][A-Z0-9_]*$/.test(code)) throw new Error('INVALID_ISSUE_CODE');
    counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

export function summarizeInputs(matrix: ParsedMatrix, schedule: ParsedSchedule) {
  const sites = schedule.customers.flatMap(customer => customer.sites);
  const agreements = schedule.customers.flatMap(customer => customer.agreements);
  const importable = agreements.filter(agreement => agreement.frequency.kind === 'parsed'
    && (agreement.dayRule.kind === 'parsed' || agreement.dayRule.kind === 'derived')
    && agreement.dayRule.allowedDays.length > 0 && agreement.treatmentCodes.length > 0);
  if (!matrix.employees.length || !matrix.vehicles.length) throw new Error('EMPTY_MATRIX');
  if (!schedule.customers.length || !sites.length) throw new Error('EMPTY_SCHEDULE');
  if (!importable.length) throw new Error('EMPTY_AGREEMENTS');
  return {
    employees: matrix.employees.length, vehicles: matrix.vehicles.length,
    pmsQualified: matrix.employees.filter(employee => employee.isPmsGrade).length,
    permanentEmployees: matrix.employees.filter(employee => employee.isPermanentlyStationed).length,
    publicTransportEmployees: matrix.employees.filter(employee => employee.canUsePublicTransport).length,
    customers: schedule.customers.length, sites: sites.length, agreementRows: agreements.length,
    importableAgreements: importable.length,
    uncertainSiteBranches: sites.filter(site => decideBranch([site.name, site.addressLine, site.regionLabel]).confidence === 'uncertain').length,
    matrixIssues: issueCounts(matrix.issues), scheduleIssues: issueCounts(schedule.issues),
  };
}

export async function writePrivateReport(directory: string, matrix: ParsedMatrix, schedule: ParsedSchedule): Promise<void> {
  const parent = await lstat(directory);
  const fromRepository = relative(resolve(__dirname, '../../..'), await realpath(directory));
  if (!parent.isDirectory() || (parent.mode & 0o077) || parent.uid !== process.getuid?.()
    || (fromRepository !== '..' && !fromRepository.startsWith(`..${sep}`))) throw new Error('PRIVATE_REPORT_DIRECTORY_REQUIRED');
  const runDirectory = await mkdtemp(join(directory, 'import-'));
  await writeFile(join(runDirectory, 'issues.json'), JSON.stringify({ matrix: matrix.issues, schedule: schedule.issues }, null, 2),
    { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const mapping = loadMatrixMapping(process.env.MATRIX_MAPPING_PATH ?? '/import-config/matrix-mapping.json');
  const { grid } = await readMatrixFile(process.env.TECHNICIAN_MATRIX_PATH!, mapping.sheetName);
  const matrix = parseMatrix(grid, mapping);
  const schedule = await parseMasterSchedule(process.env.MASTER_SCHEDULE_PATH!);
  // Parse and validate BOTH workbooks before any reference/admin/workforce write.
  const parsed = summarizeInputs(matrix, schedule);
  if (process.env.STAGING_REPORT_DIR) await writePrivateReport(process.env.STAGING_REPORT_DIR, matrix, schedule);
  if (dryRun) {
    process.stdout.write(JSON.stringify({ parsed }));
    return;
  }
  const prisma = new PrismaClient({ log: [] });
  try {
    await seedReferenceData(prisma);
    const matrixSummary = await importMatrix(prisma, matrix);
    const scheduleSummary = await importSchedule(prisma, schedule);
    process.stdout.write(JSON.stringify({ parsed, matrix: matrixSummary, schedule: scheduleSummary }));
  } finally { await prisma.$disconnect(); }
}

if (require.main === module) {
  main().catch(() => {
    // Exceptions from workbook/XML/Prisma may contain real names or credentials.
    process.stderr.write('STAGING_IMPORT_FAILED\n');
    process.exitCode = 1;
  });
}

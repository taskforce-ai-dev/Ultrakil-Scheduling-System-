/**
 * Seeds reference data and imports the UltraKIL workforce matrix.
 *
 *   pnpm db:seed                 import for real
 *   pnpm db:seed -- --dry-run    parse and report, write nothing
 *   pnpm db:seed -- --inspect    dump the workbook's shape, parse nothing
 *
 * Safe to run repeatedly: the import upserts on natural keys, so a second run
 * produces no duplicate employees and no duplicate vehicle authorizations.
 *
 * The workbook holds real staff data and is not in the repository. When it is
 * missing the seed still succeeds — it loads the branches and skips the
 * workforce import with a warning — so nobody is blocked waiting for the file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BranchCode, PrismaClient } from '@prisma/client';
import { DEFAULT_MAPPING, MatrixMapping } from '../src/workforce/matrix-import/mapping';
import { importMatrix } from '../src/workforce/matrix-import/importer';
import { parseMatrix } from '../src/workforce/matrix-import/parser';
import { readMatrixFile } from '../src/workforce/matrix-import/reader';

const REPO_ROOT = resolve(__dirname, '../../..');
const MAPPING_PATH = resolve(REPO_ROOT, 'data/matrix-mapping.json');

const BRANCH_NAMES: Record<BranchCode, string> = {
  [BranchCode.COLOMBO]: 'Colombo Branch',
  [BranchCode.KANDY]: 'Kandy Branch',
};

const prisma = new PrismaClient();

function log(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function loadMapping(): MatrixMapping {
  if (!existsSync(MAPPING_PATH)) return DEFAULT_MAPPING;

  const overrides = JSON.parse(readFileSync(MAPPING_PATH, 'utf8'));
  log(`Using column mapping overrides from ${MAPPING_PATH}`);

  return {
    ...DEFAULT_MAPPING,
    ...overrides,
    columns: { ...DEFAULT_MAPPING.columns, ...(overrides.columns ?? {}) },
    sections: { ...DEFAULT_MAPPING.sections, ...(overrides.sections ?? {}) },
    permanentSiteBranches: {
      ...DEFAULT_MAPPING.permanentSiteBranches,
      ...(overrides.permanentSiteBranches ?? {}),
    },
  };
}

async function seedBranches(): Promise<void> {
  for (const code of Object.values(BranchCode)) {
    await prisma.branch.upsert({
      where: { code },
      create: { code, name: BRANCH_NAMES[code] },
      update: { name: BRANCH_NAMES[code] },
    });
  }
  log(`Branches ready: ${Object.values(BranchCode).join(', ')}`);
}

async function inspect(path: string, mapping: MatrixMapping): Promise<void> {
  const { grid, sheetName, sheetNames } = await readMatrixFile(
    path,
    mapping.sheetName,
  );

  log(`Workbook : ${path}`);
  log(`Sheets   : ${sheetNames.join(', ')}`);
  log(`Reading  : ${sheetName}`);
  log(`Size     : ${grid.length} rows x ${grid[0]?.length ?? 0} columns`);
  log();
  log('First 12 rows (column index: value), blanks omitted:');

  grid.slice(0, 12).forEach((row, index) => {
    const cells = row
      .map((value, column) => (value ? `${column}:${value}` : null))
      .filter(Boolean);
    log(`  row ${String(index + 1).padStart(2)} | ${cells.join('  ') || '(empty)'}`);
  });
}

function report(parsed: ReturnType<typeof parseMatrix>): void {
  log();
  log('─'.repeat(72));
  log(`Header row     : ${parsed.headerRowNumber}`);
  log(`Skill columns  : ${parsed.skillColumns.length}`);
  log(`Vehicle columns: ${parsed.vehicleColumns.length}`);
  log(`Employees read : ${parsed.employees.length}`);

  const byBranch = new Map<string, number>();
  let pms = 0;
  let stationed = 0;
  for (const employee of parsed.employees) {
    byBranch.set(employee.branchCode, (byBranch.get(employee.branchCode) ?? 0) + 1);
    if (employee.isPmsGrade) pms += 1;
    if (employee.isPermanentlyStationed) stationed += 1;
  }
  for (const [branch, count] of byBranch) log(`  ${branch.padEnd(12)} ${count}`);
  log(`PMS-grade supervisors : ${pms}`);
  log(`Permanently stationed : ${stationed}`);

  log();
  log('Vehicles found:');
  for (const vehicle of parsed.vehicles) {
    const seats = vehicle.seatCapacity ? `${vehicle.seatCapacity} seats` : 'seats unknown';
    log(`  ${vehicle.code.padEnd(12)} ${seats.padEnd(14)} ${vehicle.ownershipGroup ?? ''}`);
  }

  log();
  log('Columns treated as SKILLS — check nothing here is really a vehicle:');
  log(`  ${parsed.skillColumns.map((c) => c.label).join(' | ')}`);

  if (parsed.unrecognisedGrades.length > 0) {
    log();
    log('Designations NOT counted as PMS-grade supervisors:');
    for (const grade of parsed.unrecognisedGrades) log(`  - ${grade}`);
    log('  If any of these should supervise a job, tell the team before importing.');
  }

  if (parsed.issues.length > 0) {
    log();
    log(`${parsed.issues.length} row(s) need attention. These are NOT imported:`);
    for (const issue of parsed.issues) {
      const where = issue.rowNumber ? ` (row ${issue.rowNumber})` : '';
      log(`  [${issue.code}]${where} ${issue.message}`);
    }
  }
  log('─'.repeat(72));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const inspectOnly = args.includes('--inspect');

  const mapping = loadMapping();
  const matrixPath = resolve(
    REPO_ROOT,
    process.env.TECHNICIAN_MATRIX_PATH ?? './data/technician-matrix.xlsx',
  );

  if (!existsSync(matrixPath)) {
    log(`No workforce matrix at ${matrixPath} — skipping the workforce import.`);
    log('See data/README.md for how to supply it. Seeding reference data only.');
    if (!dryRun && !inspectOnly) await seedBranches();
    return;
  }

  if (inspectOnly) {
    await inspect(matrixPath, mapping);
    return;
  }

  const { grid, sheetName } = await readMatrixFile(matrixPath, mapping.sheetName);
  log(`Read ${grid.length} rows from sheet "${sheetName}" of ${matrixPath}`);

  const parsed = parseMatrix(grid, mapping);
  report(parsed);

  if (dryRun) {
    log();
    log('Dry run — nothing was written. Re-run without --dry-run to import.');
    return;
  }

  if (parsed.employees.length === 0) {
    throw new Error(
      'Refusing to import: no employees were read. Run with --inspect to see how the workbook is being read.',
    );
  }

  await seedBranches();
  const summary = await importMatrix(prisma, parsed);

  log();
  log('Imported:');
  log(`  employees      ${summary.employeesCreated} created, ${summary.employeesUpdated} updated`);
  log(`  vehicles       ${summary.vehiclesCreated} created, ${summary.vehiclesUpdated} updated`);
  log(`  skills         ${summary.skillsLinked} linked, ${summary.skillsRemoved} removed`);
  log(`  authorizations ${summary.authorizationsLinked} linked, ${summary.authorizationsRemoved} removed`);
  log();
  log('Run this again any time — it updates rather than duplicating.');
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `\nSeed failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

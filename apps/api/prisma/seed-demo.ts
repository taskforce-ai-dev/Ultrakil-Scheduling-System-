/**
 * Seeds a fabricated workforce, for anyone without the real matrix.
 *
 *   pnpm db:seed:demo            import the demo workforce
 *   pnpm db:seed:demo -- --force overwrite even if real data is present
 *
 * The real workforce matrix holds actual staff names, so it is never
 * committed. Without it `pnpm db:seed` loads the branches and the admin
 * account and stops, leaving every workforce screen empty — which is correct
 * behaviour that looks exactly like a bug. This gives the frontend something
 * real-shaped to build against.
 *
 * Safe to run repeatedly: it goes through the same upsert-on-natural-key
 * importer as the real seed, so a second run updates rather than duplicates.
 */
import { PrismaClient, UserRole } from '@prisma/client';

import { AuthService } from '../src/auth/auth.service';
import { importMatrix } from '../src/workforce/matrix-import/importer';
import { DEMO_MARKER, buildDemoMatrix } from './demo-data';

const prisma = new PrismaClient();

function log(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Counts employees that did not come from this script.
 *
 * Demo rows carry a marker in `sourceRow`. Anything without it came from the
 * real matrix, and overwriting operational data because someone typed the
 * wrong seed command is not a recoverable mistake.
 */
async function countRealEmployees(): Promise<number> {
  const employees = await prisma.employee.findMany({
    select: { sourceRow: true },
  });

  return employees.filter((employee) => {
    const row = employee.sourceRow;
    return (
      typeof row !== 'object' ||
      row === null ||
      Array.isArray(row) ||
      !(DEMO_MARKER in row)
    );
  }).length;
}

async function seedAdminUser(): Promise<void> {
  const existing = await prisma.user.count();
  if (existing > 0) {
    log(`Users already exist (${existing}) — leaving accounts untouched.`);
    return;
  }

  const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@taskforceai.tech')
    .trim()
    .toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'ultrakil-change-me';
  const fullName = process.env.SEED_ADMIN_NAME ?? 'UltraKIL Administrator';

  await prisma.user.create({
    data: {
      email,
      fullName,
      role: UserRole.ADMIN,
      passwordHash: await AuthService.hashPassword(password),
    },
  });

  log(`Created the first admin account: ${email}`);
  if (password === 'ultrakil-change-me') {
    log('  WARNING: this is the default password. Change SEED_ADMIN_PASSWORD.');
  }
}

async function main(): Promise<void> {
  const force = process.argv.slice(2).includes('--force');

  const realEmployees = await countRealEmployees();
  if (realEmployees > 0 && !force) {
    log(
      `This database already holds ${realEmployees} employee(s) from the real matrix.`,
    );
    log('Refusing to overwrite operational data with demo records.');
    log();
    log('If you meant to do this, re-run with --force:');
    log('  pnpm db:seed:demo -- --force');
    return;
  }

  if (realEmployees > 0) {
    log(`--force given: overwriting alongside ${realEmployees} real employee(s).`);
  }

  const matrix = buildDemoMatrix();
  const summary = await importMatrix(prisma, matrix);
  await seedAdminUser();

  const byBranch = new Map<string, number>();
  for (const employee of matrix.employees) {
    byBranch.set(
      employee.branchCode,
      (byBranch.get(employee.branchCode) ?? 0) + 1,
    );
  }

  log();
  log('Demo workforce loaded. Every name and registration here is invented.');
  log();
  log(`  employees      ${summary.employeesCreated} created, ${summary.employeesUpdated} updated`);
  log(`  vehicles       ${summary.vehiclesCreated} created, ${summary.vehiclesUpdated} updated`);
  log(`  skills         ${summary.skillsLinked} linked`);
  log(`  authorizations ${summary.authorizationsLinked} linked`);
  for (const [branch, count] of byBranch) {
    log(`  ${branch.padEnd(14)} ${count} employees`);
  }
  log(`  PMS-grade supervisors    ${summary.pmsSupervisors}`);
  log(`  permanently stationed    ${summary.permanentlyStationed}`);
  log(`  can travel by bus        ${summary.publicTransportUsers}`);
  log();
  log('Sign in at http://localhost:3000 and the workforce screens will have data.');
  log('Run this again any time — it updates rather than duplicating.');
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `\nDemo seed failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

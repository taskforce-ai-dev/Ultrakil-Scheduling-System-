/**
 * Answers one question: why does the board say "No crew yet"?
 *
 * A manager looking at an empty board cannot tell the difference between a
 * broken optimizer, a week nobody has solved, an empty employee table, and a
 * schedule that was solved but never looked at. All four produce the identical
 * screen, and the first is the only one that is a bug. This walks the same
 * chain the board depends on and stops at the first link that is missing, so
 * the answer is a sentence rather than an afternoon.
 *
 *   pnpm --filter @ultrakil/api why-no-crew                 # this week
 *   pnpm --filter @ultrakil/api why-no-crew 2026-09-07      # the week containing that date
 */
import { AssignmentStatus, BranchCode, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** The statuses that mean "a crew is really on this visit". Mirrors the API. */
const LIVE: AssignmentStatus[] = [
  AssignmentStatus.DRAFT,
  AssignmentStatus.PROPOSED,
  AssignmentStatus.PUBLISHED,
  AssignmentStatus.ACKNOWLEDGED,
  AssignmentStatus.IN_PROGRESS,
];

function mondayOf(date: Date): Date {
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // getUTCDay() is 0 on Sunday, which is the *end* of the ISO week, not the start.
  const offset = (monday.getUTCDay() + 6) % 7;
  monday.setUTCDate(monday.getUTCDate() - offset);
  return monday;
}

const iso = (date: Date) => date.toISOString().slice(0, 10);

async function main(): Promise<void> {
  const argument = process.argv[2];
  const anchor = argument ? new Date(`${argument}T00:00:00.000Z`) : new Date();
  if (Number.isNaN(anchor.getTime())) {
    console.error(`Not a date: "${argument}". Use YYYY-MM-DD, for example 2026-09-07.`);
    process.exitCode = 1;
    return;
  }

  const from = mondayOf(anchor);
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + 6);

  console.log(`\nWeek ${iso(from)} to ${iso(to)}\n${'='.repeat(34)}\n`);

  // 1. Staff. Nothing downstream can work without people to assign.
  const staff = await prisma.employee.groupBy({
    by: ['branchCode'],
    _count: { _all: true },
    where: { isActive: true },
  });
  const total = staff.reduce((sum, row) => sum + row._count._all, 0);
  console.log('Active staff');
  for (const branch of [BranchCode.COLOMBO, BranchCode.KANDY]) {
    const count = staff.find((row) => row.branchCode === branch)?._count._all ?? 0;
    console.log(`  ${branch.padEnd(10)} ${count}`);
  }

  const supervisors = await prisma.employee.count({ where: { isActive: true, isPmsGrade: true } });
  console.log(`  PMS-grade supervisors: ${supervisors}`);

  // 2. Work. An empty week is not a scheduling failure.
  const visits = await prisma.generatedVisit.count({ where: { visitDate: { gte: from, lte: to } } });
  const staffed = await prisma.generatedVisit.count({
    where: { visitDate: { gte: from, lte: to }, assignments: { some: { status: { in: LIVE } } } },
  });
  console.log(`\nVisits this week: ${visits}   with a crew: ${staffed}`);

  // 3. Runs. "Nobody pressed Generate" looks exactly like "the solver failed".
  const runs = await prisma.scheduleRun.findMany({
    where: { rangeStart: { lte: to }, rangeEnd: { gte: from } },
    orderBy: { createdAt: 'desc' },
    take: 3,
  });
  console.log(`\nSchedule runs covering this week: ${runs.length === 0 ? 'none' : ''}`);
  for (const run of runs) {
    console.log(
      `  ${run.createdAt.toISOString().slice(0, 16).replace('T', ' ')}  ${run.status.padEnd(10)}` +
        ` considered ${run.visitsConsidered}, staffed ${run.visitsScheduled}` +
        `${run.errorMessage ? `  — ${run.errorMessage}` : ''}`,
    );
  }

  // The verdict. One cause, the first broken link in the chain.
  console.log(`\n${'-'.repeat(34)}`);
  if (total === 0) {
    console.log('CAUSE: there are no active employees at all.');
    console.log('FIX:   re-import the workforce matrix. Nothing can be assigned to nobody.');
  } else if (visits === 0) {
    console.log('CAUSE: this week has no visits, so there is nothing to staff.');
    console.log('FIX:   generate visits for this week, or look at a week that has work.');
  } else if (runs.length === 0) {
    console.log('CAUSE: nobody has run the optimizer over this week.');
    console.log('FIX:   Schedule History → "Generate a schedule" for this date range.');
  } else if (staffed === 0 && supervisors === 0) {
    console.log('CAUSE: no PMS-grade supervisor exists, and every job needs one.');
    console.log('FIX:   this is a roster problem, not a code one. The matrix needs a supervisor.');
  } else if (staffed === 0) {
    console.log('CAUSE: the optimizer ran but could staff nothing — almost always too few people.');
    console.log('FIX:   check the counts above, then read the reasons on the Unassigned queue.');
  } else if (staffed < visits) {
    console.log(`OK:    ${staffed} of ${visits} visits have a crew.`);
    console.log('       The rest are in the Unassigned queue, each with its reason.');
  } else {
    console.log('OK:    every visit this week has a crew. An empty board means the page is');
    console.log('       showing a different week or branch than the one solved.');
  }
  console.log();
}

main()
  .catch((caught: unknown) => {
    console.error(caught);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

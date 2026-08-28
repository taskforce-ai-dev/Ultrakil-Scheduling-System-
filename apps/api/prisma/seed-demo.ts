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
import { AgreementStatus, PrismaClient, UserRole } from '@prisma/client';

import { AuthService } from '../src/auth/auth.service';
import { importMatrix } from '../src/workforce/matrix-import/importer';
import {
  DEMO_CUSTOMERS,
  DEMO_JOB_TYPES,
  DEMO_MARKER,
  buildDemoMatrix,
  toDemoDayRules,
} from './demo-data';

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

/**
 * Loads the invented customers, their sites and the agreements over them.
 *
 * Upserts on natural keys the same way the workforce import does, so running
 * the demo seed twice updates rather than duplicating. Agreements are keyed by
 * (site, job type), which is enough to identify one commitment in this set.
 */
async function seedCatalog(): Promise<{
  jobTypes: number;
  customers: number;
  sites: number;
  agreements: number;
}> {
  const counts = { jobTypes: 0, customers: 0, sites: 0, agreements: 0 };

  const jobTypeIds = new Map<string, string>();
  for (const jobType of DEMO_JOB_TYPES) {
    const record = await prisma.jobType.upsert({
      where: { code: jobType.code },
      create: jobType,
      update: {
        name: jobType.name,
        defaultDurationMinutes: jobType.defaultDurationMinutes,
        defaultCrewSize: jobType.defaultCrewSize,
        requiredSkillCode: jobType.requiredSkillCode,
        isActive: true,
      },
    });
    jobTypeIds.set(jobType.code, record.id);
    counts.jobTypes += 1;
  }

  for (const customer of DEMO_CUSTOMERS) {
    const branch = await prisma.branch.findUniqueOrThrow({
      where: { code: customer.branchCode },
    });

    const existing = await prisma.customer.findUnique({
      where: { customerCode: customer.customerCode },
    });

    const record = existing
      ? await prisma.customer.update({
          where: { id: existing.id },
          data: {
            name: customer.name,
            branchId: branch.id,
            branchCode: customer.branchCode,
            contactName: customer.contactName,
            contactPhone: customer.contactPhone,
            contactEmail: customer.contactEmail,
            isActive: true,
          },
        })
      : await prisma.customer.create({
          data: {
            name: customer.name,
            customerCode: customer.customerCode,
            branchId: branch.id,
            branchCode: customer.branchCode,
            contactName: customer.contactName,
            contactPhone: customer.contactPhone,
            contactEmail: customer.contactEmail,
          },
        });
    counts.customers += 1;

    const siteIds = new Map<string, string>();
    for (const site of customer.sites) {
      const existingSite = await prisma.serviceSite.findFirst({
        where: { customerId: record.id, name: site.name },
      });

      const siteRecord = existingSite
        ? await prisma.serviceSite.update({
            where: { id: existingSite.id },
            data: {
              addressLine: site.addressLine,
              city: site.city,
              branchId: branch.id,
              branchCode: customer.branchCode,
              isActive: true,
              // Replaced wholesale, so a re-run cannot pile up windows.
              operatingHours: {
                deleteMany: {},
                create: site.operatingHours,
              },
            },
          })
        : await prisma.serviceSite.create({
            data: {
              customerId: record.id,
              name: site.name,
              addressLine: site.addressLine,
              city: site.city,
              branchId: branch.id,
              branchCode: customer.branchCode,
              operatingHours: { create: site.operatingHours },
            },
          });

      siteIds.set(site.name, siteRecord.id);
      counts.sites += 1;
    }

    for (const agreement of customer.agreements) {
      const siteId = siteIds.get(agreement.siteName);
      const jobTypeId = jobTypeIds.get(agreement.jobTypeCode);
      if (!siteId || !jobTypeId) continue;

      const jobType = DEMO_JOB_TYPES.find((t) => t.code === agreement.jobTypeCode)!;
      const existingAgreement = await prisma.serviceAgreement.findFirst({
        where: { serviceSiteId: siteId, jobTypeId },
      });

      const data = {
        customerId: record.id,
        serviceSiteId: siteId,
        jobTypeId,
        branchId: branch.id,
        branchCode: customer.branchCode,
        frequencyCount: agreement.frequencyCount,
        frequencyUnit: agreement.frequencyUnit,
        crewSize: agreement.crewSize ?? jobType.defaultCrewSize,
        durationMinutes: agreement.durationMinutes ?? jobType.defaultDurationMinutes,
        startDate: new Date(`${agreement.startDate}T00:00:00.000Z`),
        status: AgreementStatus.ACTIVE,
        notes: agreement.notes ?? null,
      };

      const agreementRecord = existingAgreement
        ? await prisma.serviceAgreement.update({
            where: { id: existingAgreement.id },
            data: {
              ...data,
              dayRules: { deleteMany: {}, create: toDemoDayRules(agreement) },
              requiredSkills: {
                deleteMany: {},
                create: (agreement.requiredSkillCodes ?? []).map((skillCode) => ({
                  skillCode,
                })),
              },
            },
          })
        : await prisma.serviceAgreement.create({
            data: {
              ...data,
              dayRules: { create: toDemoDayRules(agreement) },
              requiredSkills: {
                create: (agreement.requiredSkillCodes ?? []).map((skillCode) => ({
                  skillCode,
                })),
              },
            },
          });

      // One version per agreement, so the versions screen is not empty.
      const versionExists = await prisma.serviceAgreementVersion.findUnique({
        where: {
          serviceAgreementId_versionNumber: {
            serviceAgreementId: agreementRecord.id,
            versionNumber: agreementRecord.currentVersion,
          },
        },
      });

      if (!versionExists) {
        await prisma.serviceAgreementVersion.create({
          data: {
            serviceAgreementId: agreementRecord.id,
            versionNumber: agreementRecord.currentVersion,
            changedByLabel: 'Demo seed',
            changeSummary: 'Created by the demo seed',
            snapshot: {
              frequencyCount: agreement.frequencyCount,
              frequencyUnit: agreement.frequencyUnit,
              allowedDays: agreement.allowedDays,
              preferredDays: agreement.preferredDays,
              startDate: agreement.startDate,
            },
          },
        });
      }

      counts.agreements += 1;
    }
  }

  return counts;
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
  const catalog = await seedCatalog();

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
  log(`  job types      ${catalog.jobTypes}`);
  log(`  customers      ${catalog.customers}`);
  log(`  sites          ${catalog.sites}`);
  log(`  agreements     ${catalog.agreements}`);
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

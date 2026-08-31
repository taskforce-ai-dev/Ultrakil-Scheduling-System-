import {
  AgreementStatus,
  BranchCode,
  DayRuleKind,
  PrismaClient,
  Weekday,
} from '@prisma/client';

import { DEFAULT_IMPORT_BRANCH } from './sheet-mapping';
import { ParsedAgreement, ParsedSchedule } from './types';

export interface ScheduleImportSummary {
  customersCreated: number;
  customersUpdated: number;
  sitesCreated: number;
  sitesUpdated: number;
  jobTypesCreated: number;
  agreementsCreated: number;
  agreementsUpdated: number;
  /** Rows the parser could not turn into an agreement without guessing. */
  agreementsSkipped: number;
  branchCode: BranchCode;
}

/**
 * Writes a parsed master schedule into the database.
 *
 * Customers and sites are always imported — a name and an address are facts
 * the workbook states plainly. An agreement is only created when the frequency,
 * the allowed days and the treatment were all read with confidence; anything
 * else is counted as skipped and already carries an issue explaining why.
 *
 * Every write upserts on a natural key, so importing twice updates rather than
 * duplicating — the same property that makes the workforce import safe to
 * re-run as the workbook changes.
 */
export async function importSchedule(
  prisma: PrismaClient,
  parsed: ParsedSchedule,
): Promise<ScheduleImportSummary> {
  const summary: ScheduleImportSummary = {
    customersCreated: 0,
    customersUpdated: 0,
    sitesCreated: 0,
    sitesUpdated: 0,
    jobTypesCreated: 0,
    agreementsCreated: 0,
    agreementsUpdated: 0,
    agreementsSkipped: 0,
    branchCode: DEFAULT_IMPORT_BRANCH,
  };

  const branch = await prisma.branch.findUniqueOrThrow({
    where: { code: DEFAULT_IMPORT_BRANCH },
  });

  const jobTypeIds = await ensureJobTypes(prisma, parsed, summary);
  const startDate = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);

  for (const customer of parsed.customers) {
    // One transaction per customer rather than one for the whole workbook: a
    // single bad row should not roll back nine hundred good sites, and the
    // import is re-runnable, so a partial import is recoverable.
    await prisma.$transaction(async (tx) => {
      const existing = await tx.customer.findFirst({
        where: { name: customer.name },
        select: { id: true },
      });

      const record = existing
        ? await tx.customer.update({
            where: { id: existing.id },
            data: { branchId: branch.id, branchCode: branch.code, isActive: true },
          })
        : await tx.customer.create({
            data: {
              name: customer.name,
              branchId: branch.id,
              branchCode: branch.code,
            },
          });

      if (existing) summary.customersUpdated += 1;
      else summary.customersCreated += 1;

      const siteIds = new Map<string, string>();
      for (const site of customer.sites) {
        const existingSite = await tx.serviceSite.findFirst({
          where: { customerId: record.id, name: site.name },
          select: { id: true },
        });

        const siteRecord = existingSite
          ? await tx.serviceSite.update({
              where: { id: existingSite.id },
              data: {
                addressLine: site.addressLine,
                branchId: branch.id,
                branchCode: branch.code,
                isActive: true,
              },
            })
          : await tx.serviceSite.create({
              data: {
                customerId: record.id,
                name: site.name,
                addressLine: site.addressLine,
                branchId: branch.id,
                branchCode: branch.code,
              },
            });

        siteIds.set(site.name.toLowerCase(), siteRecord.id);
        if (existingSite) summary.sitesUpdated += 1;
        else summary.sitesCreated += 1;
      }

      for (const agreement of customer.agreements) {
        if (!isImportable(agreement)) {
          summary.agreementsSkipped += 1;
          continue;
        }

        const siteId = siteIds.get(agreement.siteName.toLowerCase());
        const jobTypeId = jobTypeIds.get(treatmentKey(agreement.treatmentCodes));
        if (!siteId || !jobTypeId) {
          summary.agreementsSkipped += 1;
          continue;
        }

        // Both narrowed by isImportable; TypeScript needs it said again.
        if (agreement.frequency.kind !== 'parsed') continue;
        if (agreement.dayRule.kind !== 'parsed' && agreement.dayRule.kind !== 'derived') {
          continue;
        }

        const jobType = await tx.jobType.findUniqueOrThrow({ where: { id: jobTypeId } });
        const allowedDays = agreement.dayRule.allowedDays;

        const existingAgreement = await tx.serviceAgreement.findFirst({
          where: { serviceSiteId: siteId, jobTypeId },
          select: { id: true },
        });

        const data = {
          customerId: record.id,
          serviceSiteId: siteId,
          jobTypeId,
          branchId: branch.id,
          branchCode: branch.code,
          frequencyCount: agreement.frequency.frequency.count,
          frequencyUnit: agreement.frequency.frequency.unit,
          crewSize: agreement.effort.crewSize ?? jobType.defaultCrewSize,
          durationMinutes: agreement.effort.durationMinutes ?? jobType.defaultDurationMinutes,
          startDate,
          endDate: agreement.endDate
            ? new Date(`${agreement.endDate}T00:00:00.000Z`)
            : null,
          status: AgreementStatus.ACTIVE,
          notes:
            agreement.dayRule.kind === 'derived'
              ? `Imported from the master schedule workbook (${customer.sourceSheet}). The allowed days were not stated — they were read from the ${agreement.dayRule.sampleSize} visit dates already booked (${agreement.dayRule.evidence}). Confirm with the customer.`
              : `Imported from the master schedule workbook (${customer.sourceSheet}).`,
        };

        const dayRules = toDayRuleRows(allowedDays);

        if (existingAgreement) {
          await tx.serviceAgreement.update({
            where: { id: existingAgreement.id },
            data: { ...data, dayRules: { deleteMany: {}, create: dayRules } },
          });
          summary.agreementsUpdated += 1;
        } else {
          await tx.serviceAgreement.create({
            data: { ...data, dayRules: { create: dayRules } },
          });
          summary.agreementsCreated += 1;
        }
      }
    });
  }

  return summary;
}

function isImportable(agreement: ParsedAgreement): boolean {
  return (
    agreement.frequency.kind === 'parsed' &&
    (agreement.dayRule.kind === 'parsed' || agreement.dayRule.kind === 'derived') &&
    agreement.dayRule.allowedDays.length > 0 &&
    agreement.treatmentCodes.length > 0
  );
}

/** One job type per distinct combination of treatment codes, as written. */
function treatmentKey(codes: string[]): string {
  return [...codes].sort().join('_');
}

/**
 * Creates a job type for every treatment combination the workbook uses.
 *
 * The workbook writes treatments as codes — GPC, RC, MC — and never says what
 * they stand for. They are stored as-is rather than expanded into guessed
 * names: "RC" becoming "Rodent Control" would be an invention, and a wrong
 * expansion is harder to spot later than an honest code.
 */
async function ensureJobTypes(
  prisma: PrismaClient,
  parsed: ParsedSchedule,
  summary: ScheduleImportSummary,
): Promise<Map<string, string>> {
  const combinations = new Map<string, string[]>();
  for (const customer of parsed.customers) {
    for (const agreement of customer.agreements) {
      if (agreement.treatmentCodes.length === 0) continue;
      combinations.set(treatmentKey(agreement.treatmentCodes), agreement.treatmentCodes);
    }
  }

  const ids = new Map<string, string>();
  for (const [key, codes] of combinations) {
    const code = `IMPORTED_${key}`;
    const existing = await prisma.jobType.findUnique({ where: { code } });

    const record =
      existing ??
      (await prisma.jobType.create({
        data: {
          code,
          name: codes.join(' + '),
          requiredSkillCode: null,
        },
      }));

    if (!existing) summary.jobTypesCreated += 1;
    ids.set(key, record.id);
  }

  return ids;
}

function toDayRuleRows(allowedDays: Weekday[]): { weekday: Weekday; kind: DayRuleKind }[] {
  return allowedDays.map((weekday) => ({ weekday, kind: DayRuleKind.ALLOWED }));
}

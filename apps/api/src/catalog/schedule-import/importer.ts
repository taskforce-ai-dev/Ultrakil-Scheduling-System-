import {
  AgreementStatus,
  BranchCode,
  DayRuleKind,
  PrismaClient,
  Weekday,
} from '@prisma/client';

import { decideBranch } from './branch-match';
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
  sitesInColombo: number;
  sitesInKandy: number;
  /** Sites whose town was not recognised; placed in Colombo for review. */
  sitesUncertain: number;
}

/**
 * What an import may change about a record's active state.
 *
 * Deactivating is immediate: the workbook says this client is gone, and every
 * day it keeps generating work is a crew sent somewhere nobody is paying for.
 * Reactivating is deliberately not symmetric — `isActive` is absent from the
 * serviced branch, so a record already marked red stays off. A row that has
 * merely lost its red fill is not evidence the client came back; it is
 * evidence somebody edited a cell. Switching their work back on is a decision
 * a person makes, not a side effect of re-running the importer.
 *
 * A record reactivated by hand keeps that decision: clearing its
 * `importedInactiveAt` is what tells later imports to treat it normally again.
 */
function activation(isServiced: boolean): {
  isActive?: boolean;
  importedInactiveAt?: Date | null;
} {
  if (!isServiced) return { isActive: false, importedInactiveAt: new Date() };
  return {};
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
    sitesInColombo: 0,
    sitesInKandy: 0,
    sitesUncertain: 0,
  };

  const branches = new Map<BranchCode, string>();
  for (const record of await prisma.branch.findMany()) {
    branches.set(record.code, record.id);
  }

  const jobTypeIds = await ensureJobTypes(prisma, parsed, summary);
  const startDate = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);

  for (const customer of parsed.customers) {
    // Each site gets the branch nearer to it. The customer takes whichever
    // branch most of its sites are in: the model puts a branch on the customer
    // too, and a customer disagreeing with its own sites reads as a bug.
    const siteDecisions = new Map(
      customer.sites.map((site) => [
        site.name.toLowerCase(),
        decideBranch([site.name, site.addressLine, site.regionLabel]),
      ]),
    );
    const kandyCount = [...siteDecisions.values()].filter(
      (decision) => decision.branchCode === BranchCode.KANDY,
    ).length;
    const customerBranch =
      kandyCount * 2 > siteDecisions.size ? BranchCode.KANDY : BranchCode.COLOMBO;
    const customerBranchId = branches.get(customerBranch);
    if (!customerBranchId) continue;

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
            data: {
              branchId: customerBranchId,
              branchCode: customerBranch,
              ...activation(customer.isServiced),
            },
          })
        : await tx.customer.create({
            data: {
              name: customer.name,
              branchId: customerBranchId,
              branchCode: customerBranch,
              isActive: customer.isServiced,
              importedInactiveAt: customer.isServiced ? null : new Date(),
            },
          });

      if (existing) summary.customersUpdated += 1;
      else summary.customersCreated += 1;

      const siteIds = new Map<string, string>();
      const siteBranchIds = new Map<string, string>();
      const siteBranchCodes = new Map<string, BranchCode>();
      for (const site of customer.sites) {
        const decision = siteDecisions.get(site.name.toLowerCase());
        // Each site keeps its own branch, even when that differs from its
        // customer's. A bank with branches island-wide is served by whichever
        // crew is nearer to each one.
        const siteBranch = decision?.branchCode ?? customerBranch;
        const siteBranchId = branches.get(siteBranch) ?? customerBranchId;

        if (siteBranch === BranchCode.KANDY) summary.sitesInKandy += 1;
        else summary.sitesInColombo += 1;
        if (decision?.confidence === 'uncertain') summary.sitesUncertain += 1;

        const existingSite = await tx.serviceSite.findFirst({
          where: { customerId: record.id, name: site.name },
          select: { id: true },
        });

        const siteRecord = existingSite
          ? await tx.serviceSite.update({
              where: { id: existingSite.id },
              data: {
                addressLine: site.addressLine,
                branchId: siteBranchId,
                branchCode: siteBranch,
                ...activation(site.isServiced),
              },
            })
          : await tx.serviceSite.create({
              data: {
                customerId: record.id,
                name: site.name,
                addressLine: site.addressLine,
                branchId: siteBranchId,
                branchCode: siteBranch,
                isActive: site.isServiced,
                importedInactiveAt: site.isServiced ? null : new Date(),
              },
            });

        siteIds.set(site.name.toLowerCase(), siteRecord.id);
        siteBranchIds.set(siteRecord.id, siteBranchId);
        siteBranchCodes.set(siteRecord.id, siteBranch);
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
          branchId: siteBranchIds.get(siteId) ?? customerBranchId,
          branchCode: siteBranchCodes.get(siteId) ?? customerBranch,
          frequencyCount: agreement.frequency.frequency.count,
          frequencyUnit: agreement.frequency.frequency.unit,
          frequencyInterval: agreement.frequency.frequency.interval,
          crewSize: agreement.effort.crewSize ?? jobType.defaultCrewSize,
          durationMinutes: agreement.effort.durationMinutes ?? jobType.defaultDurationMinutes,
          startDate,
          endDate: agreement.endDate
            ? new Date(`${agreement.endDate}T00:00:00.000Z`)
            : null,
          // An agreement on a site nobody services any more is kept, not deleted
          // — it is the record of what was once promised, and its past visits
          // still hang off it. ARCHIVED is what keeps it out of generation and
          // out of the optimizer without losing any of that.
          status: agreement.isServiced ? AgreementStatus.ACTIVE : AgreementStatus.ARCHIVED,
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

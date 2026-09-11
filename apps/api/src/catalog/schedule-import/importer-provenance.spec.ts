/**
 * What a re-import is forbidden to do.
 *
 * Two separate promises, both of which only hold if the importer writes
 * nothing at all for the affected columns. A record the workbook once marked
 * red stays off until a person says otherwise, and a value a manager typed is
 * never replaced by an assumption read out of a spreadsheet.
 *
 * Asserted on the write payload rather than on the database, because the bug
 * this guards against is exactly a column creeping back into `data` — a test
 * that only checked the final row would pass on a write that happened to
 * re-set the same value, and fail to notice the day it did not.
 */
import {
  AgreementStatus,
  BranchCode,
  DataProvenance,
  FrequencyUnit,
  Weekday,
} from '@prisma/client';

import { importSchedule } from './importer';
import { ParsedSchedule } from './types';

const CUSTOMER = 'Re-import Test Co';
const SITE = 'Re-import Test Co — Head Office';

const COLOMBO_BRANCH = 'colombo-branch';
const CUSTOMER_ID = 'customer-id';
const SITE_ID = 'site-id';
const AGREEMENT_ID = 'agreement-id';
const JOB_TYPE_ID = 'job-type-id';

/** The workbook as it reads once the red fill has been taken off again. */
function servicedSchedule(): ParsedSchedule {
  return {
    customers: [
      {
        name: CUSTOMER,
        sourceSheet: 'Main',
        isServiced: true,
        sites: [
          {
            name: SITE,
            addressLine: '1 Test Road, Colombo 03',
            regionLabel: 'Metro',
            locationCode: 'HO-1',
            isServiced: true,
          },
        ],
        agreements: [
          {
            siteName: SITE,
            isServiced: true,
            treatmentCodes: ['GPC'],
            frequency: {
              kind: 'parsed',
              frequency: { count: 2, unit: FrequencyUnit.MONTH, interval: 1 },
              source: 'Twice a month',
            },
            dayRule: {
              kind: 'parsed',
              allowedDays: [Weekday.MONDAY],
              source: 'Monday',
            },
            effort: { durationMinutes: 90, crewSize: 3 },
            endDate: null,
            notes: null,
          },
        ],
      },
    ],
    issues: [],
    sheetSummary: [],
  } as unknown as ParsedSchedule;
}

interface ExistingState {
  customerImportedInactiveAt: Date | null;
  siteImportedInactiveAt: Date | null;
  siteBranchSource: string;
  agreementImportedInactiveAt: Date | null;
  agreementProvenance: DataProvenance;
}

function fixture(state: Partial<ExistingState> = {}) {
  const existing: ExistingState = {
    customerImportedInactiveAt: null,
    siteImportedInactiveAt: null,
    siteBranchSource: 'FALLBACK_DEFAULT',
    agreementImportedInactiveAt: null,
    agreementProvenance: DataProvenance.SOURCE,
    ...state,
  };

  const tx = {
    customer: {
      findFirst: jest.fn(async () => ({ id: CUSTOMER_ID })),
      update: jest.fn(async () => ({ id: CUSTOMER_ID })),
      create: jest.fn(),
    },
    serviceSite: {
      findFirst: jest.fn(async () => ({
        id: SITE_ID,
        branchId: COLOMBO_BRANCH,
        branchCode: BranchCode.COLOMBO,
        branchSource: existing.siteBranchSource,
      })),
      update: jest.fn(async () => ({
        id: SITE_ID,
        branchId: COLOMBO_BRANCH,
        branchCode: BranchCode.COLOMBO,
      })),
      create: jest.fn(),
    },
    jobType: {
      findUniqueOrThrow: jest.fn(async () => ({
        id: JOB_TYPE_ID,
        defaultCrewSize: 2,
        defaultDurationMinutes: 60,
      })),
    },
    serviceAgreement: {
      findFirst: jest.fn(async () => ({
        id: AGREEMENT_ID,
        importedInactiveAt: existing.agreementImportedInactiveAt,
        crewSizeProvenance: existing.agreementProvenance,
        durationProvenance: existing.agreementProvenance,
        dayRuleProvenance: existing.agreementProvenance,
      })),
      update: jest.fn(async () => ({ id: AGREEMENT_ID })),
      create: jest.fn(),
    },
  };

  const prisma = {
    branch: {
      findMany: jest.fn(async () => [
        { id: COLOMBO_BRANCH, code: BranchCode.COLOMBO },
      ]),
    },
    jobType: {
      findUnique: jest.fn(async () => ({ id: JOB_TYPE_ID })),
      create: jest.fn(),
    },
    $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) =>
      work(tx),
    ),
  };

  return { prisma, tx };
}

function dataOf(mock: jest.Mock): Record<string, unknown> {
  expect(mock).toHaveBeenCalledTimes(1);
  return (mock.mock.calls[0][0] as { data: Record<string, unknown> }).data;
}

describe('re-importing a record the workbook once marked red', () => {
  const markedAt = new Date('2026-09-03T00:00:00.000Z');

  it('leaves a deactivated customer and site alone, and never clears the marking', async () => {
    const { prisma, tx } = fixture({
      customerImportedInactiveAt: markedAt,
      siteImportedInactiveAt: markedAt,
    });

    await importSchedule(prisma as never, servicedSchedule());

    // The serviced branch of `activation` writes nothing about being active:
    // a fill somebody removed is not evidence the client came back.
    const customerData = dataOf(tx.customer.update as jest.Mock);
    expect(customerData).not.toHaveProperty('isActive');
    expect(customerData).not.toHaveProperty('importedInactiveAt');

    const siteData = dataOf(tx.serviceSite.update as jest.Mock);
    expect(siteData).not.toHaveProperty('isActive');
    expect(siteData).not.toHaveProperty('importedInactiveAt');
  });

  it('leaves an importer-archived agreement archived', async () => {
    const { prisma, tx } = fixture({ agreementImportedInactiveAt: markedAt });

    await importSchedule(prisma as never, servicedSchedule());

    const data = dataOf(tx.serviceAgreement.update as jest.Mock);
    expect(data).not.toHaveProperty('status');
    expect(data).not.toHaveProperty('importedInactiveAt');
  });

  it('makes an agreement active again only once the marking is already gone', async () => {
    // What the manager's reactivation leaves behind: no marking. The importer
    // may then treat the agreement normally — but still writes no marking of
    // its own, so nothing it does can erase that decision.
    const { prisma, tx } = fixture({ agreementImportedInactiveAt: null });

    await importSchedule(prisma as never, servicedSchedule());

    const data = dataOf(tx.serviceAgreement.update as jest.Mock);
    expect(data).toMatchObject({ status: AgreementStatus.ACTIVE });
    expect(data).not.toHaveProperty('importedInactiveAt');
  });
});

describe('re-importing over manager-confirmed values', () => {
  it('keeps a manager-confirmed site branch and does not restate its confidence', async () => {
    const { prisma, tx } = fixture({ siteBranchSource: 'MANAGER_CONFIRMED' });

    await importSchedule(prisma as never, servicedSchedule());

    const data = dataOf(tx.serviceSite.update as jest.Mock);
    expect(data).toMatchObject({
      branchId: COLOMBO_BRANCH,
      branchCode: BranchCode.COLOMBO,
    });
    expect(data).not.toHaveProperty('branchConfidence');
    expect(data).not.toHaveProperty('branchSource');
  });

  it('keeps manager-confirmed crew size, duration and day rules', async () => {
    const { prisma, tx } = fixture({
      agreementProvenance: DataProvenance.MANAGER_CONFIRMED,
    });

    await importSchedule(prisma as never, servicedSchedule());

    const data = dataOf(tx.serviceAgreement.update as jest.Mock);
    for (const column of [
      'crewSize',
      'crewSizeProvenance',
      'durationMinutes',
      'durationProvenance',
      'dayRuleProvenance',
      'dayRules',
    ]) {
      expect(data).not.toHaveProperty(column);
    }
    // The workbook is still authoritative for what it does state.
    expect(data).toMatchObject({ frequencyCount: 2, frequencyUnit: FrequencyUnit.MONTH });
  });

  it('still overwrites values no manager has confirmed', async () => {
    const { prisma, tx } = fixture({ agreementProvenance: DataProvenance.DEFAULTED });

    await importSchedule(prisma as never, servicedSchedule());

    expect(dataOf(tx.serviceAgreement.update as jest.Mock)).toMatchObject({
      crewSize: 3,
      crewSizeProvenance: DataProvenance.SOURCE,
      durationMinutes: 90,
      durationProvenance: DataProvenance.SOURCE,
      dayRuleProvenance: DataProvenance.SOURCE,
    });
  });
});

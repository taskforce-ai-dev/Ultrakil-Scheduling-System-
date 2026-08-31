/**
 * Tests the master-schedule importer's database writes.
 *
 * The real workbook holds live customer data and is never committed, so it
 * cannot be a fixture. These tests hand the importer a small parsed structure
 * instead — that is the seam that matters here, because the risk in this code
 * is not reading the spreadsheet (unit-tested against real strings elsewhere)
 * but what it writes: duplicating customers on a re-run, or creating an
 * agreement from a row nobody could interpret.
 */
import { AgreementStatus, FrequencyUnit, PrismaClient, Weekday } from '@prisma/client';

import { importSchedule } from '../../src/catalog/schedule-import/importer';
import { ParsedSchedule } from '../../src/catalog/schedule-import/types';

const prisma = new PrismaClient();

/** Unique per run: this database keeps its rows between runs. */
const suffix = Math.random().toString(36).slice(2, 8);
const CUSTOMER = `Import Test Co ${suffix}`;

function buildSchedule(overrides: Partial<ParsedSchedule> = {}): ParsedSchedule {
  return {
    customers: [
      {
        name: CUSTOMER,
        sourceSheet: 'Main',
        sites: [
          {
            name: `${CUSTOMER} — Head Office`,
            addressLine: '1 Test Road, Colombo 03',
            regionLabel: 'Metro',
            locationCode: 'HO-1',
          },
        ],
        agreements: [
          {
            siteName: `${CUSTOMER} — Head Office`,
            treatmentCodes: ['GPC', 'RC'],
            frequency: {
              kind: 'parsed',
              frequency: { count: 2, unit: FrequencyUnit.MONTH },
              source: 'Twice a month',
            },
            dayRule: {
              kind: 'parsed',
              allowedDays: [Weekday.MONDAY, Weekday.THURSDAY],
              source: 'Monday, Thursday',
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
    ...overrides,
  };
}

beforeAll(async () => {
  await prisma.$connect();
  await prisma.branch.upsert({
    where: { code: 'COLOMBO' },
    create: { code: 'COLOMBO', name: 'Colombo Branch' },
    update: {},
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('master schedule import', () => {
  it('creates the customer, its site and the agreement', async () => {
    const summary = await importSchedule(prisma, buildSchedule());

    expect(summary.customersCreated).toBe(1);
    expect(summary.sitesCreated).toBe(1);
    expect(summary.agreementsCreated).toBe(1);

    const customer = await prisma.customer.findFirstOrThrow({
      where: { name: CUSTOMER },
      include: {
        serviceSites: true,
        serviceAgreements: { include: { dayRules: true } },
      },
    });

    expect(customer.branchCode).toBe('COLOMBO');
    expect(customer.serviceSites[0].addressLine).toBe('1 Test Road, Colombo 03');

    const agreement = customer.serviceAgreements[0];
    expect(agreement).toMatchObject({
      frequencyCount: 2,
      frequencyUnit: FrequencyUnit.MONTH,
      // Taken from the workbook's "Duration and PCT", not the job type default.
      crewSize: 3,
      durationMinutes: 90,
      status: AgreementStatus.ACTIVE,
    });
    expect(agreement.dayRules.map((rule) => rule.weekday).sort()).toEqual([
      Weekday.MONDAY,
      Weekday.THURSDAY,
    ]);
  });

  it('updates rather than duplicating when run a second time', async () => {
    const summary = await importSchedule(prisma, buildSchedule());

    expect(summary.customersCreated).toBe(0);
    expect(summary.customersUpdated).toBe(1);
    expect(summary.sitesCreated).toBe(0);
    expect(summary.agreementsCreated).toBe(0);
    expect(summary.agreementsUpdated).toBe(1);

    const customers = await prisma.customer.findMany({ where: { name: CUSTOMER } });
    expect(customers).toHaveLength(1);
  });

  it('imports the site but skips the agreement when the frequency is unsupported', async () => {
    const name = `Fortnightly Co ${suffix}`;
    const schedule = buildSchedule();
    schedule.customers = [
      {
        ...schedule.customers[0],
        name,
        sites: [{ name: `${name} — Site`, addressLine: null, regionLabel: null, locationCode: null }],
        agreements: [
          {
            ...schedule.customers[0].agreements[0],
            siteName: `${name} — Site`,
            frequency: {
              kind: 'unsupported',
              source: 'Fortnightly',
              reason: 'fortnightly is neither weekly nor monthly',
            },
          },
        ],
      },
    ];

    const summary = await importSchedule(prisma, schedule);

    // The customer is a fact the workbook states; the agreement is not.
    expect(summary.sitesCreated).toBe(1);
    expect(summary.agreementsCreated).toBe(0);
    expect(summary.agreementsSkipped).toBe(1);

    const stored = await prisma.customer.findFirstOrThrow({
      where: { name },
      include: { serviceAgreements: true },
    });
    expect(stored.serviceAgreements).toHaveLength(0);
  });

  it('records in the notes when the allowed days were derived, not stated', async () => {
    const name = `Derived Days Co ${suffix}`;
    const schedule = buildSchedule();
    schedule.customers = [
      {
        ...schedule.customers[0],
        name,
        sites: [{ name: `${name} — Site`, addressLine: null, regionLabel: null, locationCode: null }],
        agreements: [
          {
            ...schedule.customers[0].agreements[0],
            siteName: `${name} — Site`,
            dayRule: {
              kind: 'derived',
              allowedDays: [Weekday.FRIDAY],
              sampleSize: 6,
              evidence: 'FRI×6',
            },
          },
        ],
      },
    ];

    await importSchedule(prisma, schedule);

    const agreement = await prisma.serviceAgreement.findFirstOrThrow({
      where: { customer: { name } },
    });

    // Anyone reading this agreement must be able to tell that its days were
    // inferred from past bookings rather than agreed with the customer.
    expect(agreement.notes).toMatch(/were not stated/);
    expect(agreement.notes).toMatch(/FRI×6/);
    expect(agreement.notes).toMatch(/Confirm with the customer/);
  });

  it('reuses one job type per treatment combination', async () => {
    const before = await prisma.jobType.count({ where: { code: { startsWith: 'IMPORTED_' } } });
    await importSchedule(prisma, buildSchedule());
    const after = await prisma.jobType.count({ where: { code: { startsWith: 'IMPORTED_' } } });

    expect(after).toBe(before);
  });
});

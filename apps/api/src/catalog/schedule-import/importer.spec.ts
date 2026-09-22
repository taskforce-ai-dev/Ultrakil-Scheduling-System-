import { BranchCode, DataProvenance, FrequencyUnit, Weekday } from '@prisma/client';

import { importSchedule } from './importer';
import { ParsedSchedule } from './types';

describe('importSchedule transaction boundary', () => {
  it('allows each remote customer reconciliation up to two minutes', async () => {
    const stopped = new Error('stop before executing the transaction body');
    const prisma = {
      branch: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'colombo-branch', code: BranchCode.COLOMBO },
        ]),
      },
      $transaction: jest.fn().mockRejectedValue(stopped),
    };
    const parsed = {
      customers: [
        {
          name: 'Customer',
          isServiced: true,
          sourceSheet: 'Schedule',
          sites: [],
          agreements: [],
        },
      ],
      issues: [],
    };

    await expect(
      importSchedule(prisma as never, parsed as never),
    ).rejects.toBe(stopped);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 120_000,
    });
  });
});

/**
 * The booking writes, against a recording stand-in for Prisma.
 *
 * What matters here is the shape of the write — that a re-import clears only
 * the rows the workbook itself put there — and that is a property of the
 * statements issued, not of the database. The integration suite proves the
 * same thing against real rows.
 */
/** A recording stand-in for Prisma: what matters is the shape of the writes. */
function fakePrisma() {
  const booking = {
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    createMany: jest.fn().mockResolvedValue({ count: 0 }),
  };
  const tx = {
    customer: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'customer-1' }),
      update: jest.fn(),
    },
    serviceSite: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({
        id: 'site-1',
        branchId: 'colombo-branch',
        branchCode: BranchCode.COLOMBO,
      }),
      update: jest.fn(),
    },
    jobType: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        id: 'job-1',
        defaultCrewSize: 2,
        defaultDurationMinutes: 60,
      }),
    },
    serviceAgreement: {
      // What the customer already has, which the import locks in id order
      // before it updates any of it.
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'agreement-1' }),
      update: jest.fn().mockResolvedValue({ id: 'agreement-1' }),
    },
    serviceAgreementBooking: booking,
    $queryRaw: jest.fn().mockResolvedValue([]),
    // The per-customer advisory lock, held before the existence check.
    $executeRaw: jest.fn().mockResolvedValue(1),
  };

  const prisma = {
    branch: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'colombo-branch', code: BranchCode.COLOMBO }]),
    },
    jobType: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'job-1' }),
    },
    $transaction: jest.fn(async (run: (client: unknown) => Promise<unknown>) => run(tx)),
  };

  return { prisma, tx, booking };
}

describe('importSchedule booking writes', () => {
  function scheduleWith(bookedDates: string[]): ParsedSchedule {
    return {
      customers: [
        {
          name: 'Booking Co',
          sourceSheet: 'Main',
          isServiced: true,
          sites: [
            {
              name: 'Head Office',
              addressLine: null,
              regionLabel: null,
              locationCode: null,
              isServiced: true,
            },
          ],
          agreements: [
            {
              siteName: 'Head Office',
              isServiced: true,
              treatmentCodes: ['GPC'],
              frequency: {
                kind: 'parsed',
                frequency: { count: 1, unit: FrequencyUnit.MONTH, interval: 1 },
                source: 'Monthly',
              },
              dayRule: {
                kind: 'parsed',
                allowedDays: [Weekday.MONDAY],
                source: 'Monday',
              },
              effort: { durationMinutes: 90, crewSize: 2 },
              endDate: null,
              bookedDates,
              notes: null,
            },
          ],
        },
      ],
      issues: [],
      sheetSummary: [],
    };
  }


  it('writes one SOURCE row per booked date', async () => {
    const { prisma, booking } = fakePrisma();

    await importSchedule(prisma as never, scheduleWith(['2026-01-05', '2026-01-20']));

    expect(booking.createMany).toHaveBeenCalledWith({
      data: [
        {
          serviceAgreementId: 'agreement-1',
          bookedDate: new Date('2026-01-05T00:00:00.000Z'),
          provenance: DataProvenance.SOURCE,
        },
        {
          serviceAgreementId: 'agreement-1',
          bookedDate: new Date('2026-01-20T00:00:00.000Z'),
          provenance: DataProvenance.SOURCE,
        },
      ],
      skipDuplicates: true,
    });
  });

  it('clears only its own SOURCE rows before writing, so a manager entry survives', async () => {
    const { prisma, booking } = fakePrisma();

    await importSchedule(prisma as never, scheduleWith(['2026-01-05']));

    expect(booking.deleteMany).toHaveBeenCalledWith({
      where: {
        serviceAgreementId: 'agreement-1',
        provenance: DataProvenance.SOURCE,
      },
    });
    const deleteOrder = booking.deleteMany.mock.invocationCallOrder[0];
    const createOrder = booking.createMany.mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(createOrder);
  });

  it('still clears its old rows when the workbook now books nothing', async () => {
    const { prisma, booking } = fakePrisma();

    await importSchedule(prisma as never, scheduleWith([]));

    expect(booking.deleteMany).toHaveBeenCalledTimes(1);
    expect(booking.createMany).not.toHaveBeenCalled();
  });
});

/**
 * Two workbook rows that resolve to one agreement.
 *
 * The master schedule writes the same site and treatment more than once, and
 * each row carries its own booked dates. Clearing the agreement's imported
 * bookings per *row* meant the second row's delete threw away what the first
 * had just written, so the agreement kept whichever row came last. And the
 * count reported to the manager was the number of dates offered rather than
 * the number of rows the database created, which `skipDuplicates` can cut.
 */
describe('importSchedule booking writes across rows of one agreement', () => {
  function twoRows(first: string[], second: string[]): ParsedSchedule {
    const agreementRow = (bookedDates: string[]) => ({
      siteName: 'Head Office',
      isServiced: true,
      treatmentCodes: ['GPC'],
      frequency: {
        kind: 'parsed' as const,
        frequency: { count: 1, unit: FrequencyUnit.MONTH, interval: 1 },
        source: 'Monthly',
      },
      dayRule: {
        kind: 'parsed' as const,
        allowedDays: [Weekday.MONDAY],
        source: 'Monday',
      },
      effort: { durationMinutes: 90, crewSize: 2 },
      endDate: null,
      bookedDates,
      notes: null,
    });

    return {
      customers: [
        {
          name: 'Twice Co',
          sourceSheet: 'Main',
          isServiced: true,
          sites: [
            {
              name: 'Head Office',
              addressLine: null,
              regionLabel: null,
              locationCode: null,
              isServiced: true,
            },
          ],
          agreements: [agreementRow(first), agreementRow(second)],
        },
      ],
      issues: [],
      sheetSummary: [],
    };
  }

  it('clears the agreement once, so the first row\'s dates survive the second', async () => {
    const { prisma, booking } = fakePrisma();
    booking.createMany.mockImplementation(
      async ({ data }: { data: unknown[] }) => ({ count: data.length }),
    );

    await importSchedule(prisma as never, twoRows(['2026-01-05'], ['2026-02-09']));

    expect(booking.deleteMany).toHaveBeenCalledTimes(1);
    expect(booking.createMany).toHaveBeenCalledTimes(2);
    const written = booking.createMany.mock.calls.flatMap(
      ([call]: [{ data: { bookedDate: Date }[] }]) =>
        call.data.map((row) => row.bookedDate.toISOString().slice(0, 10)),
    );
    expect(written).toEqual(['2026-01-05', '2026-02-09']);
  });

  it('counts the rows the database created, not the dates it was offered', async () => {
    const { prisma, booking } = fakePrisma();
    // The manager already holds one of these days, so the insert skips it.
    booking.createMany.mockResolvedValue({ count: 1 });

    const summary = await importSchedule(
      prisma as never,
      twoRows(['2026-01-05', '2026-01-20'], []),
    );

    expect(summary.bookingsImported).toBe(1);
  });
});

/**
 * The anchor a re-import must not move.
 *
 * `startDate` is not bookkeeping on this branch: `periodIndexOf` counts an
 * agreement's periods from it, so a fortnightly agreement's fortnights are the
 * two ISO weeks from the week it began in, and a quarterly agreement's
 * quarters the three-month blocks from the month it began in. The importer
 * stamped it with the day the import ran, for updates as well as creates — so
 * re-uploading a corrected workbook a week later silently moved the period
 * boundaries of every cadence with an interval above one, and the "ask for the
 * same range twice and nothing changes" property did not survive it. Weekly
 * and monthly agreements were spared only because each week and each month is
 * its own period.
 */
describe('importSchedule and the period anchor', () => {
  function scheduleForAnchor(): ParsedSchedule {
    return {
      customers: [
        {
          name: 'Anchor Co',
          sourceSheet: 'Main',
          isServiced: true,
          sites: [
            {
              name: 'Head Office',
              addressLine: null,
              regionLabel: null,
              locationCode: null,
              isServiced: true,
            },
          ],
          agreements: [
            {
              siteName: 'Head Office',
              isServiced: true,
              treatmentCodes: ['GPC'],
              frequency: {
                kind: 'parsed',
                frequency: { count: 1, unit: FrequencyUnit.WEEK, interval: 2 },
                source: 'Fortnightly',
              },
              dayRule: {
                kind: 'parsed',
                allowedDays: [Weekday.MONDAY],
                source: 'Monday',
              },
              effort: { durationMinutes: 90, crewSize: 2 },
              endDate: null,
              bookedDates: [],
              notes: null,
            },
          ],
        },
      ],
      issues: [],
      sheetSummary: [],
    };
  }

  it('leaves an existing agreement the anchor it has always had', async () => {
    const { prisma, tx } = fakePrisma();
    tx.serviceAgreement.findFirst.mockResolvedValue({
      id: 'agreement-1',
      importedInactiveAt: null,
      crewSizeProvenance: DataProvenance.SOURCE,
      durationProvenance: DataProvenance.SOURCE,
      dayRuleProvenance: DataProvenance.SOURCE,
    });

    await importSchedule(prisma as never, scheduleForAnchor());

    expect(tx.serviceAgreement.update).toHaveBeenCalledTimes(1);
    const { data } = tx.serviceAgreement.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(data).not.toHaveProperty('startDate');
    // The rest of the workbook's reading is still applied.
    expect(data).toHaveProperty('endDate', null);
    expect(data).toHaveProperty('frequencyInterval', 2);
  });

  it('gives a newly created agreement the day the import ran', async () => {
    const { prisma, tx } = fakePrisma();

    await importSchedule(prisma as never, scheduleForAnchor());

    expect(tx.serviceAgreement.create).toHaveBeenCalledTimes(1);
    const { data } = tx.serviceAgreement.create.mock.calls[0][0] as {
      data: { startDate: Date };
    };
    expect(data.startDate).toEqual(
      new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`),
    );
  });
});

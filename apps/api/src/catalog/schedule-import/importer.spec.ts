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
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'agreement-1' }),
        update: jest.fn().mockResolvedValue({ id: 'agreement-1' }),
      },
      serviceAgreementBooking: booking,
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

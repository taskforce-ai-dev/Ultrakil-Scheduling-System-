/**
 * A hand-corrected visit window is a manager's fact, not an assumption.
 *
 * Generation stamps `windowProvenance` DEFAULTED when it had to fall back to
 * the disclosed 08:00-17:00 assumption, and the operations read model turns
 * that into a source-data warning. Once a manager has actually set the window,
 * the warning is wrong — so the correction has to say so.
 */
import { DataProvenance, UserRole, VisitStatus } from '@prisma/client';

import { AuditService } from '../../audit/audit.service';
import { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../prisma/prisma.service';
import { EligibilityService } from '../eligibility/eligibility.service';
import { VisitsService } from './visits.service';

const actor = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'admin@example.test',
  fullName: 'Admin',
  role: UserRole.ADMIN,
} as AuthenticatedUser;

const VISIT_ID = '11111111-1111-4111-8111-111111111111';

function visitRow(overrides: Record<string, unknown> = {}) {
  return {
    id: VISIT_ID,
    serviceAgreementId: '22222222-2222-4222-8222-222222222222',
    branchId: '33333333-3333-4333-8333-333333333333',
    branchCode: 'COLOMBO',
    visitDate: new Date('2026-09-07T00:00:00.000Z'),
    windowStartMinute: 480,
    windowEndMinute: 1020,
    durationMinutes: 60,
    requiredCrewSize: 2,
    // What the importer's silence leaves behind.
    windowProvenance: DataProvenance.DEFAULTED,
    status: VisitStatus.PENDING,
    isManuallyAdjusted: false,
    manuallyAdjustedAt: null,
    manuallyAdjustedBy: null,
    lockedAt: null,
    lockedByUserId: null,
    lockReason: null,
    generatedByRunId: null,
    agreementVersionId: null,
    agreementVersion: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    serviceAgreement: {
      id: '22222222-2222-4222-8222-222222222222',
      frequencyCount: 1,
      frequencyUnit: 'WEEK',
      frequencyInterval: 1,
      customer: { id: '44444444-4444-4444-8444-444444444444', name: 'Customer' },
      serviceSite: {
        id: '55555555-5555-4555-8555-555555555555',
        name: 'Site',
        _count: { operatingHours: 0 },
      },
      jobType: { name: 'Job' },
    },
    _count: { assignments: 0 },
    // The live assignment's crew, as VISIT_INCLUDE reads it.
    assignments: [],
    ...overrides,
  };
}

function fixture(row = visitRow()) {
  const tx = {
    // The row locks the real transaction takes; nothing to fence in a unit test.
    $queryRaw: jest.fn(async () => [{ id: VISIT_ID }]),
    assignment: { findMany: jest.fn(async () => []) },
    visitUnassignedReason: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    generatedVisit: {
      findUnique: jest.fn(async () => row),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...row,
        ...data,
      })),
    },
  };

  const prisma = {
    $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) =>
      work(tx),
    ),
  };

  const service = new VisitsService(
    prisma as unknown as PrismaService,
    { record: jest.fn() } as unknown as AuditService,
    { evaluate: jest.fn() } as unknown as EligibilityService,
  );

  return { service, tx };
}

function dataOf(mock: jest.Mock): Record<string, unknown> {
  expect(mock).toHaveBeenCalledTimes(1);
  return (mock.mock.calls[0][0] as { data: Record<string, unknown> }).data;
}

/**
 * The run that generated a visit, named the way a screen can print it.
 *
 * The detail panel used to render `generatedByRunId` as a raw uuid under
 * "Schedule run". A uuid tells a manager nothing they can act on, and the run
 * is recognised — everywhere else in the portal — by the weeks it covered. So
 * the origin carries the run's own horizon, and the id stays in the payload
 * for links and is never printed.
 */
describe('VisitsService origin', () => {
  function detailFixture(row: Record<string, unknown>, run: unknown) {
    const prisma = {
      generatedVisit: { findUnique: jest.fn(async () => row) },
      scheduleRun: { findUnique: jest.fn(async () => run) },
      // The visit's own hand-edit history, which `get` reads alongside origin.
      auditEvent: { findMany: jest.fn(async () => []) },
    };
    const service = new VisitsService(
      prisma as unknown as PrismaService,
      { record: jest.fn() } as unknown as AuditService,
      { evaluate: jest.fn() } as unknown as EligibilityService,
    );
    return { service, prisma };
  }

  it("carries the generating run's own horizon, so a screen never prints its id", async () => {
    const { service } = detailFixture(
      visitRow({ generatedByRunId: '66666666-6666-4666-8666-666666666666' }),
      {
        rangeStart: new Date('2026-09-15T00:00:00.000Z'),
        rangeEnd: new Date('2026-09-21T00:00:00.000Z'),
      },
    );

    const detail = await service.get(VISIT_ID);

    expect(detail.origin.generatedByRunRangeStart).toBe('2026-09-15');
    expect(detail.origin.generatedByRunRangeEnd).toBe('2026-09-21');
  });

  it('leaves the horizon null for a visit no run generated', async () => {
    const { service, prisma } = detailFixture(visitRow(), null);

    const detail = await service.get(VISIT_ID);

    expect(detail.origin.generatedByRunRangeStart).toBeNull();
    expect(detail.origin.generatedByRunRangeEnd).toBeNull();
    // Nothing to look up, so nothing is asked for.
    expect(prisma.scheduleRun.findUnique).not.toHaveBeenCalled();
  });
});

describe('VisitsService window provenance', () => {
  it('records a hand-corrected window as manager confirmed', async () => {
    const { service, tx } = fixture();

    await service.adjust(VISIT_ID, { windowStartMinute: 600 }, actor);

    expect(dataOf(tx.generatedVisit.update as jest.Mock)).toMatchObject({
      windowStartMinute: 600,
      windowProvenance: DataProvenance.MANAGER_CONFIRMED,
      isManuallyAdjusted: true,
    });
  });

  it('leaves the window unconfirmed when the edit never touched it', async () => {
    // Changing how many people a visit needs says nothing about whether the
    // assumed opening hours behind its window were right.
    const { service, tx } = fixture();

    await service.adjust(VISIT_ID, { requiredCrewSize: 3 }, actor);

    const data = dataOf(tx.generatedVisit.update as jest.Mock);
    expect(data).toMatchObject({ requiredCrewSize: 3, isManuallyAdjusted: true });
    expect(data).not.toHaveProperty('windowProvenance');
  });
});

/**
 * Stored reasons are an answer about a particular day.
 *
 * Every conflict a run records names the date, the times and the people that
 * clashed on the day the visit was standing on when it was judged: "A Perera
 * is already on another job from 09:00 to 11:00 on 2026-09-18." Move the visit
 * by hand and none of that is about this visit any more — but the rows stayed,
 * so the Unassigned queue went on citing clashes on a Friday for a visit now
 * on the Monday, while the Edit crew drawer, which checks live, correctly
 * named the Monday. Two screens, the same visit, different days.
 *
 * A visit whose reasons are dropped reads in the queue as not yet checked,
 * which is exactly what it is: nobody has evaluated it where it now stands.
 */
describe('VisitsService stale unassigned reasons', () => {
  it('drops stored reasons when a hand edit moves the visit to another day', async () => {
    const { service, tx } = fixture();

    await service.adjust(VISIT_ID, { visitDate: '2026-09-21' }, actor);

    expect(tx.visitUnassignedReason.deleteMany).toHaveBeenCalledWith({
      where: { generatedVisitId: VISIT_ID },
    });
  });

  it('drops them when the window or the duration moves under them too', async () => {
    // "from 09:00 to 11:00" is as much a part of a recorded clash as the date.
    const first = fixture();
    await first.service.adjust(VISIT_ID, { windowStartMinute: 600 }, actor);
    expect(first.tx.visitUnassignedReason.deleteMany).toHaveBeenCalled();

    const second = fixture();
    await second.service.adjust(VISIT_ID, { durationMinutes: 120 }, actor);
    expect(second.tx.visitUnassignedReason.deleteMany).toHaveBeenCalled();

    const third = fixture();
    await third.service.adjust(VISIT_ID, { requiredCrewSize: 3 }, actor);
    expect(third.tx.visitUnassignedReason.deleteMany).toHaveBeenCalled();
  });

  it('keeps them when the edit changed nothing the engine judged', async () => {
    // A note against an unchanged visit is not new information about its day,
    // and throwing the reasons away would tell the queue the visit had never
    // been looked at.
    const { service, tx } = fixture();

    await service.adjust(VISIT_ID, { reason: 'Noted for the file' }, actor);

    expect(tx.visitUnassignedReason.deleteMany).not.toHaveBeenCalled();
  });
});

describe('VisitsService window invariants', () => {
  /** A booked day whose recorded hours are shorter than the visit needs. */
  const tooShort = () =>
    visitRow({ windowStartMinute: 540, windowEndMinute: 600, durationMinutes: 90 });

  it('lets a manager change the crew of a visit whose window is already short', async () => {
    // The window came from a booking on hours the site itself records as an
    // hour. It is reported as a booking warning, and it is not this edit's
    // business — refusing the crew change left the visit uneditable for ever.
    const { service, tx } = fixture(tooShort());

    await service.adjust(VISIT_ID, { requiredCrewSize: 3 }, actor);

    expect(dataOf(tx.generatedVisit.update as jest.Mock)).toMatchObject({
      requiredCrewSize: 3,
    });
  });

  it('still refuses an edit that makes the window too short for the visit', async () => {
    const { service } = fixture();

    await expect(
      service.adjust(VISIT_ID, { durationMinutes: 900 }, actor),
    ).rejects.toMatchObject({ code: 'SERVICE_WINDOW_INVALID' });
  });

  it('still refuses a narrowed window that no longer holds the visit', async () => {
    const { service } = fixture();

    await expect(
      service.adjust(VISIT_ID, { windowEndMinute: 500 }, actor),
    ).rejects.toMatchObject({ code: 'SERVICE_WINDOW_INVALID' });
  });

  it('still refuses a window that ends before it starts', async () => {
    const { service } = fixture();

    await expect(
      service.adjust(VISIT_ID, { windowStartMinute: 1020, windowEndMinute: 480 }, actor),
    ).rejects.toMatchObject({ code: 'SERVICE_WINDOW_INVALID' });
  });
});

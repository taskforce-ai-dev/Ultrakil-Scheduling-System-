/**
 * What a manager's own write establishes about a service agreement, and what
 * the dedicated reactivation does that ordinary status changes must not.
 *
 * Crew size, duration and the allowed days are exactly the values the master
 * schedule most often failed to state, so the importer records them as
 * DEFAULTED or DERIVED. An agreement a manager wrote is a different thing
 * entirely, and a later import must not overwrite it.
 */
import {
  AgreementStatus,
  BranchCode,
  DataProvenance,
  DayRuleKind,
  FrequencyUnit,
  UserRole,
  Weekday,
} from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { AgreementsService } from './agreements.service';

const actor = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'admin@example.test',
  fullName: 'Admin',
  role: UserRole.ADMIN,
} as AuthenticatedUser;

const AGREEMENT_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const SITE_ID = '33333333-3333-4333-8333-333333333333';
const JOB_TYPE_ID = '44444444-4444-4444-8444-444444444444';
const BRANCH_ID = '55555555-5555-4555-8555-555555555555';

function agreementRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AGREEMENT_ID,
    customerId: CUSTOMER_ID,
    serviceSiteId: SITE_ID,
    jobTypeId: JOB_TYPE_ID,
    branchId: BRANCH_ID,
    branchCode: BranchCode.COLOMBO,
    frequencyCount: 1,
    frequencyUnit: FrequencyUnit.WEEK,
    frequencyInterval: 1,
    crewSize: 2,
    durationMinutes: 60,
    // How an imported row arrives: the workbook stated neither, so both are
    // the importer's own defaults and stay visibly unconfirmed.
    crewSizeProvenance: DataProvenance.DEFAULTED,
    durationProvenance: DataProvenance.DEFAULTED,
    dayRuleProvenance: DataProvenance.DERIVED,
    serviceWindowStartMinute: null,
    serviceWindowEndMinute: null,
    startDate: new Date('2026-09-07T00:00:00.000Z'),
    endDate: null,
    status: AgreementStatus.ACTIVE,
    importedInactiveAt: null as Date | null,
    currentVersion: 1,
    notes: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    customer: { id: CUSTOMER_ID, name: 'Customer' },
    serviceSite: { id: SITE_ID, name: 'Site' },
    jobType: { id: JOB_TYPE_ID, name: 'Job' },
    dayRules: [{ id: 'day-1', weekday: Weekday.MONDAY, kind: DayRuleKind.ALLOWED }],
    requiredSkills: [],
    ...overrides,
  };
}

/**
 * What Prisma would return: the scalar columns the write set, with the nested
 * relation writes resolved back into the rows they create rather than left as
 * the `{ create: [...] }` instructions they arrive as.
 */
function applied(row: ReturnType<typeof agreementRow>, data: Record<string, unknown>) {
  const {
    dayRules,
    requiredSkills,
    currentVersion,
    ...scalars
  } = data as Record<string, never>;
  void dayRules;
  void requiredSkills;
  void currentVersion;
  return { ...row, ...scalars };
}

function fixture(row = agreementRow()) {
  const tx = {
    serviceAgreement: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) =>
        applied(row, data),
      ),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...applied(row, data),
        currentVersion: row.currentVersion + 1,
      })),
    },
    serviceAgreementDayRule: { deleteMany: jest.fn() },
    serviceAgreementRequiredSkill: { deleteMany: jest.fn() },
    serviceAgreementVersion: { create: jest.fn() },
  };

  const audit = { record: jest.fn() };
  const prisma = {
    serviceAgreement: { findUnique: jest.fn(async () => row) },
    serviceSite: {
      findUnique: jest.fn(async () => ({
        id: SITE_ID,
        customerId: CUSTOMER_ID,
        branchId: BRANCH_ID,
        branchCode: BranchCode.COLOMBO,
        name: 'Site',
        isActive: true,
        // No hours recorded — the import never fabricates any — so the
        // preview falls back to the disclosed 08:00-17:00 assumption.
        operatingHours: [],
        customer: { name: 'Customer', isActive: true },
      })),
    },
    jobType: {
      findUnique: jest.fn(async () => ({
        id: JOB_TYPE_ID,
        name: 'Job',
        isActive: true,
        defaultCrewSize: 2,
        defaultDurationMinutes: 60,
      })),
    },
    $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) =>
      work(tx),
    ),
  };

  const service = new AgreementsService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
  );

  return { service, tx, audit };
}

function dataOf(mock: jest.Mock): Record<string, unknown> {
  expect(mock).toHaveBeenCalledTimes(1);
  return (mock.mock.calls[0][0] as { data: Record<string, unknown> }).data;
}

const CREATE_PAYLOAD = {
  serviceSiteId: SITE_ID,
  jobTypeId: JOB_TYPE_ID,
  frequencyCount: 1,
  frequencyUnit: FrequencyUnit.WEEK,
  allowedDays: [Weekday.MONDAY],
  startDate: '2026-09-07',
};

describe('AgreementsService manager provenance', () => {
  it('records every value of a manager-created agreement as manager confirmed', async () => {
    const { service, tx } = fixture();

    await service.create(CREATE_PAYLOAD, actor);

    expect(dataOf(tx.serviceAgreement.create as jest.Mock)).toMatchObject({
      crewSizeProvenance: DataProvenance.MANAGER_CONFIRMED,
      durationProvenance: DataProvenance.MANAGER_CONFIRMED,
      dayRuleProvenance: DataProvenance.MANAGER_CONFIRMED,
    });
  });

  it('confirms a crew size an edit supplies, and nothing else', async () => {
    const { service, tx } = fixture();

    await service.update(AGREEMENT_ID, { crewSize: 5 }, actor);

    const data = dataOf(tx.serviceAgreement.update as jest.Mock);
    expect(data).toMatchObject({
      crewSize: 5,
      crewSizeProvenance: DataProvenance.MANAGER_CONFIRMED,
    });
    // The duration still carries the agreement's old value because update
    // rewrites the column either way — but its provenance must not move, or
    // an imported default would silently become a confirmed fact.
    expect(data).not.toHaveProperty('durationProvenance');
    expect(data).not.toHaveProperty('dayRuleProvenance');
  });

  it('confirms the day rules only when the edit changed them', async () => {
    const { service, tx } = fixture();

    await service.update(
      AGREEMENT_ID,
      { allowedDays: [Weekday.MONDAY, Weekday.THURSDAY] },
      actor,
    );

    const data = dataOf(tx.serviceAgreement.update as jest.Mock);
    expect(data).toMatchObject({
      dayRuleProvenance: DataProvenance.MANAGER_CONFIRMED,
    });
    expect(data).not.toHaveProperty('crewSizeProvenance');
    expect(data).not.toHaveProperty('durationProvenance');
  });

  it('confirms a duration an edit supplies', async () => {
    const { service, tx } = fixture();

    await service.update(AGREEMENT_ID, { durationMinutes: 135 }, actor);

    const data = dataOf(tx.serviceAgreement.update as jest.Mock);
    expect(data).toMatchObject({
      durationMinutes: 135,
      durationProvenance: DataProvenance.MANAGER_CONFIRMED,
    });
    expect(data).not.toHaveProperty('crewSizeProvenance');
  });
});

describe('AgreementsService explicit reactivation', () => {
  const importedInactiveAt = new Date('2026-09-03T00:00:00.000Z');

  it('reactivates an importer-archived agreement and clears the import marking', async () => {
    const { service, tx, audit } = fixture(
      agreementRow({ status: AgreementStatus.ARCHIVED, importedInactiveAt }),
    );

    await service.reactivateImported(AGREEMENT_ID, actor);

    expect(dataOf(tx.serviceAgreement.update as jest.Mock)).toEqual({
      status: AgreementStatus.ACTIVE,
      importedInactiveAt: null,
      currentVersion: { increment: 1 },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'service_agreement.imported_reactivated',
        actor,
        before: expect.objectContaining({ importedInactiveAt }),
        after: expect.objectContaining({
          clearedImportedInactiveAt: importedInactiveAt,
        }),
      }),
      expect.anything(),
    );
  });

  it('records the reactivation as a version, naming the import it overrules', async () => {
    const { service, tx } = fixture(
      agreementRow({ status: AgreementStatus.ARCHIVED, importedInactiveAt }),
    );

    await service.reactivateImported(AGREEMENT_ID, actor);

    expect(tx.serviceAgreementVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          changeSummary: expect.stringContaining(importedInactiveAt.toISOString()),
        }),
      }),
    );
  });

  it('refuses an agreement a manager archived — archiving by hand stays final', async () => {
    // The dedicated action exists to undo one specific thing: an import
    // reading a red cell. It is not a general way back out of ARCHIVED, which
    // would leave past visits explained by an agreement that has since moved.
    const { service, tx } = fixture(
      agreementRow({ status: AgreementStatus.ARCHIVED, importedInactiveAt: null }),
    );

    await expect(service.reactivateImported(AGREEMENT_ID, actor)).rejects.toMatchObject(
      { code: 'AGREEMENT_NOT_IMPORTER_ARCHIVED' },
    );
    await expect(
      service.reactivateImported(AGREEMENT_ID, actor),
    ).rejects.toBeInstanceOf(AppException);
    expect(tx.serviceAgreement.update).not.toHaveBeenCalled();
  });

  it('leaves ordinary archiving unable to revive anything', async () => {
    const { service, tx } = fixture(
      agreementRow({ status: AgreementStatus.ARCHIVED, importedInactiveAt }),
    );

    await expect(
      service.changeStatus(AGREEMENT_ID, { status: AgreementStatus.ACTIVE }, actor),
    ).rejects.toMatchObject({ code: 'AGREEMENT_ARCHIVED' });
    expect(tx.serviceAgreement.update).not.toHaveBeenCalled();
  });
});

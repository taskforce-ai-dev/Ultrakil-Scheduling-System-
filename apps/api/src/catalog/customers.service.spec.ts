/**
 * What a manager's own write establishes about a customer or a site.
 *
 * The importer's values are assumptions — a fallback branch, no opening hours
 * at all — and they are kept visibly unconfirmed so a publish can warn about
 * them. A value a manager typed is evidence of a different kind, and these
 * tests pin the two rules that keep the distinction honest: a manager write
 * records confirmation, and it records it for the values that write actually
 * carried and no others.
 */
import {
  BranchCode,
  DataProvenance,
  SiteBranchConfidence,
  SiteBranchSource,
  UserRole,
  Weekday,
} from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { CustomersService } from './customers.service';

const actor = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'admin@example.test',
  fullName: 'Admin',
  role: UserRole.ADMIN,
} as AuthenticatedUser;

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const BRANCH_ID = '33333333-3333-4333-8333-333333333333';

function customerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CUSTOMER_ID,
    name: 'Customer',
    customerCode: null,
    branchId: BRANCH_ID,
    branchCode: BranchCode.COLOMBO,
    contactName: null,
    contactPhone: null,
    contactEmail: null,
    isActive: true,
    importedInactiveAt: null as Date | null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    serviceSites: [],
    ...overrides,
  };
}

function siteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SITE_ID,
    customerId: CUSTOMER_ID,
    name: 'Site',
    addressLine: null,
    city: null,
    branchId: BRANCH_ID,
    branchCode: BranchCode.COLOMBO,
    branchConfidence: SiteBranchConfidence.UNCERTAIN,
    branchSource: SiteBranchSource.FALLBACK_DEFAULT,
    latitude: null,
    longitude: null,
    isActive: true,
    importedInactiveAt: null as Date | null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    operatingHours: [],
    _count: { serviceAgreements: 0 },
    ...overrides,
  };
}

function fixture(options: {
  customer?: ReturnType<typeof customerRow>;
  site?: ReturnType<typeof siteRow>;
} = {}) {
  const customer = options.customer ?? customerRow();
  const site = options.site ?? siteRow();

  const tx = {
    customer: {
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...customer,
        ...data,
      })),
    },
    serviceSite: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...site,
        ...data,
        operatingHours: [],
      })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...site,
        ...data,
        operatingHours: [],
      })),
    },
    siteOperatingHours: { deleteMany: jest.fn() },
  };

  const audit = { record: jest.fn() };
  const prisma = {
    customer: { findUnique: jest.fn(async () => customer) },
    serviceSite: { findUnique: jest.fn(async () => site) },
    branch: {
      findUnique: jest.fn(async () => ({ id: BRANCH_ID, code: BranchCode.COLOMBO })),
    },
    $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) =>
      work(tx),
    ),
  };

  const service = new CustomersService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
  );

  return { service, tx, audit, customer, site };
}

/** The one write of each kind the transaction made. */
function dataOf(mock: jest.Mock): Record<string, unknown> {
  expect(mock).toHaveBeenCalledTimes(1);
  return (mock.mock.calls[0][0] as { data: Record<string, unknown> }).data;
}

describe('CustomersService manager provenance', () => {
  it('records a manager-created site branch and opening hours as confirmed', async () => {
    const { service, tx } = fixture();

    await service.createSite(
      CUSTOMER_ID,
      {
        name: 'Site',
        operatingHours: [
          { weekday: Weekday.MONDAY, opensAtMinute: 540, closesAtMinute: 1020 },
        ],
      },
      actor,
    );

    expect(dataOf(tx.serviceSite.create as jest.Mock)).toMatchObject({
      branchConfidence: SiteBranchConfidence.CONFIRMED,
      branchSource: SiteBranchSource.MANAGER_CONFIRMED,
      operatingHours: {
        create: [
          expect.objectContaining({
            weekday: Weekday.MONDAY,
            provenance: DataProvenance.MANAGER_CONFIRMED,
          }),
        ],
      },
    });
  });

  it('confirms the branch when a site edit supplies one', async () => {
    const { service, tx } = fixture();

    await service.updateSite(SITE_ID, { branchCode: BranchCode.COLOMBO }, actor);

    expect(dataOf(tx.serviceSite.update as jest.Mock)).toMatchObject({
      branchId: BRANCH_ID,
      branchCode: BranchCode.COLOMBO,
      branchConfidence: SiteBranchConfidence.CONFIRMED,
      branchSource: SiteBranchSource.MANAGER_CONFIRMED,
    });
  });

  it('leaves an imported branch unconfirmed when the edit never mentioned it', async () => {
    // Renaming a site says nothing about whether the importer guessed its town
    // correctly. Confirming it here would turn an assumption into a fact
    // nobody checked, and silence the warning that says so.
    const { service, tx } = fixture();

    await service.updateSite(SITE_ID, { name: 'Renamed' }, actor);

    const data = dataOf(tx.serviceSite.update as jest.Mock);
    expect(data).toMatchObject({ name: 'Renamed' });
    expect(data).not.toHaveProperty('branchConfidence');
    expect(data).not.toHaveProperty('branchSource');
    expect(data).not.toHaveProperty('branchCode');
  });

  it('records replacement opening hours as manager confirmed', async () => {
    const { service, tx } = fixture();

    await service.updateSite(
      SITE_ID,
      {
        operatingHours: [
          { weekday: Weekday.SATURDAY, opensAtMinute: 420, closesAtMinute: 660 },
        ],
      },
      actor,
    );

    expect(dataOf(tx.serviceSite.update as jest.Mock)).toMatchObject({
      operatingHours: {
        create: [
          expect.objectContaining({ provenance: DataProvenance.MANAGER_CONFIRMED }),
        ],
      },
    });
  });
});

describe('CustomersService explicit reactivation', () => {
  const importedInactiveAt = new Date('2026-09-03T00:00:00.000Z');

  it('clears the import marking on a customer and keeps it in the audit event', async () => {
    const { service, tx, audit } = fixture({
      customer: customerRow({ isActive: false, importedInactiveAt }),
    });

    await service.reactivate(CUSTOMER_ID, actor);

    expect(dataOf(tx.customer.update as jest.Mock)).toEqual({
      isActive: true,
      importedInactiveAt: null,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'customer.reactivated',
        actor,
        before: expect.objectContaining({ importedInactiveAt }),
        after: expect.objectContaining({
          clearedImportedInactiveAt: importedInactiveAt,
        }),
      }),
      expect.anything(),
    );
  });

  it('clears the import marking on a site and keeps it in the audit event', async () => {
    const { service, tx, audit } = fixture({
      site: siteRow({ isActive: false, importedInactiveAt }),
    });

    await service.reactivateSite(SITE_ID, actor);

    expect(dataOf(tx.serviceSite.update as jest.Mock)).toEqual({
      isActive: true,
      importedInactiveAt: null,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'service_site.reactivated',
        after: expect.objectContaining({
          clearedImportedInactiveAt: importedInactiveAt,
        }),
      }),
      expect.anything(),
    );
  });

  it('is a distinct action: deactivating never touches the import marking', async () => {
    // Reactivation is the only thing that clears the marker. If ordinary
    // deactivation wrote it too, an import's judgement and a manager's would
    // become indistinguishable in the record.
    const { service, tx } = fixture({
      customer: customerRow({ importedInactiveAt }),
      site: siteRow({ importedInactiveAt }),
    });

    await service.deactivate(CUSTOMER_ID, actor);
    expect(dataOf(tx.customer.update as jest.Mock)).toEqual({ isActive: false });

    await service.deactivateSite(SITE_ID, actor);
    expect(dataOf(tx.serviceSite.update as jest.Mock)).toEqual({ isActive: false });
  });
});

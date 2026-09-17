/**
 * Two imports racing over the same customer, or over a job type two
 * different customers' agreements share — the hazard "concurrent workbook
 * replacement" names.
 *
 * Nothing before `customer-lock.ts` serialized two `importSchedule` runs
 * against *each other* at all — only against the other writers scheduling
 * reads and writes (see `agreement-lock-order.spec.ts` and
 * `agreement-update-import-lock.spec.ts`, which are both one import racing
 * something else). Two imports of overlapping workbooks — an admin
 * re-running one that has not finished, or two admins importing at once —
 * used to be able to:
 *
 * - both read no existing customer of a given name and both create one,
 *   since `customers.name` carries no unique constraint: not an error, just
 *   two customers with the same name, each with its own sites and
 *   agreements, quietly double-booking the same client's work; and
 * - race to create the job type for a treatment combination two different
 *   customers' agreements share, which Postgres *does* reject —
 *   `job_types.code` is unique — so the loser reached the operator as a
 *   crashed import instead of the row the winner had already made.
 *
 * `lockCustomerImport` fixes the first: the whole per-customer transaction
 * queues behind it, so a second import's existence check sees exactly what
 * the first committed. `createOrRaceToExisting` fixes the second: it turns
 * the job type's unique-constraint race into a read instead of a crash.
 *
 * Both interleavings are forced rather than raced, the same way the sibling
 * specs force theirs.
 */
import { BranchCode, FrequencyUnit, PrismaClient, Weekday } from '@prisma/client';

import { importSchedule } from '../../src/catalog/schedule-import/importer';
import { ParsedSchedule } from '../../src/catalog/schedule-import/types';

const clientA = new PrismaClient();
const clientB = new PrismaClient();
const other = new PrismaClient();
const suffix = Math.random().toString(36).slice(2, 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function workbook(
  customerName: string,
  siteName: string,
  treatmentCode: string,
): ParsedSchedule {
  return {
    customers: [
      {
        name: customerName,
        sourceSheet: 'REPLACE-RACE',
        isServiced: true,
        sites: [
          {
            name: siteName,
            addressLine: 'Colombo 03',
            regionLabel: null,
            locationCode: null,
            isServiced: true,
          },
        ],
        agreements: [
          {
            siteName,
            treatmentCodes: [treatmentCode],
            frequency: {
              kind: 'parsed' as const,
              frequency: { count: 1, unit: FrequencyUnit.WEEK, interval: 1 },
              source: 'Weekly',
            },
            dayRule: {
              kind: 'parsed' as const,
              allowedDays: [Weekday.MONDAY],
              source: 'Monday',
            },
            effort: { durationMinutes: 90, crewSize: 2 },
            endDate: null,
            bookedDates: [],
            notes: null,
            isServiced: true,
          },
        ],
      },
    ],
    issues: [],
    sheetSummary: [{ sheet: 'REPLACE-RACE', rows: 1, sites: 1 }],
  };
}

/** Is anything parked on a lock over the table or function whose name this matches? */
async function blockedOn(fragment: string): Promise<boolean> {
  const rows = await other.$queryRaw<{ blocked: bigint }[]>`
    SELECT count(*) AS blocked
    FROM pg_stat_activity
    WHERE wait_event_type = 'Lock' AND query ILIKE ${'%' + fragment + '%'}
  `;
  return Number(rows[0]?.blocked ?? 0) > 0;
}

async function waitUntilBlockedOn(fragment: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await blockedOn(fragment)) return;
    await sleep(100);
  }
  throw new Error(`Nothing ever blocked on ${fragment}.`);
}

async function deleteCustomer(name: string): Promise<void> {
  const customer = await other.customer.findFirst({ where: { name } });
  if (!customer) return;
  const agreements = await other.serviceAgreement.findMany({
    where: { customerId: customer.id },
    select: { id: true },
  });
  const ids = agreements.map((agreement) => agreement.id);
  await other.generatedVisit.deleteMany({ where: { serviceAgreementId: { in: ids } } });
  await other.serviceAgreementDayRule.deleteMany({
    where: { serviceAgreementId: { in: ids } },
  });
  await other.serviceAgreement.deleteMany({ where: { id: { in: ids } } });
  await other.serviceSite.deleteMany({ where: { customerId: customer.id } });
  await other.customer.delete({ where: { id: customer.id } });
}

beforeAll(async () => {
  await clientA.$connect();
  await clientB.$connect();
  await other.$connect();
  await other.branch.upsert({
    where: { code: BranchCode.COLOMBO },
    create: { code: BranchCode.COLOMBO, name: 'COLOMBO Branch' },
    update: {},
  });
}, 60_000);

afterAll(async () => {
  await other.jobType
    .deleteMany({ where: { code: { in: ['IMPORTED_CWR', 'IMPORTED_CWRJ'] } } })
    .catch(() => undefined);
  await clientA.$disconnect();
  await clientB.$disconnect();
  await other.$disconnect();
}, 60_000);

it('queues two imports of the same new customer instead of creating it twice', async () => {
  const name = `Replace Race Customer ${suffix}`;
  try {
    let release: () => void = () => undefined;
    let acquired: () => void = () => undefined;
    const isHeld = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const mayRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Stands in for whichever import reaches this customer first: holds
    // exactly the lock `lockCustomerImport` takes, so the other import's own
    // attempt to take it is what this test observes.
    const holder = other.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${name})::bigint)`;
        acquired();
        await mayRelease;
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
    await isHeld;

    let errorA: unknown;
    let errorB: unknown;
    const importingA = importSchedule(
      clientA,
      workbook(name, 'Race Site A', 'CWR'),
    ).catch((error: unknown) => {
      errorA = error;
    });
    await waitUntilBlockedOn('pg_advisory_xact_lock');
    const importingB = importSchedule(
      clientB,
      workbook(name, 'Race Site B', 'CWR'),
    ).catch((error: unknown) => {
      errorB = error;
    });
    // Both imports now want the same customer name; queued rather than
    // racing, at least one of them is still waiting on the externally held
    // lock a moment later.
    await waitUntilBlockedOn('pg_advisory_xact_lock');
    release();

    await Promise.all([importingA, importingB, holder]);
    expect(errorA).toBeUndefined();
    expect(errorB).toBeUndefined();

    const customers = await other.customer.findMany({ where: { name } });
    expect(customers).toHaveLength(1);
  } finally {
    await deleteCustomer(name);
  }
}, 180_000);

it('reads the job type a concurrent import already committed instead of crashing on it', async () => {
  // A code of its own: the previous test's customer already leaves
  // `IMPORTED_CWR` behind (job types are never cleaned up per-customer),
  // and this test needs that row not to exist yet.
  const code = 'IMPORTED_CWRJ';
  const customerName = `Replace Race Job Type Customer ${suffix}`;
  try {
    let release: () => void = () => undefined;
    let acquired: () => void = () => undefined;
    const isHeld = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const mayRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Stands in for a concurrent import of a *different* customer whose
    // agreement shares this treatment code, held open rather than raced so
    // this test sees the exact moment the loser's own insert collides with
    // it.
    const holder = other.$transaction(
      async (tx) => {
        await tx.jobType.create({ data: { code, name: 'CWRJ' } });
        acquired();
        await mayRelease;
      },
      { timeout: 120_000, maxWait: 30_000 },
    );
    await isHeld;

    let errorA: unknown;
    const importingA = importSchedule(
      clientA,
      workbook(customerName, 'Race Site C', 'CWRJ'),
    ).catch((error: unknown) => {
      errorA = error;
    });
    // Postgres blocks a second insert of the same unique key until the first
    // resolves, so this import's own `create` parks here — on a real
    // conflict, not a contrived one — rather than failing outright.
    await waitUntilBlockedOn('job_types');
    release();

    await Promise.all([importingA, holder]);
    expect(errorA).toBeUndefined();

    const jobTypes = await other.jobType.findMany({ where: { code } });
    expect(jobTypes).toHaveLength(1);

    const agreement = await other.serviceAgreement.findFirstOrThrow({
      where: { customer: { name: customerName } },
    });
    expect(agreement.jobTypeId).toBe(jobTypes[0].id);
  } finally {
    await deleteCustomer(customerName);
  }
}, 180_000);

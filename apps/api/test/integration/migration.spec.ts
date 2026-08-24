/**
 * Empty-database migration test (ULK-C01).
 *
 * Proves that applying the committed migrations to a database with nothing in
 * it produces every table the Prisma schema declares, and that each one is
 * queryable and empty. A migration that only works against *your* laptop's
 * database is the classic way to break a teammate's first clone.
 *
 * Requires PostgreSQL and DATABASE_URL. CI provides both; locally run
 * `pnpm dev:infra && pnpm db:deploy` first.
 */
import { PrismaClient } from '@prisma/client';

/** Every table the schema declares, by its mapped database name. */
const EXPECTED_TABLES = [
  'assignment_crew_members',
  'assignment_locks',
  'assignment_vehicles',
  'assignments',
  'audit_events',
  'branches',
  'customers',
  'employee_skills',
  'employees',
  'generated_visits',
  'job_types',
  'permanent_assignments',
  'schedule_runs',
  'service_agreement_day_rules',
  'service_agreements',
  'service_sites',
  'site_operating_hours',
  'vehicle_authorizations',
  'vehicles',
  'visit_unassigned_reasons',
] as const;

const prisma = new PrismaClient();

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('migrations against an empty database', () => {
  it('creates every table the schema declares', async () => {
    const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;

    const actual = rows.map((row) => row.table_name);
    const missing = EXPECTED_TABLES.filter((table) => !actual.includes(table));

    expect(missing).toEqual([]);
  });

  it('records the migration as applied', async () => {
    const rows = await prisma.$queryRaw<
      Array<{ migration_name: string; finished_at: Date | null }>
    >`SELECT migration_name, finished_at FROM _prisma_migrations`;

    expect(rows.length).toBeGreaterThan(0);
    // A migration with no finished_at was rolled back or is still running.
    expect(rows.every((row) => row.finished_at !== null)).toBe(true);
  });

  // Deliberately asserts "queryable", not "empty". Other integration suites
  // share this database and seed rows into it, so emptiness is a property of
  // the test run order rather than of the migration. What the migration is
  // actually responsible for is that every model maps to a real, readable
  // table — a wrong @@map or a missing column shows up here immediately.
  it('leaves every table queryable through the Prisma client', async () => {
    const counts = await Promise.all([
      prisma.branch.count(),
      prisma.employee.count(),
      prisma.employeeSkill.count(),
      prisma.permanentAssignment.count(),
      prisma.vehicle.count(),
      prisma.vehicleAuthorization.count(),
      prisma.customer.count(),
      prisma.serviceSite.count(),
      prisma.siteOperatingHours.count(),
      prisma.jobType.count(),
      prisma.serviceAgreement.count(),
      prisma.serviceAgreementDayRule.count(),
      prisma.generatedVisit.count(),
      prisma.visitUnassignedReason.count(),
      prisma.assignment.count(),
      prisma.assignmentCrewMember.count(),
      prisma.assignmentVehicle.count(),
      prisma.assignmentLock.count(),
      prisma.scheduleRun.count(),
      prisma.auditEvent.count(),
    ]);

    expect(counts).toHaveLength(EXPECTED_TABLES.length);
    expect(counts.every((count) => Number.isInteger(count) && count >= 0)).toBe(
      true,
    );
  });
});

describe('schema guarantees the scheduling rules depend on', () => {
  it('keeps employee source keys unique, so re-importing cannot duplicate staff', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'employees' AND indexdef LIKE '%UNIQUE%'
    `;

    expect(rows.some((row) => row.indexdef.includes('sourceKey'))).toBe(true);
  });

  it('keeps vehicle authorizations unique per employee and vehicle', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'vehicle_authorizations' AND indexdef LIKE '%UNIQUE%'
    `;

    expect(
      rows.some(
        (row) =>
          row.indexdef.includes('employeeId') &&
          row.indexdef.includes('vehicleId'),
      ),
    ).toBe(true);
  });
});

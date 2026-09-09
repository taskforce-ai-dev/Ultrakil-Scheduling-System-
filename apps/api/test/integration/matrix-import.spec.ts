/**
 * Repeatable seed test (ULK-C01).
 *
 * Builds a workbook shaped like the real workforce matrix — merged group
 * headings, merged section labels down the left margin, capacities inside
 * vehicle column titles — imports it, then imports it again and proves nothing
 * duplicated. The real workbook holds staff data and is not in the repository,
 * so the fixture uses invented names.
 *
 * Requires PostgreSQL and DATABASE_URL.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgreementStatus,
  AssignmentStatus,
  BranchCode,
  DeploymentType,
  FrequencyUnit,
  PrismaClient,
  VisitStatus,
} from '@prisma/client';
import ExcelJS from 'exceljs';
import { DEFAULT_MAPPING } from '../../src/workforce/matrix-import/mapping';
import { importMatrix } from '../../src/workforce/matrix-import/importer';
import { parseMatrix } from '../../src/workforce/matrix-import/parser';
import { readMatrixFile } from '../../src/workforce/matrix-import/reader';

const prisma = new PrismaClient();

const mapping = {
  ...DEFAULT_MAPPING,
  permanentSiteBranches: { 'Lion Brewery': BranchCode.COLOMBO },
};

let workDir: string;
let workbookPath: string;

/** Writes a workbook with the same awkward shape as the real one. */
async function writeFixtureWorkbook(path: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Matrix');

  sheet.addRow(['', '', '', '', '', 'Fumigations', '', 'Public Vehicles', 'Personal']);
  sheet.addRow([
    '', 'No.', 'Name Of Technician', 'Station Location', 'Designation',
    'MBr Fumigation', 'Gel Application',
    'Van( 04 People) 253-4289', 'Motor Bike( 01 Person) BJG 4419',
  ]);
  sheet.addRow(['Colombo Branch', 1, 'A Perera', '', 'Senoir PMS', '✓', '✓', '✓', '']);
  sheet.addRow(['', 2, 'B Silva', '', 'Junior PMT', '', '✓', '', '✓']);
  sheet.addRow(['', 3, 'C Fernando', '', 'Pest Management Supervisor(PMS)', '✓', '', '✓', '']);
  sheet.addRow([
    'Station Technicians at Serveral Location at permanen',
    4, 'D Jayasuriya', 'Lion Brewery', 'APMS', '✓', '✓', '', '',
  ]);
  sheet.addRow(['Kandy Branch', 5, 'F Kumara', '', 'Junior PMT', '', '✓', '', '']);

  // Group headings are merged across their columns, and the section labels are
  // merged down — exactly as in the real workbook.
  sheet.mergeCells('F1:G1');
  sheet.mergeCells('A3:A5');

  await workbook.xlsx.writeFile(path);
}

async function importFixture() {
  const { grid } = await readMatrixFile(workbookPath, null);
  const parsed = parseMatrix(grid, mapping);
  const summary = await importMatrix(prisma, parsed);
  return { parsed, summary };
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'ultrakil-matrix-'));
  workbookPath = join(workDir, 'technician-matrix.xlsx');
  await writeFixtureWorkbook(workbookPath);
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Order matters: dependants first. Assignments lead the list because a crew
  // row restricts deletion of its employee — before ULK-C05 nothing created
  // assignments, so this wiped cleanly and the dependency was invisible.
  await prisma.assignment.deleteMany();
  await prisma.vehicleAuthorization.deleteMany();
  await prisma.employeeSkill.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.vehicle.deleteMany();
});

describe('importing the workforce matrix', () => {
  it.each(['group', 'capacity', 'description', 'bare'])(
    'imports and re-imports distinct provincial registrations with %s context',
    async (context) => {
      const fixturePath = join(workDir, `provincial-${context}.xlsx`);
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Matrix');
      const prefix = context === 'capacity' ? 'Van( 04 People) ' : context === 'description' ? 'Van ' : '';
      const skills = ['First Aid 2026', 'ISO 9001', 'ISO-9001', 'CPR 2026', 'Van First Aid 2026', 'IT 2026', 'QA 2026'];
      if (context === 'group') sheet.addRow([...Array<string>(5 + skills.length).fill(''), 'Transport']);
      sheet.addRows([
        ['', 'No.', 'Name Of Technician', 'Station Location', 'Designation', ...skills,
          `${prefix}WP CAB-1234`, `${prefix}CP CAB-1234`, 'Bolero Truck DAC- 2485'],
        ['Colombo Branch', 1, 'Fixture Aspen', '', 'SPMS', ...skills.map(() => '✓'), '✓', '', '✓'],
        ['', 2, 'Fixture Birch', '', 'Junior PMT', ...skills.map(() => ''), '', '✓', '✓'],
        ['', 3, 'Fixture Cedar', '', 'Junior PMT', ...skills.map(() => ''), '', '', ''],
      ]);
      await workbook.xlsx.writeFile(fixturePath);
      const { grid } = await readMatrixFile(fixturePath, null);
      const parsed = parseMatrix(grid);
      expect(parsed.issues).toEqual([]);
      const first = await importMatrix(prisma, parsed);
      expect(first.vehiclesCreated).toBe(3);
      expect(first.authorizationsLinked).toBe(4);
      const vehicles = await prisma.vehicle.findMany({ orderBy: { code: 'asc' } });
      expect(vehicles.map(({ code }) => code)).toEqual(['CP CAB-1234', 'DAC-2485', 'WP CAB-1234']);
      const employees = await prisma.employee.findMany({
        orderBy: { fullName: 'asc' }, include: {
          vehicleAuthorizations: { orderBy: { vehicle: { code: 'asc' } }, include: { vehicle: true } },
          skills: { orderBy: { skillCode: 'asc' } },
        },
      });
      expect(employees.map(({ vehicleAuthorizations }) => vehicleAuthorizations.map(({ vehicle }) => vehicle.code)))
        .toEqual([['DAC-2485', 'WP CAB-1234'], ['CP CAB-1234', 'DAC-2485'], []]);
      expect(employees[0].skills.map(({ skillCode }) => skillCode)).toEqual([
        'CPR_2026', 'FIRST_AID_2026', 'ISO_9001', 'IT_2026', 'QA_2026', 'VAN_FIRST_AID_2026',
      ]);
      const authorizations = await prisma.vehicleAuthorization.findMany({ orderBy: { id: 'asc' } });
      const second = await importMatrix(prisma, parsed);
      expect(second.vehiclesCreated).toBe(0);
      expect(second.employeesCreated).toBe(0);
      expect(second.authorizationsLinked).toBe(4);
      expect(await prisma.vehicle.findMany({ orderBy: { code: 'asc' } }))
        .toEqual(vehicles.map((vehicle) => ({ ...vehicle, updatedAt: expect.any(Date) })));
      expect(await prisma.vehicleAuthorization.findMany({ orderBy: { id: 'asc' } })).toEqual(authorizations);
    },
  );

  it('imports a no-capacity DAC header with three equal permissions and preserves them on re-import', async () => {
    const fixturePath = join(workDir, 'no-capacity-dac.xlsx');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Matrix');
    sheet.addRows([
      ['', 'No.', 'Name Of Technician', 'Station Location', 'Designation',
        'Bolero Truck DAC- 2485', 'First Aid 2026', 'ISO 9001'],
      ['Colombo Branch', 1, 'Fixture Aspen', '', 'SPMS', '✓', '✓', '✓'],
      ['', 2, 'Fixture Birch', '', 'Junior PMT', '✓', '', ''],
      ['', 3, 'Fixture Cedar', '', 'Junior PMT', '✓', '', ''],
      ['', 4, 'Fixture Elm', '', 'Junior PMT', '', '✓', ''],
    ]);
    await workbook.xlsx.writeFile(fixturePath);
    const { grid } = await readMatrixFile(fixturePath, null);
    const parsed = parseMatrix(grid);

    const first = await importMatrix(prisma, parsed);
    expect(first.vehiclesCreated).toBe(1);
    expect(first.authorizationsLinked).toBe(3);
    const vehicle = await prisma.vehicle.findUniqueOrThrow({ where: { code: 'DAC-2485' } });
    expect(vehicle.label).toBe('Bolero Truck DAC-2485');
    expect(vehicle.seatCapacity).toBeNull();
    const employees = await prisma.employee.findMany({ orderBy: { fullName: 'asc' } });
    expect(employees.map(({ fullName }) => fullName)).toEqual([
      'Fixture Aspen', 'Fixture Birch', 'Fixture Cedar', 'Fixture Elm',
    ]);
    const authorizations = await prisma.vehicleAuthorization.findMany({
      orderBy: { employee: { fullName: 'asc' } },
    });
    // This is the complete authorization record: each checked employee gets
    // the same permission; there is no owner, primary driver, or preference.
    expect(authorizations).toEqual(employees.slice(0, 3).map(({ id }) => ({
      id: expect.any(String), employeeId: id, vehicleId: vehicle.id,
      createdAt: expect.any(Date), updatedAt: expect.any(Date),
    })));
    expect(await prisma.vehicleAuthorization.count({ where: { employeeId: employees[3].id } })).toBe(0);
    expect(await prisma.vehicle.count()).toBe(1);
    expect(await prisma.employeeSkill.findMany({
      select: { skillCode: true }, orderBy: { skillCode: 'asc' },
    })).toEqual([
      { skillCode: 'FIRST_AID_2026' }, { skillCode: 'FIRST_AID_2026' }, { skillCode: 'ISO_9001' },
    ]);

    const second = await importMatrix(prisma, parsed);
    expect(second.vehiclesCreated).toBe(0);
    expect(second.employeesCreated).toBe(0);
    expect(second.authorizationsLinked).toBe(3);
    expect(await prisma.vehicle.findMany()).toEqual([
      { ...vehicle, updatedAt: expect.any(Date) },
    ]);
    expect(await prisma.employee.findMany({ select: { id: true }, orderBy: { fullName: 'asc' } }))
      .toEqual(employees.map(({ id }) => ({ id })));
    expect(await prisma.vehicleAuthorization.findMany({ orderBy: { employee: { fullName: 'asc' } } }))
      .toEqual(authorizations);
  });

  it('consolidates a normalized legacy vehicle without losing assignment or audit history', async () => {
    const fixturePath = join(workDir, 'normalized-legacy-dac.xlsx');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Matrix');
    sheet.addRows([
      ['', 'No.', 'Name Of Technician', 'Station Location', 'Designation',
        'Bolero Truck DAC- 2485'],
      ['Colombo Branch', 1, 'Fixture Aspen', '', 'SPMS', '✓'],
      ['', 2, 'Fixture Birch', '', 'Junior PMT', '✓'],
      ['', 3, 'Fixture Cedar', '', 'Junior PMT', '✓'],
    ]);
    await workbook.xlsx.writeFile(fixturePath);
    const { grid } = await readMatrixFile(fixturePath, null);
    const parsed = parseMatrix(grid);
    await importMatrix(prisma, parsed);

    const canonical = await prisma.vehicle.findUniqueOrThrow({ where: { code: 'DAC-2485' } });
    const legacy = await prisma.vehicle.create({ data: { code: 'DAC 2485', label: 'Legacy DAC' } });
    const branch = await prisma.branch.findUniqueOrThrow({ where: { code: BranchCode.COLOMBO } });
    const driver = await prisma.employee.findFirstOrThrow({ where: { fullName: 'Fixture Aspen' } });
    const legacyAuthorization = await prisma.vehicleAuthorization.create({
      data: { employeeId: driver.id, vehicleId: legacy.id },
    });
    const customer = await prisma.customer.create({
      data: {
        name: 'Matrix normalization customer',
        branchId: branch.id,
        branchCode: BranchCode.COLOMBO,
      },
    });
    const site = await prisma.serviceSite.create({
      data: {
        customerId: customer.id,
        name: 'Matrix normalization site',
        branchId: branch.id,
        branchCode: BranchCode.COLOMBO,
      },
    });
    const jobType = await prisma.jobType.create({
      data: { code: 'MATRIX_NORMALIZATION', name: 'Matrix normalization' },
    });
    const agreement = await prisma.serviceAgreement.create({
      data: {
        customerId: customer.id,
        serviceSiteId: site.id,
        jobTypeId: jobType.id,
        branchId: branch.id,
        branchCode: BranchCode.COLOMBO,
        frequencyCount: 1,
        frequencyUnit: FrequencyUnit.MONTH,
        crewSize: 1,
        durationMinutes: 60,
        startDate: new Date('2026-01-01T00:00:00.000Z'),
        status: AgreementStatus.ARCHIVED,
      },
    });
    const visit = await prisma.generatedVisit.create({
      data: {
        serviceAgreementId: agreement.id,
        branchId: branch.id,
        branchCode: BranchCode.COLOMBO,
        visitDate: new Date('2026-01-02T00:00:00.000Z'),
        windowStartMinute: 480,
        windowEndMinute: 1020,
        durationMinutes: 60,
        requiredCrewSize: 1,
        status: VisitStatus.COMPLETED,
      },
    });
    const assignment = await prisma.assignment.create({
      data: {
        generatedVisitId: visit.id,
        branchId: branch.id,
        branchCode: BranchCode.COLOMBO,
        status: AssignmentStatus.COMPLETED,
        plannedStart: new Date('2026-01-02T08:00:00.000Z'),
        plannedEnd: new Date('2026-01-02T09:00:00.000Z'),
      },
    });
    const historicalLink = await prisma.assignmentVehicle.create({
      data: { assignmentId: assignment.id, vehicleId: legacy.id, driverEmployeeId: driver.id },
    });
    const vehicleAudit = await prisma.auditEvent.create({
      data: {
        entityType: 'Vehicle', entityId: legacy.id, action: 'vehicle.updated',
        correlationId: 'matrix-normalization-test',
      },
    });
    const authorizationAudit = await prisma.auditEvent.create({
      data: {
        entityType: 'VehicleAuthorization', entityId: legacyAuthorization.id,
        action: 'vehicle_authorization.created', correlationId: 'matrix-normalization-test',
      },
    });

    try {
      const summary = await importMatrix(prisma, parsed);

      expect(summary.authorizationsRemoved).toBe(1);
      expect(await prisma.vehicle.findMany({
        where: { code: { in: ['DAC-2485', 'DAC 2485'] } },
        select: { id: true, code: true },
      })).toEqual([{ id: canonical.id, code: 'DAC-2485' }]);
      expect(await prisma.assignmentVehicle.findUniqueOrThrow({
        where: { id: historicalLink.id },
      })).toEqual({
        ...historicalLink,
        vehicleId: canonical.id,
        updatedAt: expect.any(Date),
      });
      expect(await prisma.vehicleAuthorization.count({
        where: { employeeId: driver.id, vehicleId: canonical.id },
      })).toBe(1);
      expect(await prisma.auditEvent.findUniqueOrThrow({ where: { id: vehicleAudit.id } }))
        .toEqual(vehicleAudit);
      expect(await prisma.auditEvent.findUniqueOrThrow({ where: { id: authorizationAudit.id } }))
        .toEqual(authorizationAudit);

      await importMatrix(prisma, parsed);
      expect(await prisma.vehicle.count({
        where: { code: { in: ['DAC-2485', 'DAC 2485'] } },
      })).toBe(1);
      expect(await prisma.assignmentVehicle.count({ where: { id: historicalLink.id } })).toBe(1);
    } finally {
      await prisma.auditEvent.deleteMany({ where: { correlationId: 'matrix-normalization-test' } });
      await prisma.serviceAgreement.deleteMany({ where: { id: agreement.id } });
      await prisma.serviceSite.deleteMany({ where: { id: site.id } });
      await prisma.customer.deleteMany({ where: { id: customer.id } });
      await prisma.jobType.deleteMany({ where: { id: jobType.id } });
    }
  });

  it('reads merged section labels and assigns the right branch', async () => {
    await importFixture();

    const colombo = await prisma.employee.count({
      where: { branchCode: BranchCode.COLOMBO },
    });
    const kandy = await prisma.employee.count({
      where: { branchCode: BranchCode.KANDY },
    });

    // A Perera, B Silva, C Fernando (merged Colombo label) + D Jayasuriya
    // (stationed at a Colombo site).
    expect(colombo).toBe(4);
    expect(kandy).toBe(1);
  });

  it('marks every PMS-grade supervisor, including the workbook spellings', async () => {
    await importFixture();

    const supervisors = await prisma.employee.findMany({
      where: { isPmsGrade: true },
      select: { fullName: true, gradeLabel: true },
      orderBy: { fullName: 'asc' },
    });

    expect(supervisors).toEqual([
      { fullName: 'A Perera', gradeLabel: 'Senoir PMS' },
      { fullName: 'C Fernando', gradeLabel: 'Pest Management Supervisor(PMS)' },
      { fullName: 'D Jayasuriya', gradeLabel: 'APMS' },
    ]);
  });

  it('records vehicles with the capacity from their column heading', async () => {
    await importFixture();

    const vehicles = await prisma.vehicle.findMany({ orderBy: { code: 'asc' } });
    expect(
      vehicles.map((v) => ({ code: v.code, seatCapacity: v.seatCapacity })),
    ).toEqual([
      { code: '253-4289', seatCapacity: 4 },
      { code: 'BJG 4419', seatCapacity: 1 },
    ]);
  });

  it('treats a checkmark as authorization to drive, with no ownership', async () => {
    await importFixture();

    const perera = await prisma.employee.findFirstOrThrow({
      where: { fullName: 'A Perera' },
      include: { vehicleAuthorizations: { include: { vehicle: true } } },
    });

    expect(perera.vehicleAuthorizations.map((a) => a.vehicle.code)).toEqual([
      '253-4289',
    ]);
  });

  it('flags permanently stationed staff and keeps their site name', async () => {
    await importFixture();

    const stationed = await prisma.employee.findFirstOrThrow({
      where: { fullName: 'D Jayasuriya' },
    });

    expect(stationed.deploymentType).toBe(DeploymentType.PERMANENTLY_STATIONED);
    expect(stationed.permanentSiteLabel).toBe('Lion Brewery');
  });

  it('keeps the workbook wording for grades and skills', async () => {
    await importFixture();

    const perera = await prisma.employee.findFirstOrThrow({
      where: { fullName: 'A Perera' },
      include: { skills: { orderBy: { skillCode: 'asc' } } },
    });

    expect(perera.gradeLabel).toBe('Senoir PMS');
    expect(perera.skills.map((s) => [s.skillCode, s.skillLabel])).toEqual([
      ['GEL_APPLICATION', 'Gel Application'],
      ['MBR_FUMIGATION', 'MBr Fumigation'],
    ]);
  });
});

describe('re-importing the same workbook', () => {
  it('creates no duplicate employees, vehicles, skills or authorizations', async () => {
    const first = await importFixture();

    const after = async () => ({
      employees: await prisma.employee.count(),
      vehicles: await prisma.vehicle.count(),
      skills: await prisma.employeeSkill.count(),
      authorizations: await prisma.vehicleAuthorization.count(),
    });

    const countsAfterFirst = await after();
    expect(first.summary.employeesCreated).toBe(countsAfterFirst.employees);

    const second = await importFixture();
    const countsAfterSecond = await after();

    expect(countsAfterSecond).toEqual(countsAfterFirst);
    // Second run updates rather than inserts.
    expect(second.summary.employeesCreated).toBe(0);
    expect(second.summary.employeesUpdated).toBe(countsAfterFirst.employees);
    expect(second.summary.vehiclesCreated).toBe(0);

    const third = await importFixture();
    expect(await after()).toEqual(countsAfterFirst);
    expect(third.summary.employeesCreated).toBe(0);
  });

  it('keeps employee ids stable, so anything referencing them survives', async () => {
    await importFixture();
    const before = await prisma.employee.findMany({
      select: { id: true, sourceKey: true },
      orderBy: { sourceKey: 'asc' },
    });

    await importFixture();
    const afterIds = await prisma.employee.findMany({
      select: { id: true, sourceKey: true },
      orderBy: { sourceKey: 'asc' },
    });

    expect(afterIds).toEqual(before);
  });

  it('removes a skill that is no longer check-marked in the workbook', async () => {
    await importFixture();

    const { grid } = await readMatrixFile(workbookPath, null);
    // Drop A Perera's "Gel Application" checkmark (row 3, column index 6).
    grid[2][6] = '';

    const parsed = parseMatrix(grid, mapping);
    const summary = await importMatrix(prisma, parsed);

    expect(summary.skillsRemoved).toBe(1);

    const perera = await prisma.employee.findFirstOrThrow({
      where: { fullName: 'A Perera' },
      include: { skills: true },
    });
    expect(perera.skills.map((s) => s.skillCode)).toEqual(['MBR_FUMIGATION']);
  });
});

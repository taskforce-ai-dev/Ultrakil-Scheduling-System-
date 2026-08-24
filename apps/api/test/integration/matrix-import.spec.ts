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
import { BranchCode, DeploymentType, PrismaClient } from '@prisma/client';
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
  // Order matters: dependants first.
  await prisma.vehicleAuthorization.deleteMany();
  await prisma.employeeSkill.deleteMany();
  await prisma.employee.deleteMany();
  await prisma.vehicle.deleteMany();
});

describe('importing the workforce matrix', () => {
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

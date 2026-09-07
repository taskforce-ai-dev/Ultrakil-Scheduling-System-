import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ExcelJS from 'exceljs';
import { BranchCode, FrequencyUnit, PrismaClient, Weekday } from '@prisma/client';
import { summarizeInputs, writePrivateReport } from '../../scripts/staging-import';
import { seedReferenceData } from '../../prisma/reference-data';
import { ParsedMatrix } from '../../src/workforce/matrix-import/types';
import { ParsedSchedule } from '../../src/catalog/schedule-import/types';

const matrix = {
  employees: [{ fullName: 'PRIVATE EMPLOYEE', branchCode: BranchCode.COLOMBO, isPmsGrade: true,
    isPermanentlyStationed: false, canUsePublicTransport: false }],
  vehicles: [{ code: 'PRIVATE VEHICLE' }], issues: [{ code: 'ROW_SKIPPED', message: 'PRIVATE EMPLOYEE' }],
  unrecognisedGrades: ['PRIVATE GRADE'], skillColumns: [], vehicleColumns: [], headerRowNumber: 1,
} as unknown as ParsedMatrix;
const schedule: ParsedSchedule = {
  customers: [{ name: 'PRIVATE CUSTOMER', sourceSheet: 'PRIVATE SHEET', isServiced: true,
    sites: [{ name: 'PRIVATE SITE', addressLine: 'PRIVATE ADDRESS', regionLabel: null, locationCode: null, isServiced: true }],
    agreements: [{ siteName: 'PRIVATE SITE', isServiced: true, treatmentCodes: ['GPC'],
      frequency: { kind: 'parsed', source: 'monthly', frequency: { count: 1, unit: FrequencyUnit.MONTH, interval: 1 } },
      dayRule: { kind: 'parsed', source: 'Monday', allowedDays: [Weekday.MONDAY] },
      effort: { crewSize: 2, durationMinutes: 60 }, endDate: null, notes: null }] }],
  issues: [{ code: 'BRANCH_UNKNOWN', sheet: 'PRIVATE SHEET', rowNumber: 4, message: 'PRIVATE CUSTOMER', source: 'PRIVATE VALUE' }],
  sheetSummary: [],
};

describe('staging import aggregate output', () => {
  it('shares counts and stable issue codes without source values', () => {
    const summary = summarizeInputs(matrix, schedule);
    expect(summary).toMatchObject({ employees: 1, vehicles: 1, customers: 1, sites: 1, importableAgreements: 1,
      scheduleIssues: { BRANCH_UNKNOWN: 1 }, matrixIssues: { ROW_SKIPPED: 1 } });
    expect(JSON.stringify(summary)).not.toContain('PRIVATE');
  });

  it('refuses empty workforce and schedule inputs even for dry runs', () => {
    expect(() => summarizeInputs({ ...matrix, employees: [] }, schedule)).toThrow('EMPTY_MATRIX');
    expect(() => summarizeInputs(matrix, { ...schedule, customers: [] })).toThrow('EMPTY_SCHEDULE');
    expect(() => summarizeInputs(matrix, { ...schedule, customers: [{ ...schedule.customers[0], agreements: [] }] })).toThrow('EMPTY_AGREEMENTS');
  });

  it('does not count agreements lacking an allowed weekday as importable', () => {
    const input = structuredClone(schedule);
    input.customers[0].agreements[0].dayRule = { kind: 'parsed', source: 'invalid', allowedDays: [] };
    expect(() => summarizeInputs(matrix, input)).toThrow('EMPTY_AGREEMENTS');
  });
});

describe('private detailed import reports', () => {
  it('refuses public report directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ulk-report-test-'));
    try {
      await chmod(dir, 0o755);
      await expect(writePrivateReport(dir, matrix, schedule)).rejects.toThrow('PRIVATE_REPORT_DIRECTORY_REQUIRED');
      expect(await readdir(dir)).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('creates a unique private directory and files instead of overwriting prior evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ulk-report-test-'));
    try {
      await writePrivateReport(dir, matrix, schedule);
      await writePrivateReport(dir, matrix, schedule);
      const runs = await readdir(dir);
      expect(runs).toHaveLength(2);
      for (const run of runs) {
        expect((await stat(join(dir, run))).mode & 0o777).toBe(0o700);
        const file = join(dir, run, 'issues.json');
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect(await readFile(file, 'utf8')).toContain('PRIVATE');
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('actual staging import command with synthetic workbooks', () => {
  it('dry-runs both real parsers without a database and emits only safe aggregates', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ulk-command-test-'));
    try {
      const matrixPath = join(directory, 'matrix.xlsx');
      const schedulePath = join(directory, 'schedule.xlsx');
      const matrixBook = new ExcelJS.Workbook();
      matrixBook.addWorksheet('Matrix').addRows([
        ['', '', '', '', '', 'Company'],
        ['', 'No.', 'Name Of Technician', 'Station Location', 'Designation', 'Van( 04 People) CAB-1234'],
        ['Colombo Branch', '1', 'PRIVATE SYNTHETIC TECHNICIAN', '', 'PMS', '✓'],
      ]);
      await matrixBook.xlsx.writeFile(matrixPath);
      const scheduleBook = new ExcelJS.Workbook();
      scheduleBook.addWorksheet('Main').addRows([
        ['Title'], ['', 'Client', '', 'Location', 'Treatment', 'Frequency', 'Day'],
        ['', 'PRIVATE SYNTHETIC CUSTOMER', '', 'PRIVATE SYNTHETIC SITE Colombo', 'GPC', 'Monthly', 'Monday'],
      ]);
      await scheduleBook.xlsx.writeFile(schedulePath);
      await chmod(matrixPath, 0o600);
      await chmod(schedulePath, 0o600);
      const reportDirectory = join(directory, 'reports');
      await mkdir(reportDirectory, { mode: 0o700 });
      const env = { ...process.env,
        POSTGRES_USER: 'ultrakil', POSTGRES_DB: 'ultrakil_staging',
        POSTGRES_PASSWORD: 'db-value-with-entropy-123456789',
        DATABASE_URL: 'postgresql://ultrakil:db-value-with-entropy-123456789@postgres:5432/ultrakil_staging?schema=public',
        REDIS_PASSWORD: 'redis-value-with-entropy-123456789', JWT_SECRET: 'jwt-value-with-entropy-123456789012345',
        SEED_ADMIN_EMAIL: 'pilot@example.test', SEED_ADMIN_PASSWORD: 'admin-value-with-entropy-123456789',
        SEED_ADMIN_NAME: 'Pilot Administrator',
        NEXT_PUBLIC_API_BASE_URL: 'http://localhost:3001/api', API_CORS_ORIGINS: 'http://localhost:3000',
        TECHNICIAN_MATRIX_PATH: matrixPath, MASTER_SCHEDULE_PATH: schedulePath,
        STAGING_REPORT_DIR: reportDirectory, MATRIX_MAPPING_PATH: join(directory, 'absent-mapping.json'),
      };
      const result = spawnSync(process.execPath, [resolve(__dirname, '../../../../deploy/staging-tool.mjs'), 'import', '--dry-run'],
        { encoding: 'utf8', env, timeout: 30000 });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain('PRIVATE');
      expect(JSON.parse(result.stdout).parsed).toMatchObject({ employees: 1, vehicles: 1, customers: 1, sites: 1, importableAgreements: 1 });
      expect(await readdir(reportDirectory)).toHaveLength(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 35000);
});

describe('shared reference seed', () => {
  it('preserves existing accounts and passwords', async () => {
    const prisma = { branch: { upsert: jest.fn() }, user: { count: jest.fn().mockResolvedValue(1), create: jest.fn() } };
    await seedReferenceData(prisma as unknown as PrismaClient);
    expect(prisma.branch.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});

// Fabricated workbook layout and test records only. Never reads incoming/.
import { createRequire } from 'node:module';
import { chmod, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { PrismaClient } = require('@prisma/client');
const ExcelJS = require('exceljs');
const day = '2026-09-07';
const names = ['T M Supun Tharaka Wijeweera', 'S Tharilingam', 'P Selvaraj', 'R O Elders',
  'Hasitha Bandara', 'Raj Kumar', 'Ruwan Sampath', 'Ajith Alwis'];
const publicTransport = new Set(['T M Supun Tharaka Wijeweera', 'Ajith Alwis']);
const codes = ['DAG-3284', 'ABE-7244', 'PJ-6796', 'DAI-0191', 'DAC-2485'];
const checked = [[0, 1, 2], [3, 4, 5, 6], [7, 0], [1, 2], [0, 1, 2]];

async function workbooks(directory) {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) || !resolve(directory).startsWith('/tmp/ultrakil-rehearsal-')) {
    throw new Error('Require private temporary rehearsal directory');
  }
  const matrix = new ExcelJS.Workbook();
  matrix.addWorksheet('Matrix').addRows([
    ['', 'No.', 'Name Of Technician', 'Station Location', 'Designation', 'GPC',
      'Public Vehicles', ...codes.map(code => `Van( 04 People) ${code === 'DAC-2485' ? 'DAC- 2485' : code}`)],
    ...names.map((name, index) => [index === 0 ? 'Colombo Branch' : '', String(index + 1), name, '', 'SPMS', '✓',
      publicTransport.has(name) ? '✓' : '', ...checked.map(drivers => drivers.includes(index) ? '✓' : '')]),
  ]);
  const master = new ExcelJS.Workbook();
  const sheet = master.addWorksheet('Main');
  sheet.addRows([[], ['', 'Client', '', 'Location', 'Treatment', 'Frequency', 'Day', 'Effort'],
    ['', 'Synthetic Active', '', 'Synthetic Active Colombo', 'GPC', '1 per month', 'Monday', '1 person 1 hour'],
    ['', 'Synthetic Mixed', '', 'Synthetic Open Colombo', 'GPC', '1 per month', 'Monday', '1 person 1 hour'],
    ['', 'Synthetic Mixed', '', 'Synthetic Closed Colombo', 'GPC', '1 per month', 'Monday', '1 person 1 hour'],
    ['', 'Synthetic Inactive', '', 'Synthetic Inactive Colombo', 'GPC', '1 per month', 'Monday', '1 person 1 hour'],
  ]);
  for (const row of [2, 5, 6]) for (const column of [2, 4]) {
    sheet.getRow(row).getCell(column).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } };
  }
  // Red schedule markings must not deactivate the active identity.
  sheet.getRow(3).getCell(9).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } };
  for (const [book, filename] of [[matrix, 'technician-matrix.xlsx'], [master, 'master-schedule-2026.xlsx']]) {
    const path = join(directory, filename);
    await book.xlsx.writeFile(path);
    await chmod(path, 0o600);
  }
  console.log(JSON.stringify({ syntheticWorkbooks: 2, employees: names.length, vehicles: codes.length }));
}

async function seed() {
  const url = new URL(process.env.DATABASE_URL);
  if (!['postgres', '127.0.0.1', 'localhost'].includes(url.hostname)
    || !/^\/ultrakil_rehearsal_[a-f0-9]{12}_test$/.test(url.pathname)) {
    throw new Error('Fixture requires isolated Compose rehearsal database');
  }
  const db = new PrismaClient({ log: [] });
  try {
    if (await db.employee.count() !== 8 || await db.vehicle.count() !== 5 || await db.generatedVisit.count() !== 0) {
      throw new Error('Fixture requires freshly imported synthetic data');
    }
    for (let index = 0; index < codes.length; index++) {
      const vehicle = await db.vehicle.findUniqueOrThrow({ where: { code: codes[index] }, include: { authorizations: true } });
      if (vehicle.authorizations.length !== checked[index].length) throw new Error('Synthetic authorization import mismatch');
    }
    if (await db.customer.count({ where: { isActive: false } }) !== 1
      || await db.serviceSite.count({ where: { isActive: false } }) !== 2) throw new Error('Synthetic inactive import mismatch');
    const branch = await db.branch.findUniqueOrThrow({ where: { code: 'COLOMBO' } });
    await db.vehicle.updateMany({ data: { branchId: branch.id } });
    // Fixed fixture horizon only; import code continues to use actual runtime dates.
    await db.serviceAgreement.updateMany({ data: { startDate: new Date(`${day}T00:00:00Z`) } });
    const agreement = await db.serviceAgreement.findFirstOrThrow({ where: { customer: { name: 'Synthetic Active' } } });
    const visit = await db.generatedVisit.create({ data: {
      serviceAgreementId: agreement.id, branchId: branch.id, branchCode: branch.code,
      visitDate: new Date(`${day}T00:00:00Z`), windowStartMinute: 480, windowEndMinute: 1020,
      durationMinutes: 60, requiredCrewSize: 1, isManuallyAdjusted: true,
    } });
    const employee = await db.employee.findFirstOrThrow({ where: { fullName: names[0] } });
    const run = await db.scheduleRun.create({ data: { status: 'SUCCEEDED', trigger: 'MANUAL', branchCode: branch.code,
      rangeStart: new Date(`${day}T00:00:00Z`), rangeEnd: new Date(`${day}T00:00:00Z`), progressPercent: 100,
      createdAt: new Date('2025-01-01T00:00:00Z') } });
    await db.assignment.create({ data: { generatedVisitId: visit.id, branchId: branch.id, branchCode: branch.code,
      // The API stores minute-of-day values against UTC midnight. Keep this
      // inside the visit's 08:00-17:00 window so its seeded crew is genuinely
      // eligible when the dispatch drawer re-checks it.
      plannedStart: new Date(`${day}T09:00:00Z`), plannedEnd: new Date(`${day}T10:00:00Z`), scheduleRunId: run.id,
      crewMembers: { create: { employeeId: employee.id, isPmsSupervisor: true, role: 'SUPERVISOR' } } } });
    // Another untouched successful run keeps the publish accessibility dialog
    // available after the optimizer journey publishes its own newly created run.
    await db.scheduleRun.create({ data: { status: 'SUCCEEDED', trigger: 'MANUAL', rangeStart: new Date('2025-01-01T00:00:00Z'),
      rangeEnd: new Date('2025-01-01T00:00:00Z'), progressPercent: 100, createdAt: new Date('2024-01-01T00:00:00Z') } });
    const archived = await db.serviceAgreement.findFirstOrThrow({ where: { customer: { name: 'Synthetic Inactive' } } });
    const historicalVisit = await db.generatedVisit.create({ data: { serviceAgreementId: archived.id,
      branchId: branch.id, branchCode: branch.code, visitDate: new Date('2025-01-01T00:00:00Z'),
      windowStartMinute: 480, windowEndMinute: 1020, durationMinutes: 60, requiredCrewSize: 1, status: 'COMPLETED' } });
    const historicalAssignment = await db.assignment.create({ data: { generatedVisitId: historicalVisit.id,
      branchId: branch.id, branchCode: branch.code, status: 'COMPLETED', plannedStart: new Date('2025-01-01T03:30:00Z'),
      plannedEnd: new Date('2025-01-01T04:30:00Z'), publishedAt: new Date('2024-12-31T00:00:00Z'),
      completedAt: new Date('2025-01-01T04:30:00Z') } });
    await db.assignmentNotificationOutbox.create({ data: { assignmentId: historicalAssignment.id,
      employeeId: employee.id, eventType: 'assignment.published', payload: { synthetic: true } } });
    console.log(JSON.stringify({ syntheticVisits: 2, syntheticDraftRuns: 2, inactiveCustomers: 1, inactiveSites: 2 }));
  } finally { await db.$disconnect(); }
}
async function verify() {
  const url = new URL(process.env.DATABASE_URL);
  if (!['postgres', '127.0.0.1', 'localhost'].includes(url.hostname)
    || !/^\/ultrakil_rehearsal_[a-f0-9]{12}_test$/.test(url.pathname)) throw new Error('Synthetic rehearsal only');
  const db = new PrismaClient({ log: [] });
  try {
    const futureInactive = await db.generatedVisit.count({ where: { visitDate: { gte: new Date(`${day}T00:00:00Z`) },
      serviceAgreement: { OR: [{ customer: { isActive: false } }, { serviceSite: { isActive: false } }] } } });
    const historical = await db.generatedVisit.count({ where: { status: 'COMPLETED', serviceAgreement: { customer: { isActive: false } } } });
    if (futureInactive !== 0 || historical !== 1) throw new Error('Inactive scheduling/history invariant failed');
    console.log(JSON.stringify({ futureInactive, historicalInactiveVisits: historical }));
  } finally { await db.$disconnect(); }
}
try {
  if (process.argv[2] === 'workbooks') await workbooks(process.argv[3]);
  else if (process.argv[2] === 'seed') await seed();
  else if (process.argv[2] === 'verify') await verify();
  else throw new Error('Expected workbooks, seed or verify');
} catch { console.error('Synthetic fixture failed; raw diagnostics withheld.'); process.exitCode = 1; }

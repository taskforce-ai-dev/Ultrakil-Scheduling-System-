/**
 * Proves the importer reads UltraKIL's red rows the way a manager means them.
 *
 * The real workbook holds live customer data and is never committed, so this
 * builds a small one with exceljs instead — which also lets it contain the
 * cases that matter most and are hardest to find by eye: a red section header,
 * and a red date cell in the scheduling band. Both are everywhere in the real
 * file and neither means a client has gone. Reading either as a deactivation
 * would quietly stop work for a customer who is still paying, so those two
 * rows are the point of this suite as much as the genuinely red client is.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ExcelJS from 'exceljs';

import { parseMasterSchedule } from '../../src/catalog/schedule-import/parser';
import { ParsedCustomer } from '../../src/catalog/schedule-import/types';

const RED = 'FFFF0000';

/** The "Main" mapping's columns, which this workbook has to match exactly. */
const COLUMN = { customer: 2, endDate: 3, location: 4, treatment: 5, frequency: 6, day: 7 };
const FIRST_MONTH_COLUMN = 9;

function fillRed(cell: ExcelJS.Cell): void {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: RED } };
}

interface RowSpec {
  customer: string;
  location: string;
  /** Which identity cells are red. */
  red?: ('customer' | 'location')[];
  /** Paints a date cell in the scheduling band red, as an overdue marker. */
  redDateCell?: boolean;
}

async function buildWorkbook(directory: string, rows: RowSpec[]): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Main');

  // Row 2 is the header row the mapping expects — and it is red, exactly as
  // UltraKIL's real section headings are.
  const header = sheet.getRow(2);
  header.getCell(COLUMN.customer).value = 'Client';
  header.getCell(COLUMN.location).value = 'Location';
  fillRed(header.getCell(COLUMN.customer));
  fillRed(header.getCell(COLUMN.location));
  header.commit();

  rows.forEach((spec, index) => {
    const row = sheet.getRow(3 + index);
    row.getCell(COLUMN.customer).value = spec.customer;
    row.getCell(COLUMN.location).value = spec.location;
    row.getCell(COLUMN.treatment).value = 'GPC';
    row.getCell(COLUMN.frequency).value = '1 per month';
    row.getCell(COLUMN.day).value = 'Monday';
    row.getCell(FIRST_MONTH_COLUMN).value = '5,19';

    for (const cell of spec.red ?? []) fillRed(row.getCell(COLUMN[cell]));
    if (spec.redDateCell) fillRed(row.getCell(FIRST_MONTH_COLUMN));

    row.commit();
  });

  const path = join(directory, 'colour-fixture.xlsx');
  await workbook.xlsx.writeFile(path);
  return path;
}

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ulk-colour-'));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function parseRows(rows: RowSpec[]): Promise<ParsedCustomer[]> {
  const path = await buildWorkbook(directory, rows);
  const parsed = await parseMasterSchedule(path);
  return parsed.customers;
}

describe('reading inactive records from cell colour', () => {
  it('leaves a plain row serviced', async () => {
    const [customer] = await parseRows([{ customer: 'Live Co', location: 'Colombo 03' }]);

    expect(customer.isServiced).toBe(true);
    expect(customer.sites[0].isServiced).toBe(true);
    expect(customer.agreements[0].isServiced).toBe(true);
  });

  it('reads a fully red row as no longer serviced', async () => {
    const [customer] = await parseRows([
      { customer: 'Gone Co', location: 'Kandy', red: ['customer', 'location'] },
    ]);

    expect(customer.isServiced).toBe(false);
    expect(customer.sites[0].isServiced).toBe(false);
    expect(customer.agreements[0].isServiced).toBe(false);
  });

  it('is not fooled by the red header above the rows', async () => {
    // The header is painted red in every fixture this suite builds. If it
    // leaked into the rows, every test here would report an inactive client.
    const [customer] = await parseRows([{ customer: 'Header Co', location: 'Galle' }]);

    expect(customer.isServiced).toBe(true);
    expect(customer.sites[0].isServiced).toBe(true);
  });

  it('is not fooled by a red date cell in the scheduling band', async () => {
    const [customer] = await parseRows([
      { customer: 'Overdue Co', location: 'Negombo', redDateCell: true },
    ]);

    expect(customer.isServiced).toBe(true);
    expect(customer.agreements[0].isServiced).toBe(true);
  });

  it('leaves a half-red row serviced and asks a human', async () => {
    const path = await buildWorkbook(directory, [
      { customer: 'Maybe Co', location: 'Matara', red: ['customer'] },
    ]);
    const parsed = await parseMasterSchedule(path);

    expect(parsed.customers[0].isServiced).toBe(true);
    expect(parsed.issues.map((issue) => issue.code)).toContain('RECORD_MARKING_AMBIGUOUS');
  });

  it('records every deactivation as an issue a manager can review', async () => {
    const path = await buildWorkbook(directory, [
      { customer: 'Live Co', location: 'Colombo 03' },
      { customer: 'Gone Co', location: 'Kandy', red: ['customer', 'location'] },
    ]);
    const parsed = await parseMasterSchedule(path);

    const inactive = parsed.issues.filter((issue) => issue.code === 'RECORD_INACTIVE');
    expect(inactive).toHaveLength(1);
    expect(inactive[0].message).toContain('Gone Co');
  });
});

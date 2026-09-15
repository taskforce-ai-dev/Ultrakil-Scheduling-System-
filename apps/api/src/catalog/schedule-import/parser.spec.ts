import ExcelJS from 'exceljs';

import { readBookedDates } from './parser';
import { AgreementSheetMapping } from './sheet-mapping';

const MAPPING: AgreementSheetMapping = {
  kind: 'agreements',
  sheet: 'Main',
  headerRow: 2,
  columns: { customer: 2, location: 4, treatment: 5, frequency: 6 },
  // Three month columns is enough to prove the index-to-month mapping.
  monthColumns: [9, 10, 11],
  year: 2026,
};

/** A single row of an in-memory worksheet, so no fixture workbook is needed. */
function rowWith(cells: Record<number, string>): ExcelJS.Row {
  const worksheet = new ExcelJS.Workbook().addWorksheet('Main');
  const row = worksheet.getRow(3);
  for (const [column, value] of Object.entries(cells)) {
    row.getCell(Number(column)).value = value;
  }
  return row;
}

describe('readBookedDates', () => {
  it('reads each month column as the month it stands for', () => {
    const result = readBookedDates(rowWith({ 9: '10', 10: '12', 11: '9' }), MAPPING);

    expect(result.bookings.map((booking) => booking.date)).toEqual([
      '2026-01-10',
      '2026-02-12',
      '2026-03-09',
    ]);
    expect(result.invalid).toEqual([]);
  });

  it('reads every day number a handwritten cell holds', () => {
    // "5 & 20" is the workbook's way of saying twice a month.
    const result = readBookedDates(rowWith({ 9: '5 & 20' }), MAPPING);

    expect(result.bookings.map((booking) => booking.date)).toEqual([
      '2026-01-05',
      '2026-01-20',
    ]);
  });

  it('keeps one date per day, however often the cell repeats it', () => {
    const result = readBookedDates(rowWith({ 9: '7, 7' }), MAPPING);

    expect(result.bookings.map((booking) => booking.date)).toEqual(['2026-01-07']);
  });

  it('reports a day the month does not have instead of rolling it forward', () => {
    // February 2026 has 28 days. Rolling 30 forward would book March.
    const result = readBookedDates(rowWith({ 10: '30' }), MAPPING);

    expect(result.bookings).toEqual([]);
    expect(result.invalid).toEqual([{ month: 2, day: 30 }]);
  });

  it('keeps the readable days of a cell that also holds an impossible one', () => {
    const result = readBookedDates(rowWith({ 10: '3, 30' }), MAPPING);

    expect(result.bookings.map((booking) => booking.date)).toEqual(['2026-02-03']);
    expect(result.invalid).toEqual([{ month: 2, day: 30 }]);
  });

  it('still hands the weekday derivation the month and day pairs it needs', () => {
    const result = readBookedDates(rowWith({ 9: '5 & 20' }), MAPPING);

    expect(result.bookings.map(({ month, day }) => ({ month, day }))).toEqual([
      { month: 1, day: 5 },
      { month: 1, day: 20 },
    ]);
  });

  it('reads nothing from a sheet with no month columns', () => {
    const result = readBookedDates(rowWith({ 9: '10' }), {
      ...MAPPING,
      monthColumns: undefined,
      year: undefined,
    });

    expect(result).toEqual({ bookings: [], invalid: [] });
  });
});

import { existsSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { Grid } from './types';

export class MatrixFileNotFoundError extends Error {
  readonly code = 'MATRIX_FILE_NOT_FOUND';
  constructor(readonly path: string) {
    super(
      `Workforce matrix not found at "${path}". Put the workbook there, or point TECHNICIAN_MATRIX_PATH at it. See data/README.md.`,
    );
  }
}

export class MatrixSheetNotFoundError extends Error {
  readonly code = 'MATRIX_SHEET_NOT_FOUND';
  constructor(wanted: string, available: string[]) {
    super(
      `Sheet "${wanted}" not found. The workbook contains: ${available.join(', ')}.`,
    );
  }
}

export interface ReadResult {
  grid: Grid;
  sheetName: string;
  sheetNames: string[];
}

/**
 * Reads the workbook into a plain grid of trimmed strings.
 *
 * Merged cells are resolved to their master's value, so a section label merged
 * down six rows reads as that label on all six. Without this the grid would
 * have the value on the first row and blanks under it, and every consumer would
 * have to reinvent the same fill-down logic.
 */
export async function readMatrixFile(
  path: string,
  sheetName: string | null = null,
): Promise<ReadResult> {
  if (!existsSync(path)) throw new MatrixFileNotFoundError(path);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);

  const sheetNames = workbook.worksheets.map((sheet) => sheet.name);
  const worksheet = sheetName
    ? workbook.getWorksheet(sheetName)
    : workbook.worksheets[0];

  if (!worksheet) {
    throw new MatrixSheetNotFoundError(sheetName ?? '(first sheet)', sheetNames);
  }

  const grid: Grid = [];
  const rowCount = worksheet.rowCount;
  const columnCount = worksheet.columnCount;

  for (let r = 1; r <= rowCount; r += 1) {
    const row: string[] = [];
    for (let c = 1; c <= columnCount; c += 1) {
      const cell = worksheet.getCell(r, c);
      const source = cell.isMerged && cell.master ? cell.master : cell;
      row.push(cellToText(source));
    }
    grid.push(row);
  }

  return { grid, sheetName: worksheet.name, sheetNames };
}

/**
 * Cells arrive as strings, numbers, rich text, formulas or hyperlinks depending
 * on how they were typed. `cell.text` handles most of it; the rest are unwrapped
 * here so a checkmark is a checkmark however it was entered.
 */
function cellToText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return '';

  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join('').trim();
    }
    if ('text' in value && typeof value.text === 'string') {
      return value.text.trim();
    }
    if ('result' in value) {
      return String(value.result ?? '').trim();
    }
  }

  return String(cell.text ?? value).trim();
}

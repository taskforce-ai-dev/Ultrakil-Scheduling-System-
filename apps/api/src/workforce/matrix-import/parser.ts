import { BranchCode } from '@prisma/client';
import { isPmsGradeLabel } from '../pms-grade';
import {
  DEFAULT_MAPPING,
  MatrixMapping,
  isCheckmark,
  normalizeHeader,
  parseVehicleHeader,
  toSkillCode,
} from './mapping';
import {
  ColumnSpec,
  Grid,
  ImportIssue,
  ParsedEmployee,
  ParsedMatrix,
  ParsedVehicle,
} from './types';

/**
 * Turns the workbook grid into structured records.
 *
 * Pure — no file access, no database. That is what lets the awkward parts (a
 * two-level header, vertically merged section labels, capacities buried in
 * vehicle column titles) be unit-tested against small fixtures instead of the
 * real workbook, which holds staff data and cannot live in the repository.
 *
 * The guiding rule throughout: when the workbook does not say something, record
 * an issue rather than guess. A wrong guess here becomes a wrong crew on a real
 * job.
 */
export function parseMatrix(
  grid: Grid,
  mapping: MatrixMapping = DEFAULT_MAPPING,
): ParsedMatrix {
  const issues: ImportIssue[] = [];

  const identityRowIndex = findIdentityRow(grid, mapping);
  if (identityRowIndex === -1) {
    return {
      employees: [],
      vehicles: [],
      skillColumns: [],
      vehicleColumns: [],
      unrecognisedGrades: [],
      headerRowNumber: -1,
      issues: [
        {
          code: 'MATRIX_HEADER_NOT_FOUND',
          message:
            'Could not find the header row. Expected a row containing both a name column and a designation column. Check the sheet name, or set the column spellings in data/matrix-mapping.json.',
        },
      ],
    };
  }

  const identityRow = grid[identityRowIndex];
  const identity = locateIdentityColumns(identityRow, mapping);
  if (identity.fullName === -1 || identity.designation === -1) {
    issues.push({
      code: 'MATRIX_COLUMN_MISSING',
      message: `Header row ${identityRowIndex + 1} is missing a required column. Found: ${identityRow
        .filter(Boolean)
        .join(' | ')}`,
    });
  }

  // The header is a block, not a line. In the real workbook the identity
  // columns are merged down three rows while the group headings sit on the
  // first of them and the actual column names on the last — so "Transport"
  // sits above "Van( 04 People) 253-4289". Reading only the first row would
  // name every vehicle column "Transport" and treat rows inside the header as
  // employees.
  const headerBottomIndex = findHeaderBottom(grid, identityRowIndex, identity);
  const { headerRow, groupLabels } = buildHeaderBlock(
    grid,
    identityRowIndex,
    headerBottomIndex,
  );

  const { skillColumns, vehicleColumns } = classifyColumns(
    headerRow,
    groupLabels,
    identity,
    mapping,
  );

  const vehicles = buildVehicles(vehicleColumns, groupLabels, issues);
  const vehicleCodeByColumn = new Map<number, string>();
  for (const column of vehicleColumns) {
    const { code } = parseVehicleHeader(column.label);
    if (code) vehicleCodeByColumn.set(column.index, code);
  }

  const employees: ParsedEmployee[] = [];
  const unrecognisedGrades = new Set<string>();
  const seenKeys = new Map<string, number>();

  let currentSection = '';

  for (let r = headerBottomIndex + 1; r < grid.length; r += 1) {
    const row = grid[r] ?? [];
    const rowNumber = r + 1;

    // Section labels sit in the left margin and are merged down several rows,
    // so carry the last non-empty one forward.
    const marginText = row
      .slice(0, Math.max(identity.sourceNumber, 0))
      .filter(Boolean)
      .join(' ');
    if (marginText) currentSection = marginText;

    const fullName = (row[identity.fullName] ?? '').trim();
    if (!fullName) continue;

    const gradeLabel = (row[identity.designation] ?? '').trim();
    if (!gradeLabel) {
      issues.push({
        code: 'MATRIX_ROW_INVALID',
        message: `"${fullName}" has no designation. A crew member with no grade cannot be checked against the PMS-supervisor rule, so the row is skipped.`,
        rowNumber,
      });
      continue;
    }

    const stationLocation =
      identity.stationLocation === -1
        ? ''
        : (row[identity.stationLocation] ?? '').trim();

    const section = normalizeHeader(currentSection);
    const isPermanentlyStationed = mapping.sections.permanentMarkers.some(
      (marker) => section.includes(normalizeHeader(marker)),
    );

    const branchCode = resolveBranch({
      section,
      stationLocation,
      fullName,
      isPermanentlyStationed,
      mapping,
    });

    if (!branchCode) {
      issues.push({
        code: 'MATRIX_BRANCH_UNKNOWN',
        message: isPermanentlyStationed
          ? `"${fullName}" is permanently stationed at "${stationLocation}", but the workbook does not say which branch that site belongs to. Add it to permanentSiteBranches in data/matrix-mapping.json once confirmed. Row skipped — guessing a branch would break the rule that staff only serve their own branch.`
          : `"${fullName}" is under section "${currentSection.trim()}", which does not name a branch. Row skipped.`,
        rowNumber,
        details: { stationLocation, section: currentSection.trim() },
      });
      continue;
    }

    const isPms = isPmsGradeLabel(gradeLabel);
    if (!isPms) unrecognisedGrades.add(gradeLabel);

    const sourceKey = buildSourceKey(fullName, branchCode);
    const duplicateRow = seenKeys.get(sourceKey);
    if (duplicateRow !== undefined) {
      issues.push({
        code: 'MATRIX_ROW_DUPLICATE',
        message: `"${fullName}" (${branchCode}) also appears on row ${duplicateRow}. Two rows with the same name and branch cannot be told apart, so this one is skipped rather than silently merged.`,
        rowNumber,
      });
      continue;
    }
    seenKeys.set(sourceKey, rowNumber);

    const skills = skillColumns
      .filter((column) => isCheckmark(row[column.index] ?? '', mapping))
      .map((column) => ({
        skillCode: toSkillCode(column.label),
        skillLabel: column.label,
      }));

    const vehicleRefs = vehicleColumns
      .filter((column) => isCheckmark(row[column.index] ?? '', mapping))
      .map((column) => vehicleCodeByColumn.get(column.index))
      .filter((code): code is string => Boolean(code))
      .map((vehicleCode) => ({ vehicleCode }));

    const sourceRow: Record<string, string> = {};
    headerRow.forEach((label, index) => {
      const value = (row[index] ?? '').trim();
      if (label && value) sourceRow[label] = value;
    });

    employees.push({
      sourceKey,
      rowNumber,
      sourceNumber:
        identity.sourceNumber === -1
          ? null
          : (row[identity.sourceNumber] ?? '').trim() || null,
      fullName,
      gradeLabel,
      isPmsGrade: isPms,
      branchCode,
      permanentSiteName: isPermanentlyStationed ? stationLocation || null : null,
      isPermanentlyStationed,
      skills,
      vehicles: vehicleRefs,
      sourceRow,
    });
  }

  if (employees.length === 0) {
    issues.push({
      code: 'MATRIX_NO_ROWS',
      message: `No employee rows were read below header row ${headerBottomIndex + 1}.`,
    });
  }

  return {
    employees,
    vehicles,
    skillColumns,
    vehicleColumns,
    issues,
    unrecognisedGrades: [...unrecognisedGrades].sort(),
    headerRowNumber: headerBottomIndex + 1,
  };
}

/**
 * Natural key for an employee.
 *
 * The workbook has no employee number, so the key is the normalised name plus
 * branch. Re-importing then updates people instead of duplicating them, which
 * is the whole point of the seed being repeatable.
 */
export function buildSourceKey(fullName: string, branch: BranchCode): string {
  return `${branch}:${normalizeHeader(fullName).replace(/ /g, '_')}`;
}

function findIdentityRow(grid: Grid, mapping: MatrixMapping): number {
  const wanted = (candidates: string[], row: string[]) =>
    row.some((cell) => candidates.includes(normalizeHeader(cell)));

  for (let r = 0; r < Math.min(grid.length, 30); r += 1) {
    const row = grid[r] ?? [];
    if (
      wanted(mapping.columns.fullName, row) &&
      wanted(mapping.columns.designation, row)
    ) {
      return r;
    }
  }
  return -1;
}

/**
 * Finds the last row of the header block.
 *
 * The identity columns are merged down the whole block, so once merges are
 * resolved every row in it repeats the same "Name Of Technician" text. That
 * repetition is the signal: keep descending while it holds. Capped so a
 * workbook with a stray repeated value cannot swallow the data.
 */
function findHeaderBottom(
  grid: Grid,
  identityRowIndex: number,
  identity: IdentityColumns,
): number {
  if (identity.fullName === -1) return identityRowIndex;

  const headerText = normalizeHeader(
    grid[identityRowIndex]?.[identity.fullName] ?? '',
  );
  if (!headerText) return identityRowIndex;

  const maxDepth = Math.min(identityRowIndex + 5, grid.length - 1);
  let bottom = identityRowIndex;

  while (bottom < maxDepth) {
    const next = normalizeHeader(grid[bottom + 1]?.[identity.fullName] ?? '');
    if (next !== headerText) break;
    bottom += 1;
  }

  return bottom;
}

/**
 * Flattens the header block into one label per column, plus the group headings
 * above each.
 *
 * The label is the *deepest* non-empty cell in the block — the most specific
 * heading, which is the one that names the column. Everything above it is
 * group context: "Transport" over "Personal" over the registration. Both are
 * needed, because a column is recognised as a vehicle either by its group or by
 * a capacity in its own title.
 *
 * Values are forward-filled across each row as a fallback for headings that are
 * visually grouped but not actually merged, which the reader cannot resolve.
 */
function buildHeaderBlock(
  grid: Grid,
  topIndex: number,
  bottomIndex: number,
): { headerRow: string[]; groupLabels: string[] } {
  const width = Math.max(...grid.map((row) => row.length), 0);
  const startIndex = Math.max(0, topIndex - 2);

  const rawRows: string[][] = [];
  const filledRows: string[][] = [];

  for (let r = startIndex; r <= bottomIndex; r += 1) {
    const row = grid[r] ?? [];
    const raw: string[] = new Array(width).fill('');
    const filled: string[] = new Array(width).fill('');
    let carried = '';

    for (let c = 0; c < width; c += 1) {
      const cell = (row[c] ?? '').trim();
      raw[c] = cell;
      if (cell) carried = cell;
      filled[c] = carried;
    }

    rawRows.push(raw);
    filledRows.push(filled);
  }

  const headerRow: string[] = new Array(width).fill('');
  const groupLabels: string[] = new Array(width).fill('');

  for (let c = 0; c < width; c += 1) {
    // The label comes from the raw block only. The reader has already resolved
    // merged cells, so a column blank all the way down really is blank — and
    // taking a forward-filled value here would give it its neighbour's name,
    // silently duplicating a column.
    const rawStack = rawRows.map((row) => row[c]).filter(Boolean);
    headerRow[c] = rawStack.length ? rawStack[rawStack.length - 1] : '';

    // Group context tolerates the forward fill: it is only used to help spot
    // vehicle columns, and headings that are visually grouped but not actually
    // merged are common in this workbook.
    const groupStack = filledRows
      .map((row) => row[c])
      .filter((value, index, all) => value && value !== all[index - 1])
      .filter((value) => value !== headerRow[c]);

    groupLabels[c] = groupStack.join(' / ');
  }

  return { headerRow, groupLabels };
}

interface IdentityColumns {
  sourceNumber: number;
  fullName: number;
  stationLocation: number;
  designation: number;
}

function locateIdentityColumns(
  headerRow: string[],
  mapping: MatrixMapping,
): IdentityColumns {
  const find = (candidates: string[]) =>
    headerRow.findIndex((cell) => candidates.includes(normalizeHeader(cell)));

  return {
    sourceNumber: find(mapping.columns.sourceNumber),
    fullName: find(mapping.columns.fullName),
    stationLocation: find(mapping.columns.stationLocation),
    designation: find(mapping.columns.designation),
  };
}

function classifyColumns(
  headerRow: string[],
  groupLabels: string[],
  identity: IdentityColumns,
  mapping: MatrixMapping,
): { skillColumns: ColumnSpec[]; vehicleColumns: ColumnSpec[] } {
  const identityIndexes = new Set(Object.values(identity));
  const vehicleGroups = mapping.vehicleGroups.map(normalizeHeader);

  const skillColumns: ColumnSpec[] = [];
  const vehicleColumns: ColumnSpec[] = [];

  headerRow.forEach((rawLabel, index) => {
    const label = rawLabel.trim();
    if (!label) return;
    if (identityIndexes.has(index)) return;
    if (index < identity.designation) return;

    const group = groupLabels[index]?.trim() || null;
    const normalizedGroup = group ? normalizeHeader(group) : '';

    const groupSaysVehicle = vehicleGroups.some(
      (candidate) => normalizedGroup.includes(candidate),
    );
    // A registration in the header is decisive even if the group heading is
    // missing, which happens when a column is added without extending the merge.
    const headerHasRegistration = /\(\s*\d+\s*(People|Person)\s*\)/i.test(label);

    if (groupSaysVehicle || headerHasRegistration) {
      vehicleColumns.push({ index, label, group });
    } else {
      skillColumns.push({ index, label, group });
    }
  });

  return { skillColumns, vehicleColumns };
}

function buildVehicles(
  vehicleColumns: ColumnSpec[],
  groupLabels: string[],
  issues: ImportIssue[],
): ParsedVehicle[] {
  const byCode = new Map<string, ParsedVehicle>();

  for (const column of vehicleColumns) {
    const { code, seatCapacity } = parseVehicleHeader(column.label);

    if (!code) {
      issues.push({
        code: 'MATRIX_VEHICLE_NO_REGISTRATION',
        message: `Vehicle column "${column.label}" has no registration number, so it cannot be identified. Column ignored.`,
        details: { column: column.label },
      });
      continue;
    }

    if (byCode.has(code)) {
      issues.push({
        code: 'MATRIX_VEHICLE_DUPLICATE',
        message: `Registration "${code}" appears in more than one column. Only the first is used.`,
        details: { column: column.label },
      });
      continue;
    }

    byCode.set(code, {
      code,
      label: column.label,
      seatCapacity,
      ownershipGroup: groupLabels[column.index]?.trim() || null,
    });
  }

  return [...byCode.values()];
}

function resolveBranch(input: {
  section: string;
  stationLocation: string;
  fullName: string;
  isPermanentlyStationed: boolean;
  mapping: MatrixMapping;
}): BranchCode | null {
  const { section, stationLocation, fullName, isPermanentlyStationed, mapping } =
    input;

  if (isPermanentlyStationed) {
    // The workbook gives these people a site, not a branch.
    const site = normalizeHeader(stationLocation);
    for (const [name, branch] of Object.entries(
      mapping.permanentSiteBranches,
    )) {
      if (normalizeHeader(name) === site) return branch;
    }
    return null;
  }

  for (const [label, branch] of Object.entries(mapping.sections.branches)) {
    if (section.includes(normalizeHeader(label))) return branch;
  }

  // Some rows carry the branch in the name itself, e.g. "P Praveenan Kandy".
  const normalizedName = normalizeHeader(fullName);
  for (const [label, branch] of Object.entries(mapping.sections.branches)) {
    if (normalizedName.includes(normalizeHeader(label))) return branch;
  }

  return null;
}

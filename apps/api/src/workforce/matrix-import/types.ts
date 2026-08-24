import { BranchCode } from '@prisma/client';

/** The workbook reduced to trimmed cell strings. Row 0 is sheet row 1. */
export type Grid = string[][];

export interface ColumnSpec {
  index: number;
  /** Header text exactly as it appears in the workbook. */
  label: string;
  /** Group heading above it, e.g. "Fumigations", "Transport Company". */
  group: string | null;
}

export interface ParsedSkill {
  skillCode: string;
  skillLabel: string;
}

export interface ParsedVehicleRef {
  vehicleCode: string;
}

export interface ParsedEmployee {
  /** Stable natural key; the importer upserts on this. */
  sourceKey: string;
  /** Row number in the workbook, for error messages. */
  rowNumber: number;
  /** "No." column value when present. */
  sourceNumber: string | null;
  /** Name exactly as spelled in the workbook. */
  fullName: string;
  /** Designation exactly as spelled in the workbook. */
  gradeLabel: string;
  isPmsGrade: boolean;
  branchCode: BranchCode;
  /** Set when the row sits under the permanently-stationed section. */
  permanentSiteName: string | null;
  isPermanentlyStationed: boolean;
  skills: ParsedSkill[];
  vehicles: ParsedVehicleRef[];
  /** Untouched copy of the row, keyed by header. */
  sourceRow: Record<string, string>;
}

export interface ParsedVehicle {
  /** Registration, e.g. "DAI-0191". Unique per vehicle. */
  code: string;
  /** Full header text, e.g. "Bolero Truck( 02 People) DAI-0191". */
  label: string;
  /** Seats parsed from "( 04 People)". Null when the header does not say. */
  seatCapacity: number | null;
  /** Ownership group from the workbook: Public / Personal / Transport Company / Rent. */
  ownershipGroup: string | null;
}

export interface ImportIssue {
  code: string;
  message: string;
  rowNumber?: number;
  details?: Record<string, unknown>;
}

export interface ParsedMatrix {
  employees: ParsedEmployee[];
  vehicles: ParsedVehicle[];
  skillColumns: ColumnSpec[];
  vehicleColumns: ColumnSpec[];
  /** Rows the parser refused to guess at. These are never imported. */
  issues: ImportIssue[];
  /** Designations not recognised as PMS-grade, for human review. */
  unrecognisedGrades: string[];
  headerRowNumber: number;
}

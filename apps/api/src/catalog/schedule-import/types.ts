import { FrequencyUnit, Weekday } from '@prisma/client';

/**
 * Shapes read out of UltraKIL's hand-maintained master schedule workbook.
 *
 * The workbook is twenty sheets kept by hand over years, so almost every field
 * is free text and much of it does not fit the data model. Nothing here guesses:
 * a value the parser cannot read with confidence becomes an issue naming the
 * sheet, the row and the text it could not interpret, and the row is not
 * imported. A customer silently given the wrong visit frequency is worse than
 * a customer the report says needs a human decision.
 */

/** A frequency the model can express. */
export interface ParsedFrequency {
  count: number;
  unit: FrequencyUnit;
  /** Units per cycle. 2 with WEEK is fortnightly; 3 with MONTH is quarterly. */
  interval: number;
}

export type FrequencyOutcome =
  | { kind: 'parsed'; frequency: ParsedFrequency; source: string }
  /** Recognised, but the model has no way to express it — e.g. fortnightly. */
  | { kind: 'unsupported'; source: string; reason: string }
  /** Nothing to read. */
  | { kind: 'absent' }
  /** Read, but not understood. */
  | { kind: 'unreadable'; source: string };

export type DayRuleOutcome =
  | { kind: 'parsed'; allowedDays: Weekday[]; source: string }
  /**
   * Worked out from the visit dates the workbook has already booked, because
   * the Day column was empty. Evidence rather than a guess — these are the
   * weekdays UltraKIL demonstrably uses for this site — but it is recorded
   * separately from a stated rule so nobody mistakes one for the other.
   */
  | {
      kind: 'derived';
      allowedDays: Weekday[];
      /** How many booked dates the weekdays were counted from. */
      sampleSize: number;
      evidence: string;
    }
  /** A real rule the model cannot hold — "2nd and Last Friday", "9th, 29th". */
  | { kind: 'unsupported'; source: string; reason: string }
  | { kind: 'absent' }
  | { kind: 'unreadable'; source: string };

/** Visit length and crew size, both held in the workbook's "Duration and PCT". */
export interface ParsedEffort {
  durationMinutes: number | null;
  /** PCT — pest control technicians — is the crew size. */
  crewSize: number | null;
}

export interface ParsedSite {
  /** Site name as written. */
  name: string;
  addressLine: string | null;
  /** The customer's own region label, when the sheet carries one. */
  regionLabel: string | null;
  /** Location or branch code from the sheet, when present. */
  locationCode: string | null;
}

export interface ParsedAgreement {
  siteName: string;
  /** Treatment codes exactly as written, e.g. ["GPC", "RC"]. */
  treatmentCodes: string[];
  frequency: FrequencyOutcome;
  dayRule: DayRuleOutcome;
  effort: ParsedEffort;
  /** "Agreement date Up to", when the sheet records one. */
  endDate: string | null;
  notes: string | null;
}

export interface ParsedCustomer {
  name: string;
  /** Sheet the customer came from, for tracing a row back. */
  sourceSheet: string;
  sites: ParsedSite[];
  agreements: ParsedAgreement[];
}

export interface ImportIssue {
  sheet: string;
  rowNumber: number | null;
  code:
    | 'FREQUENCY_UNSUPPORTED'
    | 'FREQUENCY_UNREADABLE'
    | 'FREQUENCY_MISSING'
    | 'DAY_RULE_UNSUPPORTED'
    | 'DAY_RULE_UNREADABLE'
    | 'DAY_RULE_MISSING'
    | 'DAY_RULE_DERIVED'
    | 'TREATMENT_MISSING'
    | 'TREATMENT_UNKNOWN'
    | 'SITE_NAME_MISSING'
    | 'BRANCH_UNKNOWN'
    | 'SHEET_NOT_MAPPED';
  /** What the workbook actually said, so a human can find it. */
  source: string | null;
  message: string;
}

export interface ParsedSchedule {
  customers: ParsedCustomer[];
  issues: ImportIssue[];
  /** Sheets read, and how many rows each contributed. */
  sheetSummary: { sheet: string; rows: number; sites: number }[];
}

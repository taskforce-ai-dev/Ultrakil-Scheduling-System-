import { BranchCode } from '@prisma/client';

/**
 * How to read each sheet of UltraKIL's master schedule workbook.
 *
 * The workbook is not one table. Two sheets list agreements across many
 * customers; the other eighteen are one customer each, with their branches
 * down the page. Every one was laid out by hand, so the column positions are
 * declared here rather than sniffed — a parser that guesses which column holds
 * the branch name will eventually pick the wrong one and nobody will notice.
 */

/** A sheet listing many customers, one agreement per row. */
export interface AgreementSheetMapping {
  kind: 'agreements';
  sheet: string;
  headerRow: number;
  columns: {
    customer: number;
    location: number;
    treatment: number;
    frequency: number;
    day?: number;
    effort?: number;
    endDate?: number;
  };
  /**
   * Columns holding the visit dates already planned, in month order from
   * January. Used to work out the weekdays a site is actually serviced on when
   * the Day column is empty, which is most of them.
   */
  monthColumns?: number[];
  /** Calendar year those dates belong to. */
  year?: number;
}

/** A sheet for one customer, one site per row. */
export interface BranchSheetMapping {
  kind: 'branches';
  sheet: string;
  /** Customer name to record. The sheet name is often an abbreviation. */
  customerName: string;
  headerRow: number;
  columns: {
    site: number;
    address?: number;
    region?: number;
    code?: number;
  };
}

export type SheetMapping = AgreementSheetMapping | BranchSheetMapping;

/**
 * The branch every imported site is given.
 *
 * The workbook does not record which UltraKIL branch serves a site — its own
 * "Region" columns are the customer's regions, not Colombo and Kandy. Rather
 * than infer a branch from a place name, every site is created in this branch
 * and listed in the report so UltraKIL can move the Kandy ones deliberately.
 * Branch isolation is a hard scheduling rule, and a wrong branch assigned
 * quietly is exactly the sort of error that survives to the pilot.
 */
export const DEFAULT_IMPORT_BRANCH = BranchCode.COLOMBO;

/** Values that appear in a site column but are not sites. */
export const SITE_NAME_STOPWORDS = new Set([
  'branch',
  'branches',
  'location',
  'outlet',
  'customer',
  'date',
  'no',
  's/n',
  'sn',
  'client',
  'region',
  'total',
  'hnb',
  'pabc',
  'ceylinco',
]);

export const SHEET_MAPPINGS: SheetMapping[] = [
  {
    kind: 'agreements',
    sheet: 'Main',
    headerRow: 2,
    columns: {
      customer: 2,
      endDate: 3,
      location: 4,
      treatment: 5,
      frequency: 6,
      day: 7,
      effort: 8,
    },
    monthColumns: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
    year: 2026,
  },
  {
    kind: 'agreements',
    sheet: 'On Request',
    headerRow: 1,
    columns: { customer: 2, location: 3, treatment: 4, frequency: 5 },
  },

  // --- One customer per sheet ------------------------------------------------
  { kind: 'branches', sheet: 'MBSL', customerName: 'MBSL', headerRow: 1, columns: { site: 2, code: 1 } },
  {
    kind: 'branches',
    sheet: 'Union Bank',
    customerName: 'Union Bank',
    headerRow: 1,
    columns: { site: 2, address: 4, region: 1 },
  },
  {
    kind: 'branches',
    sheet: 'Keells 26 From April',
    customerName: 'Keells',
    headerRow: 1,
    // Column 3 is the name the customer uses; column 2 is Keells' internal one.
    columns: { site: 3, code: 1 },
  },
  {
    kind: 'branches',
    sheet: 'Keells Special',
    customerName: 'Keells',
    headerRow: 2,
    columns: { site: 2, code: 1 },
  },
  { kind: 'branches', sheet: 'HNB', customerName: 'HNB', headerRow: 2, columns: { site: 2, code: 1 } },
  { kind: 'branches', sheet: 'Sathosa', customerName: 'Sathosa', headerRow: 1, columns: { site: 2, code: 1 } },
  {
    kind: 'branches',
    sheet: 'Cargills New',
    customerName: 'Cargills',
    headerRow: 1,
    columns: { site: 2, code: 3 },
  },
  {
    kind: 'branches',
    sheet: 'Vallibel- 2 Scope',
    customerName: 'Vallibel (Scope 2)',
    headerRow: 2,
    columns: { site: 2, code: 1 },
  },
  {
    kind: 'branches',
    sheet: 'Perera & Sons',
    customerName: 'Perera & Sons',
    headerRow: 1,
    columns: { site: 2 },
  },
  {
    kind: 'branches',
    sheet: 'Seylan Bank',
    customerName: 'Seylan Bank',
    headerRow: 1,
    columns: { site: 2, code: 1 },
  },
  { kind: 'branches', sheet: 'Dialog', customerName: 'Dialog', headerRow: 2, columns: { site: 2, code: 1 } },
  { kind: 'branches', sheet: 'Milco', customerName: 'Milco', headerRow: 2, columns: { site: 1 } },
  {
    kind: 'branches',
    sheet: 'Vallibel- 1 Scope',
    customerName: 'Vallibel (Scope 1)',
    headerRow: 2,
    columns: { site: 2, code: 1 },
  },
  { kind: 'branches', sheet: 'Ceylinco', customerName: 'Ceylinco', headerRow: 1, columns: { site: 2, code: 1 } },
  { kind: 'branches', sheet: 'PABC', customerName: 'PABC', headerRow: 1, columns: { site: 2, code: 1 } },
  { kind: 'branches', sheet: 'SPC', customerName: 'SPC', headerRow: 1, columns: { site: 2, code: 1 } },
  {
    kind: 'branches',
    sheet: 'Medical Supplies Division',
    customerName: 'Medical Supplies Division',
    headerRow: 1,
    columns: { site: 2, code: 1 },
  },
  {
    kind: 'branches',
    sheet: 'Nestle New',
    customerName: 'Nestle',
    headerRow: 1,
    columns: { site: 2, address: 4, region: 3, code: 1 },
  },
];

import ExcelJS from 'exceljs';

import { CellMarking, ExcelColour, classifyRecord, isRedMarking } from './cell-colour';
import {
  AgreementSheetMapping,
  BranchSheetMapping,
  SHEET_MAPPINGS,
  SITE_NAME_STOPWORDS,
  SheetMapping,
} from './sheet-mapping';
import {
  deriveAllowedDaysFromDates,
  parseDayRule,
  parseEffort,
  parseFrequency,
  parseTreatmentCodes,
} from './text';
import {
  ImportIssue,
  ParsedAgreement,
  ParsedCustomer,
  ParsedSchedule,
  ParsedSite,
} from './types';

/** A cell as plain text, whatever exceljs made of it. */
function cellText(row: ExcelJS.Row, column: number | undefined): string {
  if (!column) return '';
  const value = row.getCell(column).value;
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const record = value as { text?: unknown; result?: unknown };
    const inner = record.text ?? record.result ?? '';
    return String(inner).replace(/\s+/g, ' ').trim();
  }
  return String(value).replace(/\s+/g, ' ').trim();
}

/**
 * How one identity cell is marked, from its fill and its font.
 *
 * Both are read because the workbook uses both: some sheets fill the row red,
 * others leave the fill alone and turn the text red. Either is a statement;
 * neither is more official than the other.
 */
function cellMarking(row: ExcelJS.Row, column: number | undefined): CellMarking {
  if (!column) return 'plain';
  const cell = row.getCell(column);

  const fill = cell.fill;
  if (fill?.type === 'pattern' && fill.pattern !== 'none') {
    if (isRedMarking(fill.fgColor as ExcelColour | undefined)) return 'red';
  }

  if (isRedMarking(cell.font?.color as ExcelColour | undefined)) return 'red';

  return 'plain';
}

/** True when a site cell holds a heading or filler rather than a place. */
function looksLikeHeading(value: string, headerText: string): boolean {
  const normalised = value.toLowerCase().trim();
  if (!normalised) return true;
  if (normalised === headerText.toLowerCase().trim()) return true;
  if (SITE_NAME_STOPWORDS.has(normalised)) return true;
  // "Branch End 30/06/2027?" and friends — a heading with a date stuck on.
  return /^(branch|location|outlet|customer)\b.*\d{2}\/\d{2}\/\d{4}/.test(normalised);
}

/** Only a date the workbook wrote as a real date is trusted. */
function readEndDate(raw: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

/**
 * Pulls the day-of-month numbers out of a row's month columns.
 *
 * The cells are handwritten and hold things like "5,2,7,9,12" and "16.10.30",
 * so every one- or two-digit number is taken and anything outside 1-31 is
 * dropped. A wrong number simply contributes no weekday; it cannot invent one.
 */
function readBookedDates(
  row: ExcelJS.Row,
  mapping: AgreementSheetMapping,
): { month: number; day: number }[] {
  const bookings: { month: number; day: number }[] = [];

  mapping.monthColumns?.forEach((column, index) => {
    const raw = cellText(row, column);
    if (!raw) return;

    for (const match of raw.matchAll(/\b(\d{1,2})\b/g)) {
      const day = Number.parseInt(match[1], 10);
      if (day >= 1 && day <= 31) bookings.push({ month: index + 1, day });
    }
  });

  return bookings;
}

function readAgreementSheet(
  worksheet: ExcelJS.Worksheet,
  mapping: AgreementSheetMapping,
  customers: Map<string, ParsedCustomer>,
  issues: ImportIssue[],
): { rows: number; sites: number } {
  const { columns } = mapping;
  let rows = 0;
  const siteNames = new Set<string>();

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= mapping.headerRow) return;

    const customerName = cellText(row, columns.customer);
    if (!customerName || looksLikeHeading(customerName, 'client')) return;
    rows += 1;

    // A row with no location still names a customer worth creating; the site
    // falls back to the customer's own name so nothing is silently dropped.
    const rawLocation = cellText(row, columns.location);
    const siteName = rawLocation || customerName;
    if (!rawLocation) {
      issues.push({
        sheet: mapping.sheet,
        rowNumber,
        code: 'SITE_NAME_MISSING',
        source: null,
        message: `${customerName} has no location, so the site was named after the customer. Add the location to the workbook if it matters.`,
      });
    }

    // Only these two cells are ever consulted. The month and date columns are
    // full of red for reasons that have nothing to do with whether a client is
    // still on the books, and the heading guard above has already excluded
    // section headers, so a red banner cannot reach this line.
    const marking = classifyRecord([
      cellMarking(row, columns.customer),
      ...(rawLocation ? [cellMarking(row, columns.location)] : []),
    ]);
    const isServiced = marking !== 'inactive';

    if (marking === 'inactive') {
      issues.push({
        sheet: mapping.sheet,
        rowNumber,
        code: 'RECORD_INACTIVE',
        source: null,
        message: `${customerName} — ${siteName}: marked red, so it was imported as no longer serviced. It generates no future visits; its history is kept.`,
      });
    } else if (marking === 'ambiguous') {
      issues.push({
        sheet: mapping.sheet,
        rowNumber,
        code: 'RECORD_MARKING_AMBIGUOUS',
        source: null,
        message: `${customerName} — ${siteName}: the client and location cells disagree on the red marking, so it was left serviced. Someone should confirm which was meant.`,
      });
    }

    const customer = upsertCustomer(customers, customerName, mapping.sheet);
    addSite(customer, {
      name: siteName,
      addressLine: null,
      regionLabel: null,
      locationCode: null,
      isServiced,
    });
    // One live row keeps the customer live, however many of its sites have closed.
    if (isServiced) customer.isServiced = true;
    siteNames.add(siteName);

    const treatmentCodes = parseTreatmentCodes(cellText(row, columns.treatment));
    if (treatmentCodes.length === 0) {
      issues.push({
        sheet: mapping.sheet,
        rowNumber,
        code: 'TREATMENT_MISSING',
        source: null,
        message: `${customerName} — ${siteName}: no treatment recorded, so no agreement was created. UltraKIL needs to say what work this is.`,
      });
    }

    const frequency = parseFrequency(cellText(row, columns.frequency));
    let dayRule = parseDayRule(cellText(row, columns.day));

    // Most rows leave the Day column empty but do record the dates actually
    // booked. Those dates say which weekdays the site is really serviced on,
    // so they are read rather than the row being discarded for want of a rule
    // the workbook never wrote down.
    if (dayRule.kind === 'absent') {
      const derived = deriveAllowedDaysFromDates(
        readBookedDates(row, mapping),
        mapping.year ?? new Date().getUTCFullYear(),
      );
      if (derived) dayRule = { kind: 'derived', ...derived };
    }
    recordFrequencyIssue(issues, mapping.sheet, rowNumber, customerName, siteName, frequency);
    recordDayRuleIssue(issues, mapping.sheet, rowNumber, customerName, siteName, dayRule);

    customer.agreements.push({
      siteName,
      isServiced,
      treatmentCodes,
      frequency,
      dayRule,
      effort: parseEffort(cellText(row, columns.effort)),
      endDate: readEndDate(cellText(row, columns.endDate)),
      notes: null,
    });
  });

  return { rows, sites: siteNames.size };
}

function readBranchSheet(
  worksheet: ExcelJS.Worksheet,
  mapping: BranchSheetMapping,
  customers: Map<string, ParsedCustomer>,
  issues: ImportIssue[],
): { rows: number; sites: number } {
  const headerText = cellText(worksheet.getRow(mapping.headerRow), mapping.columns.site);
  const customer = upsertCustomer(customers, mapping.customerName, mapping.sheet);
  let rows = 0;
  const before = customer.sites.length;

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= mapping.headerRow) return;

    const name = cellText(row, mapping.columns.site);
    if (looksLikeHeading(name, headerText)) return;
    rows += 1;

    // A branch sheet is one customer's list of places, so the site cell is the
    // whole identity of the record and cannot disagree with itself.
    const isServiced = classifyRecord([cellMarking(row, mapping.columns.site)]) !== 'inactive';
    if (isServiced) {
      customer.isServiced = true;
    } else {
      issues.push({
        sheet: mapping.sheet,
        rowNumber,
        code: 'RECORD_INACTIVE',
        source: null,
        message: `${mapping.customerName} — ${name}: marked red, so it was imported as no longer serviced. It generates no future visits; its history is kept.`,
      });
    }

    addSite(customer, {
      name,
      addressLine: cellText(row, mapping.columns.address) || null,
      regionLabel: cellText(row, mapping.columns.region) || null,
      locationCode: cellText(row, mapping.columns.code) || null,
      isServiced,
    });
  });

  return { rows, sites: customer.sites.length - before };
}

function upsertCustomer(
  customers: Map<string, ParsedCustomer>,
  name: string,
  sheet: string,
): ParsedCustomer {
  const key = name.toLowerCase();
  const existing = customers.get(key);
  if (existing) return existing;

  const created: ParsedCustomer = {
    name,
    sourceSheet: sheet,
    sites: [],
    agreements: [],
    // Raised by the first row that is not red. A customer every one of whose
    // rows is red is genuinely gone.
    isServiced: false,
  };
  customers.set(key, created);
  return created;
}

/** Sites are keyed by name within a customer, so a repeated row is one site. */
function addSite(customer: ParsedCustomer, site: ParsedSite): void {
  const existing = customer.sites.find(
    (candidate) => candidate.name.toLowerCase() === site.name.toLowerCase(),
  );

  if (!existing) {
    customer.sites.push(site);
    return;
  }

  // A later row may carry detail the first one lacked.
  existing.addressLine ??= site.addressLine;
  existing.regionLabel ??= site.regionLabel;
  existing.locationCode ??= site.locationCode;
  // One live row is enough. The same site listed twice, red on one sheet and
  // plain on another, is still being serviced somewhere — and stopping work
  // that is still happening is the worse of the two mistakes.
  if (site.isServiced) existing.isServiced = true;
}

function recordFrequencyIssue(
  issues: ImportIssue[],
  sheet: string,
  rowNumber: number,
  customerName: string,
  siteName: string,
  frequency: ParsedAgreement['frequency'],
): void {
  const where = `${customerName} — ${siteName}`;

  if (frequency.kind === 'unsupported') {
    issues.push({
      sheet,
      rowNumber,
      code: 'FREQUENCY_UNSUPPORTED',
      source: frequency.source,
      message: `${where}: "${frequency.source}" — ${frequency.reason}. No agreement was created.`,
    });
  } else if (frequency.kind === 'unreadable') {
    issues.push({
      sheet,
      rowNumber,
      code: 'FREQUENCY_UNREADABLE',
      source: frequency.source,
      message: `${where}: could not read the frequency "${frequency.source}". No agreement was created.`,
    });
  } else if (frequency.kind === 'absent') {
    issues.push({
      sheet,
      rowNumber,
      code: 'FREQUENCY_MISSING',
      source: null,
      message: `${where}: no frequency recorded. No agreement was created.`,
    });
  }
}

function recordDayRuleIssue(
  issues: ImportIssue[],
  sheet: string,
  rowNumber: number,
  customerName: string,
  siteName: string,
  dayRule: ParsedAgreement['dayRule'],
): void {
  const where = `${customerName} — ${siteName}`;

  if (dayRule.kind === 'unsupported') {
    issues.push({
      sheet,
      rowNumber,
      code: 'DAY_RULE_UNSUPPORTED',
      source: dayRule.source,
      message: `${where}: "${dayRule.source}" — ${dayRule.reason}. No agreement was created.`,
    });
  } else if (dayRule.kind === 'unreadable') {
    issues.push({
      sheet,
      rowNumber,
      code: 'DAY_RULE_UNREADABLE',
      source: dayRule.source,
      message: `${where}: could not read the day rule "${dayRule.source}". No agreement was created.`,
    });
  } else if (dayRule.kind === 'derived') {
    issues.push({
      sheet,
      rowNumber,
      code: 'DAY_RULE_DERIVED',
      source: dayRule.evidence,
      message: `${where}: the Day column was empty, so the allowed days were read from the ${dayRule.sampleSize} visit dates already booked (${dayRule.evidence}). Confirm these are right.`,
    });
  } else if (dayRule.kind === 'absent') {
    issues.push({
      sheet,
      rowNumber,
      code: 'DAY_RULE_MISSING',
      source: null,
      message: `${where}: no allowed days recorded. No agreement was created — a visit needs a day it may fall on.`,
    });
  }
}

/** Reads the whole workbook. Nothing is written; nothing is guessed. */
export async function parseMasterSchedule(path: string): Promise<ParsedSchedule> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);

  const customers = new Map<string, ParsedCustomer>();
  const issues: ImportIssue[] = [];
  const sheetSummary: ParsedSchedule['sheetSummary'] = [];

  const mapped = new Map<string, SheetMapping>(
    SHEET_MAPPINGS.map((mapping) => [mapping.sheet, mapping]),
  );

  workbook.eachSheet((worksheet) => {
    const mapping = mapped.get(worksheet.name);

    if (!mapping) {
      // A sheet added since this mapping was written. Reported rather than
      // read on a guess: its layout is unknown, so anything read would be too.
      issues.push({
        sheet: worksheet.name,
        rowNumber: null,
        code: 'SHEET_NOT_MAPPED',
        source: null,
        message: `Sheet "${worksheet.name}" is not in the import mapping, so nothing was read from it. Add it to sheet-mapping.ts once someone confirms its layout.`,
      });
      return;
    }

    const counts =
      mapping.kind === 'agreements'
        ? readAgreementSheet(worksheet, mapping, customers, issues)
        : readBranchSheet(worksheet, mapping, customers, issues);

    sheetSummary.push({ sheet: worksheet.name, ...counts });
  });

  return { customers: [...customers.values()], issues, sheetSummary };
}

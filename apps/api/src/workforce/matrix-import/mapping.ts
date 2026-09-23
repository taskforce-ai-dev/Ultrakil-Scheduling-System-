import { BranchCode } from '@prisma/client';

/**
 * How to read the UltraKIL workforce matrix.
 *
 * Defaults match the workbook as it stands today. Override any of it by placing
 * a JSON file at `data/matrix-mapping.json` — that way the workbook can be
 * reorganised without a code change.
 */
export interface MatrixMapping {
  /** Sheet to read. Null means the first sheet. */
  sheetName: string | null;

  /** Header spellings, compared after normalisation. */
  columns: {
    sourceNumber: string[];
    fullName: string[];
    stationLocation: string[];
    designation: string[];
  };

  /**
   * Column-group headings that mean "the columns under here are vehicles".
   * Everything else to the right of Designation is treated as a skill.
   */
  vehicleGroups: string[];

  /** Section labels in the left margin, mapped to what they mean. */
  sections: {
    /** Section text -> branch. Matched as a normalised substring. */
    branches: Record<string, BranchCode>;
    /** Section text marking permanently stationed staff. */
    permanentMarkers: string[];
  };

  /**
   * Branch for permanently stationed staff, keyed by their site name.
   *
   * The workbook gives these people a site but never a branch, and the importer
   * will not infer one — staff may only serve their own branch, so a wrong
   * guess puts the wrong crew on a real job. Any site missing from this map is
   * reported and its rows skipped.
   */
  permanentSiteBranches: Record<string, BranchCode>;

  /**
   * Headings that mean "can travel by public transport" rather than naming a
   * vehicle. A checkmark here is a capability, not a driving authorization —
   * there is no vehicle to be authorised for.
   */
  publicTransportColumns: string[];

  /** Cell values that count as a checkmark. */
  checkmarkValues: string[];
}

export const DEFAULT_MAPPING: MatrixMapping = {
  sheetName: null,

  columns: {
    sourceNumber: ['NO', 'NO.', 'S NO', 'SERIAL'],
    fullName: ['NAME OF TECHNICIAN', 'NAME', 'TECHNICIAN', 'EMPLOYEE NAME'],
    stationLocation: ['STATION LOCATION', 'LOCATION', 'STATION'],
    designation: ['DESIGNATION', 'GRADE', 'POSITION'],
  },

  // From the current workbook's top header row.
  vehicleGroups: [
    'PUBLIC VEHICLES',
    'PUBLIC',
    'PERSONAL',
    'TRANSPORT COMPANY',
    'COMPANY',
    'RENT',
    'VEHICLES',
    'TRANSPORT',
  ],

  sections: {
    branches: {
      COLOMBO: BranchCode.COLOMBO,
      KANDY: BranchCode.KANDY,
    },
    permanentMarkers: ['PERMANEN', 'STATION TECHNICIA'],
  },

  // Confirmed by UltraKIL (24 Aug 2026): every permanently stationed site in
  // the current matrix belongs to the Colombo branch. Spellings are taken
  // verbatim from the workbook's "Station Location" column, typos included.
  //
  // A new site added to the workbook will NOT be guessed at — it will be
  // reported and skipped until it is added here or to data/matrix-mapping.json.
  permanentSiteBranches: {
    AuseeOats: BranchCode.COLOMBO,
    'Wattura resort': BranchCode.COLOMBO,
    'Jetwin Blue/Beach': BranchCode.COLOMBO,
    'Maththala Airport': BranchCode.COLOMBO,
    'Lion Brewery': BranchCode.COLOMBO,
    'Logipark International': BranchCode.COLOMBO,
  },

  publicTransportColumns: ['PUBLIC VEHICLES', 'PUBLIC TRANSPORT', 'PUBLIC'],

  checkmarkValues: ['✓', '✔', 'V', 'X', 'YES', 'Y', 'TRUE', '1', '√'],
};

/** Upper-cases, strips punctuation and collapses whitespace. */
export function normalizeHeader(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[._\-/\\()]+/g, ' ')
    .replace(/[^A-Za-z0-9 ]+/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

/** The importer's punctuation-insensitive vehicle identity comparison key. */
export function normalizeVehicleIdentity(raw: string): string {
  return normalizeHeader(raw).replace(/ /g, '');
}

/** Turns a skill label into a stable code, e.g. "MBr Fumigation" -> MBR_FUMIGATION. */
export function toSkillCode(label: string): string {
  return normalizeHeader(label).replace(/ /g, '_');
}

/**
 * Pulls the registration out of a vehicle header.
 *
 * Headers look like "Van( 04 People) 253-4289" or
 * "Motor Bike( 01 Person) BJG 4419". The registration is at the end and may
 * include a province ("WP CAB-1234"); description and capacity are optional.
 */
/** "( 04 People)" / "(1 Person)" — the workbook's own capacity bracket. */
const VEHICLE_CAPACITY = /\(\s*0*(\d+)\s*(?:People|Person)\s*\)/i;

/**
 * A complete trailing registration, including when there is no capacity
 * bracket ("Bolero Truck DAC- 2485"). The leading boundary prevents numeric
 * skill labels such as "Safety Level 2026" from yielding "vel 2026". Numeric
 * prefixes need a separator so an ordinary six/seven-digit skill number is not
 * mistaken for a registration. Keep an optional two-letter provincial prefix:
 * WP CAB-1234 and CP CAB-1234 identify different vehicles.
 */
const VEHICLE_REGISTRATION =
  /(?:^|\s)((?:[A-Za-z]{2}\s+)?(?:[A-Za-z]{1,3}\s*(?:-\s*)?|\d{2,3}(?:\s*-\s*|\s+))\d{4})$/;

export function parseVehicleHeader(label: string): {
  code: string | null;
  seatCapacity: number | null;
} {
  const capacityMatch = label.match(VEHICLE_CAPACITY);
  const seatCapacity = capacityMatch ? Number(capacityMatch[1]) : null;

  // Everything after the closing bracket is the registration.
  const afterBracket = capacityMatch
    ? label.slice(label.indexOf(')', capacityMatch.index ?? 0) + 1)
    : label;

  const compact = afterBracket.trim().replace(/\s+/g, ' ');

  // Never fall back to arbitrary text.
  const registration = compact.match(VEHICLE_REGISTRATION)?.[1];
  const code = registration?.replace(/\s*-\s*/g, '-') ?? null;

  return { code, seatCapacity };
}

/**
 * The vehicle label a manager reads, built from the parts rather than copied.
 *
 * Workbook column headings are written for a spreadsheet, not a screen:
 * "Van( 04 People) SYN-1003" has no space before the bracket and pads the
 * capacity to two digits. Stored verbatim, that spelling turned up wherever a
 * vehicle is named — the dispatch board, the crew editor, the vehicle page,
 * and inside eligibility refusals. The description, the capacity and the
 * registration are already understood here, so the label is assembled from
 * them once instead of being patched with another regex at every place it is
 * displayed.
 */
export function formatVehicleLabel(header: string): string {
  const compact = header.replace(/\s+/g, ' ').trim();
  const capacity = compact.match(VEHICLE_CAPACITY);
  const seatCapacity = capacity ? Number(capacity[1]) : null;
  const { code } = parseVehicleHeader(header);
  // With a bracket the registration follows it, so whatever precedes the
  // bracket is already the description; without one it sits at the end.
  const head = capacity ? compact.slice(0, capacity.index) : compact;
  const description = (capacity ? head : head.replace(VEHICLE_REGISTRATION, '')).trim();

  return [
    description,
    seatCapacity === null
      ? null
      : `(${seatCapacity} ${seatCapacity === 1 ? 'Person' : 'People'})`,
    code,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' ');
}

export function isCheckmark(value: string, mapping: MatrixMapping): boolean {
  const normalized = value.trim().toUpperCase();
  if (!normalized) return false;
  return mapping.checkmarkValues.some((v) => v.toUpperCase() === normalized);
}

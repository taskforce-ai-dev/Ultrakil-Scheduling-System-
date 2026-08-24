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

/** Turns a skill label into a stable code, e.g. "MBr Fumigation" -> MBR_FUMIGATION. */
export function toSkillCode(label: string): string {
  return normalizeHeader(label).replace(/ /g, '_');
}

/**
 * Pulls the registration out of a vehicle header.
 *
 * Headers look like "Van( 04 People) 253-4289" or
 * "Motor Bike( 01 Person) BJG 4419". The registration is the trailing token
 * after the capacity bracket.
 */
export function parseVehicleHeader(label: string): {
  code: string | null;
  seatCapacity: number | null;
} {
  const capacityMatch = label.match(/\(\s*0*(\d+)\s*(?:People|Person)\s*\)/i);
  const seatCapacity = capacityMatch ? Number(capacityMatch[1]) : null;

  // Everything after the closing bracket is the registration.
  const afterBracket = capacityMatch
    ? label.slice(label.indexOf(')', capacityMatch.index ?? 0) + 1)
    : label;

  const code = afterBracket.trim().replace(/\s+/g, ' ') || null;

  return { code, seatCapacity };
}

export function isCheckmark(value: string, mapping: MatrixMapping): boolean {
  const normalized = value.trim().toUpperCase();
  if (!normalized) return false;
  return mapping.checkmarkValues.some((v) => v.toUpperCase() === normalized);
}

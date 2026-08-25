/**
 * A fabricated workforce for local development.
 *
 * Every name, registration and site in here is invented. The real workforce
 * matrix holds actual staff names and grades, so it is never committed —
 * which leaves anyone without a copy of it looking at empty screens and
 * unable to tell a working page from a broken one. This fills that gap.
 *
 * It is built as a `ParsedMatrix` and handed to the same `importMatrix` the
 * real seed uses, so demo rows travel the identical code path and cannot
 * drift into shapes the API would never actually return.
 *
 * The set is deliberately chosen to exercise the rules that matter:
 *
 *   - both branches staffed, so branch isolation is visible rather than
 *     theoretical;
 *   - PMS-grade supervisors in *both* branches, including Kandy — the real
 *     matrix has none there, so without this nobody could see a schedulable
 *     Kandy job while that data question is open;
 *   - permanently stationed staff, who must never be moved;
 *   - an employee who can only reach a site by public transport;
 *   - vehicles shared by several drivers, and a driver authorised for more
 *     than one vehicle, so the authorization screens have something to show;
 *   - one inactive-looking edge: a grade that is deliberately NOT PMS-grade
 *     ("Pest Management Executive"), matching the real exclusion.
 */
import { BranchCode } from '@prisma/client';

import {
  parseVehicleHeader,
  toSkillCode,
} from '../src/workforce/matrix-import/mapping';
import { buildSourceKey } from '../src/workforce/matrix-import/parser';
import { isPmsGradeLabel } from '../src/workforce/pms-grade';
import type {
  ColumnSpec,
  ParsedEmployee,
  ParsedMatrix,
  ParsedVehicle,
} from '../src/workforce/matrix-import/types';

/**
 * Marks a row as fabricated.
 *
 * The demo seed refuses to touch a database holding employees without this
 * flag, so running it against a real import is a no-op rather than a silent
 * overwrite of operational data.
 */
export const DEMO_MARKER = '__demo__';

/** Skill columns, mirroring how the real workbook groups them. */
const SKILL_LABELS = [
  'General Pest Control',
  'Termite Pre Construction Soil Treatment',
  'Anti Termite Post Construction Soil Treatment',
  'MBr Fumigation',
  'Phosphine Fumigation',
  'Rodent Management',
  'Mosquito Fogging',
  'Bird Management',
] as const;

/** Vehicle headers in the workbook's own format: type, capacity, registration. */
const VEHICLE_HEADERS = [
  'Van( 04 People) CAB-1042',
  'Van( 04 People) CAB-2288',
  'Crew Cab( 05 People) CBH-7731',
  'Pickup( 03 People) PJ-5510',
  'Motor Bike( 01 Person) BFT 8820',
  'Motor Bike( 01 Person) BFT 9134',
  'Bolero Truck( 02 People) LM-3067',
] as const;

interface DemoPerson {
  fullName: string;
  gradeLabel: string;
  branchCode: BranchCode;
  skills: string[];
  /** Registrations this person may drive. Authorization only — not ownership. */
  vehicles: string[];
  permanentSiteName?: string;
  canUsePublicTransport?: boolean;
}

const PEOPLE: DemoPerson[] = [
  // --- Colombo, mobile ------------------------------------------------------
  {
    fullName: 'Nimal Rajapaksha',
    gradeLabel: 'Senior PMS',
    branchCode: BranchCode.COLOMBO,
    skills: ['General Pest Control', 'MBr Fumigation', 'Phosphine Fumigation'],
    vehicles: ['CAB-1042', 'CBH-7731'],
  },
  {
    fullName: 'Kamala Wijesinghe',
    gradeLabel: 'PMS',
    branchCode: BranchCode.COLOMBO,
    skills: [
      'General Pest Control',
      'Termite Pre Construction Soil Treatment',
      'Rodent Management',
    ],
    vehicles: ['CAB-2288'],
  },
  {
    fullName: 'Sunil Abeykoon',
    gradeLabel: 'Assistant PMS',
    branchCode: BranchCode.COLOMBO,
    skills: ['General Pest Control', 'Mosquito Fogging'],
    vehicles: ['PJ-5510', 'BFT 8820'],
  },
  {
    fullName: 'Dilrukshi Amarasena',
    gradeLabel: 'Junior PMT',
    branchCode: BranchCode.COLOMBO,
    skills: ['General Pest Control', 'Rodent Management'],
    vehicles: ['CAB-1042'],
  },
  {
    fullName: 'Chaminda Peiris',
    gradeLabel: 'PMT',
    branchCode: BranchCode.COLOMBO,
    skills: [
      'General Pest Control',
      'Anti Termite Post Construction Soil Treatment',
    ],
    vehicles: ['CAB-2288', 'LM-3067'],
  },
  {
    fullName: 'Sanduni Liyanage',
    gradeLabel: 'JPMT',
    branchCode: BranchCode.COLOMBO,
    skills: ['General Pest Control'],
    vehicles: [],
    // No vehicle at all: reaches sites by bus. A crew built around this person
    // still needs someone who can drive, unless the site is on a bus route.
    canUsePublicTransport: true,
  },
  {
    fullName: 'Ruwan Gunasekara',
    gradeLabel: 'Pest Management Executive',
    branchCode: BranchCode.COLOMBO,
    // Deliberately NOT a PMS grade. UltraKIL confirmed an Executive does not
    // count as the PMS-grade supervisor a job requires.
    skills: ['General Pest Control', 'Bird Management'],
    vehicles: ['PJ-5510'],
  },

  // --- Colombo, permanently stationed --------------------------------------
  {
    fullName: 'Priyantha Bandaranayake',
    gradeLabel: 'PMS',
    branchCode: BranchCode.COLOMBO,
    skills: ['General Pest Control', 'Rodent Management'],
    vehicles: [],
    permanentSiteName: 'Harbour View Hotel',
  },
  {
    fullName: 'Malani Serasinghe',
    gradeLabel: 'PMT',
    branchCode: BranchCode.COLOMBO,
    skills: ['General Pest Control', 'Mosquito Fogging'],
    vehicles: [],
    permanentSiteName: 'Greenfield Brewery',
  },

  // --- Kandy, mobile --------------------------------------------------------
  {
    fullName: 'Ajith Dissanayake',
    gradeLabel: 'PMS',
    branchCode: BranchCode.KANDY,
    skills: [
      'General Pest Control',
      'Termite Pre Construction Soil Treatment',
      'MBr Fumigation',
    ],
    vehicles: ['BFT 9134', 'LM-3067'],
  },
  {
    fullName: 'Thilini Ekanayake',
    gradeLabel: 'APMS',
    branchCode: BranchCode.KANDY,
    skills: ['General Pest Control', 'Bird Management'],
    vehicles: ['BFT 9134'],
  },
  {
    fullName: 'Bandula Herath',
    gradeLabel: 'PMT',
    branchCode: BranchCode.KANDY,
    skills: ['General Pest Control', 'Rodent Management'],
    vehicles: ['LM-3067'],
  },
  {
    fullName: 'Nadeeka Kumarasiri',
    gradeLabel: 'Junior PMT',
    branchCode: BranchCode.KANDY,
    skills: ['General Pest Control'],
    vehicles: [],
    canUsePublicTransport: true,
  },

  // --- Kandy, permanently stationed ----------------------------------------
  {
    fullName: 'Upali Senanayake',
    gradeLabel: 'Assistant PMS',
    branchCode: BranchCode.KANDY,
    skills: ['General Pest Control', 'Phosphine Fumigation'],
    vehicles: [],
    permanentSiteName: 'Hill Country Tea Factory',
  },
];

function buildColumns(labels: readonly string[], group: string | null, offset: number): ColumnSpec[] {
  return labels.map((label, index) => ({
    index: offset + index,
    label,
    group,
  }));
}

function buildVehicles(): ParsedVehicle[] {
  return VEHICLE_HEADERS.map((header) => {
    const { code, seatCapacity } = parseVehicleHeader(header);
    if (!code) {
      throw new Error(`Demo vehicle header has no registration: "${header}"`);
    }
    return { code, label: header, seatCapacity, ownershipGroup: 'Company Vehicles' };
  });
}

function buildEmployees(): ParsedEmployee[] {
  return PEOPLE.map((person, index) => ({
    sourceKey: buildSourceKey(person.fullName, person.branchCode),
    rowNumber: index + 2,
    sourceNumber: String(index + 1),
    fullName: person.fullName,
    gradeLabel: person.gradeLabel,
    isPmsGrade: isPmsGradeLabel(person.gradeLabel),
    branchCode: person.branchCode,
    permanentSiteName: person.permanentSiteName ?? null,
    isPermanentlyStationed: Boolean(person.permanentSiteName),
    skills: person.skills.map((label) => ({
      skillCode: toSkillCode(label),
      skillLabel: label,
    })),
    canUsePublicTransport: Boolean(person.canUsePublicTransport),
    vehicles: person.vehicles.map((vehicleCode) => ({ vehicleCode })),
    // Tags the row as fabricated. The demo seed reads this back to tell demo
    // data apart from a real import.
    sourceRow: { [DEMO_MARKER]: 'true', Name: person.fullName },
  }));
}

/** The fabricated workforce, in the shape the real importer consumes. */
export function buildDemoMatrix(): ParsedMatrix {
  const vehicles = buildVehicles();

  return {
    employees: buildEmployees(),
    vehicles,
    skillColumns: buildColumns(SKILL_LABELS, 'Services', 4),
    vehicleColumns: buildColumns(
      VEHICLE_HEADERS,
      'Company Vehicles',
      4 + SKILL_LABELS.length,
    ),
    publicTransportColumn: {
      index: 4 + SKILL_LABELS.length + VEHICLE_HEADERS.length,
      label: 'Public Vehicles',
      group: null,
    },
    issues: [],
    unrecognisedGrades: ['Pest Management Executive'],
    headerRowNumber: 1,
  };
}

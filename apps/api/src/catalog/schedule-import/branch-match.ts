import { BranchCode } from '@prisma/client';

/**
 * Works out which UltraKIL branch is nearer to a site, from its place name.
 *
 * UltraKIL has two branches, Colombo and Kandy, and the master schedule never
 * says which one serves a site. Every job must belong to exactly one branch —
 * it is a hard scheduling rule — so the choice cannot simply be skipped.
 *
 * The towns below were taken from the place names actually in the workbook.
 * Kandy's list is the Central Province towns a Kandy crew would reasonably
 * reach; Colombo's is the Western Province and the south-west coast. Anything
 * matching neither is *not* guessed: it falls to Colombo, UltraKIL's main
 * branch, and is reported as uncertain so a human can correct it. A site put
 * in the wrong branch quietly sends the wrong crew every visit for a year.
 */

export type BranchConfidence = 'matched' | 'uncertain';

export interface BranchDecision {
  branchCode: BranchCode;
  confidence: BranchConfidence;
  /** The town that decided it, when one did. */
  matchedOn: string | null;
}

/** Central Province and the hill country — a Kandy crew's territory. */
const KANDY_TOWNS = [
  'kandy', 'peradeniya', 'katugastota', 'kadugannawa', 'pilimatalawa',
  'gampola', 'nawalapitiya', 'digana', 'kundasale', 'akurana', 'wattegama',
  'teldeniya', 'galagedara', 'gelioya', 'daulagala', 'menikhinna', 'hataraliyadda',
  'matale', 'ukuwela', 'rattota', 'dambulla', 'naula', 'galewela', 'palapathwela',
  'nuwara eliya', 'nuwaraeliya', 'hatton', 'talawakele', 'talawakelle',
  'ginigathhena', 'maskeliya', 'ragala', 'walapane', 'kotagala', 'dickoya',
  'sigiriya', 'habarana', 'ibbagamuwa', 'kurunegala', 'mawathagama',
  'polgahawela', 'alawwa', 'rambukkana', 'mawanella', 'kegalle', 'warakapola',
];

/** Western Province and the south-west — a Colombo crew's territory. */
const COLOMBO_TOWNS = [
  'colombo', 'col ', 'col.', 'borella', 'bambalapitiya', 'kollupitiya',
  'wellawatta', 'wellawatte', 'dehiwala', 'mount lavinia', 'mt.lavinia',
  'mt lavinia', 'ratmalana', 'rathmalana', 'moratuwa', 'panadura', 'kalutara',
  'horana', 'bandaragama', 'wadduwa', 'beruwala', 'aluthgama', 'kotahena',
  'maradana', 'pettah', 'grandpass', 'dematagoda', 'rajagiriya', 'nugegoda',
  'nawala', 'maharagama', 'kottawa', 'homagama', 'piliyandala', 'kesbewa',
  'boralesgamuwa', 'battaramulla', 'thalawathugoda', 'thalawatugoda',
  'malabe', 'kaduwela', 'athurugiriya', 'kelaniya', 'peliyagoda', 'wattala',
  'ja ela', 'ja-ela', 'jaela', 'negombo', 'katunayake', 'seeduwa', 'gampaha',
  'kadawatha', 'ragama', 'kiribathgoda', 'minuwangoda', 'divulapitiya',
  'veyangoda', 'nittambuwa', 'yakkala', 'mirigama', 'avissawella', 'kosgama',
  'hanwella', 'padukka', 'welisara', 'raddolugama', 'ekala', 'kandana',
  'mattegoda', 'kiriwaththuduwa', 'kiriwattuduwa', 'madapatha', 'godagama',
  'wellampitiya', 'kolonnawa', 'angoda', 'mulleriyawa', 'kaluaggala',
  'galle', 'matara', 'ambalangoda', 'hikkaduwa', 'weligama', 'tangalle',
  'ratnapura', 'rathnapura', 'embilipitiya', 'balangoda', 'kuruwita',
];

/**
 * Removes town names used as road names.
 *
 * Sri Lankan addresses are full of roads named after the town they lead to:
 * "315F, Kandy Road, Kadawatha" is in the Western Province, nowhere near
 * Kandy. Matching the raw text put that site in the wrong branch, and "Kandy
 * Road" is common enough that it would have done so to many more. The road is
 * stripped first, so only the town the site is actually in remains.
 */
const ROAD_WORDS = 'road|rd|mawatha|mw|street|st|lane|highway|hwy|junction|jn';

function stripRoadNames(text: string): string {
  return text.replace(new RegExp(`\\b[a-z]+\\s+(?:${ROAD_WORDS})\\b`, 'g'), ' ');
}

/**
 * Longest town names first, so "nuwara eliya" is not shadowed by a shorter
 * name that happens to appear inside it.
 */
function findTown(haystack: string, towns: string[]): string | null {
  const match = [...towns]
    .sort((a, b) => b.length - a.length)
    .find((town) => haystack.includes(town));
  return match ?? null;
}

/**
 * Decides a branch from whatever text the workbook gave for a site — its name,
 * address and the customer's own region label, all searched together, because
 * the town can appear in any of them.
 */
export function decideBranch(parts: (string | null | undefined)[]): BranchDecision {
  const haystack = stripRoadNames(
    parts
      .filter((part): part is string => Boolean(part))
      .join(' ')
      .toLowerCase(),
  );

  // Kandy is checked first: its list is far smaller and more specific, and a
  // Kandy site sent to Colombo is the costlier mistake of the two.
  const kandy = findTown(haystack, KANDY_TOWNS);
  if (kandy) {
    return { branchCode: BranchCode.KANDY, confidence: 'matched', matchedOn: kandy };
  }

  const colombo = findTown(haystack, COLOMBO_TOWNS);
  if (colombo) {
    return { branchCode: BranchCode.COLOMBO, confidence: 'matched', matchedOn: colombo };
  }

  return {
    branchCode: BranchCode.COLOMBO,
    confidence: 'uncertain',
    matchedOn: null,
  };
}

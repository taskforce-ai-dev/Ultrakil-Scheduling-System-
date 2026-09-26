export type CoverageDayState =
  | 'UNCHECKED'
  | 'IN_PROGRESS'
  | 'NOTHING_DUE'
  | 'FAILED'
  | 'SHORTFALL'
  | 'STALE'
  | 'PREPARED_AWAITING_MANAGER'
  | 'COVERED_PUBLISHED';

export interface CoverageVisitFact {
  id: string;
  published: boolean;
  prepared: boolean;
  reasonCodes: readonly string[];
}

export interface CoverageSweepFact {
  state: Exclude<CoverageDayState, 'UNCHECKED'>;
  /** From C13's current demand and supply fingerprints, never from visit ids alone. */
  verifiedAgainstCurrentData: boolean;
  shortfallCodes: readonly string[];
}

export interface CoverageDay {
  date: string;
  state: CoverageDayState;
  visitsDue: number;
  visitsPublished: number;
  visitsPrepared: number;
  shortfalls: { code: string; message: string }[];
}

const REASON_MESSAGES: Record<string, string> = {
  NOT_STAFFED: 'A due visit has no assigned crew.',
  CREW_TOO_SMALL: 'Fewer people are assigned than this visit requires.',
  NO_VEHICLE: 'No vehicle is assigned to this visit.',
  TOO_MANY_VEHICLES: 'More than one vehicle is assigned to this visit.',
  VEHICLE_CAPACITY_EXCEEDED: 'The assigned crew does not fit in the vehicle.',
  VEHICLE_CAPACITY_UNKNOWN: 'The vehicle seat count must be confirmed before use.',
  NO_PMS_SUPERVISOR_AVAILABLE: 'No qualified PMS supervisor is available.',
  NO_AUTHORIZED_DRIVER: 'No authorized driver is available for the crew and vehicle.',
  NO_VEHICLE_AVAILABLE: 'No suitable vehicle is available.',
  NO_CREW_AVAILABLE: 'No eligible crew is available.',
  PROVENANCE_UNCONFIRMED: 'Source information needs a manager review before publication.',
  SWEEP_FAILED: 'Automatic staffing failed; review the day and retry.',
  STALE_COVERAGE: 'This day changed after verification; recheck staffing and publication.',
  UNSTAFFED_VISIT: 'A due visit does not yet have a published crew and transport plan.',
  OTHER_SHORTFALL: 'Review this day in the Unassigned Visits queue.',
};

function reasons(codes: readonly string[]): CoverageDay['shortfalls'] {
  const safeCodes = codes.map((code) => Object.hasOwn(REASON_MESSAGES, code) ? code : 'OTHER_SHORTFALL');
  return [...new Set(safeCodes)].sort().slice(0, 8).map((code) => ({
    code,
    message: REASON_MESSAGES[code],
  }));
}

/** Pure projection; database reads and sweep writes stay in separate owners. */
export function projectCoverageDay(
  date: string,
  visits: readonly CoverageVisitFact[],
  sweep: CoverageSweepFact | null,
): CoverageDay {
  const visitsDue = visits.length;
  const visitsPublished = visits.filter((visit) => visit.published).length;
  const visitsPrepared = visits.filter((visit) => !visit.published && visit.prepared).length;
  const base = { date, visitsDue, visitsPublished, visitsPrepared };

  if (!sweep) {
    return { ...base, state: 'UNCHECKED', shortfalls: [] };
  }
  if (sweep.state === 'IN_PROGRESS') {
    return { ...base, state: 'IN_PROGRESS', shortfalls: [] };
  }
  if (sweep.state === 'FAILED') {
    return { ...base, state: 'FAILED', shortfalls: reasons([...sweep.shortfallCodes, 'SWEEP_FAILED']) };
  }
  if (sweep.state === 'STALE' || !sweep.verifiedAgainstCurrentData) {
    return { ...base, state: 'STALE', shortfalls: reasons(['STALE_COVERAGE']) };
  }
  if (sweep.state === 'NOTHING_DUE') {
    // C13's due set excludes already-published work. Its NOTHING_DUE therefore
    // means no *new staffing* is due, not necessarily an empty Calendar day.
    if (sweep.shortfallCodes.length === 0 && visitsPublished === visitsDue) {
      return { ...base, state: visitsDue === 0 ? 'NOTHING_DUE' : 'COVERED_PUBLISHED', shortfalls: [] };
    }
    return { ...base, state: 'STALE', shortfalls: reasons(['STALE_COVERAGE']) };
  }

  const shortfallCodes = [
    ...sweep.shortfallCodes,
    ...visits.flatMap((visit) => visit.reasonCodes),
  ];
  const hardShortfallCodes = shortfallCodes.filter((code) => code !== 'PROVENANCE_UNCONFIRMED');
  if (sweep.state === 'SHORTFALL' || hardShortfallCodes.length > 0 || visitsPublished + visitsPrepared < visitsDue) {
    return {
      ...base,
      state: 'SHORTFALL',
      shortfalls: reasons(hardShortfallCodes.length ? hardShortfallCodes : ['UNSTAFFED_VISIT']),
    };
  }
  if (sweep.state === 'PREPARED_AWAITING_MANAGER' && visitsPublished === visitsDue && visitsDue > 0) {
    return { ...base, state: 'STALE', shortfalls: reasons(['STALE_COVERAGE']) };
  }
  if (sweep.state === 'PREPARED_AWAITING_MANAGER') {
    return {
      ...base,
      state: 'PREPARED_AWAITING_MANAGER',
      shortfalls: reasons(['PROVENANCE_UNCONFIRMED']),
    };
  }
  if (visitsPublished !== visitsDue || shortfallCodes.length > 0) {
    return { ...base, state: 'STALE', shortfalls: reasons(['STALE_COVERAGE']) };
  }
  return { ...base, state: 'COVERED_PUBLISHED', shortfalls: [] };
}

const STATE_PRIORITY: CoverageDayState[] = [
  'FAILED', 'SHORTFALL', 'STALE', 'UNCHECKED', 'IN_PROGRESS', 'PREPARED_AWAITING_MANAGER',
];

/** The all-branch view is covered only if every individual branch is covered. */
export function combineCoverageDays(date: string, days: readonly CoverageDay[]): CoverageDay {
  return {
    date,
    state: STATE_PRIORITY.find((state) => days.some((day) => day.state === state)) ??
      (days.every((day) => day.state === 'NOTHING_DUE') ? 'NOTHING_DUE' : 'COVERED_PUBLISHED'),
    visitsDue: days.reduce((sum, day) => sum + day.visitsDue, 0),
    visitsPublished: days.reduce((sum, day) => sum + day.visitsPublished, 0),
    visitsPrepared: days.reduce((sum, day) => sum + day.visitsPrepared, 0),
    shortfalls: [...new Map(days.flatMap((day) => day.shortfalls).map((item) => [item.code, item])).values()].slice(0, 8),
  };
}

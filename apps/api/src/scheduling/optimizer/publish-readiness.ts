import {
  DataProvenance,
  SiteBranchConfidence,
  SiteBranchSource,
} from '@prisma/client';

/**
 * Publishing turns a proposal into dispatch truth. Where the value a crew acts
 * on was assumed rather than stated — hours defaulted to 08:00-17:00, a site
 * branch guessed from an address, a crew size or duration filled in because the
 * workbook was silent — that assumption must be visible and deliberately
 * accepted, never silently converted into a fact.
 *
 * Codes match the operational warnings already shown on the Operations day view
 * (`scheduling/operations/operations.service.ts`) so one vocabulary describes
 * unconfirmed source data wherever a manager meets it.
 */
export const PROVENANCE_WARNING_CODES = [
  'CREW_SIZE_UNCONFIRMED',
  'DAY_RULE_UNCONFIRMED',
  'DURATION_UNCONFIRMED',
  'HOURS_UNCONFIRMED',
  'SITE_BRANCH_UNCONFIRMED',
  'VEHICLE_BRANCH_UNCONFIRMED',
] as const;

export type ProvenanceWarningCode = (typeof PROVENANCE_WARNING_CODES)[number];

export type ProvenanceWarning = {
  code: ProvenanceWarningCode;
  message: string;
  /** How many of the visits being published this warning actually affects. */
  affectedVisitCount: number;
};

const PROVENANCE_WARNING_MESSAGES: Record<ProvenanceWarningCode, string> = {
  CREW_SIZE_UNCONFIRMED:
    'Crew size was not stated by the source and has not been confirmed by a manager.',
  DAY_RULE_UNCONFIRMED:
    'Allowed service days were derived or defaulted and have not been confirmed by a manager.',
  DURATION_UNCONFIRMED:
    'Visit duration was not stated by the source and has not been confirmed by a manager.',
  HOURS_UNCONFIRMED:
    'Opening hours were not confirmed; the visible 08:00–17:00 fallback is in use.',
  SITE_BRANCH_UNCONFIRMED:
    'The service site branch is inferred from source data and needs manager confirmation.',
  VEHICLE_BRANCH_UNCONFIRMED:
    'An assigned vehicle has no confirmed branch.',
};

/**
 * Only the scalar provenance markers, so this can be read for a page of runs
 * without loading assignment object graphs.
 */
export type ProvenanceAssignment = {
  generatedVisitId: string;
  generatedVisit: {
    windowProvenance: DataProvenance;
    serviceAgreement: {
      crewSizeProvenance: DataProvenance;
      durationProvenance: DataProvenance;
      dayRuleProvenance: DataProvenance;
      serviceSite: {
        branchConfidence: SiteBranchConfidence;
        branchSource: SiteBranchSource;
      };
    };
  };
  vehicles: readonly { vehicle: { branchId: string | null } }[];
};

/**
 * A value read from the source workbook and a value a manager confirmed are
 * both facts. Everything else — derived, defaulted, or never recorded — is an
 * assumption that is still waiting on a person.
 */
function isConfirmed(provenance: DataProvenance): boolean {
  return (
    provenance === DataProvenance.SOURCE ||
    provenance === DataProvenance.MANAGER_CONFIRMED
  );
}

/**
 * The master schedule names locations, not UltraKIL branches, so no branch
 * value is ever a source fact: an address match is evidence, a fallback is a
 * guess, and only a manager's confirmation settles it.
 */
function isSiteBranchConfirmed(site: {
  branchConfidence: SiteBranchConfidence;
  branchSource: SiteBranchSource;
}): boolean {
  return (
    site.branchConfidence === SiteBranchConfidence.CONFIRMED &&
    site.branchSource === SiteBranchSource.MANAGER_CONFIRMED
  );
}

/**
 * The material unconfirmed-source warnings carried by a specific set of
 * assignments — the ones that would actually be published, not the run's
 * counters. Each code is reported once, with the number of distinct visits it
 * affects.
 */
export function provenanceWarnings(
  assignments: readonly ProvenanceAssignment[],
): ProvenanceWarning[] {
  const affected = new Map<ProvenanceWarningCode, Set<string>>();
  const flag = (code: ProvenanceWarningCode, visitId: string) => {
    const visits = affected.get(code) ?? new Set<string>();
    visits.add(visitId);
    affected.set(code, visits);
  };

  for (const assignment of assignments) {
    const visitId = assignment.generatedVisitId;
    const visit = assignment.generatedVisit;
    const agreement = visit.serviceAgreement;

    if (!isConfirmed(visit.windowProvenance)) flag('HOURS_UNCONFIRMED', visitId);
    if (!isConfirmed(agreement.crewSizeProvenance)) flag('CREW_SIZE_UNCONFIRMED', visitId);
    if (!isConfirmed(agreement.durationProvenance)) flag('DURATION_UNCONFIRMED', visitId);
    if (!isConfirmed(agreement.dayRuleProvenance)) flag('DAY_RULE_UNCONFIRMED', visitId);
    if (!isSiteBranchConfirmed(agreement.serviceSite)) flag('SITE_BRANCH_UNCONFIRMED', visitId);
    if (assignment.vehicles.some(({ vehicle }) => vehicle.branchId === null)) {
      flag('VEHICLE_BRANCH_UNCONFIRMED', visitId);
    }
  }

  return PROVENANCE_WARNING_CODES.filter((code) => (affected.get(code)?.size ?? 0) > 0).map(
    (code) => ({
      code,
      message: PROVENANCE_WARNING_MESSAGES[code],
      affectedVisitCount: affected.get(code)!.size,
    }),
  );
}

export const PARTIAL_PUBLISH_MESSAGE =
  'This run left visits unassigned. A manager acknowledgement and reason are required to publish the partial schedule.';
export const UNCONFIRMED_SOURCE_PUBLISH_MESSAGE =
  'This run rests on source data that is still unconfirmed. A manager acknowledgement and reason are required before publishing it as dispatch truth.';

export type PublishReadiness = {
  state: 'READY' | 'BLOCKED' | 'ACKNOWLEDGEMENT_REQUIRED';
  code: 'ZERO_RESULTS' | 'PARTIAL_RESULTS' | 'SOURCE_DATA_UNCONFIRMED' | null;
  message: string | null;
  /** The run left visits unassigned. */
  requiresPartialAcknowledgement: boolean;
  /** The work being published rests on unconfirmed source data. */
  requiresProvenanceAcknowledgement: boolean;
  provenanceWarnings: ProvenanceWarning[];
};

export function publishReadiness(
  counters: {
    visitsConsidered: number;
    visitsScheduled: number;
    visitsUnassigned: number;
  },
  warnings: ProvenanceWarning[] = [],
): PublishReadiness {
  if (counters.visitsScheduled <= 0) {
    return {
      state: 'BLOCKED',
      code: 'ZERO_RESULTS',
      message: 'This run produced no dispatchable assignments and cannot be published.',
      requiresPartialAcknowledgement: false,
      requiresProvenanceAcknowledgement: false,
      provenanceWarnings: warnings,
    };
  }

  const requiresPartialAcknowledgement =
    counters.visitsUnassigned > 0 || counters.visitsScheduled < counters.visitsConsidered;
  const requiresProvenanceAcknowledgement = warnings.length > 0;

  if (!requiresPartialAcknowledgement && !requiresProvenanceAcknowledgement) {
    return {
      state: 'READY',
      code: null,
      message: null,
      requiresPartialAcknowledgement: false,
      requiresProvenanceAcknowledgement: false,
      provenanceWarnings: [],
    };
  }

  // Both gates can apply at once. Neither is allowed to hide the other, so the
  // message names every acknowledgement the manager still owes.
  const messages = [
    ...(requiresPartialAcknowledgement ? [PARTIAL_PUBLISH_MESSAGE] : []),
    ...(requiresProvenanceAcknowledgement ? [UNCONFIRMED_SOURCE_PUBLISH_MESSAGE] : []),
  ];

  return {
    state: 'ACKNOWLEDGEMENT_REQUIRED',
    code: requiresPartialAcknowledgement ? 'PARTIAL_RESULTS' : 'SOURCE_DATA_UNCONFIRMED',
    message: messages.join(' '),
    requiresPartialAcknowledgement,
    requiresProvenanceAcknowledgement,
    provenanceWarnings: warnings,
  };
}

/**
 * What the manager still owes before this publication may proceed, as one
 * manager-safe sentence, or null when every required acknowledgement is in
 * hand. Each gate is checked independently so a satisfied one never excuses an
 * outstanding one.
 */
export function missingPublishAcknowledgement(
  readiness: PublishReadiness,
  given: {
    acknowledgePartial: boolean;
    acknowledgeProvenance: boolean;
    reason: string | null;
  },
): string | null {
  const outstanding: string[] = [];
  if (readiness.requiresPartialAcknowledgement && !given.acknowledgePartial) {
    outstanding.push(PARTIAL_PUBLISH_MESSAGE);
  }
  if (readiness.requiresProvenanceAcknowledgement && !given.acknowledgeProvenance) {
    outstanding.push(UNCONFIRMED_SOURCE_PUBLISH_MESSAGE);
  }
  const needsReason =
    readiness.requiresPartialAcknowledgement || readiness.requiresProvenanceAcknowledgement;
  if (needsReason && !given.reason?.trim()) {
    outstanding.push('A reason for publishing is required and must not be empty.');
  }
  return outstanding.length > 0 ? outstanding.join(' ') : null;
}

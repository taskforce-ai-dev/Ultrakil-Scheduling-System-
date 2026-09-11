import {
  DataProvenance,
  SiteBranchConfidence,
  SiteBranchSource,
} from '@prisma/client';

export const MATERIAL_PROVENANCE_WARNING_CODES = [
  'CREW_SIZE_UNCONFIRMED',
  'DAY_RULE_UNCONFIRMED',
  'DURATION_UNCONFIRMED',
  'HOURS_UNCONFIRMED',
  'SITE_BRANCH_UNCONFIRMED',
  'VEHICLE_BRANCH_UNCONFIRMED',
] as const;

export type MaterialProvenanceWarning = {
  code: (typeof MATERIAL_PROVENANCE_WARNING_CODES)[number];
  message: string;
  affectedVisitCount: number;
};

type PublicationAssignment = {
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
  vehicles: Array<{ vehicle: { branchId: string | null } }>;
};

export type PublishReadiness = {
  state: 'READY' | 'BLOCKED' | 'ACKNOWLEDGEMENT_REQUIRED';
  code: 'ZERO_RESULTS' | 'PARTIAL_RESULTS' | 'SOURCE_DATA_UNCONFIRMED' | null;
  message: string | null;
  requiresPartialAcknowledgement: boolean;
  requiresProvenanceAcknowledgement: boolean;
  provenanceWarnings: MaterialProvenanceWarning[];
};

export function materialProvenanceWarnings(
  assignments: PublicationAssignment[],
): MaterialProvenanceWarning[] {
  const affectedVisits = new Map<MaterialProvenanceWarning['code'], Set<string>>();
  const add = (code: MaterialProvenanceWarning['code'], visitId: string) => {
    const visits = affectedVisits.get(code) ?? new Set<string>();
    visits.add(visitId);
    affectedVisits.set(code, visits);
  };

  for (const assignment of assignments) {
    const { generatedVisit, generatedVisitId, vehicles } = assignment;
    const agreement = generatedVisit.serviceAgreement;
    if (isUnconfirmed(generatedVisit.windowProvenance)) add('HOURS_UNCONFIRMED', generatedVisitId);
    if (isUnconfirmed(agreement.crewSizeProvenance)) add('CREW_SIZE_UNCONFIRMED', generatedVisitId);
    if (isUnconfirmed(agreement.durationProvenance)) add('DURATION_UNCONFIRMED', generatedVisitId);
    if (isUnconfirmed(agreement.dayRuleProvenance)) add('DAY_RULE_UNCONFIRMED', generatedVisitId);
    if (
      agreement.serviceSite.branchConfidence !== SiteBranchConfidence.CONFIRMED
      || agreement.serviceSite.branchSource !== SiteBranchSource.MANAGER_CONFIRMED
    ) {
      add('SITE_BRANCH_UNCONFIRMED', generatedVisitId);
    }
    if (vehicles.some(({ vehicle }) => vehicle.branchId === null)) {
      add('VEHICLE_BRANCH_UNCONFIRMED', generatedVisitId);
    }
  }

  const messages: Record<MaterialProvenanceWarning['code'], string> = {
    CREW_SIZE_UNCONFIRMED: 'Crew size is not confirmed by source data for one or more visits.',
    DAY_RULE_UNCONFIRMED: 'Allowed service days are not confirmed by source data for one or more visits.',
    DURATION_UNCONFIRMED: 'Visit duration is not confirmed by source data for one or more visits.',
    HOURS_UNCONFIRMED: 'Opening hours were not confirmed for one or more visits.',
    SITE_BRANCH_UNCONFIRMED: 'The service site branch is not manager-confirmed for one or more visits.',
    VEHICLE_BRANCH_UNCONFIRMED: 'An assigned vehicle has no confirmed branch for one or more visits.',
  };
  return [...affectedVisits.entries()]
    .map(([code, visits]) => ({ code, message: messages[code], affectedVisitCount: visits.size }))
    .sort((left, right) => left.code.localeCompare(right.code));
}

function isUnconfirmed(provenance: DataProvenance): boolean {
  return provenance !== DataProvenance.SOURCE
    && provenance !== DataProvenance.MANAGER_CONFIRMED;
}

export function publishReadiness(
  counters: { visitsConsidered: number; visitsScheduled: number; visitsUnassigned: number },
  provenanceWarnings: MaterialProvenanceWarning[] = [],
): PublishReadiness {
  const requiresPartialAcknowledgement = counters.visitsUnassigned > 0
    || counters.visitsScheduled < counters.visitsConsidered;
  const requiresProvenanceAcknowledgement = provenanceWarnings.length > 0;
  if (counters.visitsScheduled <= 0) {
    return {
      state: 'BLOCKED',
      code: 'ZERO_RESULTS',
      message: 'This run produced no dispatchable assignments and cannot be published.',
      requiresPartialAcknowledgement: false,
      requiresProvenanceAcknowledgement: false,
      provenanceWarnings,
    };
  }
  if (requiresPartialAcknowledgement || requiresProvenanceAcknowledgement) {
    const message = requiresPartialAcknowledgement
      ? 'This run left visits unassigned. A manager acknowledgement and reason are required to publish the partial schedule.'
      : 'This run includes source data that is not confirmed. A manager acknowledgement and reason are required before publishing.';
    return {
      state: 'ACKNOWLEDGEMENT_REQUIRED',
      code: requiresPartialAcknowledgement ? 'PARTIAL_RESULTS' : 'SOURCE_DATA_UNCONFIRMED',
      message,
      requiresPartialAcknowledgement,
      requiresProvenanceAcknowledgement,
      provenanceWarnings,
    };
  }
  return {
    state: 'READY',
    code: null,
    message: null,
    requiresPartialAcknowledgement: false,
    requiresProvenanceAcknowledgement: false,
    provenanceWarnings: [],
  };
}

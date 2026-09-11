import { DataProvenance, SiteBranchConfidence, SiteBranchSource } from '@prisma/client';

import {
  materialProvenanceWarnings,
  publishReadiness,
} from './publish-readiness';

describe('publishReadiness', () => {
  it('blocks a zero-result run', () => {
    expect(publishReadiness({ visitsConsidered: 4, visitsScheduled: 0, visitsUnassigned: 4 }))
      .toMatchObject({ state: 'BLOCKED', code: 'ZERO_RESULTS' });
  });

  it('requires explicit acknowledgement for a partial run', () => {
    expect(publishReadiness({ visitsConsidered: 4, visitsScheduled: 3, visitsUnassigned: 1 }))
      .toMatchObject({ state: 'ACKNOWLEDGEMENT_REQUIRED', code: 'PARTIAL_RESULTS' });
  });

  it('is ready when every considered visit was scheduled', () => {
    expect(publishReadiness({ visitsConsidered: 4, visitsScheduled: 4, visitsUnassigned: 0 }))
      .toMatchObject({ state: 'READY', code: null, message: null });
  });

  it('requires acknowledgement for restored source data whose provenance is unknown', () => {
    const warnings = materialProvenanceWarnings([
      {
        generatedVisitId: 'visit-1',
        generatedVisit: {
          windowProvenance: DataProvenance.UNKNOWN,
          serviceAgreement: {
            crewSizeProvenance: DataProvenance.UNKNOWN,
            durationProvenance: DataProvenance.UNKNOWN,
            dayRuleProvenance: DataProvenance.UNKNOWN,
            serviceSite: {
              branchConfidence: SiteBranchConfidence.UNCERTAIN,
              branchSource: SiteBranchSource.FALLBACK_DEFAULT,
            },
          },
        },
        vehicles: [{ vehicle: { branchId: null } }],
      },
    ]);

    expect(warnings.map((warning) => warning.code)).toEqual([
      'CREW_SIZE_UNCONFIRMED',
      'DAY_RULE_UNCONFIRMED',
      'DURATION_UNCONFIRMED',
      'HOURS_UNCONFIRMED',
      'SITE_BRANCH_UNCONFIRMED',
      'VEHICLE_BRANCH_UNCONFIRMED',
    ]);
    expect(publishReadiness(
      { visitsConsidered: 1, visitsScheduled: 1, visitsUnassigned: 0 },
      warnings,
    )).toMatchObject({
      state: 'ACKNOWLEDGEMENT_REQUIRED',
      code: 'SOURCE_DATA_UNCONFIRMED',
      requiresProvenanceAcknowledgement: true,
      provenanceWarnings: warnings,
    });
  });
});

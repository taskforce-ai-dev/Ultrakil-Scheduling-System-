import {
  DataProvenance,
  SiteBranchConfidence,
  SiteBranchSource,
} from '@prisma/client';

import {
  missingPublishAcknowledgement,
  ProvenanceAssignment,
  provenanceWarnings,
  publishReadiness,
} from './publish-readiness';

function assignment(
  overrides: {
    visitId?: string;
    windowProvenance?: DataProvenance;
    crewSizeProvenance?: DataProvenance;
    durationProvenance?: DataProvenance;
    dayRuleProvenance?: DataProvenance;
    branchConfidence?: SiteBranchConfidence;
    branchSource?: SiteBranchSource;
    vehicleBranchIds?: (string | null)[];
  } = {},
): ProvenanceAssignment {
  return {
    generatedVisitId: overrides.visitId ?? 'visit',
    generatedVisit: {
      windowProvenance: overrides.windowProvenance ?? DataProvenance.SOURCE,
      serviceAgreement: {
        crewSizeProvenance: overrides.crewSizeProvenance ?? DataProvenance.SOURCE,
        durationProvenance: overrides.durationProvenance ?? DataProvenance.SOURCE,
        dayRuleProvenance: overrides.dayRuleProvenance ?? DataProvenance.SOURCE,
        serviceSite: {
          branchConfidence: overrides.branchConfidence ?? SiteBranchConfidence.CONFIRMED,
          branchSource: overrides.branchSource ?? SiteBranchSource.MANAGER_CONFIRMED,
        },
      },
    },
    vehicles: (overrides.vehicleBranchIds ?? ['branch']).map((branchId) => ({
      vehicle: { branchId },
    })),
  };
}

describe('provenanceWarnings', () => {
  it('reports nothing when every value came from the source workbook', () => {
    expect(provenanceWarnings([assignment()])).toEqual([]);
  });

  it('treats a manager-confirmed value as a confirmed fact', () => {
    expect(
      provenanceWarnings([
        assignment({
          windowProvenance: DataProvenance.MANAGER_CONFIRMED,
          crewSizeProvenance: DataProvenance.MANAGER_CONFIRMED,
          durationProvenance: DataProvenance.MANAGER_CONFIRMED,
          dayRuleProvenance: DataProvenance.MANAGER_CONFIRMED,
        }),
      ]),
    ).toEqual([]);
  });

  it.each([
    ['HOURS_UNCONFIRMED', { windowProvenance: DataProvenance.DEFAULTED }],
    ['HOURS_UNCONFIRMED', { windowProvenance: DataProvenance.UNKNOWN }],
    ['CREW_SIZE_UNCONFIRMED', { crewSizeProvenance: DataProvenance.DEFAULTED }],
    ['CREW_SIZE_UNCONFIRMED', { crewSizeProvenance: DataProvenance.DERIVED }],
    ['CREW_SIZE_UNCONFIRMED', { crewSizeProvenance: DataProvenance.UNKNOWN }],
    ['DURATION_UNCONFIRMED', { durationProvenance: DataProvenance.DEFAULTED }],
    ['DURATION_UNCONFIRMED', { durationProvenance: DataProvenance.UNKNOWN }],
    ['DAY_RULE_UNCONFIRMED', { dayRuleProvenance: DataProvenance.DERIVED }],
    ['DAY_RULE_UNCONFIRMED', { dayRuleProvenance: DataProvenance.DEFAULTED }],
    ['DAY_RULE_UNCONFIRMED', { dayRuleProvenance: DataProvenance.UNKNOWN }],
    [
      'SITE_BRANCH_UNCONFIRMED',
      {
        branchConfidence: SiteBranchConfidence.UNCERTAIN,
        branchSource: SiteBranchSource.FALLBACK_DEFAULT,
      },
    ],
    [
      'SITE_BRANCH_UNCONFIRMED',
      {
        branchConfidence: SiteBranchConfidence.MATCHED,
        branchSource: SiteBranchSource.ADDRESS_MATCH,
      },
    ],
    ['VEHICLE_BRANCH_UNCONFIRMED', { vehicleBranchIds: [null] }],
  ])('raises %s for unconfirmed source data', (code, overrides) => {
    expect(provenanceWarnings([assignment(overrides)])).toEqual([
      { code, message: expect.any(String), affectedVisitCount: 1 },
    ]);
  });

  it('ignores an assignment with no vehicle rather than inventing a branch warning', () => {
    expect(provenanceWarnings([assignment({ vehicleBranchIds: [] })])).toEqual([]);
  });

  it('counts the distinct visits each warning affects, not the times it is seen', () => {
    const warnings = provenanceWarnings([
      assignment({ visitId: 'visit-a', windowProvenance: DataProvenance.DEFAULTED }),
      assignment({ visitId: 'visit-a', windowProvenance: DataProvenance.DEFAULTED }),
      assignment({ visitId: 'visit-b', windowProvenance: DataProvenance.DEFAULTED }),
      assignment({ visitId: 'visit-c', crewSizeProvenance: DataProvenance.DEFAULTED }),
    ]);

    expect(warnings).toEqual([
      { code: 'CREW_SIZE_UNCONFIRMED', message: expect.any(String), affectedVisitCount: 1 },
      { code: 'HOURS_UNCONFIRMED', message: expect.any(String), affectedVisitCount: 2 },
    ]);
  });

  it('reports every material warning a single visit carries', () => {
    expect(
      provenanceWarnings([
        assignment({
          windowProvenance: DataProvenance.DEFAULTED,
          crewSizeProvenance: DataProvenance.DEFAULTED,
          durationProvenance: DataProvenance.DEFAULTED,
          dayRuleProvenance: DataProvenance.DERIVED,
          branchConfidence: SiteBranchConfidence.UNCERTAIN,
          branchSource: SiteBranchSource.FALLBACK_DEFAULT,
          vehicleBranchIds: [null],
        }),
      ]).map((warning) => warning.code),
    ).toEqual([
      'CREW_SIZE_UNCONFIRMED',
      'DAY_RULE_UNCONFIRMED',
      'DURATION_UNCONFIRMED',
      'HOURS_UNCONFIRMED',
      'SITE_BRANCH_UNCONFIRMED',
      'VEHICLE_BRANCH_UNCONFIRMED',
    ]);
  });
});

describe('publishReadiness', () => {
  const complete = { visitsConsidered: 4, visitsScheduled: 4, visitsUnassigned: 0 };
  const hoursWarning = provenanceWarnings([
    assignment({ windowProvenance: DataProvenance.DEFAULTED }),
  ]);

  it('blocks a zero-result run', () => {
    expect(
      publishReadiness({ visitsConsidered: 4, visitsScheduled: 0, visitsUnassigned: 4 }),
    ).toMatchObject({ state: 'BLOCKED', code: 'ZERO_RESULTS' });
  });

  it('requires explicit acknowledgement for a partial run', () => {
    expect(
      publishReadiness({ visitsConsidered: 4, visitsScheduled: 3, visitsUnassigned: 1 }),
    ).toMatchObject({
      state: 'ACKNOWLEDGEMENT_REQUIRED',
      code: 'PARTIAL_RESULTS',
      requiresPartialAcknowledgement: true,
      requiresProvenanceAcknowledgement: false,
    });
  });

  it('is ready when every considered visit was scheduled from confirmed data', () => {
    expect(publishReadiness(complete)).toEqual({
      state: 'READY',
      code: null,
      message: null,
      requiresPartialAcknowledgement: false,
      requiresProvenanceAcknowledgement: false,
      provenanceWarnings: [],
    });
  });

  it('requires acknowledgement for a complete run built on unconfirmed source data', () => {
    expect(publishReadiness(complete, hoursWarning)).toMatchObject({
      state: 'ACKNOWLEDGEMENT_REQUIRED',
      code: 'SOURCE_DATA_UNCONFIRMED',
      requiresPartialAcknowledgement: false,
      requiresProvenanceAcknowledgement: true,
      provenanceWarnings: hoursWarning,
    });
  });

  it('raises both requirements, and says both, when a partial run is also unconfirmed', () => {
    const readiness = publishReadiness(
      { visitsConsidered: 4, visitsScheduled: 3, visitsUnassigned: 1 },
      hoursWarning,
    );

    expect(readiness.requiresPartialAcknowledgement).toBe(true);
    expect(readiness.requiresProvenanceAcknowledgement).toBe(true);
    expect(readiness.message).toContain('left visits unassigned');
    expect(readiness.message).toContain('unconfirmed');
  });
});

describe('missingPublishAcknowledgement', () => {
  const warning = provenanceWarnings([
    assignment({ windowProvenance: DataProvenance.DEFAULTED }),
  ]);
  const partial = { visitsConsidered: 4, visitsScheduled: 3, visitsUnassigned: 1 };
  const complete = { visitsConsidered: 4, visitsScheduled: 4, visitsUnassigned: 0 };
  const reason = 'Reviewed with the branch manager.';

  it('asks for nothing when a run is ready', () => {
    expect(
      missingPublishAcknowledgement(publishReadiness(complete), {
        acknowledgePartial: false,
        acknowledgeProvenance: false,
        reason: null,
      }),
    ).toBeNull();
  });

  it('refuses an unconfirmed-source publication with no acknowledgement', () => {
    expect(
      missingPublishAcknowledgement(publishReadiness(complete, warning), {
        acknowledgePartial: false,
        acknowledgeProvenance: false,
        reason,
      }),
    ).toContain('unconfirmed');
  });

  it('refuses an unconfirmed-source publication acknowledged without a reason', () => {
    expect(
      missingPublishAcknowledgement(publishReadiness(complete, warning), {
        acknowledgePartial: false,
        acknowledgeProvenance: true,
        reason: '   ',
      }),
    ).toContain('reason');
  });

  it('accepts an unconfirmed-source publication with acknowledgement and a reason', () => {
    expect(
      missingPublishAcknowledgement(publishReadiness(complete, warning), {
        acknowledgePartial: false,
        acknowledgeProvenance: true,
        reason,
      }),
    ).toBeNull();
  });

  it('lets neither gate excuse the other on the same publish', () => {
    const readiness = publishReadiness(partial, warning);

    expect(
      missingPublishAcknowledgement(readiness, {
        acknowledgePartial: true,
        acknowledgeProvenance: false,
        reason,
      }),
    ).toBe(
      'This run rests on source data that is still unconfirmed. A manager acknowledgement and reason are required before publishing it as dispatch truth.',
    );
    expect(
      missingPublishAcknowledgement(readiness, {
        acknowledgePartial: false,
        acknowledgeProvenance: true,
        reason,
      }),
    ).toBe(
      'This run left visits unassigned. A manager acknowledgement and reason are required to publish the partial schedule.',
    );
    expect(
      missingPublishAcknowledgement(readiness, {
        acknowledgePartial: true,
        acknowledgeProvenance: true,
        reason,
      }),
    ).toBeNull();
  });
});

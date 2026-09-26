import { combineCoverageDays, projectCoverageDay } from './coverage-projection';

const visit = (id: string, published = false, prepared = false) => ({
  id,
  published,
  prepared,
  reasonCodes: [] as string[],
});

describe('rolling coverage projection', () => {
  it('does not call an empty day covered without a completed sweep', () => {
    expect(projectCoverageDay('2026-10-26', [], null)).toMatchObject({
      state: 'UNCHECKED', visitsDue: 0, visitsPublished: 0,
    });
  });

  it('covers a verified no-due day', () => {
    expect(projectCoverageDay('2026-10-26', [], {
      state: 'NOTHING_DUE', verifiedAgainstCurrentData: true, shortfallCodes: [],
    })).toMatchObject({ state: 'NOTHING_DUE', visitsDue: 0 });
  });

  it('treats a verified no-new-work sweep with existing published visits as covered', () => {
    expect(projectCoverageDay('2026-10-26', [visit('already-published', true)], {
      state: 'NOTHING_DUE', verifiedAgainstCurrentData: true, shortfallCodes: [],
    })).toMatchObject({ state: 'COVERED_PUBLISHED', visitsDue: 1, visitsPublished: 1 });
  });

  it('counts only published dispatch, not a draft, as coverage', () => {
    expect(projectCoverageDay('2026-10-26', [visit('a', false, true)], {
      state: 'PREPARED_AWAITING_MANAGER', verifiedAgainstCurrentData: true, shortfallCodes: [],
    })).toMatchObject({
      state: 'PREPARED_AWAITING_MANAGER', visitsDue: 1, visitsPublished: 0, visitsPrepared: 1,
    });
  });

  it('classifies provenance review as awaiting manager, not a staffing shortfall', () => {
    expect(projectCoverageDay('2026-10-26', [visit('a', false, true)], {
      state: 'PREPARED_AWAITING_MANAGER', verifiedAgainstCurrentData: true,
      shortfallCodes: ['PROVENANCE_UNCONFIRMED'],
    })).toMatchObject({ state: 'PREPARED_AWAITING_MANAGER' });
  });

  it('refuses a false all-clear if one visit is still unstaffed', () => {
    expect(projectCoverageDay('2026-10-26', [visit('a', true), visit('b')], {
      state: 'SHORTFALL', verifiedAgainstCurrentData: true, shortfallCodes: ['NO_PMS_SUPERVISOR_AVAILABLE'],
    })).toMatchObject({
      state: 'SHORTFALL', visitsDue: 2, visitsPublished: 1,
      shortfalls: [{ code: 'NO_PMS_SUPERVISOR_AVAILABLE' }],
    });
  });

  it('invalidates a completed sweep when a new due visit is generated', () => {
    expect(projectCoverageDay('2026-10-26', [visit('a', true), visit('new', false, true)], {
      state: 'COVERED_PUBLISHED', verifiedAgainstCurrentData: false, shortfallCodes: [],
    })).toMatchObject({ state: 'STALE', visitsDue: 2 });
  });

  it('does not call a no-visit day covered when new agreement demand has not generated a visit yet', () => {
    expect(projectCoverageDay('2026-10-26', [], {
      state: 'NOTHING_DUE', verifiedAgainstCurrentData: false, shortfallCodes: [],
    })).toMatchObject({ state: 'STALE', visitsDue: 0 });
  });

  it('does not present a failed sweep as coverage even if prior dispatch is published', () => {
    expect(projectCoverageDay('2026-10-26', [visit('a', true)], {
      state: 'FAILED', verifiedAgainstCurrentData: false, shortfallCodes: ['SWEEP_FAILED'],
    })).toMatchObject({ state: 'FAILED', visitsDue: 1, visitsPublished: 1 });
  });

  it('does not call the all-branch day covered when only Colombo was swept', () => {
    const colombo = projectCoverageDay('2026-10-26', [visit('colombo', true)], {
      state: 'COVERED_PUBLISHED', verifiedAgainstCurrentData: true, shortfallCodes: [],
    });
    const kandy = projectCoverageDay('2026-10-26', [], null);
    expect(combineCoverageDays('2026-10-26', [colombo, kandy])).toMatchObject({
      state: 'UNCHECKED', visitsDue: 1, visitsPublished: 1,
    });
  });

  it('covers an all-branch day when one branch is published and the other has nothing due', () => {
    const colombo = projectCoverageDay('2026-10-26', [visit('colombo', true)], {
      state: 'COVERED_PUBLISHED', verifiedAgainstCurrentData: true, shortfallCodes: [],
    });
    const kandy = projectCoverageDay('2026-10-26', [], {
      state: 'NOTHING_DUE', verifiedAgainstCurrentData: true, shortfallCodes: [],
    });
    expect(combineCoverageDays('2026-10-26', [colombo, kandy])).toMatchObject({
      state: 'COVERED_PUBLISHED', visitsDue: 1, visitsPublished: 1,
    });
  });

  it('does not echo an unexpected stored reason code into aggregate alerts', () => {
    const result = projectCoverageDay('2026-10-26', [visit('a')], {
      state: 'SHORTFALL', verifiedAgainstCurrentData: true,
      shortfallCodes: ['customer@example.com'],
    });
    expect(result.shortfalls).toEqual([{
      code: 'OTHER_SHORTFALL', message: 'Review this day in the Unassigned Visits queue.',
    }]);
  });

  it('shows an active attempt without pretending it is verified', () => {
    expect(projectCoverageDay('2026-10-26', [], {
      state: 'IN_PROGRESS', verifiedAgainstCurrentData: false, shortfallCodes: [],
    })).toMatchObject({ state: 'IN_PROGRESS' });
  });

  it('treats a previously covered day with a withdrawn published assignment as stale', () => {
    expect(projectCoverageDay('2026-10-26', [visit('a', false, true)], {
      state: 'COVERED_PUBLISHED', verifiedAgainstCurrentData: true, shortfallCodes: [],
    })).toMatchObject({ state: 'STALE', visitsPublished: 0 });
  });
});

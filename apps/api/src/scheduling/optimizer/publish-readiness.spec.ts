import { publishReadiness } from './publish-readiness';

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
      .toEqual({ state: 'READY', code: null, message: null });
  });
});

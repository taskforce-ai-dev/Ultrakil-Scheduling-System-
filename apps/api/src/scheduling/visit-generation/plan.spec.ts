import {
  ExistingVisit,
  RequiredVisit,
  planGeneration,
  planIsEmpty,
  protectionReasonFor,
} from './plan';

function required(overrides: Partial<RequiredVisit> = {}): RequiredVisit {
  return {
    serviceAgreementId: 'agreement-1',
    visitDate: '2026-09-09',
    windowStartMinute: 540,
    windowEndMinute: 1020,
    durationMinutes: 90,
    requiredCrewSize: 2,
    branchCode: 'COLOMBO',
    agreementVersionId: 'version-1',
    isPreferredDay: true,
    ...overrides,
  };
}

function existing(overrides: Partial<ExistingVisit> = {}): ExistingVisit {
  return {
    id: 'visit-1',
    serviceAgreementId: 'agreement-1',
    visitDate: '2026-09-09',
    windowStartMinute: 540,
    windowEndMinute: 1020,
    durationMinutes: 90,
    requiredCrewSize: 2,
    status: 'PENDING',
    isManuallyAdjusted: false,
    isLocked: false,
    hasAssignments: false,
    ...overrides,
  };
}

describe('protectionReasonFor', () => {
  it('leaves a fresh, untouched visit unprotected', () => {
    expect(protectionReasonFor(existing())).toBeNull();
  });

  it.each([
    [{ isLocked: true }, 'LOCKED'],
    [{ isManuallyAdjusted: true }, 'MANUALLY_ADJUSTED'],
    [{ hasAssignments: true }, 'HAS_ASSIGNMENT'],
    [{ status: 'SCHEDULED' }, 'ALREADY_SCHEDULED'],
    [{ status: 'COMPLETED' }, 'ALREADY_COMPLETED'],
    [{ status: 'CANCELLED' }, 'CANCELLED'],
  ])('protects %o', (overrides, reason) => {
    expect(protectionReasonFor(existing(overrides))).toBe(reason);
  });

  it('does not protect a visit the scheduler failed to staff', () => {
    // UNASSIGNED is the generator's own output, not a manager's decision, so
    // regenerating may replace it.
    expect(protectionReasonFor(existing({ status: 'UNASSIGNED' }))).toBeNull();
  });

  it('reports the strongest reason first when several apply', () => {
    expect(
      protectionReasonFor(existing({ isLocked: true, status: 'COMPLETED' })),
    ).toBe('LOCKED');
  });
});

describe('planGeneration', () => {
  it('adds a visit the calendar does not have', () => {
    const plan = planGeneration([required()], []);

    expect(plan.additions).toHaveLength(1);
    expect(plan.updates).toEqual([]);
    expect(plan.removals).toEqual([]);
  });

  it('counts an identical visit as unchanged, not as an update', () => {
    // This is what makes running the same generation twice a no-op.
    const plan = planGeneration([required()], [existing()]);

    expect(plan.unchangedCount).toBe(1);
    expect(planIsEmpty(plan)).toBe(true);
  });

  it('updates an untouched visit whose agreement changed', () => {
    const plan = planGeneration(
      [required({ durationMinutes: 120, requiredCrewSize: 3 })],
      [existing()],
    );

    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].changes).toEqual([
      { field: 'durationMinutes', from: 90, to: 120 },
      { field: 'requiredCrewSize', from: 2, to: 3 },
    ]);
  });

  it('removes a visit the agreement no longer asks for', () => {
    const plan = planGeneration([], [existing()]);

    expect(plan.removals).toEqual([
      {
        visitId: 'visit-1',
        serviceAgreementId: 'agreement-1',
        visitDate: '2026-09-09',
        reason: 'NO_LONGER_REQUIRED',
      },
    ]);
  });

  describe('protected work is reported, never touched', () => {
    it('will not update a scheduled visit, and says what it would have done', () => {
      const plan = planGeneration(
        [required({ durationMinutes: 120 })],
        [existing({ status: 'SCHEDULED' })],
      );

      expect(plan.updates).toEqual([]);
      expect(plan.protectedVisits).toEqual([
        {
          visitId: 'visit-1',
          serviceAgreementId: 'agreement-1',
          visitDate: '2026-09-09',
          protection: 'ALREADY_SCHEDULED',
          wouldHave: 'UPDATE',
          changes: [{ field: 'durationMinutes', from: 90, to: 120 }],
        },
      ]);
    });

    it('will not remove a locked visit, and says so', () => {
      const plan = planGeneration([], [existing({ isLocked: true })]);

      expect(plan.removals).toEqual([]);
      expect(plan.protectedVisits[0]).toMatchObject({
        protection: 'LOCKED',
        wouldHave: 'REMOVE',
      });
    });

    it('will not remove a visit a manager moved by hand', () => {
      const plan = planGeneration([], [existing({ isManuallyAdjusted: true })]);

      expect(plan.removals).toEqual([]);
      expect(plan.protectedVisits[0].protection).toBe('MANUALLY_ADJUSTED');
    });

    it('will not remove a completed visit — that is history', () => {
      const plan = planGeneration([], [existing({ status: 'COMPLETED' })]);

      expect(plan.removals).toEqual([]);
      expect(plan.protectedVisits[0].protection).toBe('ALREADY_COMPLETED');
    });
  });

  it('treats a moved date as one addition and one removal, not an edit', () => {
    // The unique key is agreement + date + start, so a different date is a
    // different visit. Saying so plainly beats pretending to "move" one.
    const plan = planGeneration(
      [required({ visitDate: '2026-09-10' })],
      [existing({ visitDate: '2026-09-09' })],
    );

    expect(plan.additions).toHaveLength(1);
    expect(plan.removals).toHaveLength(1);
  });

  it('keeps agreements apart — a matching date under another agreement is not the same visit', () => {
    const plan = planGeneration(
      [required({ serviceAgreementId: 'agreement-2' })],
      [existing({ serviceAgreementId: 'agreement-1' })],
    );

    expect(plan.additions).toHaveLength(1);
    expect(plan.removals).toHaveLength(1);
  });

  it('handles a mixed run without losing anything', () => {
    const plan = planGeneration(
      [
        required({ visitDate: '2026-09-09' }), // unchanged
        required({ visitDate: '2026-09-16', durationMinutes: 120 }), // update
        required({ visitDate: '2026-09-23' }), // addition
      ],
      [
        existing({ id: 'v1', visitDate: '2026-09-09' }),
        existing({ id: 'v2', visitDate: '2026-09-16' }),
        existing({ id: 'v3', visitDate: '2026-09-30' }), // obsolete
        existing({ id: 'v4', visitDate: '2026-10-07', status: 'SCHEDULED' }), // protected
      ],
    );

    expect(plan.unchangedCount).toBe(1);
    expect(plan.updates.map((u) => u.visitId)).toEqual(['v2']);
    expect(plan.additions).toHaveLength(1);
    expect(plan.removals.map((r) => r.visitId)).toEqual(['v3']);
    expect(plan.protectedVisits.map((p) => p.visitId)).toEqual(['v4']);

    // Every existing visit is accounted for exactly once — nothing vanishes.
    const accounted =
      plan.unchangedCount +
      plan.updates.length +
      plan.removals.length +
      plan.protectedVisits.length;
    expect(accounted).toBe(4);
  });
});

import {
  type CandidateAssignment,
  type GuardInput,
  NO_VEHICLE_POLICY,
  evaluateDueSet,
} from './publication-guard';

const VISIT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VISIT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VISIT_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DRIVER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MATE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const VAN = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const assignmentFor = (
  visitId: string,
  over: Partial<CandidateAssignment> = {},
): CandidateAssignment => ({
  id: `assignment-${visitId}`,
  generatedVisitId: visitId,
  crewEmployeeIds: [DRIVER],
  vehicleIds: [VAN],
  ...over,
});

const input = (over: Partial<GuardInput> = {}): GuardInput => ({
  dueVisits: [{ id: VISIT_A, requiredCrewSize: 1 }],
  assignments: [assignmentFor(VISIT_A)],
  vehicles: new Map([[VAN, { seats: 4 }]]),
  authorizedDrivers: new Map([[VAN, new Set([DRIVER])]]),
  publicTransportEmployeeIds: new Set<string>(),
  ...over,
});

const codes = (verdict: ReturnType<typeof evaluateDueSet>) =>
  verdict.shortfalls.map((s) => s.code);

describe('evaluateDueSet', () => {
  it('publishes a day where every due visit is satisfiable', () => {
    const verdict = evaluateDueSet(input());

    expect(verdict.decision).toBe('PUBLISHABLE');
    expect(verdict.shortfalls).toEqual([]);
    expect(verdict.visitsDue).toBe(1);
    expect(verdict.visitsStaffed).toBe(1);
  });

  it('treats a day with nothing due as publishable', () => {
    const verdict = evaluateDueSet(input({ dueVisits: [], assignments: [] }));

    expect(verdict.decision).toBe('PUBLISHABLE');
    expect(verdict.visitsDue).toBe(0);
    expect(verdict.visitsStaffed).toBe(0);
  });

  // The whole point of measuring the due set rather than the assignments.
  // `publishReadiness` looks at what is being published and cannot see a
  // visit nothing was produced for; this must.
  it('catches a due visit the run never staffed at all', () => {
    const verdict = evaluateDueSet(
      input({
        dueVisits: [
          { id: VISIT_A, requiredCrewSize: 1 },
          { id: VISIT_B, requiredCrewSize: 1 },
        ],
        assignments: [assignmentFor(VISIT_A)],
      }),
    );

    expect(verdict.decision).toBe('WITHHOLD');
    expect(verdict.shortfalls).toEqual([
      expect.objectContaining({ generatedVisitId: VISIT_B, code: 'NOT_STAFFED' }),
    ]);
    expect(verdict.visitsDue).toBe(2);
    expect(verdict.visitsStaffed).toBe(1);
  });

  // All-or-nothing: one bad visit withholds the entire day, including the
  // visits that were perfectly fine.
  it('withholds the whole day when a single visit fails', () => {
    const verdict = evaluateDueSet(
      input({
        dueVisits: [
          { id: VISIT_A, requiredCrewSize: 1 },
          { id: VISIT_B, requiredCrewSize: 1 },
          { id: VISIT_C, requiredCrewSize: 1 },
        ],
        assignments: [
          assignmentFor(VISIT_A),
          assignmentFor(VISIT_B),
          assignmentFor(VISIT_C, { vehicleIds: [] }),
        ],
      }),
    );

    expect(verdict.decision).toBe('WITHHOLD');
    expect(codes(verdict)).toEqual(['NO_VEHICLE']);
  });

  it('reports too few crew', () => {
    const verdict = evaluateDueSet(
      input({ dueVisits: [{ id: VISIT_A, requiredCrewSize: 2 }] }),
    );

    expect(codes(verdict)).toContain('CREW_TOO_SMALL');
  });

  it('reports more than one vehicle', () => {
    const verdict = evaluateDueSet(
      input({
        assignments: [assignmentFor(VISIT_A, { vehicleIds: [VAN, 'second-van'] })],
      }),
    );

    expect(codes(verdict)).toEqual(['TOO_MANY_VEHICLES']);
  });

  it('reports a crew that does not fit the vehicle', () => {
    const verdict = evaluateDueSet(
      input({
        dueVisits: [{ id: VISIT_A, requiredCrewSize: 2 }],
        assignments: [assignmentFor(VISIT_A, { crewEmployeeIds: [DRIVER, MATE] })],
        vehicles: new Map([[VAN, { seats: 1 }]]),
      }),
    );

    expect(codes(verdict)).toContain('VEHICLE_CAPACITY_EXCEEDED');
  });

  it('reports a vehicle nobody in the crew may drive', () => {
    const verdict = evaluateDueSet(
      input({
        assignments: [assignmentFor(VISIT_A, { crewEmployeeIds: [MATE] })],
      }),
    );

    expect(codes(verdict)).toEqual(['NO_AUTHORIZED_DRIVER']);
  });

  it('accepts any authorised driver in the crew, not a designated one', () => {
    const verdict = evaluateDueSet(
      input({
        dueVisits: [{ id: VISIT_A, requiredCrewSize: 2 }],
        assignments: [assignmentFor(VISIT_A, { crewEmployeeIds: [MATE, DRIVER] })],
      }),
    );

    expect(verdict.decision).toBe('PUBLISHABLE');
  });

  // A capacity that cannot be violated is not a capacity that passes. C12
  // found all 18 active vehicles carry a seat count, so this should never
  // fire on today's data — which is exactly why it must fail loudly if it
  // ever does, rather than quietly counting as satisfied.
  it('refuses a vehicle with no recorded seat count rather than assuming it fits', () => {
    const verdict = evaluateDueSet(
      input({ vehicles: new Map([[VAN, { seats: null }]]) }),
    );

    expect(verdict.decision).toBe('WITHHOLD');
    expect(codes(verdict)).toContain('VEHICLE_CAPACITY_UNKNOWN');
  });

  it('refuses a vehicle with no fleet row at all', () => {
    const verdict = evaluateDueSet(input({ vehicles: new Map() }));

    expect(codes(verdict)).toContain('VEHICLE_CAPACITY_UNKNOWN');
  });

  // A manager who fixes one fault only to meet the next on the following run
  // spends a week on one day. Every failing rule is reported at once.
  it('reports every failing rule on a visit, not just the first', () => {
    const verdict = evaluateDueSet(
      input({
        dueVisits: [{ id: VISIT_A, requiredCrewSize: 3 }],
        assignments: [assignmentFor(VISIT_A, { crewEmployeeIds: [MATE, 'third'] })],
        vehicles: new Map([[VAN, { seats: 1 }]]),
      }),
    );

    expect(codes(verdict).sort()).toEqual([
      'CREW_TOO_SMALL',
      'NO_AUTHORIZED_DRIVER',
      'VEHICLE_CAPACITY_EXCEEDED',
    ]);
  });

  it('carries a manager-readable message that names no employee', () => {
    const verdict = evaluateDueSet(
      input({ assignments: [assignmentFor(VISIT_A, { crewEmployeeIds: [MATE] })] }),
    );

    const [only] = verdict.shortfalls;
    expect(only.message).toBe(
      'Nobody in the assigned crew is authorised to drive the assigned vehicle.',
    );
    expect(only.message).not.toContain(MATE);
    expect(only.message).not.toContain(VAN);
  });

  it('ignores an assignment for a visit that is not due', () => {
    const verdict = evaluateDueSet(
      input({
        dueVisits: [{ id: VISIT_A, requiredCrewSize: 1 }],
        assignments: [assignmentFor(VISIT_A), assignmentFor(VISIT_B, { vehicleIds: [] })],
      }),
    );

    expect(verdict.decision).toBe('PUBLISHABLE');
    expect(verdict.visitsStaffed).toBe(1);
  });
});

describe('NO_VEHICLE_POLICY', () => {
  // Sol asked for the current reading to be kept explicit and unshipped
  // while the three-way public-transport decision goes to Thivarrakesh.
  // Explicit means a change to it cannot pass silently, so the value is
  // asserted here rather than only described in a comment.
  it('records the decided policy, so a change cannot pass silently', () => {
    expect(NO_VEHICLE_POLICY).toEqual({
      decision: 'PUBLIC_TRANSPORT_VALID_MANAGER_REVIEW',
      unauthorizedCode: 'NO_VEHICLE',
    });
  });

  // Policy (c): valid, and never automatic.
  it('accepts a no-vehicle crew that may use public transport, but forces review', () => {
    const verdict = evaluateDueSet(
      input({
        assignments: [assignmentFor(VISIT_A, { vehicleIds: [] })],
        publicTransportEmployeeIds: new Set([DRIVER]),
      }),
    );

    expect(verdict.decision).toBe('PUBLISHABLE');
    expect(verdict.shortfalls).toEqual([]);
    expect(verdict.requiresManagerReview).toBe(true);
  });

  it('still refuses a no-vehicle crew where anyone lacks the authorisation', () => {
    const verdict = evaluateDueSet(
      input({
        dueVisits: [{ id: VISIT_A, requiredCrewSize: 2 }],
        assignments: [
          assignmentFor(VISIT_A, { crewEmployeeIds: [DRIVER, MATE], vehicleIds: [] }),
        ],
        // MATE is not authorised, so the crew as a whole is not.
        publicTransportEmployeeIds: new Set([DRIVER]),
      }),
    );

    expect(verdict.decision).toBe('WITHHOLD');
    expect(codes(verdict)).toEqual([NO_VEHICLE_POLICY.unauthorizedCode]);
  });

  // `every` on an empty list is true, which would wave an empty crew through
  // as a public-transport team. It is not one.
  it('does not treat an empty crew as a public-transport crew', () => {
    const verdict = evaluateDueSet(
      input({
        assignments: [
          assignmentFor(VISIT_A, { crewEmployeeIds: [], vehicleIds: [] }),
        ],
        publicTransportEmployeeIds: new Set([DRIVER]),
      }),
    );

    expect(verdict.decision).toBe('WITHHOLD');
    expect(codes(verdict).sort()).toEqual(['CREW_TOO_SMALL', 'NO_VEHICLE']);
  });

  it('leaves an ordinary vehicle day free to publish automatically', () => {
    expect(evaluateDueSet(input()).requiresManagerReview).toBe(false);
  });
});

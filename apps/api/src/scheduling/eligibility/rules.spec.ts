import { CrewRole, DeploymentType } from '@prisma/client';

import {
  AssignmentProposal,
  EligibilityContext,
  EmployeeFacts,
  VehicleFacts,
  VisitFacts,
  evaluateAssignment,
} from './rules';

/**
 * One positive and one negative per hard rule, plus compound and determinism
 * cases. These are the tests that decide whether a crew turns up somewhere they
 * are not allowed to be, so each one states the rule in its name.
 */

const SITE_ID = 'site-1';

function visit(overrides: Partial<VisitFacts> = {}): VisitFacts {
  return {
    id: 'visit-1',
    branchCode: 'COLOMBO',
    visitDate: '2026-09-09',
    windowStartMinute: 9 * 60,
    windowEndMinute: 17 * 60,
    durationMinutes: 90,
    requiredCrewSize: 2,
    serviceSiteId: SITE_ID,
    siteName: 'Main Kitchen',
    customerName: 'Cinnamon Grand',
    requiredSkillCodes: [],
    status: 'UNASSIGNED',
    ...overrides,
  };
}

function employee(overrides: Partial<EmployeeFacts> = {}): EmployeeFacts {
  return {
    id: 'emp-1',
    fullName: 'A Perera',
    branchCode: 'COLOMBO',
    isActive: true,
    isPmsGrade: false,
    deploymentType: DeploymentType.MOBILE,
    permanentSiteIds: [],
    skillCodes: [],
    authorizedVehicleIds: [],
    unavailableReason: null,
    busy: [],
    ...overrides,
  };
}

function vehicle(overrides: Partial<VehicleFacts> = {}): VehicleFacts {
  return {
    id: 'veh-1',
    label: 'Van (04 People) 253-4289',
    branchCode: 'COLOMBO',
    isActive: true,
    seatCapacity: 4,
    busy: [],
    ...overrides,
  };
}

const SUPERVISOR = employee({ id: 'sup-1', fullName: 'S Silva', isPmsGrade: true });
const TECHNICIAN = employee({ id: 'tech-1', fullName: 'T Fernando' });

function context(overrides: Partial<EligibilityContext> = {}): EligibilityContext {
  return {
    visit: visit(),
    employees: [SUPERVISOR, TECHNICIAN],
    vehicles: [vehicle()],
    branchHasPmsSupervisor: true,
    existingLock: null,
    ...overrides,
  };
}

function proposal(overrides: Partial<AssignmentProposal> = {}): AssignmentProposal {
  return {
    plannedStartMinute: 9 * 60,
    plannedEndMinute: 11 * 60,
    crew: [
      { employeeId: SUPERVISOR.id, role: CrewRole.SUPERVISOR },
      { employeeId: TECHNICIAN.id, role: CrewRole.TECHNICIAN },
    ],
    vehicles: [],
    ...overrides,
  };
}

const codesOf = (result: { conflicts: { code: string }[] }) =>
  result.conflicts.map((conflict) => conflict.code);

describe('eligibility engine', () => {
  it('accepts a crew that satisfies every rule', () => {
    const result = evaluateAssignment(proposal(), context());

    expect(result.conflicts).toEqual([]);
    expect(result.isEligible).toBe(true);
  });

  describe('branch isolation', () => {
    it('accepts a crew from the visit’s own branch', () => {
      expect(evaluateAssignment(proposal(), context()).isEligible).toBe(true);
    });

    it('refuses a Kandy employee on Colombo work', () => {
      const kandy = employee({ ...TECHNICIAN, branchCode: 'KANDY' });
      const result = evaluateAssignment(
        proposal(),
        context({ employees: [SUPERVISOR, kandy] }),
      );

      expect(codesOf(result)).toContain('BRANCH_MISMATCH');
      expect(result.conflicts[0].message).toContain('KANDY');
    });
  });

  describe('permanently stationed staff', () => {
    it('accepts them at the site they are stationed at', () => {
      const stationed = employee({
        ...TECHNICIAN,
        deploymentType: DeploymentType.PERMANENTLY_STATIONED,
        permanentSiteIds: [SITE_ID],
      });

      const result = evaluateAssignment(
        proposal(),
        context({ employees: [SUPERVISOR, stationed] }),
      );

      expect(result.isEligible).toBe(true);
    });

    it('refuses to send them anywhere else', () => {
      const stationed = employee({
        ...TECHNICIAN,
        deploymentType: DeploymentType.PERMANENTLY_STATIONED,
        permanentSiteIds: ['some-other-site'],
      });

      const result = evaluateAssignment(
        proposal(),
        context({ employees: [SUPERVISOR, stationed] }),
      );

      expect(codesOf(result)).toContain('EMPLOYEE_PERMANENTLY_STATIONED');
    });
  });

  describe('PMS supervision', () => {
    it('accepts a crew containing a PMS-grade supervisor', () => {
      expect(evaluateAssignment(proposal(), context()).isEligible).toBe(true);
    });

    it('refuses a crew with no supervisor', () => {
      const second = employee({ id: 'tech-2', fullName: 'U Bandara' });
      const result = evaluateAssignment(
        proposal({
          crew: [
            { employeeId: TECHNICIAN.id, role: CrewRole.TECHNICIAN },
            { employeeId: second.id, role: CrewRole.TECHNICIAN },
          ],
        }),
        context({ employees: [TECHNICIAN, second] }),
      );

      expect(codesOf(result)).toContain('NO_PMS_SUPERVISOR_AVAILABLE');
    });

    it('names the branch shortage when the branch employs no supervisor at all', () => {
      // Kandy's real situation. "Add a supervisor" is useless advice when the
      // branch has none, so this is a different problem with a different code.
      const kandyVisit = visit({ branchCode: 'KANDY' });
      const one = employee({ id: 'k-1', branchCode: 'KANDY', fullName: 'K One' });
      const two = employee({ id: 'k-2', branchCode: 'KANDY', fullName: 'K Two' });

      const result = evaluateAssignment(
        proposal({
          crew: [
            { employeeId: one.id, role: CrewRole.TECHNICIAN },
            { employeeId: two.id, role: CrewRole.TECHNICIAN },
          ],
        }),
        context({
          visit: kandyVisit,
          employees: [one, two],
          branchHasPmsSupervisor: false,
        }),
      );

      expect(codesOf(result)).toContain('BRANCH_HAS_NO_PMS_SUPERVISOR');
      expect(codesOf(result)).not.toContain('NO_PMS_SUPERVISOR_AVAILABLE');
      expect(result.conflicts[0].remediation).toContain('promote');
    });
  });

  describe('crew size', () => {
    it('accepts a crew of exactly the required size', () => {
      expect(evaluateAssignment(proposal(), context()).isEligible).toBe(true);
    });

    it('refuses a crew that is one short', () => {
      const result = evaluateAssignment(
        proposal({ crew: [{ employeeId: SUPERVISOR.id, role: CrewRole.SUPERVISOR }] }),
        context(),
      );

      expect(codesOf(result)).toContain('CREW_TOO_SMALL');
      expect(result.conflicts[0].message).toContain('needs 2');
    });

    it('counts a duplicated person once, and says so', () => {
      const result = evaluateAssignment(
        proposal({
          crew: [
            { employeeId: SUPERVISOR.id, role: CrewRole.SUPERVISOR },
            { employeeId: SUPERVISOR.id, role: CrewRole.TECHNICIAN },
          ],
        }),
        context(),
      );

      expect(codesOf(result)).toContain('DUPLICATE_CREW_MEMBER');
      expect(codesOf(result)).toContain('CREW_TOO_SMALL');
    });
  });

  describe('required skills', () => {
    it('accepts a crew that covers every required skill between them', () => {
      const result = evaluateAssignment(
        proposal(),
        context({
          visit: visit({ requiredSkillCodes: ['FUMIGATION', 'RODENT'] }),
          employees: [
            { ...SUPERVISOR, skillCodes: ['FUMIGATION'] },
            { ...TECHNICIAN, skillCodes: ['RODENT'] },
          ],
        }),
      );

      expect(result.isEligible).toBe(true);
    });

    it('refuses when a required skill is missing, and names it', () => {
      const result = evaluateAssignment(
        proposal(),
        context({ visit: visit({ requiredSkillCodes: ['FUMIGATION'] }) }),
      );

      expect(codesOf(result)).toContain('SKILL_NOT_HELD');
      expect(result.conflicts[0].resources.skillCodes).toEqual(['FUMIGATION']);
    });
  });

  describe('double booking', () => {
    it('accepts a crew whose other job finishes before this one starts', () => {
      const busy = employee({
        ...TECHNICIAN,
        busy: [{ assignmentId: 'a-1', startMinute: 7 * 60, endMinute: 9 * 60 }],
      });

      // Touching is not overlapping — 09:00 to 09:00 is fine.
      const result = evaluateAssignment(
        proposal(),
        context({ employees: [SUPERVISOR, busy] }),
      );

      expect(result.isEligible).toBe(true);
    });

    it('refuses an employee already out on an overlapping job', () => {
      const busy = employee({
        ...TECHNICIAN,
        busy: [{ assignmentId: 'a-1', startMinute: 10 * 60, endMinute: 12 * 60 }],
      });

      const result = evaluateAssignment(
        proposal(),
        context({ employees: [SUPERVISOR, busy] }),
      );

      expect(codesOf(result)).toContain('EMPLOYEE_DOUBLE_BOOKED');
      expect(result.conflicts[0].resources.assignmentIds).toEqual(['a-1']);
    });

    it('refuses a vehicle already out on an overlapping job', () => {
      const busyVan = vehicle({
        busy: [{ assignmentId: 'a-2', startMinute: 10 * 60, endMinute: 12 * 60 }],
      });

      const result = evaluateAssignment(
        proposal({ vehicles: [{ vehicleId: busyVan.id, driverEmployeeId: SUPERVISOR.id }] }),
        context({
          employees: [{ ...SUPERVISOR, authorizedVehicleIds: [busyVan.id] }, TECHNICIAN],
          vehicles: [busyVan],
        }),
      );

      expect(codesOf(result)).toContain('VEHICLE_DOUBLE_BOOKED');
    });
  });

  describe('employee availability', () => {
    it('accepts someone with no leave on the day', () => {
      expect(evaluateAssignment(proposal(), context()).isEligible).toBe(true);
    });

    it('refuses someone on leave', () => {
      const away = employee({ ...TECHNICIAN, unavailableReason: 'LEAVE' });
      const result = evaluateAssignment(
        proposal(),
        context({ employees: [SUPERVISOR, away] }),
      );

      expect(codesOf(result)).toContain('EMPLOYEE_UNAVAILABLE');
    });

    it('refuses an inactive employee', () => {
      const gone = employee({ ...TECHNICIAN, isActive: false });
      const result = evaluateAssignment(
        proposal(),
        context({ employees: [SUPERVISOR, gone] }),
      );

      expect(codesOf(result)).toContain('EMPLOYEE_INACTIVE');
    });
  });

  describe('vehicles', () => {
    const authorizedSupervisor = { ...SUPERVISOR, authorizedVehicleIds: ['veh-1'] };

    it('accepts a vehicle driven by an authorized crew member', () => {
      const result = evaluateAssignment(
        proposal({ vehicles: [{ vehicleId: 'veh-1', driverEmployeeId: SUPERVISOR.id }] }),
        context({ employees: [authorizedSupervisor, TECHNICIAN] }),
      );

      expect(result.isEligible).toBe(true);
    });

    it('accepts a crew with no vehicle at all', () => {
      // Staff who can use public transport need none; a missing vehicle is not
      // a conflict.
      expect(evaluateAssignment(proposal({ vehicles: [] }), context()).isEligible).toBe(true);
    });

    it('refuses a vehicle whose named driver is not authorized', () => {
      const result = evaluateAssignment(
        proposal({ vehicles: [{ vehicleId: 'veh-1', driverEmployeeId: TECHNICIAN.id }] }),
        context({ employees: [authorizedSupervisor, TECHNICIAN] }),
      );

      expect(codesOf(result)).toContain('NO_AUTHORIZED_DRIVER');
      // The way out is named, not left to the manager to work out.
      expect(result.conflicts[0].remediation).toContain('S Silva');
    });

    it('refuses a vehicle with no driver named', () => {
      const result = evaluateAssignment(
        proposal({ vehicles: [{ vehicleId: 'veh-1', driverEmployeeId: null }] }),
        context({ employees: [authorizedSupervisor, TECHNICIAN] }),
      );

      expect(codesOf(result)).toContain('NO_AUTHORIZED_DRIVER');
    });

    it('refuses a vehicle with fewer seats than the crew', () => {
      const small = vehicle({ id: 'veh-2', label: 'Bike 55-1234', seatCapacity: 1 });
      const result = evaluateAssignment(
        proposal({ vehicles: [{ vehicleId: small.id, driverEmployeeId: SUPERVISOR.id }] }),
        context({
          employees: [{ ...SUPERVISOR, authorizedVehicleIds: [small.id] }, TECHNICIAN],
          vehicles: [small],
        }),
      );

      expect(codesOf(result)).toContain('VEHICLE_CAPACITY_EXCEEDED');
    });

    it('does not refuse a vehicle whose branch was never recorded', () => {
      // The workforce matrix does not give every van a branch. Unknown is not
      // the same as wrong, and refusing it would invent a fact.
      const unknownBranch = vehicle({ id: 'veh-4', branchCode: null, seatCapacity: null });
      const result = evaluateAssignment(
        proposal({
          vehicles: [{ vehicleId: unknownBranch.id, driverEmployeeId: SUPERVISOR.id }],
        }),
        context({
          employees: [
            { ...SUPERVISOR, authorizedVehicleIds: [unknownBranch.id] },
            TECHNICIAN,
          ],
          vehicles: [unknownBranch],
        }),
      );

      expect(result.isEligible).toBe(true);
    });

    it('refuses a vehicle from the other branch', () => {
      const kandyVan = vehicle({ id: 'veh-3', branchCode: 'KANDY', label: 'Kandy Van' });
      const result = evaluateAssignment(
        proposal({ vehicles: [{ vehicleId: kandyVan.id, driverEmployeeId: SUPERVISOR.id }] }),
        context({
          employees: [{ ...SUPERVISOR, authorizedVehicleIds: [kandyVan.id] }, TECHNICIAN],
          vehicles: [kandyVan],
        }),
      );

      expect(codesOf(result)).toContain('VEHICLE_BRANCH_MISMATCH');
    });

    it('refuses a vehicle that is off the road', () => {
      const broken = vehicle({ isActive: false });
      const result = evaluateAssignment(
        proposal({ vehicles: [{ vehicleId: broken.id, driverEmployeeId: SUPERVISOR.id }] }),
        context({
          employees: [{ ...SUPERVISOR, authorizedVehicleIds: [broken.id] }, TECHNICIAN],
          vehicles: [broken],
        }),
      );

      expect(codesOf(result)).toContain('VEHICLE_INACTIVE');
    });
  });

  describe('the service window', () => {
    it('accepts a booking inside the site’s hours', () => {
      expect(evaluateAssignment(proposal(), context()).isEligible).toBe(true);
    });

    it('refuses a booking that starts before the site opens', () => {
      const result = evaluateAssignment(
        proposal({ plannedStartMinute: 7 * 60, plannedEndMinute: 9 * 60 }),
        context(),
      );

      expect(codesOf(result)).toContain('OUTSIDE_SERVICE_HOURS');
      expect(result.conflicts[0].message).toContain('09:00');
    });

    it('refuses a booking shorter than the job takes', () => {
      const result = evaluateAssignment(
        proposal({ plannedStartMinute: 9 * 60, plannedEndMinute: 10 * 60 }),
        context({ visit: visit({ durationMinutes: 120 }) }),
      );

      expect(codesOf(result)).toContain('WINDOW_TOO_SHORT');
    });
  });

  describe('manager locks are preserved', () => {
    it('accepts a visit with no lock', () => {
      expect(evaluateAssignment(proposal(), context()).isEligible).toBe(true);
    });

    it('refuses to reassign a locked visit', () => {
      const result = evaluateAssignment(
        proposal(),
        context({
          existingLock: {
            assignmentId: 'a-9',
            scope: 'FULL',
            reason: 'Customer asked for this crew',
          },
        }),
      );

      expect(codesOf(result)).toContain('ASSIGNMENT_LOCKED');
      expect(result.conflicts[0].message).toContain('Customer asked for this crew');
    });
  });

  describe('a visit that is already history', () => {
    it('refuses to staff a completed visit', () => {
      const result = evaluateAssignment(
        proposal(),
        context({ visit: visit({ status: 'COMPLETED' }) }),
      );

      expect(codesOf(result)).toContain('VISIT_NOT_SCHEDULABLE');
    });
  });

  describe('compound conflicts', () => {
    it('reports every problem at once rather than stopping at the first', () => {
      // A manager who fixes the branch, is then told the crew is too small, and
      // then that a skill is missing, stops trusting the screen.
      const wrongBranch = employee({
        id: 'k-9',
        fullName: 'K Nine',
        branchCode: 'KANDY',
        unavailableReason: 'SICK',
      });

      const result = evaluateAssignment(
        proposal({
          crew: [{ employeeId: wrongBranch.id, role: CrewRole.TECHNICIAN }],
          plannedStartMinute: 6 * 60,
          plannedEndMinute: 7 * 60,
        }),
        context({
          visit: visit({ requiredSkillCodes: ['FUMIGATION'], durationMinutes: 120 }),
          employees: [wrongBranch],
        }),
      );

      expect(codesOf(result)).toEqual(
        expect.arrayContaining([
          'BRANCH_MISMATCH',
          'CREW_TOO_SMALL',
          'EMPLOYEE_UNAVAILABLE',
          'SKILL_NOT_HELD',
          'NO_PMS_SUPERVISOR_AVAILABLE',
          'OUTSIDE_SERVICE_HOURS',
          'WINDOW_TOO_SHORT',
        ]),
      );
      expect(result.isEligible).toBe(false);
    });
  });

  describe('determinism', () => {
    it('returns an identical result for identical input', () => {
      const first = evaluateAssignment(proposal({ crew: [] }), context());
      const second = evaluateAssignment(proposal({ crew: [] }), context());

      expect(JSON.stringify(first)).toEqual(JSON.stringify(second));
    });

    it('does not depend on the order the crew is listed in', () => {
      const forwards = evaluateAssignment(
        proposal({
          crew: [
            { employeeId: SUPERVISOR.id, role: CrewRole.SUPERVISOR },
            { employeeId: TECHNICIAN.id, role: CrewRole.TECHNICIAN },
          ],
        }),
        context({ visit: visit({ requiredSkillCodes: ['FUMIGATION'] }) }),
      );
      const backwards = evaluateAssignment(
        proposal({
          crew: [
            { employeeId: TECHNICIAN.id, role: CrewRole.TECHNICIAN },
            { employeeId: SUPERVISOR.id, role: CrewRole.SUPERVISOR },
          ],
        }),
        context({ visit: visit({ requiredSkillCodes: ['FUMIGATION'] }) }),
      );

      expect(JSON.stringify(forwards)).toEqual(JSON.stringify(backwards));
    });

    it('does not depend on the order employees arrive from the database', () => {
      const away = employee({ ...TECHNICIAN, unavailableReason: 'LEAVE' });
      const alsoAway = employee({
        id: 'tech-2',
        fullName: 'V Wijesinghe',
        unavailableReason: 'SICK',
      });
      const crew = [
        { employeeId: away.id, role: CrewRole.TECHNICIAN },
        { employeeId: alsoAway.id, role: CrewRole.TECHNICIAN },
      ];

      const oneWay = evaluateAssignment(
        proposal({ crew }),
        context({ employees: [away, alsoAway] }),
      );
      const otherWay = evaluateAssignment(
        proposal({ crew }),
        context({ employees: [alsoAway, away] }),
      );

      expect(JSON.stringify(oneWay)).toEqual(JSON.stringify(otherWay));
    });
  });
});

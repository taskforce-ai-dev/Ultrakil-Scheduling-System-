import { BranchCode, DeploymentType, VisitStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

import { EligibilityService } from './eligibility.service';
import { evaluateAssignment } from './rules';

it('loads availability and bookings for the proposed visit date without writing the visit', async () => {
  const originalDate = new Date('2027-03-03T00:00:00Z');
  const proposedDate = new Date('2027-03-04T00:00:00Z');
  const prisma = {
    generatedVisit: {
      findUnique: jest.fn(async () => ({
        id: 'visit',
        branchCode: BranchCode.COLOMBO,
        visitDate: originalDate,
        windowStartMinute: 540,
        windowEndMinute: 720,
        durationMinutes: 90,
        requiredCrewSize: 1,
        status: VisitStatus.SCHEDULED,
        assignments: [],
        serviceAgreement: {
          serviceSite: { id: 'site', name: 'Site' },
          customer: { name: 'Customer' },
          requiredSkills: [],
        },
      })),
    },
    employee: {
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 1),
    },
    vehicle: { findMany: jest.fn(async () => []) },
  };
  const service = new EligibilityService(prisma as unknown as PrismaService);
  const options = {
    excludeAssignmentId: 'draft',
    proposedVisit: {
      visitDate: proposedDate,
      windowStartMinute: 600,
      windowEndMinute: 780,
      durationMinutes: 120,
      requiredCrewSize: 2,
    },
  };
  const context = await service.buildContext(
    'visit',
    {
      plannedStartMinute: 600,
      plannedEndMinute: 690,
      crew: [{ employeeId: 'employee', role: 'SUPERVISOR' }],
      vehicles: [{ vehicleId: 'vehicle', driverEmployeeId: 'employee' }],
    },
    options,
  );

  expect(context.visit).toMatchObject({
    visitDate: '2027-03-04',
    windowStartMinute: 600,
    windowEndMinute: 780,
    durationMinutes: 120,
    requiredCrewSize: 2,
  });
  expect(prisma.employee.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      include: expect.objectContaining({
        availability: expect.objectContaining({
          where: {
            startDate: { lte: proposedDate },
            endDate: { gte: proposedDate },
          },
        }),
        permanentAssignments: expect.objectContaining({
          where: expect.objectContaining({
            effectiveFrom: { lte: proposedDate },
          }),
        }),
        crewMemberships: expect.objectContaining({
          where: {
            assignment: expect.objectContaining({
              generatedVisit: { visitDate: proposedDate },
              id: { not: 'draft' },
            }),
          },
        }),
      }),
    }),
  );
  expect(prisma.vehicle.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      include: expect.objectContaining({
        assignmentVehicles: expect.objectContaining({
          where: {
            assignment: expect.objectContaining({
              generatedVisit: { visitDate: proposedDate },
              id: { not: 'draft' },
            }),
          },
        }),
      }),
    }),
  );
});

it('keeps a reservation ending at midnight as minute 1440 for authoritative employee and vehicle checks', async () => {
  const visitDate = new Date('2027-03-04T00:00:00.000Z');
  const reservation = {
    id: 'late-booking',
    plannedStart: new Date('2027-03-04T22:00:00.000Z'),
    plannedEnd: new Date('2027-03-05T00:00:00.000Z'),
  };
  const prisma = {
    generatedVisit: { findUnique: jest.fn().mockResolvedValue({
      id: 'visit', branchCode: BranchCode.COLOMBO, visitDate,
      windowStartMinute: 0, windowEndMinute: 1440, durationMinutes: 30, requiredCrewSize: 1,
      status: VisitStatus.SCHEDULED, assignments: [],
      serviceAgreement: { serviceSite: { id: 'site', name: 'Site' }, customer: { name: 'Customer' }, requiredSkills: [] },
    }) },
    employee: { findMany: jest.fn().mockResolvedValue([{
      id: 'employee', fullName: 'Employee', branchCode: BranchCode.COLOMBO, isActive: true,
      isPmsGrade: true, deploymentType: 'MOBILE', canUsePublicTransport: false,
      skills: [], vehicleAuthorizations: [{ vehicleId: 'vehicle' }], availability: [], permanentAssignments: [],
      crewMemberships: [{ assignment: reservation }],
    }]), count: jest.fn().mockResolvedValue(1) },
    vehicle: { findMany: jest.fn().mockResolvedValue([{
      id: 'vehicle', label: 'Vehicle', isActive: true, seatCapacity: 2, branch: { code: BranchCode.COLOMBO },
      assignmentVehicles: [{ assignment: reservation }],
    }]) },
  };
  const service = new EligibilityService(prisma as never);
  const proposal = { plannedStartMinute: 1410, plannedEndMinute: 1440, crew: [{ employeeId: 'employee', role: 'SUPERVISOR' as const }], vehicles: [{ vehicleId: 'vehicle', driverEmployeeId: 'employee' }] };
  const context = await service.buildContext('visit', proposal);

  expect(context.employees[0].busy).toEqual([{ assignmentId: 'late-booking', startMinute: 1320, endMinute: 1440 }]);
  expect(context.vehicles[0].busy).toEqual([{ assignmentId: 'late-booking', startMinute: 1320, endMinute: 1440 }]);
  expect(evaluateAssignment(proposal, context).conflicts.map((conflict) => conflict.code)).toEqual(
    expect.arrayContaining(['EMPLOYEE_DOUBLE_BOOKED', 'VEHICLE_DOUBLE_BOOKED']),
  );

  const adjacent = { ...proposal, plannedStartMinute: 1200, plannedEndMinute: 1320 };
  expect(evaluateAssignment(adjacent, context).conflicts.map((conflict) => conflict.code)).not.toEqual(
    expect.arrayContaining(['EMPLOYEE_DOUBLE_BOOKED', 'VEHICLE_DOUBLE_BOOKED']),
  );
});

it('loads active same-branch and branchless candidate resources with live reservations only', async () => {
  const visitDate = new Date('2027-03-04T00:00:00.000Z');
  const prisma = {
    generatedVisit: { findUnique: jest.fn().mockResolvedValue({ id: 'visit', branchCode: BranchCode.COLOMBO, visitDate, serviceAgreement: { serviceSiteId: 'site' } }) },
    employee: { findMany: jest.fn().mockResolvedValue([]) },
    vehicle: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const service = new EligibilityService(prisma as never);

  await expect(service.candidates('visit', { plannedStartMinute: 540, plannedEndMinute: 660 }, 'draft'))
    .resolves.toEqual({ employees: [], vehicles: [] });
  expect(prisma.employee.findMany).toHaveBeenCalledWith(expect.objectContaining({
    where: { isActive: true, branchCode: BranchCode.COLOMBO },
    include: expect.objectContaining({ crewMemberships: expect.objectContaining({
      where: { assignment: expect.objectContaining({ id: { not: 'draft' } }) },
    }) }),
  }));
  expect(prisma.vehicle.findMany).toHaveBeenCalledWith(expect.objectContaining({
    where: { isActive: true, OR: [{ branch: { is: { code: BranchCode.COLOMBO } } }, { branchId: null }] },
  }));
  const employeeCall = prisma.employee.findMany.mock.calls[0][0];
  const liveStatuses = employeeCall.include.crewMemberships.where.assignment.status.in;
  expect(liveStatuses).toEqual(expect.arrayContaining(['DRAFT', 'PROPOSED', 'PUBLISHED', 'ACKNOWLEDGED', 'IN_PROGRESS']));
  expect(liveStatuses).not.toEqual(expect.arrayContaining(['CANCELLED', 'SUPERSEDED']));
});



describe('EligibilityService candidates', () => {
  it('returns individually available resources, honoring reason precedence and excluding its own draft', async () => {
    const visitDate = new Date('2026-09-23T00:00:00.000Z');
    const prisma = {
      generatedVisit: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'visit', branchCode: 'COLOMBO', visitDate,
          serviceAgreement: { serviceSiteId: 'site-here' },
        }),
      },
      employee: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'absent', fullName: 'Able Absence', availability: [{ kind: 'LEAVE' }],
            deploymentType: DeploymentType.PERMANENTLY_STATIONED, isPmsGrade: false,
            permanentAssignments: [{ serviceSiteId: 'site-away' }], crewMemberships: [],
          },
          {
            id: 'stationed', fullName: 'Bina Stationed', availability: [],
            deploymentType: DeploymentType.PERMANENTLY_STATIONED, isPmsGrade: false,
            permanentAssignments: [{ serviceSiteId: 'site-away' }], crewMemberships: [],
          },
          {
            id: 'busy', fullName: 'Charlie Busy', availability: [], permanentAssignments: [],
            deploymentType: DeploymentType.MOBILE, isPmsGrade: false,
            crewMemberships: [{ assignment: { id: 'busy-late', plannedStart: new Date('2026-09-23T10:00:00.000Z'), plannedEnd: new Date('2026-09-23T12:00:00.000Z') } }, { assignment: { id: 'busy-early', plannedStart: new Date('2026-09-23T09:00:00.000Z'), plannedEnd: new Date('2026-09-23T11:00:00.000Z') } }],
          },
          {
            id: 'self', fullName: 'Dina Self', availability: [],
            deploymentType: DeploymentType.PERMANENTLY_STATIONED, isPmsGrade: true,
            permanentAssignments: [{ serviceSiteId: 'site-here' }],
            // The Prisma predicate excludes this visit's sole editable draft.
            crewMemberships: [],
          },
          {
            id: 'adjacent', fullName: 'Esha Adjacent', availability: [], permanentAssignments: [],
            deploymentType: DeploymentType.MOBILE, isPmsGrade: false,
            crewMemberships: [{ assignment: { id: 'ends-midnight', plannedStart: new Date('2026-09-23T22:00:00.000Z'), plannedEnd: new Date('2026-09-24T00:00:00.000Z') } }],
          },
          {
            id: 'mobile-other', fullName: 'Fae Mobile', availability: [],
            deploymentType: DeploymentType.MOBILE, isPmsGrade: false,
            permanentAssignments: [{ serviceSiteId: 'site-away' }], crewMemberships: [],
          },
          {
            id: 'multi-target', fullName: 'Gita Multi', availability: [],
            deploymentType: DeploymentType.PERMANENTLY_STATIONED, isPmsGrade: false,
            permanentAssignments: [{ serviceSiteId: 'site-away' }, { serviceSiteId: 'site-here' }], crewMemberships: [],
          },
        ]),
      },
      vehicle: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'busy-vehicle', label: 'Van Busy', seatCapacity: 3, assignmentVehicles: [{ assignment: { id: 'v-busy', plannedStart: new Date('2026-09-23T09:00:00.000Z'), plannedEnd: new Date('2026-09-23T11:00:00.000Z') } }] },
          { id: 'self-vehicle', label: 'Van Self', seatCapacity: null, assignmentVehicles: [] },
          { id: 'adjacent-vehicle', label: 'Van Adjacent', seatCapacity: 2, assignmentVehicles: [{ assignment: { id: 'ends-midnight', plannedStart: new Date('2026-09-23T22:00:00.000Z'), plannedEnd: new Date('2026-09-24T00:00:00.000Z') } }] },
        ]),
      },
    };
    const service = new EligibilityService(prisma as never);

    const result = await service.candidates('visit', { plannedStartMinute: 540, plannedEndMinute: 660 }, 'self-draft');
    const byEmployeeId = new Map(result.employees.map((candidate) => [candidate.id, candidate]));
    const byVehicleId = new Map(result.vehicles.map((candidate) => [candidate.id, candidate]));

    expect(byEmployeeId.get('absent')).toMatchObject({
      isAvailable: false,
      unavailableReason: { code: 'EMPLOYEE_UNAVAILABLE', message: 'On leave' },
    });
    expect(byEmployeeId.get('stationed')).toMatchObject({
      isAvailable: false,
      unavailableReason: { code: 'EMPLOYEE_PERMANENTLY_STATIONED' },
    });
    expect(byEmployeeId.get('busy')).toMatchObject({
      isAvailable: false,
      unavailableReason: { code: 'EMPLOYEE_DOUBLE_BOOKED', message: 'Booked 09:00–11:00' },
    });
    expect(byEmployeeId.get('self')?.isAvailable).toBe(true);
    expect(byEmployeeId.get('self')).toMatchObject({ displayName: 'Dina Self', isPmsGrade: true, unavailableReason: null });
    expect(byEmployeeId.get('adjacent')?.isAvailable).toBe(true);
    expect(byEmployeeId.get('mobile-other')?.isAvailable).toBe(true);
    expect(byEmployeeId.get('multi-target')?.isAvailable).toBe(true);
    expect(byVehicleId.get('busy-vehicle')).toMatchObject({
      isAvailable: false,
      unavailableReason: { code: 'VEHICLE_DOUBLE_BOOKED', message: 'Booked 09:00–11:00' },
    });
    expect(byVehicleId.get('self-vehicle')?.isAvailable).toBe(true);
    expect(byVehicleId.get('self-vehicle')).toMatchObject({ displayName: 'Van Self', seatCapacity: null, unavailableReason: null });
    expect(byVehicleId.get('adjacent-vehicle')?.isAvailable).toBe(true);
    expect(result.employees.map((candidate) => candidate.id)).toEqual(['self', 'adjacent', 'mobile-other', 'multi-target', 'absent', 'stationed', 'busy']);
    expect(prisma.vehicle.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ isActive: true, OR: expect.any(Array) }),
    }));
    expect(prisma.employee.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        crewMemberships: expect.objectContaining({
          where: { assignment: expect.objectContaining({ id: { not: 'self-draft' } }) },
        }),
      }),
    }));

    const late = await service.candidates('visit', { plannedStartMinute: 1410, plannedEndMinute: 1440 }, 'self-draft');
    expect(late.employees.find((candidate) => candidate.id === 'adjacent')).toMatchObject({
      isAvailable: false,
      unavailableReason: { code: 'EMPLOYEE_DOUBLE_BOOKED', message: 'Booked 22:00–24:00' },
    });
    expect(late.vehicles.find((candidate) => candidate.id === 'adjacent-vehicle')).toMatchObject({
      isAvailable: false,
      unavailableReason: { code: 'VEHICLE_DOUBLE_BOOKED', message: 'Booked 22:00–24:00' },
    });
  });
});

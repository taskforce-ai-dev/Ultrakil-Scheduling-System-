import { BranchCode, VisitStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { EligibilityService } from './eligibility.service';

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

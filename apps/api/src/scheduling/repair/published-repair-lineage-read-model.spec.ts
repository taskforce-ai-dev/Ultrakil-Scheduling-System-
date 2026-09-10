import { AssignmentStatus, BranchCode, CrewRole } from '@prisma/client';

import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AssignmentsService } from '../eligibility/assignments.service';
import { EligibilityService } from '../eligibility/eligibility.service';

it('includes repair-published assignments and exposes their lineage', async () => {
  const repairId = '77777777-7777-4777-8777-777777777777';
  const predecessorId = '11111111-1111-4111-8111-111111111111';
  const employeeId = '33333333-3333-4333-8333-333333333333';
  const prisma = {
    employee: { findUnique: jest.fn(async () => ({ id: employeeId })) },
    assignment: {
      count: jest.fn(async () => 1),
      findMany: jest.fn(async () => [
        {
          id: '66666666-6666-4666-8666-666666666666',
          generatedVisitId: '22222222-2222-4222-8222-222222222222',
          status: AssignmentStatus.PUBLISHED,
          scheduleRunId: null,
          publishedByRepairId: repairId,
          supersedesAssignmentId: predecessorId,
          branchCode: BranchCode.COLOMBO,
          plannedStart: new Date('2027-03-03T10:00:00.000Z'),
          plannedEnd: new Date('2027-03-03T11:00:00.000Z'),
          publishedAt: new Date('2027-02-28T10:00:00.000Z'),
          acknowledgedAt: null,
          startedAt: null,
          completedAt: null,
          crewMembers: [
            {
              employeeId,
              role: CrewRole.SUPERVISOR,
              isPmsSupervisor: true,
              employee: { fullName: 'Supervisor' },
            },
          ],
          vehicles: [],
          generatedVisit: {
            serviceAgreement: {
              notes: null,
              customer: { name: 'Customer' },
              serviceSite: { name: 'Site' },
              jobType: { name: 'Service' },
            },
          },
        },
      ]),
    },
  };
  const service = new AssignmentsService(
    prisma as unknown as PrismaService,
    {} as EligibilityService,
    {} as AuditService,
  );

  const result = await service.employeeAssignments(employeeId, {});

  expect(prisma.assignment.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        OR: [
          { scheduleRunId: { not: null } },
          { publishedByRepairId: { not: null } },
        ],
      }),
    }),
  );
  expect(result.items[0]).toMatchObject({
    scheduleRunId: null,
    publishedByRepairId: repairId,
    supersedesAssignmentId: predecessorId,
  });
});

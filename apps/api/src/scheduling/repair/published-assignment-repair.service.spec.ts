import {
  AssignmentRepairAction,
  AssignmentStatus,
  BranchCode,
  CrewRole,
  Prisma,
  VisitStatus,
} from '@prisma/client';

import { AuditService } from '../../audit/audit.service';
import { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../prisma/prisma.service';
import { Conflict } from '../eligibility/conflict-codes';
import { EligibilityService } from '../eligibility/eligibility.service';
import { PublishedAssignmentRepairService } from './published-assignment-repair.service';

const actor = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'admin@example.test',
  fullName: 'Admin',
  role: 'ADMIN',
} as AuthenticatedUser;

const sourceId = '11111111-1111-4111-8111-111111111111';
const visitId = '22222222-2222-4222-8222-222222222222';
const employeeId = '33333333-3333-4333-8333-333333333333';

function source(status: AssignmentStatus = AssignmentStatus.PUBLISHED) {
  return {
    id: sourceId,
    generatedVisitId: visitId,
    branchId: '44444444-4444-4444-8444-444444444444',
    branchCode: BranchCode.COLOMBO as BranchCode,
    status,
    plannedStart: new Date('2027-03-03T09:00:00.000Z'),
    plannedEnd: new Date('2027-03-03T10:00:00.000Z'),
    scheduleRunId: '55555555-5555-4555-8555-555555555555',
    publishedAt: new Date('2027-02-28T09:00:00.000Z'),
    acknowledgedAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date('2027-02-28T08:00:00.000Z'),
    updatedAt: new Date('2027-02-28T09:00:00.000Z'),
    crewMembers: [
      {
        employeeId,
        role: CrewRole.SUPERVISOR,
        isPmsSupervisor: true,
        employee: { fullName: 'Supervisor' },
      },
    ],
    vehicles: [],
    locks: [] as Array<{
      assignmentId: string;
      scope: string;
      reason: string | null;
    }>,
    generatedVisit: {
      id: visitId,
      branchId: '44444444-4444-4444-8444-444444444444',
      branchCode: BranchCode.COLOMBO as BranchCode,
      visitDate: new Date('2027-03-03T00:00:00.000Z'),
      status: VisitStatus.SCHEDULED,
      updatedAt: new Date('2027-02-28T09:00:00.000Z'),
      assignments: [{ id: sourceId }],
      serviceAgreement: {
        customer: { name: 'Customer' },
        serviceSite: { name: 'Site' },
      },
    },
  };
}

function fixture(status: AssignmentStatus = AssignmentStatus.PUBLISHED) {
  const row = source(status);
  const repairs: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: jest.fn(async () => [{ id: visitId }]),
    assignment: {
      findMany: jest.fn(async () => [row]),
      updateMany: jest.fn(async () => ({ count: 1 })),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...row,
        ...data,
        id: '66666666-6666-4666-8666-666666666666',
        status: AssignmentStatus.PUBLISHED,
      })),
    },
    employee: {
      findMany: jest.fn(async () => [{ id: employeeId, isPmsGrade: true }]),
    },
    generatedVisit: { update: jest.fn() },
    visitUnassignedReason: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    assignmentNotificationOutbox: {
      updateMany: jest.fn(async () => ({ count: 1 })),
      createMany: jest.fn(),
    },
    publishedAssignmentRepair: {
      findUnique: jest.fn(
        async ({ where }: { where: { idempotencyKey: string } }) =>
          repairs.find((entry) => entry.idempotencyKey === where.idempotencyKey) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const repair = {
          id: '77777777-7777-4777-8777-777777777777',
          createdAt: new Date('2027-02-28T10:00:00.000Z'),
          ...data,
        };
        repairs.push(repair);
        return repair;
      }),
    },
    publishedAssignmentRepairItem: { create: jest.fn() },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const eligibility = {
    evaluate: jest.fn(async () => ({
      isEligible: true,
      conflicts: [] as Conflict[],
    })),
  };
  const audit = { record: jest.fn() };
  const service = new PublishedAssignmentRepairService(
    prisma as unknown as PrismaService,
    eligibility as unknown as EligibilityService,
    audit as unknown as AuditService,
  );
  return { service, prisma, tx, eligibility, audit, repairs, row };
}

const replacement = {
  sourceAssignmentId: sourceId,
  action: AssignmentRepairAction.REPLACED,
  replacement: {
    plannedStartMinute: 600,
    plannedEndMinute: 660,
    crew: [{ employeeId, role: CrewRole.SUPERVISOR }],
    vehicles: [],
  },
};

describe('PublishedAssignmentRepairService', () => {
  it('previews a replacement with a canonical hash and zero writes', async () => {
    const { service, prisma, tx } = fixture();

    const first = await service.preview({ operations: [replacement] });
    const second = await service.preview({ operations: [replacement] });

    expect(first.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.planHash).toBe(first.planHash);
    expect(first.items[0]).toMatchObject({
      sourceAssignmentId: sourceId,
      action: AssignmentRepairAction.REPLACED,
      isValid: true,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.assignment.updateMany).not.toHaveBeenCalled();
    expect(tx.publishedAssignmentRepair.create).not.toHaveBeenCalled();
  });

  it('evaluates a batch without retaining any targeted predecessor reservation', async () => {
    const { service, tx, eligibility, row } = fixture();
    const secondSourceId = '88888888-8888-4888-8888-888888888888';
    const secondVisitId = '99999999-9999-4999-8999-999999999999';
    tx.assignment.findMany.mockResolvedValueOnce([
      row,
      {
        ...row,
        id: secondSourceId,
        generatedVisitId: secondVisitId,
        generatedVisit: {
          ...row.generatedVisit,
          id: secondVisitId,
          assignments: [{ id: secondSourceId }],
        },
      },
    ]);

    await service.preview({
      operations: [replacement, { ...replacement, sourceAssignmentId: secondSourceId }],
    });

    expect(eligibility.evaluate).toHaveBeenCalledTimes(2);
    expect(eligibility.evaluate).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      { excludeAssignmentIds: [sourceId, secondSourceId] },
      expect.any(Object),
    );
  });

  it.each([
    AssignmentStatus.ACKNOWLEDGED,
    AssignmentStatus.IN_PROGRESS,
    AssignmentStatus.COMPLETED,
    AssignmentStatus.SUPERSEDED,
  ])('rejects %s as a repair source', async (status) => {
    const { service } = fixture(status);
    await expect(service.preview({ operations: [replacement] })).rejects.toMatchObject({
      code: 'RESOURCE_CONFLICT',
    });
  });

  it('detects invalid current published assignments', async () => {
    const { service, eligibility } = fixture();
    eligibility.evaluate.mockResolvedValueOnce({
      isEligible: false,
      conflicts: [
        {
          code: 'CREW_CANNOT_TRAVEL',
          message: 'No transport',
          remediation: 'Repair',
          resources: { visitId },
        },
      ],
    });

    const result = await service.validateCurrent({ page: 1, pageSize: 20 });

    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      assignmentId: sourceId,
      visitId,
      timeScope: 'FUTURE',
      isSelectableForRepair: true,
      conflicts: [{ code: 'CREW_CANNOT_TRAVEL' }],
    });
  });

  it('classifies historical findings and refuses to preview them', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2027-03-03T06:00:00.000Z'));
    try {
      const { service, row, eligibility } = fixture();
      row.generatedVisit.visitDate = new Date('2027-03-02T00:00:00.000Z');
      eligibility.evaluate.mockResolvedValue({
        isEligible: false,
        conflicts: [{
          code: 'CREW_CANNOT_TRAVEL',
          message: 'No transport',
          remediation: 'Repair',
          resources: { visitId },
        }],
      });

      const findings = await service.validateCurrent({ page: 1, pageSize: 20 });

      expect(findings.items[0]).toMatchObject({
        timeScope: 'HISTORICAL',
        isSelectableForRepair: false,
      });
      await expect(
        service.preview({ operations: [replacement] }),
      ).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('requires explicit acknowledgement before applying a current-day repair', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2027-03-03T06:00:00.000Z'));
    try {
      const { service, tx } = fixture();
      const preview = await service.preview({ operations: [replacement] });

      await expect(
        service.apply(
          {
            operations: [replacement],
            planHash: preview.planHash,
            sourceFingerprints: preview.items.map((item) => ({
              sourceAssignmentId: item.sourceAssignmentId,
              fingerprint: item.sourceFingerprint,
            })),
            confirmation: true,
            reason: 'Current-day repair',
            idempotencyKey: 'current-day-1',
          },
          actor,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(tx.assignment.updateMany).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not silently bypass an active manager lock', async () => {
    const { service, row } = fixture();
    row.locks = [
      { assignmentId: sourceId, scope: 'FULL', reason: 'Manager dispatch hold' },
    ];

    const preview = await service.preview({ operations: [replacement] });

    expect(preview.items[0]).toMatchObject({
      isValid: false,
      conflicts: [{ code: 'ASSIGNMENT_LOCKED' }],
    });
  });

  it('paginates invalid findings and reports the invalid total, not every published row', async () => {
    const { service, tx, eligibility, row } = fixture();
    const invalid = {
      ...row,
      id: '88888888-8888-4888-8888-888888888888',
      generatedVisitId: '99999999-9999-4999-8999-999999999999',
      generatedVisit: {
        ...row.generatedVisit,
        id: '99999999-9999-4999-8999-999999999999',
      },
    };
    tx.assignment.findMany.mockResolvedValueOnce([row, invalid]);
    eligibility.evaluate
      .mockResolvedValueOnce({ isEligible: true, conflicts: [] })
      .mockResolvedValueOnce({
        isEligible: false,
        conflicts: [
          {
            code: 'CREW_CANNOT_TRAVEL',
            message: 'No transport',
            remediation: 'Repair',
            resources: { visitId: invalid.generatedVisitId },
          },
        ],
      });

    const result = await service.validateCurrent({ page: 1, pageSize: 1 });

    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].assignmentId).toBe(invalid.id);
  });

  it('atomically replaces the exact predecessor and emits audit and outbox intents', async () => {
    const { service, tx, audit } = fixture();
    const preview = await service.preview({ operations: [replacement] });

    const result = await service.apply(
      {
        operations: [replacement],
        planHash: preview.planHash,
        sourceFingerprints: preview.items.map((item) => ({
          sourceAssignmentId: item.sourceAssignmentId,
          fingerprint: item.sourceFingerprint,
        })),
        confirmation: true,
        reason: 'Correct legacy transport violation',
        idempotencyKey: 'repair-legacy-transport-1',
      },
      actor,
    );

    expect(result.items[0]).toMatchObject({
      sourceAssignmentId: sourceId,
      action: AssignmentRepairAction.REPLACED,
    });
    expect(tx.assignment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: sourceId,
          status: AssignmentStatus.PUBLISHED,
        }),
        data: { status: AssignmentStatus.SUPERSEDED },
      }),
    );
    expect(tx.assignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          supersedesAssignmentId: sourceId,
          status: AssignmentStatus.PUBLISHED,
        }),
      }),
    );
    expect(tx.visitUnassignedReason.deleteMany).toHaveBeenCalledWith({
      where: { generatedVisitId: visitId },
    });
    expect(tx.assignmentNotificationOutbox.updateMany).toHaveBeenCalledWith({
      where: {
        assignmentId: sourceId,
        eventType: 'assignment.published',
        processedAt: null,
        cancelledAt: null,
      },
      data: {
        cancelledAt: expect.any(Date),
        cancelledByRepairId: expect.any(String),
      },
    });
    expect(tx.publishedAssignmentRepairItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceAssignmentId: sourceId,
          action: AssignmentRepairAction.REPLACED,
          before: expect.objectContaining({
            customerName: 'Customer',
            siteName: 'Site',
            visitDate: '2027-03-03',
          }),
          after: expect.objectContaining({
            customerName: 'Customer',
            siteName: 'Site',
            visitDate: '2027-03-03',
          }),
        }),
      }),
    );
    expect(tx.assignmentNotificationOutbox.createMany).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'assignment.repair_replaced' }),
      tx,
    );
    expect(tx.publishedAssignmentRepair.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          communicationState: 'APPLIED_PENDING_COMMUNICATION',
        }),
      }),
    );
  });

  it('uses one publication timestamp for every replacement in a batch', async () => {
    const { service, tx, row } = fixture();
    const secondSourceId = '88888888-8888-4888-8888-888888888888';
    const secondVisitId = '99999999-9999-4999-8999-999999999999';
    const secondEmployeeId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const second = {
      ...row,
      id: secondSourceId,
      generatedVisitId: secondVisitId,
      crewMembers: [
        {
          ...row.crewMembers[0],
          employeeId: secondEmployeeId,
        },
      ],
      generatedVisit: {
        ...row.generatedVisit,
        id: secondVisitId,
        assignments: [{ id: secondSourceId }],
      },
    };
    tx.assignment.findMany.mockResolvedValue([row, second]);
    tx.$queryRaw.mockResolvedValue([{ id: visitId }, { id: secondVisitId }]);
    tx.employee.findMany.mockResolvedValue([
      { id: employeeId, isPmsGrade: true },
      { id: secondEmployeeId, isPmsGrade: true },
    ]);
    const operations = [
      replacement,
      {
        ...replacement,
        sourceAssignmentId: secondSourceId,
        replacement: {
          ...replacement.replacement,
          crew: [{ employeeId: secondEmployeeId, role: CrewRole.SUPERVISOR }],
        },
      },
    ];
    const preview = await service.preview({ operations });

    await service.apply(
      {
        operations,
        planHash: preview.planHash,
        sourceFingerprints: preview.items.map((item) => ({
          sourceAssignmentId: item.sourceAssignmentId,
          fingerprint: item.sourceFingerprint,
        })),
        confirmation: true,
        reason: 'Correct batch',
        idempotencyKey: 'repair-batch-1',
      },
      actor,
    );

    const timestamps = tx.assignment.create.mock.calls.map(
      ([call]) => (call as { data: { publishedAt: Date } }).data.publishedAt,
    );
    expect(timestamps).toHaveLength(2);
    expect(timestamps[1]).toBe(timestamps[0]);
  });

  it('refuses a partial repair when another published sibling for the visit is omitted', async () => {
    const { service, row } = fixture();
    row.generatedVisit.assignments = [
      { id: sourceId },
      { id: '88888888-8888-4888-8888-888888888888' },
    ];

    await expect(service.preview({ operations: [replacement] })).rejects.toMatchObject({
      code: 'RESOURCE_CONFLICT',
    });
  });

  it('refuses two replacement successors for the same visit', async () => {
    const { service, tx, row } = fixture();
    const secondSourceId = '88888888-8888-4888-8888-888888888888';
    const second = {
      ...row,
      id: secondSourceId,
      crewMembers: [
        {
          ...row.crewMembers[0],
          employeeId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        },
      ],
      generatedVisit: {
        ...row.generatedVisit,
        assignments: [{ id: sourceId }, { id: secondSourceId }],
      },
    };
    row.generatedVisit.assignments = [{ id: sourceId }, { id: secondSourceId }];
    tx.assignment.findMany.mockResolvedValue([row, second]);

    await expect(
      service.preview({
        operations: [
          replacement,
          {
            ...replacement,
            sourceAssignmentId: secondSourceId,
            replacement: {
              ...replacement.replacement,
              plannedStartMinute: 720,
              plannedEndMinute: 780,
              crew: [
                {
                  employeeId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
                  role: CrewRole.SUPERVISOR,
                },
              ],
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('applies sibling withdrawals before the single replacement successor', async () => {
    const { service, tx, row } = fixture();
    const secondSourceId = '88888888-8888-4888-8888-888888888888';
    const second = {
      ...row,
      id: secondSourceId,
      generatedVisit: {
        ...row.generatedVisit,
        assignments: [{ id: sourceId }, { id: secondSourceId }],
      },
    };
    row.generatedVisit.assignments = [{ id: sourceId }, { id: secondSourceId }];
    tx.assignment.findMany.mockResolvedValue([row, second]);
    const operations = [
      replacement,
      {
        sourceAssignmentId: secondSourceId,
        action: AssignmentRepairAction.WITHDRAWN,
        unassignedReasons: [
          {
            code: 'DUPLICATE_PUBLISHED_ASSIGNMENT',
            message: 'This duplicate publication is superseded by the reviewed successor.',
          },
        ],
      },
    ];
    const preview = await service.preview({ operations });

    await service.apply(
      {
        operations,
        planHash: preview.planHash,
        sourceFingerprints: preview.items.map((item) => ({
          sourceAssignmentId: item.sourceAssignmentId,
          fingerprint: item.sourceFingerprint,
        })),
        confirmation: true,
        reason: 'Collapse duplicate published siblings',
        idempotencyKey: 'repair-sibling-order',
      },
      actor,
    );

    expect(tx.generatedVisit.update.mock.calls.map(([call]) => call.data.status)).toEqual([
      VisitStatus.UNASSIGNED,
      VisitStatus.SCHEDULED,
    ]);
  });

  it('uses the generated visit branch for the replacement successor', async () => {
    const { service, tx, row } = fixture();
    row.branchId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    row.branchCode = BranchCode.KANDY;
    row.generatedVisit.branchId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    row.generatedVisit.branchCode = BranchCode.COLOMBO;
    const preview = await service.preview({ operations: [replacement] });

    await service.apply(
      {
        operations: [replacement],
        planHash: preview.planHash,
        sourceFingerprints: preview.items.map((item) => ({
          sourceAssignmentId: item.sourceAssignmentId,
          fingerprint: item.sourceFingerprint,
        })),
        confirmation: true,
        reason: 'Repair stale branch lineage',
        idempotencyKey: 'repair-stale-branch',
      },
      actor,
    );

    expect(tx.assignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          branchId: row.generatedVisit.branchId,
          branchCode: row.generatedVisit.branchCode,
        }),
      }),
    );
  });

  it('locks replacement employees and vehicles before transactional revalidation', async () => {
    const { service, tx, eligibility } = fixture();
    const vehicleId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const operation = {
      ...replacement,
      replacement: {
        ...replacement.replacement,
        vehicles: [{ vehicleId, driverEmployeeId: employeeId }],
      },
    };
    const preview = await service.preview({ operations: [operation] });

    await service.apply(
      {
        operations: [operation],
        planHash: preview.planHash,
        sourceFingerprints: preview.items.map((item) => ({
          sourceAssignmentId: item.sourceAssignmentId,
          fingerprint: item.sourceFingerprint,
        })),
        confirmation: true,
        reason: 'Fence replacement resources',
        idempotencyKey: 'repair-resource-lock-order',
      },
      actor,
    );

    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(tx.$queryRaw.mock.invocationCallOrder[2]).toBeLessThan(
      eligibility.evaluate.mock.invocationCallOrder[2],
    );
  });

  it('withdraws the predecessor into the unassigned queue with structured reasons', async () => {
    const { service, tx } = fixture();
    const operation = {
      sourceAssignmentId: sourceId,
      action: AssignmentRepairAction.WITHDRAWN,
      unassignedReasons: [
        {
          code: 'CREW_CANNOT_TRAVEL',
          message: 'Published crew cannot reach the site.',
          details: { source: 'published-integrity-validator' },
        },
      ],
    };
    const preview = await service.preview({ operations: [operation] });

    await service.apply(
      {
        operations: [operation],
        planHash: preview.planHash,
        sourceFingerprints: preview.items.map((item) => ({
          sourceAssignmentId: item.sourceAssignmentId,
          fingerprint: item.sourceFingerprint,
        })),
        confirmation: true,
        reason: 'Withdraw unsafe visit',
        idempotencyKey: 'repair-withdraw-1',
      },
      actor,
    );

    expect(tx.generatedVisit.update).toHaveBeenCalledWith({
      where: { id: visitId },
      data: { status: VisitStatus.UNASSIGNED },
    });
    expect(tx.visitUnassignedReason.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            generatedVisitId: visitId,
            code: 'CREW_CANNOT_TRAVEL',
          }),
        ],
      }),
    );
  });

  it('replays an identical idempotency key without a second transaction and rejects key reuse', async () => {
    const { service, prisma } = fixture();
    const preview = await service.preview({ operations: [replacement] });
    const request = {
      operations: [replacement],
      planHash: preview.planHash,
      sourceFingerprints: preview.items.map((item) => ({
        sourceAssignmentId: item.sourceAssignmentId,
        fingerprint: item.sourceFingerprint,
      })),
      confirmation: true,
      reason: 'Repair',
      idempotencyKey: 'same-key',
    };
    const first = await service.apply(request, actor);
    const calls = prisma.$transaction.mock.calls.length;

    await expect(service.apply(request, actor)).resolves.toEqual(first);
    expect(prisma.$transaction).toHaveBeenCalledTimes(calls);
    await expect(
      service.apply({ ...request, reason: 'Different request' }, actor),
    ).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
  });

  it('rejects plan or source drift before mutating', async () => {
    const { service, tx, row } = fixture();
    const preview = await service.preview({ operations: [replacement] });
    row.updatedAt = new Date('2027-03-01T09:00:00.000Z');

    await expect(
      service.apply(
        {
          operations: [replacement],
          planHash: preview.planHash,
          sourceFingerprints: preview.items.map((item) => ({
            sourceAssignmentId: item.sourceAssignmentId,
            fingerprint: item.sourceFingerprint,
          })),
          confirmation: true,
          reason: 'Repair',
          idempotencyKey: 'drift-key',
        },
        actor,
      ),
    ).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(tx.assignment.updateMany).not.toHaveBeenCalled();
  });

  it('leaves no committed repair result when the transaction rolls back', async () => {
    const { service, prisma } = fixture();
    const preview = await service.preview({ operations: [replacement] });
    prisma.$transaction.mockRejectedValueOnce(new Error('injected failure'));

    await expect(
      service.apply(
        {
          operations: [replacement],
          planHash: preview.planHash,
          sourceFingerprints: preview.items.map((item) => ({
            sourceAssignmentId: item.sourceAssignmentId,
            fingerprint: item.sourceFingerprint,
          })),
          confirmation: true,
          reason: 'Repair',
          idempotencyKey: 'rollback-key',
        },
        actor,
      ),
    ).rejects.toThrow('injected failure');
  });

  it('sanitizes a concurrent source-repair uniqueness conflict', async () => {
    const { service, prisma } = fixture();
    const preview = await service.preview({ operations: [replacement] });
    prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.19.3',
        meta: {
          modelName: 'PublishedAssignmentRepairItem',
          target: ['sourceAssignmentId'],
        },
      }),
    );

    await expect(
      service.apply(
        {
          operations: [replacement],
          planHash: preview.planHash,
          sourceFingerprints: preview.items.map((item) => ({
            sourceAssignmentId: item.sourceAssignmentId,
            fingerprint: item.sourceFingerprint,
          })),
          confirmation: true,
          reason: 'Repair',
          idempotencyKey: 'concurrent-source-repair',
        },
        actor,
      ),
    ).rejects.toMatchObject({
      code: 'RESOURCE_CONFLICT',
      status: 409,
    });
  });
});

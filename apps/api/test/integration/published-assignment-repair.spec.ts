import {
  AgreementStatus,
  AssignmentRepairAction,
  AssignmentStatus,
  BranchCode,
  CrewRole,
  FrequencyUnit,
  UserRole,
  VisitStatus,
} from "@prisma/client";

import { AuditService } from "../../src/audit/audit.service";
import { AuthenticatedUser } from "../../src/auth/auth.types";
import { AppException } from "../../src/common/errors/app.exception";
import { PrismaService } from "../../src/prisma/prisma.service";
import { EligibilityService } from "../../src/scheduling/eligibility/eligibility.service";
import {
  PublishedAssignmentRepairApplyInput,
  PublishedAssignmentRepairOperation,
  PublishedAssignmentRepairPreview,
  PublishedAssignmentRepairService,
} from "../../src/scheduling/repair/published-assignment-repair.service";

const prisma = new PrismaService();
const eligibility = new EligibilityService(prisma);
const audit = new AuditService(prisma);
const repairs = new PublishedAssignmentRepairService(
  prisma,
  eligibility,
  audit,
);

const suffix = Math.random().toString(36).slice(2, 10);
const fixturePrefix = `repair-pg-${suffix}`;
const actor: AuthenticatedUser = {
  id: "8c08d7ad-a385-4bbb-a0d4-7df5f365d25b",
  email: `repair-admin-${suffix}@ultrakil.test`,
  fullName: "Repair PostgreSQL Admin",
  role: UserRole.ADMIN,
};

interface RepairFixture {
  agreementId: string;
  customerId: string;
  employeeId: string;
  jobTypeId: string;
  sourceAssignmentId: string;
  visitId: string;
}

interface SqlArtifacts {
  triggerName: string;
  functionName: string;
  sequenceName: string;
}

const fixtureIds = {
  agreementIds: [] as string[],
  customerIds: [] as string[],
  employeeIds: [] as string[],
  jobTypeIds: [] as string[],
  sourceAssignmentIds: [] as string[],
  visitIds: [] as string[],
};
const activeSqlArtifacts: SqlArtifacts[] = [];
let fixtureNumber = 0;
let branchId: string;

async function createFixture(
  options: {
    reasonCode?: string;
    additionalOutboxEvent?: string;
  } = {},
): Promise<RepairFixture> {
  fixtureNumber += 1;
  const label = `${fixturePrefix}-${fixtureNumber}`;
  const visitDate = new Date(Date.UTC(2037, 0, fixtureNumber + 1));

  const employee = await prisma.employee.create({
    data: {
      sourceKey: `${label}-employee`,
      fullName: `${label} Supervisor`,
      gradeLabel: "PMS",
      isPmsGrade: true,
      branchId,
      branchCode: BranchCode.COLOMBO,
      canUsePublicTransport: true,
    },
  });
  const customer = await prisma.customer.create({
    data: {
      name: `${label} Customer`,
      branchId,
      branchCode: BranchCode.COLOMBO,
    },
  });
  const site = await prisma.serviceSite.create({
    data: {
      customerId: customer.id,
      name: `${label} Site`,
      branchId,
      branchCode: BranchCode.COLOMBO,
    },
  });
  const jobType = await prisma.jobType.create({
    data: {
      code: `REPAIR_PG_${suffix.toUpperCase()}_${fixtureNumber}`,
      name: `${label} Job`,
      defaultCrewSize: 1,
      defaultDurationMinutes: 60,
    },
  });
  const agreement = await prisma.serviceAgreement.create({
    data: {
      customerId: customer.id,
      serviceSiteId: site.id,
      jobTypeId: jobType.id,
      branchId,
      branchCode: BranchCode.COLOMBO,
      frequencyCount: 1,
      frequencyUnit: FrequencyUnit.WEEK,
      crewSize: 1,
      durationMinutes: 60,
      startDate: visitDate,
      status: AgreementStatus.ACTIVE,
    },
  });
  const visit = await prisma.generatedVisit.create({
    data: {
      serviceAgreementId: agreement.id,
      branchId,
      branchCode: BranchCode.COLOMBO,
      visitDate,
      windowStartMinute: 480,
      windowEndMinute: 1020,
      durationMinutes: 60,
      requiredCrewSize: 1,
      status: VisitStatus.SCHEDULED,
      ...(options.reasonCode
        ? {
            unassignedReasons: {
              create: {
                code: options.reasonCode,
                message: `Original ${options.reasonCode} reason`,
                details: { fixture: label },
              },
            },
          }
        : {}),
    },
  });
  const source = await prisma.assignment.create({
    data: {
      generatedVisitId: visit.id,
      branchId,
      branchCode: BranchCode.COLOMBO,
      status: AssignmentStatus.PUBLISHED,
      plannedStart: new Date(visitDate.getTime() + 600 * 60_000),
      plannedEnd: new Date(visitDate.getTime() + 660 * 60_000),
      publishedAt: new Date("2036-12-01T00:00:00.000Z"),
      crewMembers: {
        create: {
          employeeId: employee.id,
          role: CrewRole.SUPERVISOR,
          isPmsSupervisor: true,
        },
      },
      notificationOutboxEntries: {
        create: [
          {
            employeeId: employee.id,
            eventType: "assignment.published",
            payload: { fixture: label, intent: "original publication" },
          },
          ...(options.additionalOutboxEvent
            ? [
                {
                  employeeId: employee.id,
                  eventType: options.additionalOutboxEvent,
                  payload: { fixture: label, intent: "must survive repair" },
                },
              ]
            : []),
        ],
      },
    },
  });

  fixtureIds.agreementIds.push(agreement.id);
  fixtureIds.customerIds.push(customer.id);
  fixtureIds.employeeIds.push(employee.id);
  fixtureIds.jobTypeIds.push(jobType.id);
  fixtureIds.sourceAssignmentIds.push(source.id);
  fixtureIds.visitIds.push(visit.id);

  return {
    agreementId: agreement.id,
    customerId: customer.id,
    employeeId: employee.id,
    jobTypeId: jobType.id,
    sourceAssignmentId: source.id,
    visitId: visit.id,
  };
}

function replacementFor(
  fixture: RepairFixture,
): PublishedAssignmentRepairOperation {
  return {
    sourceAssignmentId: fixture.sourceAssignmentId,
    action: AssignmentRepairAction.REPLACED,
    replacement: {
      plannedStartMinute: 660,
      plannedEndMinute: 720,
      crew: [{ employeeId: fixture.employeeId, role: CrewRole.SUPERVISOR }],
      vehicles: [],
    },
  };
}

function applyInput(
  operations: PublishedAssignmentRepairOperation[],
  preview: PublishedAssignmentRepairPreview,
  idempotencyKey: string,
): PublishedAssignmentRepairApplyInput {
  return {
    operations,
    planHash: preview.planHash,
    sourceFingerprints: preview.items.map((item) => ({
      sourceAssignmentId: item.sourceAssignmentId,
      fingerprint: item.sourceFingerprint,
    })),
    confirmation: true,
    reason: "PostgreSQL transactional repair proof",
    idempotencyKey,
  };
}

async function dropSqlArtifacts(artifacts: SqlArtifacts): Promise<void> {
  await prisma.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS "${artifacts.triggerName}" ON "assignments"`,
  );
  await prisma.$executeRawUnsafe(
    `DROP FUNCTION IF EXISTS "${artifacts.functionName}"()`,
  );
  await prisma.$executeRawUnsafe(
    `DROP SEQUENCE IF EXISTS "${artifacts.sequenceName}"`,
  );
}

async function cleanupFixtures(): Promise<void> {
  for (const artifacts of activeSqlArtifacts.splice(0)) {
    await dropSqlArtifacts(artifacts);
  }

  if (fixtureIds.visitIds.length === 0) return;
  const repairItems = await prisma.publishedAssignmentRepairItem.findMany({
    where: { generatedVisitId: { in: fixtureIds.visitIds } },
    select: { repairId: true, replacementAssignmentId: true },
  });
  const repairIds = [...new Set(repairItems.map((item) => item.repairId))];
  const replacementIds = repairItems
    .map((item) => item.replacementAssignmentId)
    .filter((id): id is string => id !== null);
  const assignmentIds = [...fixtureIds.sourceAssignmentIds, ...replacementIds];

  await prisma.assignmentNotificationOutbox.deleteMany({
    where: { assignmentId: { in: assignmentIds } },
  });
  await prisma.auditEvent.deleteMany({
    where: {
      OR: [
        { entityId: { in: assignmentIds } },
        ...(repairIds.length > 0 ? [{ correlationId: { in: repairIds } }] : []),
      ],
    },
  });
  await prisma.publishedAssignmentRepairItem.deleteMany({
    where: { generatedVisitId: { in: fixtureIds.visitIds } },
  });
  await prisma.assignment.deleteMany({ where: { id: { in: replacementIds } } });
  await prisma.publishedAssignmentRepair.deleteMany({
    where: { id: { in: repairIds } },
  });
  await prisma.serviceAgreement.deleteMany({
    where: { id: { in: fixtureIds.agreementIds } },
  });
  await prisma.customer.deleteMany({
    where: { id: { in: fixtureIds.customerIds } },
  });
  await prisma.jobType.deleteMany({
    where: { id: { in: fixtureIds.jobTypeIds } },
  });
  await prisma.employee.deleteMany({
    where: { id: { in: fixtureIds.employeeIds } },
  });

  for (const ids of Object.values(fixtureIds)) ids.length = 0;
}

beforeAll(async () => {
  await prisma.$connect();
  const branch = await prisma.branch.upsert({
    where: { code: BranchCode.COLOMBO },
    create: { code: BranchCode.COLOMBO, name: "Colombo Branch" },
    update: {},
  });
  branchId = branch.id;
});

afterEach(async () => {
  await cleanupFixtures();
});

afterAll(async () => {
  await cleanupFixtures();
  await prisma.$disconnect();
});

describe("PublishedAssignmentRepairService with real PostgreSQL", () => {
  it("rolls back every row when the second item fails after the first item mutated", async () => {
    const first = await createFixture({ reasonCode: "ORIGINAL_REASON_ONE" });
    const second = await createFixture({ reasonCode: "ORIGINAL_REASON_TWO" });
    const operations = [replacementFor(first), replacementFor(second)];
    const preview = await repairs.preview({ operations });
    expect(preview.isValid).toBe(true);
    const reasonsBefore = await prisma.visitUnassignedReason.findMany({
      where: { generatedVisitId: { in: fixtureIds.visitIds } },
      orderBy: { id: "asc" },
    });
    const outboxBefore = await prisma.assignmentNotificationOutbox.findMany({
      where: {
        assignmentId: { in: fixtureIds.sourceAssignmentIds },
        eventType: "assignment.published",
      },
      orderBy: { id: "asc" },
    });

    const sqlNonce = `${suffix}_${Date.now()}`;
    const artifacts: SqlArtifacts = {
      triggerName: `repair_rollback_trigger_${sqlNonce}`,
      functionName: `repair_rollback_function_${sqlNonce}`,
      sequenceName: `repair_rollback_sequence_${sqlNonce}`,
    };
    activeSqlArtifacts.push(artifacts);

    await prisma.$executeRawUnsafe(
      `CREATE SEQUENCE "${artifacts.sequenceName}"`,
    );
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${artifacts.functionName}"() RETURNS trigger AS $$
      DECLARE mutation_number bigint;
      BEGIN
        IF OLD.status = 'PUBLISHED' AND NEW.status = 'SUPERSEDED' THEN
          mutation_number := nextval('${artifacts.sequenceName}'::regclass);
          IF mutation_number = 2 THEN
            RAISE EXCEPTION 'repair rollback injection';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${artifacts.triggerName}"
      BEFORE UPDATE ON "assignments"
      FOR EACH ROW EXECUTE FUNCTION "${artifacts.functionName}"()
    `);

    try {
      await expect(
        repairs.apply(
          applyInput(operations, preview, `rollback-${suffix}`),
          actor,
        ),
      ).rejects.toBeDefined();

      const [sequence] = await prisma.$queryRawUnsafe<
        Array<{ last_value: bigint }>
      >(`SELECT last_value FROM "${artifacts.sequenceName}"`);
      expect(Number(sequence.last_value)).toBe(2);

      expect(
        await prisma.publishedAssignmentRepair.count({
          where: { idempotencyKey: `rollback-${suffix}` },
        }),
      ).toBe(0);
      expect(
        await prisma.publishedAssignmentRepairItem.count({
          where: { sourceAssignmentId: { in: fixtureIds.sourceAssignmentIds } },
        }),
      ).toBe(0);
      expect(
        await prisma.auditEvent.count({
          where: {
            entityId: { in: fixtureIds.sourceAssignmentIds },
            action: {
              in: ["assignment.repair_replaced", "assignment.repair_withdrawn"],
            },
          },
        }),
      ).toBe(0);
      expect(
        await prisma.assignment.count({
          where: {
            supersedesAssignmentId: { in: fixtureIds.sourceAssignmentIds },
          },
        }),
      ).toBe(0);

      const sources = await prisma.assignment.findMany({
        where: { id: { in: fixtureIds.sourceAssignmentIds } },
        select: { id: true, status: true },
        orderBy: { id: "asc" },
      });
      expect(sources).toHaveLength(2);
      expect(
        sources.every((source) => source.status === AssignmentStatus.PUBLISHED),
      ).toBe(true);

      const visits = await prisma.generatedVisit.findMany({
        where: { id: { in: fixtureIds.visitIds } },
        select: { id: true, status: true },
      });
      expect(
        visits.every((visit) => visit.status === VisitStatus.SCHEDULED),
      ).toBe(true);
      expect(
        await prisma.visitUnassignedReason.findMany({
          where: { generatedVisitId: { in: fixtureIds.visitIds } },
          orderBy: { id: "asc" },
        }),
      ).toEqual(reasonsBefore);
      expect(
        await prisma.assignmentNotificationOutbox.findMany({
          where: {
            assignmentId: { in: fixtureIds.sourceAssignmentIds },
            eventType: "assignment.published",
          },
          orderBy: { id: "asc" },
        }),
      ).toEqual(outboxBefore);
      expect(
        await prisma.assignmentNotificationOutbox.count({
          where: {
            assignmentId: { in: fixtureIds.sourceAssignmentIds },
            eventType: { in: ["assignment.corrected", "assignment.withdrawn"] },
          },
        }),
      ).toBe(0);
    } finally {
      await dropSqlArtifacts(artifacts);
      activeSqlArtifacts.splice(activeSqlArtifacts.indexOf(artifacts), 1);
    }
  });

  it("allows exactly one of two genuine concurrent repairs of the same source", async () => {
    const fixture = await createFixture();
    const operations = [replacementFor(fixture)];
    const preview = await repairs.preview({ operations });
    const requests = [
      applyInput(operations, preview, `concurrent-a-${suffix}`),
      applyInput(operations, preview, `concurrent-b-${suffix}`),
    ];

    const results = await Promise.allSettled(
      requests.map((request) => repairs.apply(request, actor)),
    );
    const fulfilled = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof repairs.apply>>
      > => result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(AppException);
    expect(rejected[0].reason).toMatchObject({
      code: "RESOURCE_CONFLICT",
      status: 409,
    });
    expect((rejected[0].reason as Error).message).not.toMatch(
      /P2002|Prisma|PostgreSQL|unique constraint|database error/i,
    );

    const committedRepairs = await prisma.publishedAssignmentRepair.findMany({
      where: {
        idempotencyKey: {
          in: requests.map((request) => request.idempotencyKey),
        },
      },
      select: { id: true },
    });
    expect(committedRepairs).toHaveLength(1);
    expect(fulfilled[0].value.repairId).toBe(committedRepairs[0].id);
    expect(
      await prisma.publishedAssignmentRepairItem.count({
        where: { sourceAssignmentId: fixture.sourceAssignmentId },
      }),
    ).toBe(1);

    const successors = await prisma.assignment.findMany({
      where: { supersedesAssignmentId: fixture.sourceAssignmentId },
      select: { id: true, status: true, publishedByRepairId: true },
    });
    expect(successors).toEqual([
      {
        id: fulfilled[0].value.items[0].replacementAssignmentId,
        status: AssignmentStatus.PUBLISHED,
        publishedByRepairId: committedRepairs[0].id,
      },
    ]);
  });

  it("does not cancel an unrelated pending outbox event during a repair", async () => {
    const fixture = await createFixture({
      additionalOutboxEvent: "assignment.reminder",
    });
    const reminderBefore =
      await prisma.assignmentNotificationOutbox.findFirstOrThrow({
        where: {
          assignmentId: fixture.sourceAssignmentId,
          eventType: "assignment.reminder",
        },
      });
    const operations = [replacementFor(fixture)];
    const preview = await repairs.preview({ operations });

    const result = await repairs.apply(
      applyInput(operations, preview, `outbox-scope-${suffix}`),
      actor,
    );

    const reminderAfter =
      await prisma.assignmentNotificationOutbox.findUniqueOrThrow({
        where: { id: reminderBefore.id },
      });
    expect(reminderAfter).toEqual(reminderBefore);
    const obsoletePublication =
      await prisma.assignmentNotificationOutbox.findFirstOrThrow({
        where: {
          assignmentId: fixture.sourceAssignmentId,
          eventType: "assignment.published",
        },
        select: {
          processedAt: true,
          cancelledAt: true,
          cancelledByRepairId: true,
        },
      });
    expect(obsoletePublication).toEqual({
      processedAt: null,
      cancelledAt: expect.any(Date),
      cancelledByRepairId: result.repairId,
    });
  });

  it("enforces outbox terminal-state exclusivity under a real process-versus-cancel race", async () => {
    const fixture = await createFixture({
      additionalOutboxEvent: "assignment.terminal-race",
    });
    const terminal = await prisma.assignmentNotificationOutbox.findFirstOrThrow(
      {
        where: {
          assignmentId: fixture.sourceAssignmentId,
          eventType: "assignment.terminal-race",
        },
      },
    );
    const processedAt = new Date("2036-12-02T00:00:00.000Z");
    const cancelledAt = new Date("2036-12-03T00:00:00.000Z");

    const constraints = await prisma.$queryRaw<
      Array<{ constraint_name: string }>
    >`
      SELECT conname AS constraint_name
      FROM pg_constraint
      WHERE conrelid = 'assignment_notification_outbox'::regclass
    `;
    expect(
      constraints.map((constraint) => constraint.constraint_name),
    ).toContain("assignment_notification_outbox_terminal_state_check");

    let exclusivityFailure: unknown;
    try {
      await prisma.assignmentNotificationOutbox.update({
        where: { id: terminal.id },
        data: { processedAt, cancelledAt },
      });
    } catch (error) {
      exclusivityFailure = error;
    }
    expect(exclusivityFailure).toBeInstanceOf(Error);
    expect(
      await prisma.assignmentNotificationOutbox.findUniqueOrThrow({
        where: { id: terminal.id },
        select: { processedAt: true, cancelledAt: true },
      }),
    ).toEqual({ processedAt: null, cancelledAt: null });

    const outcomes = await Promise.all([
      prisma.assignmentNotificationOutbox.updateMany({
        where: { id: terminal.id, processedAt: null, cancelledAt: null },
        data: { processedAt },
      }),
      prisma.assignmentNotificationOutbox.updateMany({
        where: { id: terminal.id, processedAt: null, cancelledAt: null },
        data: { cancelledAt },
      }),
    ]);
    expect(outcomes.map((outcome) => outcome.count).sort()).toEqual([0, 1]);

    const finalState =
      await prisma.assignmentNotificationOutbox.findUniqueOrThrow({
        where: { id: terminal.id },
        select: { processedAt: true, cancelledAt: true },
      });
    expect(
      Number(finalState.processedAt !== null) +
        Number(finalState.cancelledAt !== null),
    ).toBe(1);
  });
});

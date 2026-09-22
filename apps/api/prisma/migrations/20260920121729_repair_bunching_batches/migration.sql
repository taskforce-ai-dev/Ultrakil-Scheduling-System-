-- CreateTable
CREATE TABLE "repair_bunching_batches" (
    "id" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "planHash" TEXT NOT NULL,
    "reason" TEXT,
    "actorUserId" TEXT NOT NULL,
    "actorLabel" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repair_bunching_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "repair_bunching_batches_idempotencyKey_key" ON "repair_bunching_batches"("idempotencyKey");

-- CreateIndex
CREATE INDEX "repair_bunching_batches_createdAt_idx" ON "repair_bunching_batches"("createdAt");

-- RenameIndex
DO $$
BEGIN
    IF to_regclass('"assignment_notification_outbox_assignmentId_employeeId_eventTyp"') IS NOT NULL
       AND to_regclass('"assignment_notification_outbox_assignmentId_employeeId_even_key"') IS NULL THEN
        ALTER INDEX "assignment_notification_outbox_assignmentId_employeeId_eventTyp"
            RENAME TO "assignment_notification_outbox_assignmentId_employeeId_even_key";
    END IF;
END $$;

-- RenameIndex
DO $$
BEGIN
    IF to_regclass('"published_assignment_repair_items_repairId_sourceAssignmentId_k"') IS NOT NULL
       AND to_regclass('"published_assignment_repair_items_repairId_sourceAssignment_key"') IS NULL THEN
        ALTER INDEX "published_assignment_repair_items_repairId_sourceAssignmentId_k"
            RENAME TO "published_assignment_repair_items_repairId_sourceAssignment_key";
    END IF;
END $$;

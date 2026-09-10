CREATE TYPE "AssignmentRepairAction" AS ENUM ('REPLACED', 'WITHDRAWN');
CREATE TYPE "PublishedAssignmentRepairCommunicationState" AS ENUM ('APPLIED_PENDING_COMMUNICATION', 'COMMUNICATION_CONFIRMED');

ALTER TABLE "assignments"
ADD COLUMN "supersedesAssignmentId" UUID,
ADD COLUMN "publishedByRepairId" UUID;

CREATE UNIQUE INDEX "assignments_supersedesAssignmentId_key"
ON "assignments"("supersedesAssignmentId");

ALTER TABLE "assignments"
ADD CONSTRAINT "assignments_supersedesAssignmentId_fkey"
FOREIGN KEY ("supersedesAssignmentId") REFERENCES "assignments"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "published_assignment_repairs" (
  "id" UUID NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "planHash" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "actorLabel" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "communicationState" "PublishedAssignmentRepairCommunicationState" NOT NULL DEFAULT 'APPLIED_PENDING_COMMUNICATION',
  "communicationConfirmedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "published_assignment_repairs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "published_assignment_repairs_idempotencyKey_key"
ON "published_assignment_repairs"("idempotencyKey");
CREATE INDEX "published_assignment_repairs_createdAt_idx"
ON "published_assignment_repairs"("createdAt");

CREATE INDEX "assignments_publishedByRepairId_idx"
ON "assignments"("publishedByRepairId");

ALTER TABLE "assignments"
ADD CONSTRAINT "assignments_publishedByRepairId_fkey"
FOREIGN KEY ("publishedByRepairId") REFERENCES "published_assignment_repairs"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "assignment_notification_outbox"
ADD COLUMN "cancelledAt" TIMESTAMP(3),
ADD COLUMN "cancelledByRepairId" UUID;

ALTER TABLE "assignment_notification_outbox"
ADD CONSTRAINT "assignment_notification_outbox_terminal_state_check"
CHECK (NOT ("processedAt" IS NOT NULL AND "cancelledAt" IS NOT NULL));

CREATE INDEX "assignment_notification_outbox_cancelledAt_idx"
ON "assignment_notification_outbox"("cancelledAt");

ALTER TABLE "assignment_notification_outbox"
ADD CONSTRAINT "assignment_notification_outbox_cancelledByRepairId_fkey"
FOREIGN KEY ("cancelledByRepairId") REFERENCES "published_assignment_repairs"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "published_assignment_repair_items" (
  "id" UUID NOT NULL,
  "repairId" UUID NOT NULL,
  "sourceAssignmentId" UUID NOT NULL,
  "replacementAssignmentId" UUID,
  "generatedVisitId" UUID NOT NULL,
  "action" "AssignmentRepairAction" NOT NULL,
  "sourceFingerprint" TEXT NOT NULL,
  "before" JSONB NOT NULL,
  "after" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "published_assignment_repair_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "published_assignment_repair_items_replacementAssignmentId_key"
ON "published_assignment_repair_items"("replacementAssignmentId");
CREATE UNIQUE INDEX "published_assignment_repair_items_repairId_sourceAssignmentId_key"
ON "published_assignment_repair_items"("repairId", "sourceAssignmentId");
CREATE UNIQUE INDEX "published_assignment_repair_items_sourceAssignmentId_key"
ON "published_assignment_repair_items"("sourceAssignmentId");
CREATE INDEX "published_assignment_repair_items_generatedVisitId_idx"
ON "published_assignment_repair_items"("generatedVisitId");

ALTER TABLE "published_assignment_repair_items"
ADD CONSTRAINT "published_assignment_repair_items_repairId_fkey"
FOREIGN KEY ("repairId") REFERENCES "published_assignment_repairs"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "published_assignment_repair_items"
ADD CONSTRAINT "published_assignment_repair_items_sourceAssignmentId_fkey"
FOREIGN KEY ("sourceAssignmentId") REFERENCES "assignments"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "published_assignment_repair_items"
ADD CONSTRAINT "published_assignment_repair_items_replacementAssignmentId_fkey"
FOREIGN KEY ("replacementAssignmentId") REFERENCES "assignments"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "published_assignment_repair_items"
ADD CONSTRAINT "published_assignment_repair_items_generatedVisitId_fkey"
FOREIGN KEY ("generatedVisitId") REFERENCES "generated_visits"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

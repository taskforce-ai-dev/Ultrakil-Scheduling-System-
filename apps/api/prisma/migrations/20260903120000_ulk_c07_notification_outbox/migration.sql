-- CreateTable
CREATE TABLE "assignment_notification_outbox" (
    "id" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "assignment_notification_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assignment_notification_outbox_processedAt_idx" ON "assignment_notification_outbox"("processedAt");

-- CreateIndex
CREATE INDEX "assignment_notification_outbox_employeeId_idx" ON "assignment_notification_outbox"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "assignment_notification_outbox_assignmentId_employeeId_eventType_key" ON "assignment_notification_outbox"("assignmentId", "employeeId", "eventType");

-- AddForeignKey
ALTER TABLE "assignment_notification_outbox" ADD CONSTRAINT "assignment_notification_outbox_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_notification_outbox" ADD CONSTRAINT "assignment_notification_outbox_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

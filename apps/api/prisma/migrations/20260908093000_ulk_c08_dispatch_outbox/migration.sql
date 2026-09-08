CREATE TYPE "ScheduleRunDispatchProvider" AS ENUM ('BULLMQ', 'QSTASH');
CREATE TYPE "ScheduleRunDispatchStatus" AS ENUM ('PENDING', 'PUBLISHED', 'CANCELLED');

CREATE TABLE "schedule_run_dispatch_outbox" (
  "id" UUID NOT NULL,
  "scheduleRunId" UUID NOT NULL,
  "provider" "ScheduleRunDispatchProvider" NOT NULL,
  "status" "ScheduleRunDispatchStatus" NOT NULL DEFAULT 'PENDING',
  "messageId" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt" TIMESTAMP(3),
  "lastError" TEXT,
  "terminalFailureMessageId" TEXT,
  "terminalFailureCode" TEXT,
  "terminalFailureMessage" TEXT,
  "terminalFailureAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "schedule_run_dispatch_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "schedule_run_dispatch_outbox_scheduleRunId_key"
ON "schedule_run_dispatch_outbox"("scheduleRunId");
CREATE INDEX "schedule_run_dispatch_outbox_status_updatedAt_idx"
ON "schedule_run_dispatch_outbox"("status", "updatedAt");

ALTER TABLE "schedule_run_dispatch_outbox"
ADD CONSTRAINT "schedule_run_dispatch_outbox_scheduleRunId_fkey"
FOREIGN KEY ("scheduleRunId") REFERENCES "schedule_runs"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

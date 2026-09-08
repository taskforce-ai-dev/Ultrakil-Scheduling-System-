-- Make at-least-once HTTP queue delivery safe without changing the public
-- schedule-run API. The lease is authoritative for all worker-owned writes.
ALTER TABLE "schedule_runs"
ADD COLUMN "timeLimitSeconds" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN "executionLeaseId" UUID,
ADD COLUMN "executionLeaseExpiresAt" TIMESTAMP(3),
ADD COLUMN "executionAttempt" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "schedule_runs_executionLeaseExpiresAt_idx"
ON "schedule_runs"("executionLeaseExpiresAt");

-- CreateEnum
CREATE TYPE "RepairBunchingStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'FAILED');

-- AlterTable
--
-- The key is claimed before the first move, so a row now exists while the
-- apply is still running. Existing rows were only ever written after every
-- move had landed, which is exactly COMPLETED.
ALTER TABLE "repair_bunching_batches"
    ADD COLUMN "status" "RepairBunchingStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    ADD COLUMN "appliedMoves" JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN "failureReason" TEXT,
    ADD COLUMN "completedAt" TIMESTAMP(3);

UPDATE "repair_bunching_batches"
   SET "status" = 'COMPLETED',
       "completedAt" = "createdAt";

ALTER TABLE "repair_bunching_batches" ALTER COLUMN "result" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "repair_bunching_batches_status_idx" ON "repair_bunching_batches"("status");

-- AlterEnum
ALTER TYPE "AssignmentStatus" ADD VALUE 'SUPERSEDED';

-- AlterEnum
ALTER TYPE "LockScope" ADD VALUE 'SUPERVISOR';

-- AlterEnum
ALTER TYPE "ScheduleRunStatus" ADD VALUE 'SUPERSEDED';

-- AlterTable
ALTER TABLE "schedule_runs" ADD COLUMN     "cancelRequestedAt" TIMESTAMP(3),
ADD COLUMN     "jobId" TEXT,
ADD COLUMN     "progressPercent" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "publishedByUserId" TEXT,
ADD COLUMN     "supersededByRunId" UUID;

-- AddForeignKey
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_supersededByRunId_fkey" FOREIGN KEY ("supersededByRunId") REFERENCES "schedule_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "DayCoverageState" AS ENUM ('IN_PROGRESS', 'NOTHING_DUE', 'AWAITING_GENERATION', 'COVERED_PUBLISHED', 'PREPARED_AWAITING_MANAGER', 'SHORTFALL', 'STALE', 'FAILED');

-- CreateTable
CREATE TABLE "day_coverage" (
    "id" UUID NOT NULL,
    "branchCode" "BranchCode" NOT NULL,
    "coverageDate" DATE NOT NULL,
    "state" "DayCoverageState" NOT NULL DEFAULT 'IN_PROGRESS',
    "visitsDue" INTEGER NOT NULL DEFAULT 0,
    "visitsStaffed" INTEGER NOT NULL DEFAULT 0,
    "demandDigest" TEXT,
    "supplyDigest" TEXT,
    "scheduleRunId" UUID,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimExpiresAt" TIMESTAMP(3) NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "claimToken" UUID,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "day_coverage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "day_coverage_shortfalls" (
    "id" UUID NOT NULL,
    "dayCoverageId" UUID NOT NULL,
    "generatedVisitId" UUID NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "day_coverage_shortfalls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "day_coverage_coverageDate_state_idx" ON "day_coverage"("coverageDate", "state");

-- CreateIndex
CREATE INDEX "day_coverage_state_claimExpiresAt_idx" ON "day_coverage"("state", "claimExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "day_coverage_branchCode_coverageDate_key" ON "day_coverage"("branchCode", "coverageDate");

-- CreateIndex
CREATE INDEX "day_coverage_shortfalls_generatedVisitId_idx" ON "day_coverage_shortfalls"("generatedVisitId");

-- CreateIndex
CREATE UNIQUE INDEX "day_coverage_shortfalls_dayCoverageId_generatedVisitId_reas_key" ON "day_coverage_shortfalls"("dayCoverageId", "generatedVisitId", "reasonCode");

-- AddForeignKey
ALTER TABLE "day_coverage" ADD CONSTRAINT "day_coverage_scheduleRunId_fkey" FOREIGN KEY ("scheduleRunId") REFERENCES "schedule_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "day_coverage_shortfalls" ADD CONSTRAINT "day_coverage_shortfalls_dayCoverageId_fkey" FOREIGN KEY ("dayCoverageId") REFERENCES "day_coverage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "day_coverage_shortfalls" ADD CONSTRAINT "day_coverage_shortfalls_generatedVisitId_fkey" FOREIGN KEY ("generatedVisitId") REFERENCES "generated_visits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

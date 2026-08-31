-- AlterTable
ALTER TABLE "generated_visits" ADD COLUMN     "isManuallyAdjusted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lockReason" TEXT,
ADD COLUMN     "lockedAt" TIMESTAMP(3),
ADD COLUMN     "lockedByUserId" TEXT,
ADD COLUMN     "manuallyAdjustedAt" TIMESTAMP(3),
ADD COLUMN     "manuallyAdjustedBy" TEXT;

-- CreateIndex
CREATE INDEX "generated_visits_serviceAgreementId_visitDate_idx" ON "generated_visits"("serviceAgreementId", "visitDate");

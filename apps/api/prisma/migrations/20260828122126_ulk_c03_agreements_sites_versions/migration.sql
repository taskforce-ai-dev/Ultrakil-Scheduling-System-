/*
  Warnings:

  - You are about to drop the column `isActive` on the `service_agreements` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "AgreementStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

-- DropIndex
DROP INDEX "service_agreements_branchId_isActive_idx";

-- DropIndex
DROP INDEX "site_operating_hours_serviceSiteId_weekday_key";

-- AlterTable
ALTER TABLE "generated_visits" ADD COLUMN     "agreementVersionId" UUID;

-- AlterTable
ALTER TABLE "service_agreements" DROP COLUMN "isActive",
ADD COLUMN     "currentVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "status" "AgreementStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateTable
CREATE TABLE "service_agreement_required_skills" (
    "id" UUID NOT NULL,
    "serviceAgreementId" UUID NOT NULL,
    "skillCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_agreement_required_skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_agreement_versions" (
    "id" UUID NOT NULL,
    "serviceAgreementId" UUID NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changedByUserId" TEXT,
    "changedByLabel" TEXT,
    "changeSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_agreement_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_agreement_required_skills_skillCode_idx" ON "service_agreement_required_skills"("skillCode");

-- CreateIndex
CREATE UNIQUE INDEX "service_agreement_required_skills_serviceAgreementId_skillC_key" ON "service_agreement_required_skills"("serviceAgreementId", "skillCode");

-- CreateIndex
CREATE INDEX "service_agreement_versions_serviceAgreementId_createdAt_idx" ON "service_agreement_versions"("serviceAgreementId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "service_agreement_versions_serviceAgreementId_versionNumber_key" ON "service_agreement_versions"("serviceAgreementId", "versionNumber");

-- CreateIndex
CREATE INDEX "service_agreements_branchId_status_idx" ON "service_agreements"("branchId", "status");

-- CreateIndex
CREATE INDEX "site_operating_hours_serviceSiteId_weekday_idx" ON "site_operating_hours"("serviceSiteId", "weekday");

-- AddForeignKey
ALTER TABLE "service_agreement_required_skills" ADD CONSTRAINT "service_agreement_required_skills_serviceAgreementId_fkey" FOREIGN KEY ("serviceAgreementId") REFERENCES "service_agreements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_agreement_versions" ADD CONSTRAINT "service_agreement_versions_serviceAgreementId_fkey" FOREIGN KEY ("serviceAgreementId") REFERENCES "service_agreements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_visits" ADD CONSTRAINT "generated_visits_agreementVersionId_fkey" FOREIGN KEY ("agreementVersionId") REFERENCES "service_agreement_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

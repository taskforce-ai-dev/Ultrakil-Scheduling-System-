-- Additive source-data provenance. Existing rows are deliberately UNKNOWN:
-- a migration must not retrospectively present old values as manager-confirmed.
CREATE TYPE "SiteBranchConfidence" AS ENUM ('MATCHED', 'UNCERTAIN', 'CONFIRMED');
CREATE TYPE "SiteBranchSource" AS ENUM ('ADDRESS_MATCH', 'FALLBACK_DEFAULT', 'MANAGER_CONFIRMED');
CREATE TYPE "DataProvenance" AS ENUM ('UNKNOWN', 'SOURCE', 'DERIVED', 'DEFAULTED', 'MANAGER_CONFIRMED');

ALTER TABLE "vehicles" ADD COLUMN "ownershipGroup" TEXT;

ALTER TABLE "service_sites"
  ADD COLUMN "branchConfidence" "SiteBranchConfidence" NOT NULL DEFAULT 'UNCERTAIN',
  ADD COLUMN "branchSource" "SiteBranchSource" NOT NULL DEFAULT 'FALLBACK_DEFAULT';

ALTER TABLE "site_operating_hours"
  ADD COLUMN "provenance" "DataProvenance" NOT NULL DEFAULT 'MANAGER_CONFIRMED';

ALTER TABLE "service_agreements"
  ADD COLUMN "crewSizeProvenance" "DataProvenance" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "durationProvenance" "DataProvenance" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "dayRuleProvenance" "DataProvenance" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "importedInactiveAt" TIMESTAMP(3);

ALTER TABLE "generated_visits"
  ADD COLUMN "windowProvenance" "DataProvenance" NOT NULL DEFAULT 'UNKNOWN';

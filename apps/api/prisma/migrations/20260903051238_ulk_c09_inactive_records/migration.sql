-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "importedInactiveAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "service_sites" ADD COLUMN     "importedInactiveAt" TIMESTAMP(3);

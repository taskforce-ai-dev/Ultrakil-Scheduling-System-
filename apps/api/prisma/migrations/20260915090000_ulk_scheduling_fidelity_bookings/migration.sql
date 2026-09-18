-- Booked visit dates from the master schedule workbook, and the record of why
-- each generated visit sits where it does. Both additive: no existing column
-- changes meaning, and existing visits take EARLIEST because that is exactly
-- how they were placed.

CREATE TYPE "VisitPlacement" AS ENUM ('BOOKED', 'ANCHORED', 'SPREAD', 'EARLIEST');

CREATE TABLE "service_agreement_bookings" (
    "id" UUID NOT NULL,
    "serviceAgreementId" UUID NOT NULL,
    "bookedDate" DATE NOT NULL,
    "provenance" "DataProvenance" NOT NULL DEFAULT 'SOURCE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_agreement_bookings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "service_agreement_bookings_serviceAgreementId_idx"
  ON "service_agreement_bookings"("serviceAgreementId");

CREATE UNIQUE INDEX "service_agreement_bookings_serviceAgreementId_bookedDate_key"
  ON "service_agreement_bookings"("serviceAgreementId", "bookedDate");

ALTER TABLE "service_agreement_bookings"
  ADD CONSTRAINT "service_agreement_bookings_serviceAgreementId_fkey"
  FOREIGN KEY ("serviceAgreementId") REFERENCES "service_agreements"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "generated_visits"
  ADD COLUMN "placement" "VisitPlacement" NOT NULL DEFAULT 'EARLIEST';

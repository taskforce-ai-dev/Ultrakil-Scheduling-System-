-- The daily load guard reads every visit standing in a branch's horizon on
-- every generation run, filtering by branch code and visit date. The existing
-- indexes are on branchId or serviceAgreementId, neither of which that query
-- can use, so it was a sequential scan of the whole table per run.
--
-- Additive: an index only. No column or constraint changes meaning.

CREATE INDEX "generated_visits_branchCode_visitDate_idx"
  ON "generated_visits"("branchCode", "visitDate");

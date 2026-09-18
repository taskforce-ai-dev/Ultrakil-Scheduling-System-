/**
 * The branch filter, worded once.
 *
 * Seven screens carry the same control and it was labelled three different
 * ways: "Both branches" on five of them, an option reading "All branches" on
 * two, and — on those same two, which had no value-to-label map — a trigger
 * showing the raw "ALL". The same filter has to be recognisable as the same
 * filter from one screen to the next.
 *
 * "All branches" rather than "Both": the pilot runs two, but nothing in the
 * data model says there will only ever be two, and a label that becomes a lie
 * the day a third branch opens is a label to avoid writing.
 */

export type BranchFilter = "ALL" | "COLOMBO" | "KANDY";

export const BRANCH_FILTER_LABELS: Record<BranchFilter, string> = {
  ALL: "All branches",
  COLOMBO: "Colombo",
  KANDY: "Kandy",
};

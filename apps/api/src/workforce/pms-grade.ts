/**
 * PMS-grade recognition.
 *
 * Project rule: every scheduled job requires at least one PMS-grade supervisor,
 * where PMS-grade means Senior PMS, PMS, Assistant PMS, SPMS or APMS.
 *
 * The workforce matrix is maintained by hand, so grade cells vary in spacing,
 * casing and punctuation. We normalise for those, but we deliberately do NOT
 * guess at unfamiliar grade names: an unrecognised grade is treated as
 * non-supervisory and reported by the importer so a human can decide. Silently
 * promoting an unknown grade to supervisor would weaken a hard rule.
 */

/** Canonical grade labels, in the wording used by the project rules. */
export const PMS_GRADE_LABELS = [
  'Senior PMS',
  'PMS',
  'Assistant PMS',
  'SPMS',
  'APMS',
] as const;

export type PmsGradeLabel = (typeof PMS_GRADE_LABELS)[number];

/**
 * Normalised spellings that map to a PMS grade. Only additions agreed with the
 * client belong here — never a guess.
 */
const PMS_GRADE_ALIASES = new Set<string>([
  'SENIOR PMS',
  'SENIOR P M S',
  'SR PMS',
  'PMS',
  'ASSISTANT PMS',
  'ASST PMS',
  'APMS',
  'SPMS',
]);

/**
 * Upper-cases, strips punctuation and collapses whitespace, so that
 * "Sr. PMS", "sr  pms" and "SR PMS" all compare equal.
 */
export function normalizeGradeLabel(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/[._\-/\\()]+/g, ' ')
    .replace(/[^A-Za-z0-9 ]+/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

/** True when the source grade label is one of the PMS supervisor grades. */
export function isPmsGradeLabel(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return PMS_GRADE_ALIASES.has(normalizeGradeLabel(raw));
}

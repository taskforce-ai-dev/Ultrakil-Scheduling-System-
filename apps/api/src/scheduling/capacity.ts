/**
 * A branch-day's capacity is spent in crew-minutes, not in a count of visits.
 *
 * A raw visit count treats a fifteen-minute one-person check the same as a
 * four-hour four-person job — the flaw the Technical Director's review named
 * directly: the source workbook itself has a fifteen-job day nothing is
 * wrong with, and a count-based cap could not tell that day apart from one
 * that genuinely overruns its crews. Crew-minutes can: it is the same
 * quantity a crew's own day is measured in, so two visits that together cost
 * a crew an hour cost a branch the same whether they are one visit or four.
 */
export function crewMinutesOf(visit: {
  durationMinutes: number;
  requiredCrewSize: number;
}): number {
  return visit.durationMinutes * visit.requiredCrewSize;
}

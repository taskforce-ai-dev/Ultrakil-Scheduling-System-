import { formatMinuteOfDay } from "@/lib/calendar";
import type { VisitStatus } from "@/lib/api-client";

/**
 * The facts a calendar tile is allowed to say about a visit.
 *
 * Two screens draw one of these — the Visit Calendar (`/visits`, reading
 * visits) and the unified Calendar (`calendar-board`, reading the calendar
 * read model) — from two different payloads. They drifted apart once already:
 * a fix landed on one and not the other, and for a fortnight the same visit
 * had two different start times depending on which screen a coordinator
 * happened to open. The wording lives here now, so there is only one answer
 * to give.
 */
export interface VisitTileFacts {
  customerName: string;
  /** YYYY-MM-DD. */
  visitDate: string;
  durationMinutes: number;
  /**
   * When the crew is actually due, from the assignment. Null when nobody is
   * assigned — and never the service window, which is only the span the visit
   * has to fall inside. A site with no recorded hours gets a defaulted
   * 08:00-17:00 window; printed as a start time that reads as "the crew
   * arrives at 08:00" for every visit on the day, and on this dataset nine
   * tiles in twelve would have been wrong, one of them by six and a half
   * hours.
   */
  plannedStartMinute: number | null;
  plannedEndMinute: number | null;
  /**
   * The span the visit has to fall inside. Used to order a day's tiles when
   * nothing has been planned yet, and for nothing else — it is a constraint,
   * never a time to show a manager.
   */
  windowStartMinute: number;
  /** People on the visit right now. Zero when nobody is assigned. */
  crewCount: number;
}

/** Whether anyone has decided when this visit actually happens. */
export function isVisitTimeDecided(facts: VisitTileFacts): boolean {
  return facts.plannedStartMinute !== null && facts.plannedEndMinute !== null;
}

/**
 * When the crew is there, or an honest statement that nobody has decided yet.
 *
 * Without an assignment the tile says how long the work takes and that its
 * hour is undecided; it does not invent one.
 */
export function visitTileTime(facts: VisitTileFacts): string {
  if (!isVisitTimeDecided(facts)) return `${facts.durationMinutes} min · time not set`;
  return `${formatMinuteOfDay(facts.plannedStartMinute as number)}–${formatMinuteOfDay(
    facts.plannedEndMinute as number,
  )}`;
}

/** The word "No crew", said rather than left blank. */
export const NO_CREW_LABEL = "No crew";

/** The next operational stage for an unstaffed visit, without changing its API status. */
export function unstaffedVisitStage(status: VisitStatus): string | null {
  if (status === "PENDING") return "Planning stage";
  if (status === "UNASSIGNED") return "Assignment required";
  return null;
}

/**
 * Spoken as a sentence in both cases: "at 60 min · time not set on
 * 2026-09-21" is not one, and the unstaffed tile is the one a screen reader
 * user most needs to understand.
 *
 * `stage` is whatever the screen colour-codes by, appended in its own words.
 */
export function visitTileAccessibleName(facts: VisitTileFacts, stage?: string): string {
  const tail = stage ? `, ${stage}` : "";
  if (isVisitTimeDecided(facts)) {
    return `${facts.customerName} at ${visitTileTime(facts)} on ${facts.visitDate}${tail}`;
  }
  const crew = facts.crewCount > 0 ? `${facts.crewCount} crew` : "no crew";
  return `${facts.customerName} on ${facts.visitDate}, ${facts.durationMinutes} minutes, time not set, ${crew}${tail}`;
}

/**
 * How a day's tiles are ordered.
 *
 * By the hour the crew is due; and for a visit where nobody has decided one,
 * by the window it has to fall inside — the only ordering fact available,
 * used here and never shown. Ties break on the customer's name so the same
 * day always renders the same way whatever order the server returned.
 */
export function compareVisitTiles(left: VisitTileFacts, right: VisitTileFacts): number {
  const leftStart = left.plannedStartMinute ?? left.windowStartMinute;
  const rightStart = right.plannedStartMinute ?? right.windowStartMinute;
  if (leftStart !== rightStart) return leftStart - rightStart;
  return left.customerName.localeCompare(right.customerName);
}

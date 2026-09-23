import { Lock, PencilLine, Sparkles, UserCheck, UserX } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { Visit, VisitStatus } from "@/lib/api-client";

/**
 * How a visit's state is shown, in one place.
 *
 * Two rules drive every choice here.
 *
 * A visit carries *two independent facts*: what stage it has reached
 * (`status`), and whether a person has taken ownership of it (locked or
 * hand-edited). They are separate badges because a visit can be both — a
 * locked visit that is still unassigned is the normal case right after
 * generation, and collapsing them into one label would hide it.
 *
 * And nothing here may suggest a visit is staffed before an assignment
 * exists. `SCHEDULED` is the API's word for "has a crew"; every other status
 * gets the explicit "No crew yet" marker rather than neutral silence, because
 * silence on a calendar reads as "fine".
 */

/**
 * One word per status, used by every screen that names one.
 *
 * "Unassigned" is not among them any more, and deliberately. It was the API's
 * word for "the scheduler tried to staff this visit and could not", while the
 * calendar also said "no crew assigned yet" for the broader fact — every visit
 * without a crew, PENDING ones nobody has tried to staff included. A manager
 * filtering by the obvious word lost the untried visits and went home
 * believing the month was covered. The two facts now have two names.
 */
export const VISIT_STATUS_LABEL: Record<VisitStatus, string> = {
  PENDING: "Planned",
  UNASSIGNED: "Action required",
  SCHEDULED: "Crew assigned",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

type BadgeVariant = React.ComponentProps<typeof Badge>["variant"];

const STATUS_VARIANT: Record<VisitStatus, BadgeVariant> = {
  PENDING: "outline",
  UNASSIGNED: "outline",
  SCHEDULED: "success",
  COMPLETED: "secondary",
  CANCELLED: "destructive",
};

export function VisitStatusBadge({ status }: { status: VisitStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{VISIT_STATUS_LABEL[status]}</Badge>;
}

/**
 * Says in words whether anyone is actually going. Rendered for every visit,
 * not only the staffed ones — a manager scanning a month must never read an
 * unstaffed visit as covered.
 */
export function CrewBadge({ visit }: { visit: Visit }) {
  // People, not assignment records. `assignmentCount` counts the latter — one
  // record holds a whole crew — so a two-person job badged "1 crew member"
  // beside a dispatch row naming both of them.
  if (visit.assignedCrewCount > 0) {
    return (
      <Badge variant="success">
        <UserCheck aria-hidden="true" />
        {visit.assignedCrewCount === 1 ? "1 crew member" : `${visit.assignedCrewCount} crew`}
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="text-muted-foreground">
      <UserX aria-hidden="true" />
      No crew yet
    </Badge>
  );
}

/**
 * Who owns this row: generation, or a person. "Generated" is stated rather
 * than left blank so that "nobody has touched this, the next run may move it"
 * is visible, not merely implied by the absence of anything else.
 */
export function VisitOwnershipBadges({ visit }: { visit: Visit }) {
  const owned: React.ReactNode[] = [];

  if (visit.isLocked) {
    owned.push(
      <Badge key="locked" variant="default">
        <Lock aria-hidden="true" />
        Locked
      </Badge>
    );
  }

  if (visit.isManuallyAdjusted) {
    owned.push(
      <Badge key="adjusted" variant="secondary">
        <PencilLine aria-hidden="true" />
        Manually modified
      </Badge>
    );
  }

  if (owned.length === 0) {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        <Sparkles aria-hidden="true" />
        Generated
      </Badge>
    );
  }

  return <>{owned}</>;
}


/** Plain-language reason regeneration will skip a visit. */
export const PROTECTION_LABEL: Record<string, string> = {
  LOCKED: "Locked by a manager",
  MANUALLY_ADJUSTED: "Modified by hand",
  HAS_ASSIGNMENT: "A crew is already assigned",
  ALREADY_SCHEDULED: "Already scheduled",
  ALREADY_COMPLETED: "Already completed",
  CANCELLED: "Cancelled",
};

export function protectionLabel(reason: string | null): string | null {
  if (!reason) return null;
  return PROTECTION_LABEL[reason] ?? reason;
}

/**
 * Plain-language reason a visit sits on the date it does.
 *
 * The API decides the placement; this only puts it into words. A manager
 * asking "why is this on the 17th?" needs to know first of all whether the
 * date is a commitment to the customer or the system's own choice.
 */
export const PLACEMENT_LABEL: Record<string, string> = {
  BOOKED: "Booked with the customer",
  ANCHORED: "Near this site's usual day",
  SPREAD: "Moved off a day that was full",
  EARLIEST: "First allowed day of the period",
};

/**
 * A reason the API added after this build shipped still has to read as
 * English. Showing the raw enum puts SPREAD_BY_REGION in front of a manager as
 * though it were a sentence; "Placed by the generator" is true of every
 * placement the API can invent, and says the one thing the label exists to
 * say — that a person did not choose this date.
 */
const UNKNOWN_PLACEMENT_LABEL = "Placed by the generator";

export function placementLabel(placement: string | null): string | null {
  if (!placement) return null;
  return PLACEMENT_LABEL[placement] ?? UNKNOWN_PLACEMENT_LABEL;
}

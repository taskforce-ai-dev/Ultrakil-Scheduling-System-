import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { CrewBadge, VisitStatusBadge } from "@/components/shared/visit-badges";
import { buildVisit } from "@/test/fixtures";

/**
 * One truth about how many people are on a visit.
 *
 * The badge read `assignmentCount` — the number of assignment *records* — and
 * called it crew. A visit whose single assignment carried two people badged
 * "1 crew member" beside a dispatch row naming both of them and a calendar
 * tile badging 2, so a fully staffed job read as a man short.
 */
describe("CrewBadge", () => {
  it("counts the people on the visit, not the records holding them", () => {
    render(<CrewBadge visit={buildVisit({ assignmentCount: 1, assignedCrewCount: 2 })} />);

    expect(screen.getByText("2 crew")).toBeInTheDocument();
  });

  it("says one crew member when exactly one person is going", () => {
    render(<CrewBadge visit={buildVisit({ assignmentCount: 1, assignedCrewCount: 1 })} />);

    expect(screen.getByText("1 crew member")).toBeInTheDocument();
  });

  it("says no crew yet when nobody is going, whatever history the visit has", () => {
    // Superseded and cancelled assignments are records, not people.
    render(<CrewBadge visit={buildVisit({ assignmentCount: 3, assignedCrewCount: 0 })} />);

    expect(screen.getByText("No crew yet")).toBeInTheDocument();
  });
});

describe("VisitStatusBadge", () => {
  it("uses calm, actionable labels for planned and assignment-required visits", () => {
    const { rerender } = render(<VisitStatusBadge status="PENDING" />);

    expect(screen.getByText("Planned")).toBeInTheDocument();
    expect(screen.queryByText(/awaiting staffing|staffing failed|no crew yet/i)).not.toBeInTheDocument();

    rerender(<VisitStatusBadge status="UNASSIGNED" />);

    expect(screen.getByText("Action required")).toBeInTheDocument();
    expect(screen.queryByText(/awaiting staffing|staffing failed|no crew yet/i)).not.toBeInTheDocument();
  });
});

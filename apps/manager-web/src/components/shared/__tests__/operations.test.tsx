import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { OperationsDayPanel } from "@/components/shared/operations";
import { parseOperationsDay } from "@/lib/api-client";

const day = parseOperationsDay({
  date: "2026-09-10",
  summary: { total: 3, ready: 1, proposed: 1, unassigned: 0, exceptions: 1, hoursUnconfirmed: 1 },
  items: [
    {
      visit: { id: "ready", customerName: "Ready customer", siteName: "Site", jobTypeName: "Job", requiredCrewSize: 2, windowStartMinute: 480, windowEndMinute: 1020, hoursUnconfirmed: false },
      state: "READY",
      dispatchAssignment: { id: "ready-published", status: "PUBLISHED", crew: [{ fullName: "A Perera" }], vehicles: [] },
      proposedAssignment: null,
      violations: [],
      warnings: [],
      nextAction: "No action needed",
      scheduleVersion: { status: "PUBLISHED" },
    },
    {
      visit: { id: "draft", customerName: "Draft customer", siteName: "Site", jobTypeName: "Job", requiredCrewSize: 2, windowStartMinute: 480, windowEndMinute: 1020, hoursUnconfirmed: true },
      state: "PROPOSED",
      dispatchAssignment: null,
      proposedAssignment: { id: "draft-proposal", status: "DRAFT", crew: [{ fullName: "Draft person" }], vehicles: [] },
      violations: [],
      warnings: [{ code: "HOURS_UNCONFIRMED", message: "Hours are assumed or unconfirmed" }],
      nextAction: "Review and publish",
      scheduleVersion: { status: "DRAFT" },
    },
    {
      visit: { id: "exception", customerName: "Exception customer", siteName: "Site", jobTypeName: "Job", requiredCrewSize: 2, windowStartMinute: 480, windowEndMinute: 1020, hoursUnconfirmed: false },
      state: "EXCEPTION",
      dispatchAssignment: { id: "invalid-published", status: "PUBLISHED", crew: [{ fullName: "Published invalid person" }], vehicles: [] },
      proposedAssignment: null,
      violations: [{ code: "UNKNOWN_BRANCH", message: "Branch needs confirmation" }],
      warnings: [],
      nextAction: "Confirm branch",
      scheduleVersion: { status: "PUBLISHED" },
    },
  ],
});

describe("OperationsDayPanel", () => {
  it("shows published assignment history with a repair successor and mixed provenance", () => {
    const repaired = parseOperationsDay({
      date: "2026-09-10",
      items: [{
        visit: { id: "repair-visit", customerName: "Repair customer" },
        state: "READY",
        dispatchAssignment: { id: "repair-successor", status: "PUBLISHED", crew: [], vehicles: [] },
        proposedAssignment: null,
        violations: [],
        warnings: [],
        nextAction: "Dispatch the published assignment.",
        publishedAssignmentLineage: {
          hasMixedProvenance: true,
          entries: [
            { assignmentId: "original", status: "SUPERSEDED", supersedesAssignmentId: null, publishedByRepairId: null, provenance: "SCHEDULE_RUN", publishedAt: "2026-09-09T08:00:00.000Z" },
            { assignmentId: "repair-successor", status: "PUBLISHED", supersedesAssignmentId: "original", publishedByRepairId: "repair-1", provenance: "REPAIR", publishedAt: "2026-09-10T08:00:00.000Z" },
          ],
        },
      }],
    });

    render(<OperationsDayPanel data={repaired} />);

    const item = screen.getByText("Repair customer").closest("li")!;
    expect(within(item).getByText("Published assignment history")).toBeInTheDocument();
    expect(within(item).getByText(/Mixed scheduled and repair versions/)).toBeInTheDocument();
    expect(within(item).getByText(/Version 1.*Superseded.*Scheduled run/)).toBeInTheDocument();
    expect(within(item).getByText(/Version 2.*Published.*Repair.*supersedes original/)).toBeInTheDocument();
  });

  it("labels proposals and exceptions without calling them assigned", () => {
    render(<OperationsDayPanel data={day} />);

    expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Proposed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Exception").length).toBeGreaterThan(0);
    expect(screen.getByText("Draft assignment — not dispatched")).toBeInTheDocument();
    expect(screen.getByText("Assignment needs review — not dispatchable")).toBeInTheDocument();
    expect(screen.getByText("Hours are assumed or unconfirmed")).toBeInTheDocument();
    const exception = screen.getByText("Exception customer").closest("li")!;
    expect(within(exception).getByText("Crew: Published invalid person")).toBeInTheDocument();
    expect(within(exception).queryByText("Crew assigned")).not.toBeInTheDocument();
  });

  it("shows the server summary and a concrete next action", () => {
    render(<OperationsDayPanel data={day} />);

    expect(screen.getByRole("heading", { name: "Operational queues" })).toBeInTheDocument();
    expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
    const exception = screen.getByText("Exception customer").closest("li")!;
    expect(within(exception).getByText("Confirm branch")).toBeInTheDocument();
    expect(within(exception).queryByText(/Published schedule version/)).not.toBeInTheDocument();
  });

  it("keeps the published crew visible after a visit is completed", () => {
    const completed = parseOperationsDay({
      date: "2026-09-10",
      items: [
        {
          visit: { id: "completed", customerName: "Completed customer" },
          state: "COMPLETED",
          dispatchAssignment: { id: "completed-published", status: "COMPLETED", crew: [{ fullName: "Completed crew" }], vehicles: [] },
          proposedAssignment: null,
          violations: [],
          warnings: [],
          nextAction: "No action needed",
        },
      ],
    });

    render(<OperationsDayPanel data={completed} />);

    const item = screen.getByText("Completed customer").closest("li")!;
    expect(within(item).getByText("Completed assignment")).toBeInTheDocument();
    expect(within(item).getByText("Crew: Completed crew")).toBeInTheDocument();
  });

  it("keeps acknowledged published work labelled as dispatch truth", () => {
    const acknowledged = parseOperationsDay({
      date: "2026-09-10",
      items: [{
        visit: { id: "acknowledged", customerName: "Acknowledged customer" },
        state: "READY",
        dispatchAssignment: {
          id: "acknowledged-published",
          status: "ACKNOWLEDGED",
          crew: [{ fullName: "Acknowledged crew" }],
          vehicles: [],
        },
        proposedAssignment: null,
        violations: [],
        warnings: [],
        nextAction: "Dispatch the published assignment.",
        scheduleVersion: { id: "run-1", status: "ACKNOWLEDGED", publishedAt: "2026-09-10T08:00:00.000Z" },
      }],
    });

    render(<OperationsDayPanel data={acknowledged} />);

    const item = screen.getByText("Acknowledged customer").closest("li")!;
    expect(within(item).getByText("Crew assigned")).toBeInTheDocument();
    expect(within(item).queryByText(/schedule version/)).not.toBeInTheDocument();
  });
});

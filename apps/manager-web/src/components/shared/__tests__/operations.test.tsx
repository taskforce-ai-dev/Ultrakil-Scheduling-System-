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
      dispatchAssignment: { crew: [{ fullName: "A Perera" }], vehicles: [] },
      proposedAssignment: null,
      violations: [],
      nextAction: "No action needed",
      scheduleVersion: { status: "PUBLISHED" },
    },
    {
      visit: { id: "draft", customerName: "Draft customer", siteName: "Site", jobTypeName: "Job", requiredCrewSize: 2, windowStartMinute: 480, windowEndMinute: 1020, hoursUnconfirmed: true },
      state: "PROPOSED",
      dispatchAssignment: null,
      proposedAssignment: { crew: [{ fullName: "Draft person" }], vehicles: [] },
      violations: [],
      nextAction: "Review and publish",
      scheduleVersion: { status: "DRAFT" },
    },
    {
      visit: { id: "exception", customerName: "Exception customer", siteName: "Site", jobTypeName: "Job", requiredCrewSize: 2, windowStartMinute: 480, windowEndMinute: 1020, hoursUnconfirmed: false },
      state: "EXCEPTION",
      dispatchAssignment: { crew: [{ fullName: "Invalid person" }], vehicles: [] },
      proposedAssignment: null,
      violations: [{ code: "UNKNOWN_BRANCH", message: "Branch needs confirmation" }],
      nextAction: "Confirm branch",
      scheduleVersion: { status: "PUBLISHED" },
    },
  ],
});

describe("OperationsDayPanel", () => {
  it("labels proposals and exceptions without calling them assigned", () => {
    render(<OperationsDayPanel data={day} />);

    expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Proposed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Exception").length).toBeGreaterThan(0);
    expect(screen.getByText("Draft assignment — not dispatched")).toBeInTheDocument();
    expect(screen.getByText("Assignment needs review — not dispatchable")).toBeInTheDocument();
    expect(screen.getByText("Hours are assumed or unconfirmed")).toBeInTheDocument();
  });

  it("shows the server summary and a concrete next action", () => {
    render(<OperationsDayPanel data={day} />);

    expect(screen.getByRole("heading", { name: "Operational queues" })).toBeInTheDocument();
    expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
    const exception = screen.getByText("Exception customer").closest("li")!;
    expect(within(exception).getByText("Confirm branch")).toBeInTheDocument();
    expect(within(exception).getByText(/Published schedule version/)).toBeInTheDocument();
  });

  it("keeps the published crew visible after a visit is completed", () => {
    const completed = parseOperationsDay({
      date: "2026-09-10",
      items: [
        {
          visit: { id: "completed", customerName: "Completed customer" },
          state: "COMPLETED",
          dispatchAssignment: { crew: [{ fullName: "Completed crew" }], vehicles: [] },
          proposedAssignment: null,
          violations: [],
          nextAction: "No action needed",
        },
      ],
    });

    render(<OperationsDayPanel data={completed} />);

    const item = screen.getByText("Completed customer").closest("li")!;
    expect(within(item).getByText("Completed assignment")).toBeInTheDocument();
    expect(within(item).getByText("Crew: Completed crew")).toBeInTheDocument();
  });
});

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
    expect(within(exception).getByText(/Published schedule version/)).toBeInTheDocument();
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
    expect(within(item).getByText("Published schedule version run-1")).toBeInTheDocument();
    expect(within(item).queryByText(/not dispatch truth/)).not.toBeInTheDocument();
  });
});

describe("OperationsDayPanel published assignment lineage", () => {
  function lineageDay(publishedAssignmentLineage: unknown) {
    return parseOperationsDay({
      date: "2026-09-10",
      items: [{
        visit: { id: "corrected", customerName: "Corrected customer" },
        state: "READY",
        dispatchAssignment: {
          id: "v3",
          status: "PUBLISHED",
          crew: [{ fullName: "Repaired crew" }],
          vehicles: [],
        },
        proposedAssignment: null,
        violations: [],
        warnings: [],
        nextAction: "Dispatch the published assignment.",
        scheduleVersion: { id: "run-9", status: "PUBLISHED", publishedAt: "2026-09-10T08:00:00.000Z" },
        publishedAssignmentLineage,
      }],
    });
  }

  it("tells the correction story and keeps the schedule version alongside it", () => {
    const day = lineageDay({
      entries: [
        {
          assignmentId: "v1",
          status: "SUPERSEDED",
          supersedesAssignmentId: null,
          supersededByAssignmentId: "v2",
          publishedByRepairId: null,
          provenance: "SCHEDULE_RUN",
          publishedAt: "2026-09-10T06:00:00.000Z",
          isCurrent: false,
        },
        {
          assignmentId: "v2",
          status: "SUPERSEDED",
          supersedesAssignmentId: "v1",
          supersededByAssignmentId: "v3",
          publishedByRepairId: null,
          provenance: "SCHEDULE_RUN",
          publishedAt: "2026-09-10T07:00:00.000Z",
          isCurrent: false,
        },
        {
          assignmentId: "v3",
          status: "PUBLISHED",
          supersedesAssignmentId: "v2",
          supersededByAssignmentId: null,
          publishedByRepairId: "repair77",
          provenance: "REPAIR",
          publishedAt: "2026-09-10T08:00:00.000Z",
          isCurrent: true,
        },
      ],
      totalCount: 3,
      truncated: false,
      omittedCount: 0,
      currentAssignmentId: "v3",
      withdrawn: false,
      hasMixedProvenance: true,
    });

    render(<OperationsDayPanel data={day} />);

    const history = screen.getByRole("region", { name: "Published assignment history" });
    expect(within(history).getByText(/current published version/)).toBeInTheDocument();
    expect(within(history).getByText(/supersedes v2/)).toBeInTheDocument();
    expect(within(history).getByText(/audited repair repair77/)).toBeInTheDocument();
    expect(within(history).getByText(/mixes scheduled and repaired/)).toBeInTheDocument();

    // Schedule-run history is a different thing and must survive.
    const item = screen.getByText("Corrected customer").closest("li")!;
    expect(within(item).getByText("Published schedule version run-9")).toBeInTheDocument();
  });

  it("says plainly when the chain was truncated", () => {
    const day = lineageDay({
      entries: [
        {
          assignmentId: "v12",
          status: "SUPERSEDED",
          supersedesAssignmentId: "v11",
          supersededByAssignmentId: "v3",
          publishedByRepairId: null,
          provenance: "SCHEDULE_RUN",
          publishedAt: "2026-09-10T07:00:00.000Z",
          isCurrent: false,
        },
        {
          assignmentId: "v3",
          status: "PUBLISHED",
          supersedesAssignmentId: "v12",
          supersededByAssignmentId: null,
          publishedByRepairId: null,
          provenance: "SCHEDULE_RUN",
          publishedAt: "2026-09-10T08:00:00.000Z",
          isCurrent: true,
        },
      ],
      totalCount: 13,
      truncated: true,
      omittedCount: 11,
      currentAssignmentId: "v3",
      withdrawn: false,
      hasMixedProvenance: false,
    });

    render(<OperationsDayPanel data={day} />);

    const history = screen.getByRole("region", { name: "Published assignment history" });
    expect(within(history).getByText(/Showing the 2 most recent of 13 published versions/)).toBeInTheDocument();
    expect(within(history).getByText(/11 older versions are not shown/)).toBeInTheDocument();
  });

  it("says a visit has no published history rather than staying silent", () => {
    const day = parseOperationsDay({
      date: "2026-09-10",
      items: [{
        visit: { id: "fresh", customerName: "Fresh customer" },
        state: "PROPOSED",
        dispatchAssignment: null,
        proposedAssignment: { id: "draft", status: "DRAFT", crew: [], vehicles: [] },
        violations: [],
        warnings: [],
        nextAction: "Review and publish the proposed assignment.",
        scheduleVersion: { id: "run-2", status: "DRAFT" },
        publishedAssignmentLineage: {
          entries: [],
          totalCount: 0,
          truncated: false,
          omittedCount: 0,
          currentAssignmentId: null,
          withdrawn: false,
          hasMixedProvenance: false,
        },
      }],
    });

    render(<OperationsDayPanel data={day} />);

    const item = screen.getByText("Fresh customer").closest("li")!;
    expect(within(item).getByText("No published assignment history for this visit yet.")).toBeInTheDocument();
    expect(within(item).getByText(/Draft schedule version run-2/)).toBeInTheDocument();
  });
});

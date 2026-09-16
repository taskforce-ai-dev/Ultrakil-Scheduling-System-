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

  /**
   * "EMPLOYEE_DOUBLE_BOOKED: This employee is already assigned…" printed the
   * engine's own name above a sentence that already said it in English, and
   * made a handled refusal read as a crash. The sentence is the product.
   */
  it("explains a violation in words, without shouting the engine's code", () => {
    render(<OperationsDayPanel data={day} />);

    const exception = screen.getByText("Exception customer").closest("li")!;
    expect(within(exception).getByText(/Branch needs confirmation/)).toBeInTheDocument();
    expect(within(exception).queryByText(/UNKNOWN_BRANCH/)).not.toBeInTheDocument();
  });

  it("shows the server summary and a concrete next action", () => {
    render(<OperationsDayPanel data={day} />);

    expect(screen.getByRole("heading", { name: "Operational queues" })).toBeInTheDocument();
    expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
    const exception = screen.getByText("Exception customer").closest("li")!;
    expect(within(exception).getByText("Confirm branch")).toBeInTheDocument();
    expect(within(exception).getByText(/^Published schedule\b/)).toBeInTheDocument();
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
    expect(within(item).getByText(/Published schedule/)).toBeInTheDocument();
    expect(within(item).queryByText(/not dispatch truth/)).not.toBeInTheDocument();
  });

  it("names the schedule run by its weeks and never by its id", () => {
    const published = parseOperationsDay({
      date: "2026-09-10",
      items: [{
        visit: { id: "named", customerName: "Named customer" },
        state: "READY",
        dispatchAssignment: {
          id: "named-published",
          status: "PUBLISHED",
          crew: [{ fullName: "Named crew" }],
          vehicles: [],
        },
        proposedAssignment: null,
        violations: [],
        warnings: [],
        nextAction: "Dispatch the published assignment.",
        scheduleVersion: {
          id: "6a1d0f2e-9c4b-4a3d-8f10-2b7c5e9d0a14",
          status: "PUBLISHED",
          publishedAt: "2026-09-15T12:05:00.000Z",
          rangeStart: "2026-09-15",
          rangeEnd: "2026-09-21",
        },
      }],
    });

    render(<OperationsDayPanel data={published} />);

    const item = screen.getByText("Named customer").closest("li")!;
    expect(
      within(item).getByText(/^Published schedule 15–21 Sep, published \d{1,2} Sep \d{2}:\d{2}$/),
    ).toBeInTheDocument();
    // Schedule History is where the rest of the run's story is.
    // The link carries the run, so Schedule History can pick it out of fifty.
    expect(within(item).getByRole("link", { name: /Published schedule 15–21 Sep/ })).toHaveAttribute(
      "href",
      "/schedule-history?run=6a1d0f2e-9c4b-4a3d-8f10-2b7c5e9d0a14",
    );
  });

  it("prints no uuid anywhere on a day of published work", () => {
    const withRuns = parseOperationsDay({
      date: "2026-09-10",
      items: [
        {
          visit: { id: "one", customerName: "First customer" },
          state: "READY",
          dispatchAssignment: { id: "a1", status: "PUBLISHED", crew: [], vehicles: [] },
          proposedAssignment: null,
          violations: [],
          warnings: [],
          nextAction: "No action needed",
          scheduleVersion: {
            id: "6a1d0f2e-9c4b-4a3d-8f10-2b7c5e9d0a14",
            status: "PUBLISHED",
            publishedAt: "2026-09-15T12:05:00.000Z",
            rangeStart: "2026-09-15",
            rangeEnd: "2026-09-21",
          },
        },
        {
          visit: { id: "two", customerName: "Second customer" },
          state: "PROPOSED",
          dispatchAssignment: null,
          proposedAssignment: { id: "a2", status: "DRAFT", crew: [], vehicles: [] },
          violations: [],
          warnings: [],
          nextAction: "Review and publish",
          scheduleVersion: {
            id: "e3c7b9a1-55d2-4e68-9b0c-71f4a8d2c603",
            status: "DRAFT",
            publishedAt: null,
            rangeStart: "2026-09-28",
            rangeEnd: "2026-10-04",
          },
        },
      ],
    });

    const { container } = render(<OperationsDayPanel data={withRuns} />);

    const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    expect(container.textContent ?? "").not.toMatch(UUID);
    expect(screen.getByText(/^Draft schedule 28 Sep – 4 Oct — not dispatch truth$/)).toBeInTheDocument();
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
    // Ordinal and human labels, never an id fragment: "supersedes 8f2c1a0b…"
    // is a string a manager can neither search for nor say out loud.
    expect(within(history).getByText(/Version 3 of 3/)).toBeInTheDocument();
    expect(within(history).getByText(/replaces version 2/)).toBeInTheDocument();
    expect(within(history).getByText(/the audited repair of \d{1,2} Sep/)).toBeInTheDocument();
    expect(within(history).getByText(/mixes scheduled and repaired/)).toBeInTheDocument();
    expect(history.textContent ?? "").not.toContain("repair77");
    expect(history.textContent ?? "").not.toMatch(/\b[0-9a-f]{8}\b/);

    // Schedule-run history is a different thing and must survive.
    const item = screen.getByText("Corrected customer").closest("li")!;
    expect(within(item).getByText(/^Published schedule, published /)).toBeInTheDocument();
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
    // The numbering counts from the whole chain, not from what fitted.
    expect(within(history).getByText(/Version 13 of 13/)).toBeInTheDocument();
    expect(within(history).getByText(/Version 12 of 13/)).toBeInTheDocument();
    // v12's own predecessor is not in the shown window, so it is described
    // rather than named by an id nobody can look up here.
    expect(within(history).getByText(/replaces an earlier version/)).toBeInTheDocument();
    expect(history.textContent ?? "").not.toContain("v11");
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
    expect(within(item).getByText("Draft schedule — not dispatch truth")).toBeInTheDocument();
  });
});

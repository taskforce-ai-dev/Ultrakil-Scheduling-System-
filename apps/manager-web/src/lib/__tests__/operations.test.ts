import { describe, expect, it } from "vitest";

import { parseOperationsDay, type OperationsDayResponse } from "@/lib/api-client";

describe("operations day contract parser", () => {
  it("keeps authoritative state separate from draft proposals", () => {
    const parsed = parseOperationsDay({
      date: "2026-09-10",
      branchCode: "COLOMBO",
      summary: { total: 1, ready: 0, proposed: 1, unassigned: 0, exceptions: 0, hoursUnconfirmed: 1 },
      items: [
        {
          visit: {
            id: "visit-1",
            customerName: "Cinnamon Grand",
            siteName: "Kitchen",
            jobTypeName: "Termite Control",
            requiredCrewSize: 2,
            windowStartMinute: 480,
            windowEndMinute: 1020,
            hoursUnconfirmed: true,
          },
          state: "PROPOSED",
          dispatchAssignment: null,
          proposedAssignment: { crew: [{ fullName: "A Perera" }], vehicles: [] },
          violations: [],
          nextAction: "Review and publish",
          scheduleVersion: { id: "v2", status: "DRAFT" },
        },
      ],
    });

    expect(parsed.items[0].state).toBe("PROPOSED");
    expect(parsed.items[0].dispatchAssignment).toBeNull();
    expect(parsed.items[0].proposedAssignment?.crew).toHaveLength(1);
    expect(parsed.items[0].visit.hoursUnconfirmed).toBe(true);
  });

  it("defensively normalizes malformed responses without inventing a dispatch assignment", () => {
    const parsed = parseOperationsDay({
      date: 42,
      summary: { total: "not-a-number" },
      items: [
        {
          visit: { id: "visit-2", customerName: "Unknown", windowStartMinute: null },
          state: "NOT_A_STATE",
          dispatchAssignment: { crew: [{ fullName: "Draft person" }] },
        },
        null,
      ],
    });

    expect(parsed.date).toBe("");
    expect(parsed.summary).toEqual({
      total: 0,
      ready: 0,
      proposed: 0,
      unassigned: 0,
      exceptions: 0,
      hoursUnconfirmed: 0,
    });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].state).toBe("UNASSIGNED");
    expect(parsed.items[0].dispatchAssignment).toBeNull();
    expect(parsed.items[0].visit.windowStartMinute).toBeNull();
  });

  it("does not treat a proposal snapshot as published dispatch truth", () => {
    const parsed = parseOperationsDay({
      items: [
        {
          visit: { id: "visit-proposed" },
          state: "PROPOSED",
          dispatchAssignment: { crew: [{ fullName: "Draft crew" }] },
          proposedAssignment: { crew: [{ fullName: "Draft crew" }] },
        },
      ],
    });

    expect(parsed.items[0].dispatchAssignment).toBeNull();
    expect(parsed.items[0].proposedAssignment?.crew[0].fullName).toBe("Draft crew");
  });

  it("retains warnings and lineage fields when present", () => {
    const parsed: OperationsDayResponse = parseOperationsDay({
      date: "2026-09-10",
      items: [{
        visit: { id: "v", hoursUnconfirmed: false },
        state: "EXCEPTION",
        violations: [{ code: "UNKNOWN_BRANCH", message: "Branch needs confirmation" }],
        sourceDataWarnings: [
          { code: "ASSUMED_HOURS", message: "Opening hours are assumed", source: "Master Schedule" },
        ],
        nextAction: "Confirm branch",
        scheduleVersion: { id: "v1", status: "PUBLISHED", predecessorId: "v0" },
      }],
    });

    expect(parsed.items[0].violations[0].code).toBe("UNKNOWN_BRANCH");
    expect(parsed.items[0].nextAction).toBe("Confirm branch");
    expect(parsed.items[0].scheduleVersion?.predecessorId).toBe("v0");
    expect(parsed.items[0].warnings).toContain("Opening hours are assumed (source: Master Schedule)");
  });
});

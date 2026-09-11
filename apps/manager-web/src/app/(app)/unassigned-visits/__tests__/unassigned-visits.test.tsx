import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The queue reads ?visit=<id> to open on one visit. Kept switchable so the
// "asked for by name" path can be exercised alongside the filter tests.
const { searchParamsRef } = vi.hoisted(() => ({
  searchParamsRef: { current: null as URLSearchParams | null },
}));

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return { ...actual, useSearchParams: () => searchParamsRef.current };
});

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return {
    ...actual,
    fetchUnassignedVisits: vi.fn(),
    fetchVisit: vi.fn(),
    lockVisit: vi.fn(),
    unlockVisit: vi.fn(),
  };
});

import UnassignedVisitsPage from "../page";
import { fetchUnassignedVisits, type UnassignedVisit } from "@/lib/api-client";
import { buildConflict, buildUnassignedVisit } from "@/test/fixtures";

const kandyNoSupervisor = buildUnassignedVisit({
  visitId: "visit-kandy",
  branchCode: "KANDY",
  customerName: "Grandview Hotel",
  siteName: "Main Kitchen",
  requiredCrewSize: 2,
  conflicts: [
    buildConflict({
      code: "BRANCH_HAS_NO_PMS_SUPERVISOR",
      message: "No PMS-grade supervisor is available in Kandy for this visit.",
      remediation: "Assign a Kandy PMS supervisor, or wait until one becomes available.",
      resources: {
        visitId: "visit-kandy",
        employeeIds: [],
        vehicleIds: [],
        serviceSiteId: "site-kandy",
        skillCodes: [],
        assignmentIds: [],
      },
    }),
  ],
});

const colomboCrewTooSmall = buildUnassignedVisit({
  visitId: "visit-colombo",
  branchCode: "COLOMBO",
  customerName: "Cinnamon Grand Colombo",
  siteName: "Main Kitchen",
  requiredCrewSize: 3,
  conflicts: [
    buildConflict({
      code: "CREW_TOO_SMALL",
      message: "Only 1 of the 3 required crew members were proposed.",
      remediation: "Add more crew to the assignment.",
      resources: {
        visitId: "visit-colombo",
        employeeIds: ["employee-9"],
        vehicleIds: [],
        serviceSiteId: "site-colombo",
        skillCodes: [],
        assignmentIds: [],
      },
    }),
    buildConflict({
      code: "SKILL_NOT_HELD",
      message: "No proposed crew member holds the Fumigation skill.",
      remediation: "Assign a crew member who holds this skill.",
      resources: {
        visitId: "visit-colombo",
        employeeIds: [],
        vehicleIds: [],
        serviceSiteId: "site-colombo",
        skillCodes: ["FUMIGATION"],
        assignmentIds: [],
      },
    }),
  ],
});

function mockUnassigned(items: UnassignedVisit[], total = items.length) {
  vi.mocked(fetchUnassignedVisits).mockResolvedValue({
    items,
    total,
    page: 1,
    pageSize: 200,
    hasNextPage: false,
    conflictFacets: {},
  });
}

beforeEach(() => {
  searchParamsRef.current = null;
  mockUnassigned([kandyNoSupervisor, colomboCrewTooSmall]);
});

async function renderPage() {
  const user = userEvent.setup();
  render(<UnassignedVisitsPage />);
  await screen.findByText("Grandview Hotel");
  return user;
}

describe("unassigned visits queue", () => {
  it("displays every returned conflict, not only the first", async () => {
    await renderPage();

    const row = screen.getByText("Cinnamon Grand Colombo").closest("li")!;
    expect(within(row).getByText(/Only 1 of the 3 required crew members/)).toBeInTheDocument();
    expect(within(row).getByText(/No proposed crew member holds the Fumigation skill/)).toBeInTheDocument();
  });

  it("makes the Kandy PMS supervisor shortage explicit", async () => {
    await renderPage();

    expect(screen.getByText("Kandy has no PMS supervisor available")).toBeInTheDocument();
  });

  it("stays quiet about the Kandy banner when no such conflict is returned", async () => {
    mockUnassigned([colomboCrewTooSmall]);
    render(<UnassignedVisitsPage />);
    await screen.findByText("Cinnamon Grand Colombo");

    expect(screen.queryByText("Kandy has no PMS supervisor available")).not.toBeInTheDocument();
  });

  it("gives a direct path from a conflict to the resource it names", async () => {
    await renderPage();

    const row = screen.getByText("Cinnamon Grand Colombo").closest("li")!;
    const link = within(row).getByRole("button", { name: /View employee/ });
    expect(link).toHaveAttribute("href", "/workforce/employee-9");
  });

  it("filters by branch", async () => {
    const user = await renderPage();

    await user.click(screen.getByLabelText("Branch"));
    await user.click(await screen.findByRole("option", { name: "Kandy" }));

    const lastCall = vi.mocked(fetchUnassignedVisits).mock.calls.at(-1)?.[0];
    expect(lastCall).toMatchObject({ branchCode: "KANDY" });
  });

  it("returns to the first server page when the branch changes", async () => {
    mockUnassigned([kandyNoSupervisor, colomboCrewTooSmall], 640);
    const user = await renderPage();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(vi.mocked(fetchUnassignedVisits).mock.calls.at(-1)?.[0]).toMatchObject({ page: 2 });

    await user.click(screen.getByLabelText("Branch"));
    await user.click(await screen.findByRole("option", { name: "Kandy" }));

    expect(vi.mocked(fetchUnassignedVisits).mock.calls.at(-1)?.[0]).toMatchObject({
      branchCode: "KANDY",
      page: 1,
    });
  });

  it("asks the server for a conflict group instead of filtering in the browser", async () => {
    // The group goes to the server as `conflictGroup` — the filter it
    // validates — and never as `conflictCode`, which is the engine's own
    // vocabulary and rejects a group label outright.
    const user = await renderPage();

    await user.click(screen.getByLabelText("Conflict type"));
    await user.click(await screen.findByRole("option", { name: "Missing skill" }));

    const lastCall = vi.mocked(fetchUnassignedVisits).mock.calls.at(-1)?.[0];
    expect(lastCall).toMatchObject({ conflictGroup: "MISSING_SKILL", page: 1 });
    expect(lastCall).not.toHaveProperty("conflictCode");
    expect(lastCall).not.toHaveProperty("status");
  });

  it("shows what the server returned for a conflict group, unfiltered", async () => {
    // Whatever the server sends back is what the list shows: re-filtering it
    // here would leave the rows disagreeing with the total beside them.
    const user = await renderPage();

    await user.click(screen.getByLabelText("Conflict type"));
    await user.click(await screen.findByRole("option", { name: "Missing skill" }));

    expect(await screen.findByText("Cinnamon Grand Colombo")).toBeInTheDocument();
    expect(screen.getByText("Grandview Hotel")).toBeInTheDocument();
  });

  it("asks the server for an operation state rather than sending a status", async () => {
    const user = await renderPage();

    await user.click(screen.getByLabelText("Status"));
    await user.click(await screen.findByRole("option", { name: "Exceptions" }));

    const lastCall = vi.mocked(fetchUnassignedVisits).mock.calls.at(-1)?.[0];
    expect(lastCall).toMatchObject({ operationState: "EXCEPTION", page: 1 });
    expect(lastCall).not.toHaveProperty("status");
  });

  it("asks the server for unchecked work by its operation state", async () => {
    const user = await renderPage();

    await user.click(screen.getByLabelText("Status"));
    await user.click(await screen.findByRole("option", { name: "Unassigned" }));

    expect(vi.mocked(fetchUnassignedVisits).mock.calls.at(-1)?.[0]).toMatchObject({
      operationState: "UNASSIGNED",
    });
  });

  it("still shows only the visit asked for by name", async () => {
    // focusVisitId is not a filter — it picks out one named row — and it has
    // to keep winning now that the filters themselves are the server's.
    searchParamsRef.current = new URLSearchParams("visit=visit-kandy");
    render(<UnassignedVisitsPage />);
    await screen.findByText("Grandview Hotel");

    expect(screen.getByText(/Showing the one visit you asked about/)).toBeInTheDocument();
    expect(screen.queryByText("Cinnamon Grand Colombo")).not.toBeInTheDocument();
  });

  it("shows an empty state when nothing is unassigned", async () => {
    mockUnassigned([]);
    render(<UnassignedVisitsPage />);

    expect(await screen.findByText("Nothing unassigned")).toBeInTheDocument();
  });

  it("says so when the page holds fewer visits than the API reports", async () => {
    mockUnassigned([kandyNoSupervisor, colomboCrewTooSmall], 640);
    await renderPage();

    expect(
      screen.getByText(/Showing 2 of 640 unassigned visits/)
    ).toBeInTheDocument();
  });

  it("does not use color as the only signal for a conflict group", async () => {
    await renderPage();

    // Each conflict card carries the group's text label and stable code
    // alongside its icon, not just a colored badge.
    const row = screen.getByText("Grandview Hotel").closest("li")!;
    expect(within(row).getByText("Missing PMS supervisor")).toBeInTheDocument();
    expect(within(row).getByText("BRANCH_HAS_NO_PMS_SUPERVISOR")).toBeInTheDocument();
  });

  it("never shows a not-yet-checked visit as if it had no problems", async () => {
    // hasBeenChecked: false means nobody has proposed a crew — the queue
    // used to only list refusals, so this state is new. An empty conflict
    // list here must never read as "this visit is fine".
    const untried = buildUnassignedVisit({
      visitId: "visit-untried",
      customerName: "Arpico DC",
      operationState: "UNASSIGNED",
      hasBeenChecked: false,
      conflicts: [],
    });
    mockUnassigned([untried]);
    render(<UnassignedVisitsPage />);
    await screen.findByText("Arpico DC");

    const row = screen.getByText("Arpico DC").closest("li")!;
    expect(within(row).getByText("Not yet checked")).toBeInTheDocument();
    expect(within(row).getByText(/hasn.t been checked/)).toBeInTheDocument();
  });
});

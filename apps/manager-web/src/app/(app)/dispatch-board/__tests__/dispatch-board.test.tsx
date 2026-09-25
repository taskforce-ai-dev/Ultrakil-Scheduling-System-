import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return {
    ...actual,
    fetchVisits: vi.fn(),
    fetchVisitAssignment: vi.fn(),
    fetchVisit: vi.fn(),
    fetchOperationsDay: vi.fn(),
    lockVisit: vi.fn(),
    unlockVisit: vi.fn(),
  };
});

import DispatchBoardPage from "../page";
import {
  ApiError,
  fetchOperationsDay,
  fetchVisit,
  fetchVisitAssignment,
  fetchVisits,
  type Assignment,
  type OperationsDayResponse,
  type Visit,
} from "@/lib/api-client";
import { buildAssignment, buildVisit, buildVisitDetail } from "@/test/fixtures";

function buildOperationsDay(overrides: Partial<OperationsDayResponse> = {}): OperationsDayResponse {
  return {
    date: NOW_ISO,
    branchCode: null,
    summary: {
      total: 0,
      ready: 0,
      proposed: 0,
      awaitingStaffing: 0,
      staffingFailed: 0,
      exceptions: 0,
      hoursUnconfirmed: 0,
    },
    items: [],
    ...overrides,
  };
}

const NOW = new Date("2026-09-09T09:00:00.000Z");
const NOW_ISO = "2026-09-09";

const staffed = buildVisit({
  id: "visit-staffed",
  visitDate: "2026-09-09",
  customerName: "Cinnamon Grand Colombo",
  siteName: "Main Kitchen",
  windowStartMinute: 540,
  windowEndMinute: 1020,
  status: "SCHEDULED",
  assignmentCount: 2,
});
const unassigned = buildVisit({
  id: "visit-unassigned",
  visitDate: "2026-09-09",
  customerName: "Union Bank Kadawatha",
  siteName: "Kadawatha Branch",
  windowStartMinute: 600,
  windowEndMinute: 1080,
  status: "UNASSIGNED",
  assignmentCount: 0,
});

function mockVisits(items: Visit[]) {
  vi.mocked(fetchVisits).mockResolvedValue({ items, total: items.length, page: 1, pageSize: 200 });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);

  mockVisits([staffed, unassigned]);
  vi.mocked(fetchVisit).mockReset();
  vi.mocked(fetchVisitAssignment).mockReset();
  vi.mocked(fetchOperationsDay).mockReset();
  vi.mocked(fetchOperationsDay).mockResolvedValue(buildOperationsDay());
  vi.mocked(fetchVisitAssignment).mockResolvedValue(
    buildAssignment({
      generatedVisitId: "visit-staffed",
      crew: [
        { employeeId: "e-1", fullName: "A Perera", role: "SUPERVISOR", isPmsSupervisor: true },
        { employeeId: "e-2", fullName: "N Fernando", role: "TECHNICIAN", isPmsSupervisor: false },
      ],
      vehicles: [
        { vehicleId: "v-1", label: "Van 253-4289", driverEmployeeId: "e-1", driverName: "A Perera" },
      ],
    })
  );
});

async function renderBoard() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<DispatchBoardPage />);
  await screen.findByText("Cinnamon Grand Colombo");
  return user;
}

describe("dispatch board", () => {
  it("never says nobody is assigned here beside the crews it is listing", async () => {
    await renderBoard();

    // The board's own subject is who is on each visit — it lists a supervisor,
    // a crew and an Edit crew button. The sentence it used to carry belongs to
    // the Visits page, where the work really has nobody on it, and read as a
    // flat contradiction of the rows underneath it.
    expect(screen.queryByText(/Nobody is assigned here/)).not.toBeInTheDocument();
    const staffedRow = screen.getByText("Cinnamon Grand Colombo").closest("tr")!;
    expect(within(staffedRow).getByText("A Perera, N Fernando")).toBeInTheDocument();
    expect(within(staffedRow).getByRole("button", { name: /Edit crew/ })).toBeInTheDocument();
    expect(
      screen.getByText(/Visits still waiting for a crew are queued in Unassigned Visits/),
    ).toBeInTheDocument();
  });

  it("shows the supervisor, crew, and vehicle for a staffed visit", async () => {
    await renderBoard();

    const row = screen.getByText("Cinnamon Grand Colombo").closest("tr")!;
    expect(within(row).getByText("A Perera")).toBeInTheDocument();
    expect(within(row).getByText("A Perera, N Fernando")).toBeInTheDocument();
    expect(within(row).getByText("Van 253-4289 (A Perera)")).toBeInTheDocument();
  });

  /**
   * The column and the Edit crew drawer named different people on the same
   * visit — the column reads the PMS grade, the drawer reads each crew row's
   * role. The column now says which of the two it is showing, and picks the
   * PMS-grade member the drawer also calls Supervisor when there is one.
   */
  it("says the supervisor it names is the PMS one", async () => {
    await renderBoard();

    expect(screen.getByRole("columnheader", { name: "PMS supervisor" })).toBeInTheDocument();
  });

  it("prefers the PMS-grade member the crew rows also call Supervisor", async () => {
    vi.mocked(fetchVisitAssignment).mockResolvedValue(
      buildAssignment({
        generatedVisitId: "visit-staffed",
        crew: [
          // Name order would reach Tech 13 first; the crew's own Supervisor row
          // is Tech 22, and both hold the PMS grade.
          { employeeId: "e-13", fullName: "Tech 13", role: "TECHNICIAN", isPmsSupervisor: true },
          { employeeId: "e-22", fullName: "Tech 22", role: "SUPERVISOR", isPmsSupervisor: true },
        ],
        vehicles: [],
      })
    );
    await renderBoard();

    const row = screen.getByText("Cinnamon Grand Colombo").closest("tr")!;
    const supervisorCell = within(row).getAllByRole("cell")[3];
    expect(supervisorCell).toHaveTextContent("Tech 22");
    expect(supervisorCell).not.toHaveTextContent("Tech 13");
  });

  it("never implies a visit is staffed before an assignment exists", async () => {
    await renderBoard();

    const row = screen.getByText("Union Bank Kadawatha").closest("tr")!;
    expect(within(row).getByText("No PMS supervisor")).toBeInTheDocument();
    expect(within(row).getByText("No assigned crew")).toBeInTheDocument();
    expect(within(row).getByText("No vehicle")).toBeInTheDocument();
    // No round trip was made for a visit the API already said has nobody on it.
    expect(fetchVisitAssignment).not.toHaveBeenCalledWith("visit-unassigned");
  });

  it("opens the visit detail drawer as the direct path from a row", async () => {
    vi.mocked(fetchVisit).mockResolvedValue(buildVisitDetail({ id: "visit-staffed" }));
    const user = await renderBoard();

    await user.click(screen.getByText("Cinnamon Grand Colombo"));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("moves a day at a time and refetches", async () => {
    const user = await renderBoard();

    await user.click(screen.getByRole("button", { name: "Next day" }));

    const lastCall = vi.mocked(fetchVisits).mock.calls.at(-1)?.[0];
    expect(lastCall).toMatchObject({ from: "2026-09-10", to: "2026-09-10" });
  });

  it("filters by branch", async () => {
    const user = await renderBoard();

    await user.click(screen.getByLabelText("Branch"));
    await user.click(await screen.findByRole("option", { name: "Kandy" }));

    const lastCall = vi.mocked(fetchVisits).mock.calls.at(-1)?.[0];
    expect(lastCall).toMatchObject({ branchCode: "KANDY" });
  });

  it("shows an empty state when nothing is scheduled", async () => {
    mockVisits([]);
    render(<DispatchBoardPage />);

    expect(await screen.findByText("Nothing scheduled for this date")).toBeInTheDocument();
  });

  it("keeps assumed site hours visible on the dispatch row", async () => {
    mockVisits([
      buildVisit({
        id: "visit-assumed-hours",
        customerName: "Assumed-hours customer",
        hoursUnconfirmed: true,
        assignmentCount: 0,
      }),
    ]);
    render(<DispatchBoardPage />);

    const row = (await screen.findByText("Assumed-hours customer")).closest("tr")!;
    expect(within(row).getByText(/Assumed hours/)).toBeInTheDocument();
  });

  it("keeps the newer branch's visits and operations panel even when the older branch answers last", async () => {
    const user = await renderBoard();

    // Both fetches below race independently — set each up with its own
    // resolver queue, in the order load() actually calls them. Cleared first
    // so the mount-time call above doesn't count toward the two below.
    vi.mocked(fetchVisits).mockClear();
    vi.mocked(fetchOperationsDay).mockClear();
    let resolveOlderVisits: ((page: Awaited<ReturnType<typeof fetchVisits>>) => void) | undefined;
    let resolveNewerVisits: ((page: Awaited<ReturnType<typeof fetchVisits>>) => void) | undefined;
    vi.mocked(fetchVisits).mockImplementation(
      () =>
        new Promise((resolve) => {
          if (resolveOlderVisits) resolveNewerVisits = resolve;
          else resolveOlderVisits = resolve;
        })
    );
    let resolveOlderOperations: ((data: OperationsDayResponse) => void) | undefined;
    let resolveNewerOperations: ((data: OperationsDayResponse) => void) | undefined;
    vi.mocked(fetchOperationsDay).mockImplementation(
      () =>
        new Promise((resolve) => {
          if (resolveOlderOperations) resolveNewerOperations = resolve;
          else resolveOlderOperations = resolve;
        })
    );

    // Two branch switches in a row — Colombo's requests are the older ones,
    // Kandy's are the newer ones that reflect what is now on screen.
    await user.click(screen.getByLabelText("Branch"));
    await user.click(await screen.findByRole("option", { name: "Colombo" }));
    await user.click(screen.getByLabelText("Branch"));
    await user.click(await screen.findByRole("option", { name: "Kandy" }));
    expect(fetchVisits).toHaveBeenCalledTimes(2);
    expect(fetchOperationsDay).toHaveBeenCalledTimes(2);

    const kandyVisit = buildVisit({
      id: "visit-kandy-only",
      customerName: "Kandy Fresh Co",
      assignmentCount: 0,
    });
    const colomboVisit = buildVisit({
      id: "visit-colombo-only",
      customerName: "Colombo Stale Co",
      assignmentCount: 0,
    });

    // The newer requests answer first — realistic under any real network,
    // where request order and response order are not the same.
    resolveNewerVisits?.({ items: [kandyVisit], total: 1, page: 1, pageSize: 200 });
    resolveNewerOperations?.(buildOperationsDay({ summary: { ...buildOperationsDay().summary, total: 22 } }));
    expect(await screen.findByText("Kandy Fresh Co")).toBeInTheDocument();
    expect(screen.getByText("Total").nextElementSibling).toHaveTextContent("22");

    // The older, stale requests finally answer. Neither may overwrite what
    // the newer requests already put on screen.
    resolveOlderVisits?.({ items: [colomboVisit], total: 1, page: 1, pageSize: 200 });
    resolveOlderOperations?.(buildOperationsDay({ summary: { ...buildOperationsDay().summary, total: 11 } }));
    await Promise.resolve();
    expect(screen.queryByText("Colombo Stale Co")).not.toBeInTheDocument();
    expect(screen.getByText("Kandy Fresh Co")).toBeInTheDocument();
    expect(screen.getByText("Total").nextElementSibling).toHaveTextContent("22");
  });

  it("clears the operations panel immediately on a reload, instead of leaving the old day/branch totals under the new selection", async () => {
    const user = await renderBoard();
    expect(screen.getByText("Total").nextElementSibling).toHaveTextContent("0");

    let resolveOperations: ((data: OperationsDayResponse) => void) | undefined;
    vi.mocked(fetchOperationsDay).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveOperations = resolve;
        })
    );

    await user.click(screen.getByLabelText("Branch"));
    await user.click(await screen.findByRole("option", { name: "Kandy" }));

    // Gone the moment the reload starts — not still showing Colombo's totals
    // relabeled as Kandy's until the new response happens to land.
    expect(screen.queryByText("Total")).not.toBeInTheDocument();

    resolveOperations?.(buildOperationsDay({ summary: { ...buildOperationsDay().summary, total: 7 } }));
    expect(await screen.findByText("Total")).toBeInTheDocument();
    expect(screen.getByText("Total").nextElementSibling).toHaveTextContent("7");
  });

  it("disables Share when there is nothing on the board to share", async () => {
    mockVisits([]);
    render(<DispatchBoardPage />);
    await screen.findByText("Nothing scheduled for this date");

    expect(screen.getByRole("button", { name: "Share" })).toBeDisabled();
  });

  it("keeps Share disabled through a deferred branch reload until both the visits and their assignments arrive", async () => {
    const user = await renderBoard();
    expect(screen.getByRole("button", { name: "Share" })).toBeEnabled();

    vi.mocked(fetchVisits).mockClear();
    vi.mocked(fetchVisitAssignment).mockClear();

    const reloadedVisit = buildVisit({
      id: "visit-kandy-reloaded",
      customerName: "Kandy Fresh Co",
      assignmentCount: 1,
    });

    let resolveVisits: ((page: Awaited<ReturnType<typeof fetchVisits>>) => void) | undefined;
    vi.mocked(fetchVisits).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveVisits = resolve;
        })
    );
    let resolveAssignment: ((assignment: Assignment) => void) | undefined;
    vi.mocked(fetchVisitAssignment).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAssignment = resolve;
        })
    );

    await user.click(screen.getByLabelText("Branch"));
    await user.click(await screen.findByRole("option", { name: "Kandy" }));

    // Still showing the previous, fully-loaded board while the new one is in
    // flight — Share must not offer to copy it under the newly picked branch.
    expect(screen.getByRole("button", { name: "Share" })).toBeDisabled();

    resolveVisits?.({ items: [reloadedVisit], total: 1, page: 1, pageSize: 200 });
    // The new visit list has landed — proven by the assignment round trip it
    // triggers — but the board stays on its loading skeleton and the
    // assignment itself hasn't arrived. Share must keep waiting through this
    // gap, or it could be clicked while "No assigned crew" would be wrong for a
    // visit that does have one.
    await waitFor(() => expect(fetchVisitAssignment).toHaveBeenCalledWith("visit-kandy-reloaded"));
    expect(screen.getByRole("button", { name: "Share" })).toBeDisabled();

    resolveAssignment?.(
      buildAssignment({
        generatedVisitId: "visit-kandy-reloaded",
        crew: [{ employeeId: "e-9", fullName: "R Silva", role: "TECHNICIAN", isPmsSupervisor: false }],
        vehicles: [],
      })
    );
    await screen.findByText("Kandy Fresh Co");
    expect(screen.getByRole("button", { name: "Share" })).toBeEnabled();
  });

  it("disables Share once the board fails to load, instead of sharing the last successful day", async () => {
    const user = await renderBoard();
    expect(screen.getByRole("button", { name: "Share" })).toBeEnabled();

    vi.mocked(fetchVisits).mockRejectedValueOnce(
      new ApiError({ code: "UNKNOWN_ERROR", message: "Something went wrong." })
    );

    await user.click(screen.getByRole("button", { name: "Next day" }));

    await screen.findByText("Couldn't load the dispatch board");
    expect(screen.getByRole("button", { name: "Share" })).toBeDisabled();
  });

  it("hides the list's Share action in Calendar view instead of sharing the hidden list-day state", async () => {
    const user = await renderBoard();
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Calendar" }));

    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "List" }));

    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
  });
});

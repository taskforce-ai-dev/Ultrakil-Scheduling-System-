import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return {
    ...actual,
    fetchVisits: vi.fn(),
    fetchVisitAssignment: vi.fn(),
    fetchVisit: vi.fn(),
    lockVisit: vi.fn(),
    unlockVisit: vi.fn(),
  };
});

import DispatchBoardPage from "../page";
import { fetchVisit, fetchVisitAssignment, fetchVisits, type Visit } from "@/lib/api-client";
import { buildAssignment, buildVisit, buildVisitDetail } from "@/test/fixtures";

const NOW = new Date("2026-09-09T09:00:00.000Z");

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
  const user = userEvent.setup();
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
    expect(within(row).getByText("No crew yet")).toBeInTheDocument();
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
});

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
  it("shows the supervisor, crew, and vehicle for a staffed visit", async () => {
    await renderBoard();

    const row = screen.getByText("Cinnamon Grand Colombo").closest("tr")!;
    expect(within(row).getByText("A Perera")).toBeInTheDocument();
    expect(within(row).getByText("A Perera, N Fernando")).toBeInTheDocument();
    expect(within(row).getByText("Van 253-4289 (A Perera)")).toBeInTheDocument();
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
});

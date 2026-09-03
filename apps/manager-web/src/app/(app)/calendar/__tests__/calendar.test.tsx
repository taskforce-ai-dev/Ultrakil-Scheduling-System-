import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>(
    "@/lib/api-client"
  );
  return { ...actual, fetchCalendar: vi.fn() };
});

import CalendarPage from "../page";
import { fetchCalendar } from "@/lib/api-client";
import { buildCalendarAssignment, buildCalendarEntry } from "@/test/fixtures";
import { todayIso } from "@/lib/calendar";

const unassigned = buildCalendarEntry({
  visitId: "visit-unassigned",
  visitDate: todayIso(),
  customerName: "Grandview Hotel",
  branchCode: "KANDY",
  assignment: null,
});

const published = buildCalendarEntry({
  visitId: "visit-published",
  visitDate: todayIso(),
  customerName: "Cinnamon Grand Colombo",
  branchCode: "COLOMBO",
  instructions: "Focus on the kitchen and store room.",
  assignment: buildCalendarAssignment({
    status: "PUBLISHED",
    publishedAt: "2026-09-01T10:00:00.000Z",
    crew: [
      { employeeId: "employee-1", fullName: "A Perera", role: "SUPERVISOR", isPmsSupervisor: true },
      { employeeId: "employee-2", fullName: "B Silva", role: "TECHNICIAN", isPmsSupervisor: false },
    ],
    vehicles: [{ vehicleId: "vehicle-1", label: "Van — COL-4521", driverName: "A Perera" }],
  }),
});

beforeEach(() => {
  vi.mocked(fetchCalendar).mockReset();
  vi.mocked(fetchCalendar).mockResolvedValue({ items: [unassigned, published], total: 2 });
});

describe("CalendarPage", () => {
  it("renders both an unassigned and a published visit for today", async () => {
    render(<CalendarPage />);

    expect(await screen.findByText("Grandview Hotel")).toBeInTheDocument();
    expect(screen.getByText("Cinnamon Grand Colombo")).toBeInTheDocument();
    // The stage legend counts every visible entry by stage.
    expect(screen.getByText(/Needs a crew \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Published \(1\)/)).toBeInTheDocument();
  });

  it("shows crew, supervisor and vehicle detail when a published visit is opened", async () => {
    const user = userEvent.setup();
    render(<CalendarPage />);

    await user.click(await screen.findByText("Cinnamon Grand Colombo"));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("A Perera")).toBeInTheDocument();
    expect(within(dialog).getByText("B Silva")).toBeInTheDocument();
    expect(within(dialog).getByText(/Van — COL-4521/)).toBeInTheDocument();
    expect(within(dialog).getByText(/driven by A Perera/)).toBeInTheDocument();
    expect(within(dialog).getByText("Focus on the kitchen and store room.")).toBeInTheDocument();
  });

  it("tells the manager an unassigned visit has no crew yet", async () => {
    const user = userEvent.setup();
    render(<CalendarPage />);

    await user.click(await screen.findByText("Grandview Hotel"));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/No crew on this visit yet/i)
    ).toBeInTheDocument();
  });

  it("filters to one branch, sending it to the API", async () => {
    const user = userEvent.setup();
    render(<CalendarPage />);
    await screen.findByText("Grandview Hotel");

    await user.click(screen.getByLabelText("Branch"));
    await user.click(await screen.findByRole("option", { name: "Kandy" }));

    expect(fetchCalendar).toHaveBeenLastCalledWith(
      expect.objectContaining({ branchCode: "KANDY" })
    );
  });

  it("filters by stage on the client", async () => {
    const user = userEvent.setup();
    render(<CalendarPage />);
    await screen.findByText("Grandview Hotel");

    await user.click(screen.getByLabelText("Stage"));
    await user.click(await screen.findByRole("option", { name: "Published to the crew" }));

    expect(screen.queryByText("Grandview Hotel")).not.toBeInTheDocument();
    expect(screen.getByText("Cinnamon Grand Colombo")).toBeInTheDocument();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, fetchCalendar: vi.fn() };
});

import CalendarPage from "../page";
import { fetchCalendar } from "@/lib/api-client";
import { buildCalendarAssignment, buildCalendarEntry } from "@/test/fixtures";
import { daysInView, todayIso, type CalendarView } from "@/lib/calendar";

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
  windowStartMinute: 540,
  windowEndMinute: 1020,
  assignment: buildCalendarAssignment({
    plannedStartMinute: 540,
    plannedEndMinute: 690,
    status: "PUBLISHED",
    publishedAt: "2026-09-01T10:00:00.000Z",
    crew: [
      {
        employeeId: "employee-1",
        fullName: "A Perera",
        role: "SUPERVISOR",
        isPmsSupervisor: true,
      },
      {
        employeeId: "employee-2",
        fullName: "B Silva",
        role: "TECHNICIAN",
        isPmsSupervisor: false,
      },
    ],
    vehicles: [
      {
        vehicleId: "vehicle-1",
        label: "Van — COL-4521",
        driverEmployeeId: "employee-1",
        driverName: "A Perera",
      },
    ],
  }),
});

beforeEach(() => {
  vi.mocked(fetchCalendar).mockReset();
  vi.mocked(fetchCalendar).mockResolvedValue({
    items: [unassigned, published],
    total: 2,
  });
});

describe("CalendarPage", () => {
  it.each([true, false])("shows the opening-hours warning only when unconfirmed=%s", async (hoursUnconfirmed) => {
    const user = userEvent.setup();
    vi.mocked(fetchCalendar).mockResolvedValue({ items: [{ ...published, hoursUnconfirmed }], total: 1 });
    render(<CalendarPage />);
    const chip = await screen.findByRole("button", {
      name: `Cinnamon Grand Colombo at 09:00–11:30 on ${todayIso()}, published${hoursUnconfirmed ? ", opening hours unconfirmed" : ""}`,
    });
    expect(within(chip).queryByText("Hours unconfirmed") !== null).toBe(hoursUnconfirmed);
    await user.click(chip);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText("Hours unconfirmed") !== null).toBe(hoursUnconfirmed);
    expect(within(dialog).queryByText(/No opening hours are recorded/) !== null).toBe(hoursUnconfirmed);
    if (hoursUnconfirmed) expect(within(dialog).getByText("08:00–17:00")).toBeInTheDocument();
  });

  it.each<CalendarView>(["month", "week"])("gives the populated %s calendar valid accessible rows and column headers", async (view) => {
    const user = userEvent.setup();
    render(<CalendarPage />);
    await screen.findByText("Cinnamon Grand Colombo");
    if (view === "week") await user.click(screen.getByRole("button", { name: "Week" }));

    const grid = await screen.findByRole("grid", { name: view === "month" ? "Month calendar" : "Week calendar" });
    const rows = within(grid).getAllByRole("row");
    const days = daysInView(todayIso(), view);
    expect(rows).toHaveLength(1 + days.length / 7);
    const headers = within(rows[0]).getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    for (const header of headers) expect(header.closest('[role="row"]')).toBe(rows[0]);
    const cells = within(grid).getAllByRole("gridcell");
    expect(cells).toHaveLength(days.length);
    for (const row of rows.slice(1)) {
      const rowCells = within(row).getAllByRole("gridcell");
      expect(rowCells).toHaveLength(7);
      for (const cell of rowCells) expect(cell.closest('[role="row"]')).toBe(row);
    }
    for (const row of rows) expect(row.closest('[role="grid"]')).toBe(grid);
  });

  it("uses the assigned appointment time in the chip and detail, not the permitted window", async () => {
    const user = userEvent.setup();
    render(<CalendarPage />);
    const chip = await screen.findByRole("button", {
      name: `Cinnamon Grand Colombo at 09:00–11:30 on ${todayIso()}, published`,
    });
    expect(within(chip).getByText("09:00–11:30")).toBeInTheDocument();
    await user.click(chip);
    expect(within(await screen.findByRole("dialog")).getByText(/09:00–11:30/)).toBeInTheDocument();
    expect(screen.queryByText(/09:00–17:00/)).not.toBeInTheDocument();
  });

  it("sorts by assigned start time and uses the allowed window for unassigned visits", async () => {
    vi.mocked(fetchCalendar).mockResolvedValue({ items: [
      { ...published, windowStartMinute: 480, assignment: buildCalendarAssignment({
        plannedStartMinute: 660, plannedEndMinute: 750,
      }) },
      { ...unassigned, windowStartMinute: 600, windowEndMinute: 1020 },
    ], total: 2 });
    render(<CalendarPage />);
    const earlier = await screen.findByRole("button", {
      name: `Grandview Hotel at 10:00–17:00 on ${todayIso()}, needs a crew`,
    });
    const later = screen.getByRole("button", { name: /Cinnamon Grand Colombo at 11:00–12:30/ });
    expect(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each(["assignment", "visit", "cancelled visit"])("shows completed stage for a %s", async (source) => {
    vi.mocked(fetchCalendar).mockResolvedValue({ items: [{
      ...published,
      visitStatus: source === "visit" ? "COMPLETED" : source === "cancelled visit" ? "CANCELLED" : "SCHEDULED",
      assignment: buildCalendarAssignment({ status: source === "assignment" ? "COMPLETED" : "PUBLISHED" }),
    }], total: 1 });
    render(<CalendarPage />);
    expect(await screen.findByRole("button", { name: /Cinnamon Grand Colombo.*completed \/ cancelled/ })).toBeInTheDocument();
    expect(screen.getByText("Completed / cancelled (1)")).toBeInTheDocument();
    expect(screen.getByText("Published (0)")).toBeInTheDocument();
  });

  it.each(["success", "failure"])("ignores an older request's %s after a newer success", async (outcome) => {
    const user = userEvent.setup();
    const older = deferred<Awaited<ReturnType<typeof fetchCalendar>>>();
    const newer = deferred<Awaited<ReturnType<typeof fetchCalendar>>>();
    vi.mocked(fetchCalendar).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    render(<CalendarPage />);
    await user.click(screen.getByRole("button", { name: "Week" }));
    expect(fetchCalendar).toHaveBeenCalledTimes(2);
    await act(async () => newer.resolve({ items: [published], total: 1 }));
    expect(screen.getByText("Cinnamon Grand Colombo")).toBeInTheDocument();
    await act(async () => {
      if (outcome === "success") older.resolve({ items: [unassigned], total: 1 });
      else older.reject(new Error("Old request failed"));
    });
    expect(screen.getByText("Cinnamon Grand Colombo")).toBeInTheDocument();
    expect(screen.queryByText("Grandview Hotel")).not.toBeInTheDocument();
    expect(screen.queryByText("Couldn't load the calendar")).not.toBeInTheDocument();
  });

  it("keeps loading the newest request when an older request finishes first", async () => {
    const user = userEvent.setup();
    const older = deferred<Awaited<ReturnType<typeof fetchCalendar>>>();
    const newer = deferred<Awaited<ReturnType<typeof fetchCalendar>>>();
    vi.mocked(fetchCalendar).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    render(<CalendarPage />);
    await user.click(screen.getByRole("button", { name: "Week" }));
    await act(async () => older.resolve({ items: [unassigned], total: 1 }));
    expect(screen.queryByText("Grandview Hotel")).not.toBeInTheDocument();
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(screen.queryByText("Nothing in this range")).not.toBeInTheDocument();
    await act(async () => newer.resolve({ items: [published], total: 1 }));
    expect(screen.getByText("Cinnamon Grand Colombo")).toBeInTheDocument();
  });

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
    expect(within(dialog).getByText(/No crew on this visit yet/i)).toBeInTheDocument();
  });

  it("filters to one branch, sending it to the API", async () => {
    const user = userEvent.setup();
    render(<CalendarPage />);
    await screen.findByText("Grandview Hotel");

    await user.click(screen.getByLabelText("Branch"));
    await user.click(await screen.findByRole("option", { name: "Kandy" }));

    expect(fetchCalendar).toHaveBeenLastCalledWith(
      expect.objectContaining({ branchCode: "KANDY" }),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

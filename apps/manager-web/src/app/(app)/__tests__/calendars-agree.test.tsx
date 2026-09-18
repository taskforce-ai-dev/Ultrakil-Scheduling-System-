import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, fetchCalendar: vi.fn(), fetchVisits: vi.fn(), fetchBranches: vi.fn(), fetchCustomers: vi.fn(), fetchJobTypes: vi.fn() };
});

import CalendarPage from "../calendar/page";
import VisitsPage from "../visits/page";
import {
  fetchBranches,
  fetchCalendar,
  fetchCustomers,
  fetchJobTypes,
  fetchVisits,
} from "@/lib/api-client";
import { buildCalendarAssignment, buildCalendarEntry, buildVisit } from "@/test/fixtures";
import { todayIso } from "@/lib/calendar";

/**
 * The two calendars, held to one answer about one visit.
 *
 * The Visit Calendar (`/visits`) and the unified Calendar read different
 * endpoints and draw their own tiles, and they have drifted before: last
 * round's fix — stop printing a defaulted service window as though it were
 * the appointment time — landed on one of them and not the other, and for a
 * fortnight the same visit had two different start times depending on which
 * screen a coordinator opened. A dispatch coordinator reading a start time
 * off the wrong one to a customer on the phone would have been six and a half
 * hours out.
 *
 * Both now render through `@/lib/visit-tile`. This holds them to it.
 */
const DATE = todayIso();

/** One visit, described twice: once as each screen's payload sees it. */
const STAFFED = {
  customerName: "Cinnamon Grand Colombo",
  durationMinutes: 90,
  // A site with no recorded hours: the window is the defaulted 08:00-17:00,
  // and it is not when anybody arrives.
  windowStartMinute: 8 * 60,
  windowEndMinute: 17 * 60,
  plannedStartMinute: 13 * 60 + 30,
  plannedEndMinute: 15 * 60,
  crewCount: 2,
};

const UNSTAFFED = {
  customerName: "Grandview Hotel",
  durationMinutes: 60,
  windowStartMinute: 8 * 60,
  windowEndMinute: 17 * 60,
};

beforeEach(() => {
  vi.mocked(fetchBranches).mockResolvedValue([]);
  vi.mocked(fetchCustomers).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 200 });
  vi.mocked(fetchJobTypes).mockResolvedValue([]);
  vi.mocked(fetchCalendar).mockResolvedValue({
    items: [
      buildCalendarEntry({
        visitId: "staffed",
        visitDate: DATE,
        customerName: STAFFED.customerName,
        durationMinutes: STAFFED.durationMinutes,
        windowStartMinute: STAFFED.windowStartMinute,
        windowEndMinute: STAFFED.windowEndMinute,
        visitStatus: "SCHEDULED",
        assignment: buildCalendarAssignment({
          plannedStartMinute: STAFFED.plannedStartMinute,
          plannedEndMinute: STAFFED.plannedEndMinute,
          crew: [
            { employeeId: "e1", fullName: "A Perera", role: "SUPERVISOR", isPmsSupervisor: true },
            { employeeId: "e2", fullName: "B Silva", role: "TECHNICIAN", isPmsSupervisor: false },
          ],
        }),
      }),
      buildCalendarEntry({
        visitId: "unstaffed",
        visitDate: DATE,
        customerName: UNSTAFFED.customerName,
        durationMinutes: UNSTAFFED.durationMinutes,
        windowStartMinute: UNSTAFFED.windowStartMinute,
        windowEndMinute: UNSTAFFED.windowEndMinute,
        visitStatus: "UNASSIGNED",
        assignment: null,
      }),
    ],
    total: 2,
  });
  vi.mocked(fetchVisits).mockResolvedValue({
    items: [
      buildVisit({
        id: "staffed",
        visitDate: DATE,
        customerName: STAFFED.customerName,
        durationMinutes: STAFFED.durationMinutes,
        windowStartMinute: STAFFED.windowStartMinute,
        windowEndMinute: STAFFED.windowEndMinute,
        status: "SCHEDULED",
        assignmentCount: 1,
        assignedCrewCount: STAFFED.crewCount,
        plannedStartMinute: STAFFED.plannedStartMinute,
        plannedEndMinute: STAFFED.plannedEndMinute,
      }),
      buildVisit({
        id: "unstaffed",
        visitDate: DATE,
        customerName: UNSTAFFED.customerName,
        durationMinutes: UNSTAFFED.durationMinutes,
        windowStartMinute: UNSTAFFED.windowStartMinute,
        windowEndMinute: UNSTAFFED.windowEndMinute,
        status: "UNASSIGNED",
      }),
    ],
    total: 2,
    page: 1,
    pageSize: 500,
  });
});

/**
 * One screen's tile for one customer, as a manager reads it. Each call
 * replaces the previous render, so the two screens can be compared inside a
 * single test without their DOMs overlapping.
 */
async function tile(Page: () => React.JSX.Element, customerName: string) {
  cleanup();
  render(<Page />);
  const name = await screen.findByText(customerName);
  const button = name.closest("button")!;
  return {
    /** The tile's own words, with the customer's name taken back out. */
    text: (button.textContent ?? "").replace(customerName, "|"),
    accessibleName: button.getAttribute("aria-label") ?? "",
  };
}

describe("the Visit Calendar and the Calendar, on the same visit", () => {
  it("print the crew's planned start, not the service window", async () => {
    const onVisits = await tile(VisitsPage, STAFFED.customerName);
    const onCalendar = await tile(CalendarPage, STAFFED.customerName);

    expect(onVisits.text).toContain("13:30–15:00");
    expect(onCalendar.text).toContain("13:30–15:00");
    // The defaulted window must not appear anywhere on either tile.
    expect(onVisits.text).not.toContain("08:00");
    expect(onCalendar.text).not.toContain("08:00");
    expect(onVisits.accessibleName).toContain("at 13:30–15:00");
    expect(onCalendar.accessibleName).toContain("at 13:30–15:00");
  });

  it("say the hour is undecided rather than printing a window as a plan", async () => {
    const onVisits = await tile(VisitsPage, UNSTAFFED.customerName);
    const onCalendar = await tile(CalendarPage, UNSTAFFED.customerName);

    expect(onVisits.text).toContain("60 min · time not set");
    expect(onCalendar.text).toContain("60 min · time not set");
    expect(onVisits.text).not.toContain("08:00");
    expect(onCalendar.text).not.toContain("08:00");
    // "at 60 min · time not set on …" is not a sentence. Neither screen says it.
    expect(onVisits.accessibleName).not.toContain(" at ");
    expect(onCalendar.accessibleName).not.toContain(" at ");
  });

  it("both say whether anybody is going", async () => {
    // A tile that shows only a time and a customer makes staffed and
    // unstaffed look identical, which is what the Visit Calendar had become.
    expect((await tile(VisitsPage, STAFFED.customerName)).text).toMatch(/\|2$/);
    expect((await tile(CalendarPage, STAFFED.customerName)).text).toMatch(/\|2$/);
    expect((await tile(VisitsPage, UNSTAFFED.customerName)).text).toContain("No crew");
    expect((await tile(CalendarPage, UNSTAFFED.customerName)).text).toContain("No crew");
  });

  it("agree word for word about the time and the crew", async () => {
    for (const customer of [STAFFED.customerName, UNSTAFFED.customerName]) {
      const onVisits = await tile(VisitsPage, customer);
      const onCalendar = await tile(CalendarPage, customer);
      expect(onVisits.text).toBe(onCalendar.text);
    }
  });
});

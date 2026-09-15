import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return {
    ...actual,
    fetchVisits: vi.fn(),
    fetchVisit: vi.fn(),
    fetchCustomers: vi.fn(),
    fetchJobTypes: vi.fn(),
    fetchBranches: vi.fn(),
    lockVisit: vi.fn(),
    unlockVisit: vi.fn(),
    previewVisitGeneration: vi.fn(),
    confirmVisitGeneration: vi.fn(),
  };
});

import VisitsPage from "../page";
import {
  ApiError,
  confirmVisitGeneration,
  fetchBranches,
  fetchCustomers,
  fetchJobTypes,
  fetchVisit,
  fetchVisits,
  lockVisit,
  previewVisitGeneration,
  type Visit,
} from "@/lib/api-client";
import {
  buildCustomer,
  buildGenerationImpact,
  buildJobType,
  buildServiceSite,
  buildVisit,
  buildVisitDetail,
} from "@/test/fixtures";

// The calendar anchors on "today", so the fixtures have to sit in the month
// the test is actually run in — otherwise this suite would start failing on
// its own in September.
const NOW = new Date("2026-09-15T09:00:00.000Z");

const site = buildServiceSite({ id: "site-1", customerId: "customer-1" });
const customer = buildCustomer({
  id: "customer-1",
  name: "Cinnamon Grand Colombo",
  sites: [site],
});
const otherCustomer = buildCustomer({ id: "customer-2", name: "Union Bank Kadawatha", sites: [] });
const jobType = buildJobType({ id: "job-1", name: "Termite Control" });
const otherJobType = buildJobType({ id: "job-2", name: "Rodent Control" });

const generated = buildVisit({
  id: "visit-generated",
  visitDate: "2026-09-09",
  customerName: "Cinnamon Grand Colombo",
  jobTypeName: "Termite Control",
});
const locked = buildVisit({
  id: "visit-locked",
  visitDate: "2026-09-16",
  customerName: "Union Bank Kadawatha",
  jobTypeName: "Rodent Control",
  isLocked: true,
  lockReason: "Customer confirmed this date",
  isProtected: true,
  protectionReason: "LOCKED",
});
const staffed = buildVisit({
  id: "visit-staffed",
  visitDate: "2026-09-23",
  customerName: "Cinnamon Grand Colombo",
  jobTypeName: "Termite Control",
  status: "SCHEDULED",
  assignmentCount: 2,
  isProtected: true,
  protectionReason: "ALREADY_SCHEDULED",
});

function mockVisits(items: Visit[]) {
  vi.mocked(fetchVisits).mockResolvedValue({
    items,
    total: items.length,
    page: 1,
    pageSize: 500,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);

  mockVisits([generated, locked, staffed]);
  vi.mocked(fetchCustomers).mockResolvedValue({
    items: [customer, otherCustomer],
    total: 2,
    page: 1,
    pageSize: 200,
  });
  vi.mocked(fetchJobTypes).mockResolvedValue([jobType, otherJobType]);
  vi.mocked(fetchBranches).mockResolvedValue([
    {
      id: "branch-colombo",
      code: "COLOMBO",
      name: "Colombo",
      employeeCount: 20,
      vehicleCount: 5,
      pmsSupervisorCount: 3,
      dailyVisitCap: 2,
    },
    {
      id: "branch-kandy",
      code: "KANDY",
      name: "Kandy",
      employeeCount: 10,
      vehicleCount: 2,
      pmsSupervisorCount: 1,
      dailyVisitCap: 2,
    },
  ]);
  vi.mocked(fetchVisit).mockReset();
  vi.mocked(lockVisit).mockReset();
  vi.mocked(previewVisitGeneration).mockReset();
  vi.mocked(confirmVisitGeneration).mockReset();
});

/** The calendar grid alone — customer names also appear in the filter menus. */
function grid() {
  return screen.getByRole("grid");
}

/** Chips are labelled with the date too, so two visits for one customer are distinct. */
function chip(customerName: string, time: string, date: string) {
  return screen.getByRole("button", {
    name: `${customerName} at ${time} on ${date}`,
  });
}

async function renderCalendar() {
  const user = userEvent.setup();
  render(<VisitsPage />);
  await screen.findByText("September 2026");
  return user;
}

/** Base UI selects are listbox popups, not native <select>. */
async function chooseOption(
  user: ReturnType<typeof userEvent.setup>,
  labelText: string,
  optionName: string
) {
  await user.click(screen.getByLabelText(labelText));
  await user.click(await screen.findByRole("option", { name: optionName }));
}

describe("calendar rendering", () => {
  it("shows the current month and every visit in it", async () => {
    await renderCalendar();

    expect(screen.getByTestId("calendar-range")).toHaveTextContent("September 2026");
    expect(within(grid()).getAllByText("Cinnamon Grand Colombo")).toHaveLength(2);
    expect(within(grid()).getByText("Union Bank Kadawatha")).toBeInTheDocument();
    expect(screen.getByText("3 visits")).toBeInTheDocument();
  });

  it("keeps scheduled visit times readable on the green status tint", async () => {
    await renderCalendar();

    const scheduledChip = chip("Cinnamon Grand Colombo", "09:00", "2026-09-23");
    expect(within(scheduledChip).getByText("09:00")).toHaveClass("text-foreground");
    expect(
      within(scheduledChip.parentElement!).getByRole("button", {
        name: "Move Cinnamon Grand Colombo's visit to a different date",
      })
    ).toHaveClass("text-foreground");
  });

  it("asks the API for the whole grid, not just the month", async () => {
    await renderCalendar();

    // September 2026 starts on a Tuesday, so the grid opens on Mon 31 August
    // and runs to Sun 4 October. Fetching 1–30 September would leave those
    // cells wrongly empty.
    expect(vi.mocked(fetchVisits).mock.calls[0][0]).toMatchObject({
      from: "2026-08-31",
      to: "2026-10-04",
    });
  });

  it("switches to a week view and back", async () => {
    const user = await renderCalendar();

    await user.click(screen.getByRole("button", { name: "Week" }));
    expect(screen.getByTestId("calendar-range")).toHaveTextContent("14 – 20 September 2026");

    await user.click(screen.getByRole("button", { name: "Month" }));
    expect(screen.getByTestId("calendar-range")).toHaveTextContent("September 2026");
  });

  it("moves a month at a time and refetches", async () => {
    const user = await renderCalendar();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByTestId("calendar-range")).toHaveTextContent("October 2026");

    await user.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByTestId("calendar-range")).toHaveTextContent("September 2026");
  });
});

describe("filters", () => {
  it("sends the branch to the API so Colombo and Kandy stay separable", async () => {
    const user = await renderCalendar();

    await chooseOption(user, "Branch", "Kandy");

    const lastCall = vi.mocked(fetchVisits).mock.calls.at(-1)?.[0];
    expect(lastCall).toMatchObject({ branchCode: "KANDY" });
  });

  it("narrows by customer", async () => {
    const user = await renderCalendar();

    await chooseOption(user, "Customer", "Union Bank Kadawatha");

    expect(within(grid()).getByText("Union Bank Kadawatha")).toBeInTheDocument();
    expect(within(grid()).queryByText("Cinnamon Grand Colombo")).not.toBeInTheDocument();
    expect(screen.getByText("1 visits")).toBeInTheDocument();
  });

  it("narrows by treatment", async () => {
    const user = await renderCalendar();

    await chooseOption(user, "Treatment", "Rodent Control");

    expect(within(grid()).getByText("Union Bank Kadawatha")).toBeInTheDocument();
    expect(within(grid()).queryByText("Cinnamon Grand Colombo")).not.toBeInTheDocument();
  });

  it("narrows by visit state", async () => {
    const user = await renderCalendar();

    await chooseOption(user, "Visit state", "Locked");
    expect(within(grid()).getByText("Union Bank Kadawatha")).toBeInTheDocument();
    expect(screen.getByText("1 visits")).toBeInTheDocument();

    await chooseOption(user, "Visit state", "Generated (untouched)");
    // The staffed visit is untouched by a person too, so both qualify.
    expect(screen.getByText("2 visits")).toBeInTheDocument();
  });

  it("keeps the filters and the date when a visit is opened and closed", async () => {
    mockVisits([
      generated,
      buildVisit({
        id: "visit-october",
        visitDate: "2026-10-07",
        customerName: "Union Bank Kadawatha",
        jobTypeName: "Rodent Control",
      }),
    ]);
    vi.mocked(fetchVisit).mockResolvedValue(
      buildVisitDetail({ id: "visit-october", customerName: "Union Bank Kadawatha" })
    );
    const user = await renderCalendar();

    await user.click(screen.getByRole("button", { name: "Next" }));
    await chooseOption(user, "Customer", "Union Bank Kadawatha");
    expect(screen.getByTestId("calendar-range")).toHaveTextContent("October 2026");

    await user.click(chip("Union Bank Kadawatha", "09:00", "2026-10-07"));
    await screen.findByText("Why this visit exists");
    await user.keyboard("{Escape}");

    // The whole point: the manager lands back where they were, not on today
    // with the filters cleared.
    expect(screen.getByTestId("calendar-range")).toHaveTextContent("October 2026");
    expect(screen.getByLabelText("Customer")).toHaveTextContent("Union Bank Kadawatha");
  });
});

describe("an empty month", () => {
  it("points at the month that actually holds the work", async () => {
    // The calendar opens on today's month. If the generated work starts next
    // month, a blank grid reads as broken — this is the case a manager hits
    // on the very first visit to the screen.
    vi.mocked(fetchVisits).mockImplementation(async (query) =>
      query?.pageSize === 1
        ? { items: [buildVisit({ visitDate: "2026-10-07" })], total: 206, page: 1, pageSize: 1 }
        : { items: [], total: 0, page: 1, pageSize: 500 }
    );
    const user = await renderCalendar();

    expect(
      await screen.findByText("No visits in September 2026")
    ).toBeInTheDocument();
    expect(
      screen.getByText(/206 visits have been generated. The earliest is Wednesday 7 October 2026/)
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Go to the first visit" }));

    expect(screen.getByTestId("calendar-range")).toHaveTextContent("October 2026");
  });

  it("offers generation when nothing has been generated at all", async () => {
    mockVisits([]);
    await renderCalendar();

    expect(
      await screen.findByText("No visits have been generated yet")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "See what the agreements ask for" })
    ).toBeInTheDocument();
  });

  it("says so when the filters are what emptied the grid", async () => {
    const user = await renderCalendar();

    await chooseOption(user, "Customer", "Union Bank Kadawatha");
    await chooseOption(user, "Treatment", "Termite Control");

    // Union Bank's visit is Rodent Control, so the pair matches nothing.
    expect(screen.getByText("Nothing matches these filters")).toBeInTheDocument();
    expect(
      screen.getByText(/3 visits fall in this range, but the filters exclude all of them/)
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear the filters" }));

    expect(screen.getByText("3 visits")).toBeInTheDocument();
  });
});

describe("a busy day", () => {
  it("caps a month cell and drills into the week instead of growing the grid", async () => {
    const busy = Array.from({ length: 7 }, (_, index) =>
      buildVisit({
        id: `busy-${index}`,
        visitDate: "2026-09-09",
        windowStartMinute: 540 + index * 30,
      })
    );
    mockVisits(busy);
    const user = await renderCalendar();

    // Three chips and an overflow link, not seven chips.
    expect(within(grid()).getAllByRole("button", { name: /Cinnamon Grand Colombo at/ })).toHaveLength(3);
    const more = within(grid()).getByRole("button", { name: "+ 4 more" });

    await user.click(more);

    expect(screen.getByTestId("calendar-range")).toHaveTextContent("7 – 13 September 2026");
    // The week view shows the day in full.
    expect(within(grid()).getAllByRole("button", { name: /Cinnamon Grand Colombo at/ })).toHaveLength(7);
  });
});

describe("paging honesty", () => {
  it("says so when the range holds more visits than one page", async () => {
    vi.mocked(fetchVisits).mockResolvedValue({
      items: [generated, locked, staffed],
      total: 640,
      page: 1,
      pageSize: 500,
    });
    await renderCalendar();

    expect(
      screen.getByText(/This range holds 640 visits and only the first 3 are shown/)
    ).toBeInTheDocument();
  });

  it("stays quiet when the whole range fits", async () => {
    await renderCalendar();

    expect(screen.queryByText(/only the first/)).not.toBeInTheDocument();
  });
});

describe("state badges", () => {
  it("never implies a visit is staffed before an assignment exists", async () => {
    vi.mocked(fetchVisit).mockResolvedValue(buildVisitDetail({ id: "visit-generated" }));
    const user = await renderCalendar();

    expect(screen.getByText("2 with no crew assigned yet")).toBeInTheDocument();

    await user.click(chip("Cinnamon Grand Colombo", "09:00", "2026-09-09"));

    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("No crew yet")).toBeInTheDocument();
    expect(within(drawer).getByText("Unassigned")).toBeInTheDocument();
    expect(within(drawer).queryByText("Crew assigned")).not.toBeInTheDocument();
  });


  it("stays silent when the site's hours are known", async () => {
    await renderCalendar();

    expect(screen.queryByText(/opening hours unconfirmed/)).not.toBeInTheDocument();
  });

  it("counts locked and manually modified work separately", async () => {
    mockVisits([
      generated,
      locked,
      buildVisit({ id: "visit-edited", visitDate: "2026-09-17", isManuallyAdjusted: true }),
    ]);
    await renderCalendar();

    expect(screen.getByText("1 locked")).toBeInTheDocument();
    expect(screen.getByText("1 manually modified")).toBeInTheDocument();
  });
});

describe("the visit detail drawer", () => {
  it("explains why the visit exists, by the version it came from", async () => {
    vi.mocked(fetchVisit).mockResolvedValue(buildVisitDetail({ id: "visit-generated" }));
    const user = await renderCalendar();

    await user.click(chip("Cinnamon Grand Colombo", "09:00", "2026-09-09"));

    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("Fortnightly")).toBeInTheDocument();
    expect(within(drawer).getByText("Version 1")).toBeInTheDocument();
    expect(within(drawer).getByText("Wed")).toBeInTheDocument();
    expect(within(drawer).getByText("Termite Control")).toBeInTheDocument();
    expect(within(drawer).getByText("09:00 and 17:00")).toBeInTheDocument();
  });

  it("says on the row when the window is shorter than the visit", async () => {
    // A booked date on hours the site itself records as an hour is planned on
    // those hours deliberately. The generation panel says so once, and then
    // the panel closes; the visit carries the problem for weeks afterwards
    // and nothing on it says a word.
    vi.mocked(fetchVisit).mockResolvedValue(
      buildVisitDetail({
        id: "visit-generated",
        windowStartMinute: 540,
        windowEndMinute: 600,
        durationMinutes: 90,
      })
    );
    const user = await renderCalendar();

    await user.click(chip("Cinnamon Grand Colombo", "09:00", "2026-09-09"));

    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("Window shorter than the visit")).toBeInTheDocument();
  });

  it("says nothing of the sort when the window comfortably holds the visit", async () => {
    vi.mocked(fetchVisit).mockResolvedValue(buildVisitDetail({ id: "visit-generated" }));
    const user = await renderCalendar();

    await user.click(chip("Cinnamon Grand Colombo", "09:00", "2026-09-09"));

    const drawer = await screen.findByRole("dialog");
    expect(
      within(drawer).queryByText("Window shorter than the visit")
    ).not.toBeInTheDocument();
  });

  it("says the date is a commitment when it came from a customer booking", async () => {
    vi.mocked(fetchVisit).mockResolvedValue(
      buildVisitDetail({ id: "visit-generated", placement: "BOOKED" })
    );
    const user = await renderCalendar();

    await user.click(chip("Cinnamon Grand Colombo", "09:00", "2026-09-09"));

    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("Why this date")).toBeInTheDocument();
    expect(within(drawer).getByText("Booked with the customer")).toBeInTheDocument();
  });

  it("says when the system chose the date because another day was full", async () => {
    vi.mocked(fetchVisit).mockResolvedValue(
      buildVisitDetail({ id: "visit-generated", placement: "SPREAD" })
    );
    const user = await renderCalendar();

    await user.click(chip("Cinnamon Grand Colombo", "09:00", "2026-09-09"));

    const drawer = await screen.findByRole("dialog");
    expect(
      within(drawer).getByText("Moved off a day that was full")
    ).toBeInTheDocument();
  });

  it("never puts a raw placement enum in front of a manager", async () => {
    // A reason the API adds after this build ships still has to read as
    // English. "SPREAD_BY_REGION" on a drawer is not a sentence.
    vi.mocked(fetchVisit).mockResolvedValue(
      // Cast deliberately: the contract this build was generated from has no
      // such member, which is exactly the situation being rehearsed.
      buildVisitDetail({
        id: "visit-generated",
        placement: "SPREAD_BY_REGION" as "SPREAD",
      })
    );
    const user = await renderCalendar();

    await user.click(chip("Cinnamon Grand Colombo", "09:00", "2026-09-09"));

    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("Placed by the generator")).toBeInTheDocument();
    expect(within(drawer).queryByText(/SPREAD_BY_REGION/)).not.toBeInTheDocument();
  });

  it("says why a protected visit will be left alone", async () => {
    vi.mocked(fetchVisit).mockResolvedValue(
      buildVisitDetail({
        id: "visit-locked",
        customerName: "Union Bank Kadawatha",
        isLocked: true,
        lockReason: "Customer confirmed this date",
        isProtected: true,
        protectionReason: "LOCKED",
      })
    );
    const user = await renderCalendar();

    await user.click(chip("Union Bank Kadawatha", "09:00", "2026-09-16"));

    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("Locked by a manager")).toBeInTheDocument();
    expect(within(drawer).getByText("Customer confirmed this date")).toBeInTheDocument();
    expect(
      within(drawer).getByRole("button", { name: "Release this visit" })
    ).toBeInTheDocument();
  });

  it("surfaces a backend refusal without closing the drawer", async () => {
    vi.mocked(fetchVisit).mockResolvedValue(buildVisitDetail({ id: "visit-generated" }));
    vi.mocked(lockVisit).mockRejectedValue(
      new ApiError({ code: "INSUFFICIENT_ROLE", message: "Only an admin can lock a visit." })
    );
    const user = await renderCalendar();

    await user.click(chip("Cinnamon Grand Colombo", "09:00", "2026-09-09"));
    const drawer = await screen.findByRole("dialog");
    await user.click(within(drawer).getByRole("button", { name: "Lock this visit" }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});

describe("regeneration impact review", () => {
  it("says which day a protected visit would have moved to", async () => {
    // The visit is pinned to the manager's day so the period is not planned
    // twice. That must not read as "nothing to see": the agreement points at
    // another day now, and only the manager can move it.
    vi.mocked(previewVisitGeneration).mockResolvedValue(
      buildGenerationImpact({
        protectedVisits: [
          {
            visitId: "visit-held",
            serviceAgreementId: "agreement-2",
            customerName: "Union Bank Kadawatha",
            siteName: "Kadawatha Branch",
            visitDate: "2026-09-16",
            protection: "LOCKED",
            wouldHave: "UPDATE",
            changes: [
              { field: "visitDate", from: "2026-09-16", to: "2026-09-18" },
              { field: "durationMinutes", from: "90", to: "120" },
            ],
          },
        ],
      })
    );
    const user = await renderCalendar();

    await user.click(screen.getByRole("button", { name: "Generate visits" }));

    const drawer = await screen.findByRole("dialog");
    expect(
      within(drawer).getByText(/generation would have moved it to 2026-09-18/)
    ).toBeInTheDocument();
    expect(within(drawer).getByText(/durationMinutes 90 → 120/)).toBeInTheDocument();
  });


  it("previews without writing, and lists every bucket", async () => {
    vi.mocked(previewVisitGeneration).mockResolvedValue(
      buildGenerationImpact({
        agreementsConsidered: 4,
        additions: [
          {
            serviceAgreementId: "agreement-1",
            customerName: "Cinnamon Grand Colombo",
            siteName: "Main Kitchen",
            visitDate: "2026-09-30",
            windowStartMinute: 540,
            windowEndMinute: 1020,
            durationMinutes: 90,
            requiredCrewSize: 2,
            branchCode: "COLOMBO",
            isPreferredDay: true,
            placement: "ANCHORED",
          },
        ],
        removals: [
          {
            visitId: "visit-gone",
            serviceAgreementId: "agreement-9",
            customerName: "Greenfield Brewery",
            siteName: "Plant",
            visitDate: "2026-09-11",
            reason: "NO_LONGER_REQUIRED",
          },
        ],
        protectedVisits: [
          {
            visitId: "visit-locked",
            serviceAgreementId: "agreement-2",
            customerName: "Union Bank Kadawatha",
            siteName: "Kadawatha Branch",
            visitDate: "2026-09-16",
            protection: "LOCKED",
            wouldHave: "REMOVE",
            changes: [],
          },
        ],
        shortfalls: [
          {
            serviceAgreementId: "agreement-3",
            customerName: "Arpico DC",
            siteName: "Mattegoda",
            periodStart: "2026-09-07",
            periodEnd: "2026-09-13",
            requested: 2,
            scheduled: 0,
            reason: "SITE_CLOSED_ON_ALLOWED_DAYS",
            message: "The site is closed on every allowed weekday.",
          },
        ],
      })
    );
    const user = await renderCalendar();

    await user.click(screen.getByRole("button", { name: "Generate visits" }));

    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText(/Nothing has been written yet/)).toBeInTheDocument();
    expect(within(drawer).getByText("Visits to create")).toBeInTheDocument();
    expect(within(drawer).getByText(/Protected — will not be touched/)).toBeInTheDocument();
    // The raw enum is never shown to a manager.
    expect(within(drawer).queryByText(/\bLOCKED\b/)).not.toBeInTheDocument();
    expect(
      within(drawer).getByText(/Locked by a manager; generation would have removed it/)
    ).toBeInTheDocument();
    expect(within(drawer).getByText("No longer required")).toBeInTheDocument();
    expect(
      within(drawer).getByText(/the agreement no longer asks for it/)
    ).toBeInTheDocument();
    expect(within(drawer).getByText("Conflicts")).toBeInTheDocument();
    // Raw enums never reach a manager.
    expect(within(drawer).queryByText(/NO_LONGER_REQUIRED/)).not.toBeInTheDocument();
    expect(
      within(drawer).getByText(/The site is closed on every allowed weekday/)
    ).toBeInTheDocument();

    expect(confirmVisitGeneration).not.toHaveBeenCalled();
  });

  it("names a day still carrying more work than the branch plans for", async () => {
    vi.mocked(previewVisitGeneration).mockResolvedValue(
      buildGenerationImpact({
        loadWarnings: [
          {
            branchCode: "COLOMBO",
            date: "2026-09-14",
            plannedCount: 14,
            bookedCount: 14,
            cap: 12,
            message:
              "2026-09-14 carries 14 visits in COLOMBO, over the 12 a day this branch plans for. Every one of them is a date already booked with the customer, so none was moved.",
          },
        ],
      })
    );
    const user = await renderCalendar();

    await user.click(screen.getByRole("button", { name: "Generate visits" }));

    const drawer = await screen.findByRole("dialog");
    expect(
      within(drawer).getByText("Days over the branch's limit")
    ).toBeInTheDocument();
    expect(
      within(drawer).getByText("2026-09-14, COLOMBO: 14 visits — limit 12")
    ).toBeInTheDocument();
  });

  it("names a booked date the site's own hours contradict, without naming the customer", async () => {
    vi.mocked(previewVisitGeneration).mockResolvedValue(
      buildGenerationImpact({
        bookingWarnings: [
          {
            serviceAgreementId: "agreement-7",
            date: "2026-09-19",
            reason: "SITE_CLOSED_ON_BOOKED_DAY",
            message:
              "2026-09-19 is booked with the customer, but the site has no recorded opening hours on a saturday. The visit is planned on the assumed 08:00-17:00 day and marked unconfirmed. Record the site's hours for that day.",
          },
        ],
      })
    );
    const user = await renderCalendar();

    await user.click(screen.getByRole("button", { name: "Generate visits" }));

    const drawer = await screen.findByRole("dialog");
    expect(
      within(drawer).getByText("Booked on a day the site's hours do not allow")
    ).toBeInTheDocument();
    expect(
      within(drawer).getByText("2026-09-19 — No hours recorded for that weekday")
    ).toBeInTheDocument();
    expect(
      within(drawer).getByText(/no recorded opening hours on a saturday/)
    ).toBeInTheDocument();
    // Raw enums never reach a manager.
    expect(
      within(drawer).queryByText(/SITE_CLOSED_ON_BOOKED_DAY/)
    ).not.toBeInTheDocument();
  });

  it("confirms exactly the range that was previewed", async () => {
    vi.mocked(previewVisitGeneration).mockResolvedValue(
      buildGenerationImpact({
        additions: [
          {
            serviceAgreementId: "agreement-1",
            customerName: "Cinnamon Grand Colombo",
            siteName: "Main Kitchen",
            visitDate: "2026-09-30",
            windowStartMinute: 540,
            windowEndMinute: 1020,
            durationMinutes: 90,
            requiredCrewSize: 2,
            branchCode: "COLOMBO",
            isPreferredDay: true,
            placement: "ANCHORED",
          },
        ],
      })
    );
    vi.mocked(confirmVisitGeneration).mockResolvedValue(
      buildGenerationImpact({ isPreview: false, scheduleRunId: "run-9" })
    );
    const user = await renderCalendar();

    await user.click(screen.getByRole("button", { name: "Generate visits" }));
    await screen.findByText("Visits to create");
    await user.click(screen.getByRole("button", { name: "Generate" }));

    const previewArgs = vi.mocked(previewVisitGeneration).mock.calls[0][0];
    const confirmArgs = vi.mocked(confirmVisitGeneration).mock.calls[0][0];
    // A manager must not be shown one range and given another.
    expect(confirmArgs).toEqual(previewArgs);
  });

  it("generates the whole grid, so the weeks it draws are weeks it plans", async () => {
    // The September grid runs 2026-08-31 to 2026-10-04: whole Monday-to-Sunday
    // weeks, and the whole calendar month inside them. A run plans only the
    // periods it holds whole, and periods are calendar-aligned — so this range
    // holds a whole week for every weekly agreement and a whole month for
    // every monthly one, and the week view and the month view plan exactly the
    // same weeks. The calendar month on its own held neither end's week, and a
    // weekly agreement generated from the month view landed on a different day
    // from the same agreement generated from the week view.
    vi.mocked(previewVisitGeneration).mockResolvedValue(buildGenerationImpact());
    const user = await renderCalendar();

    await user.click(screen.getByRole("button", { name: "Generate visits" }));
    await screen.findByText("Visits to create");

    const args = vi.mocked(previewVisitGeneration).mock.calls[0][0];
    expect(args.from).toBe("2026-08-31");
    expect(args.to).toBe("2026-10-04");
  });

  it("starts the generated range on a Monday and ends it on a Sunday", async () => {
    // The property that makes the two views agree, stated as itself.
    vi.mocked(previewVisitGeneration).mockResolvedValue(buildGenerationImpact());
    const user = await renderCalendar();

    await user.click(screen.getByRole("button", { name: "Generate visits" }));
    await screen.findByText("Visits to create");

    const args = vi.mocked(previewVisitGeneration).mock.calls[0][0];
    expect(new Date(`${args.from}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(new Date(`${args.to}T00:00:00Z`).getUTCDay()).toBe(0);
  });

  it("names the agreements a range could plan nothing for", async () => {
    // A quarterly agreement asked about from a week view plans nothing, and a
    // zero with no explanation reads exactly like a calendar already in order.
    vi.mocked(previewVisitGeneration).mockResolvedValue(
      buildGenerationImpact({
        skippedPeriods: [
          {
            serviceAgreementId: "agreement-q1",
            frequencyUnit: "MONTH",
            frequencyInterval: 3,
            periodsSkipped: 1,
            reason: "RANGE_HOLDS_NO_WHOLE_PERIOD",
            message: "no whole quarter",
          },
          {
            serviceAgreementId: "agreement-q2",
            frequencyUnit: "MONTH",
            frequencyInterval: 3,
            periodsSkipped: 2,
            reason: "RANGE_HOLDS_NO_WHOLE_PERIOD",
            message: "no whole quarter",
          },
          {
            serviceAgreementId: "agreement-f1",
            frequencyUnit: "WEEK",
            frequencyInterval: 2,
            periodsSkipped: 1,
            reason: "RANGE_HOLDS_NO_WHOLE_PERIOD",
            message: "no whole fortnight",
          },
        ],
      })
    );
    const user = await renderCalendar();

    await user.click(screen.getByRole("button", { name: "Generate visits" }));
    const drawer = await screen.findByRole("dialog");

    expect(
      within(drawer).getByText(
        "Quarterly agreements need a range covering a whole quarter; 2 skipped."
      )
    ).toBeInTheDocument();
    expect(
      within(drawer).getByText(
        "Fortnightly agreements need a range covering a whole fortnight; 1 skipped."
      )
    ).toBeInTheDocument();
  });

  it("generates exactly the week the week view shows", async () => {
    vi.mocked(previewVisitGeneration).mockResolvedValue(buildGenerationImpact());
    const user = await renderCalendar();

    await user.click(screen.getByRole("button", { name: "Week" }));
    await user.click(screen.getByRole("button", { name: "Generate visits" }));
    await screen.findByText("Visits to create");

    const args = vi.mocked(previewVisitGeneration).mock.calls[0][0];
    expect(args.from).toBe("2026-09-14");
    expect(args.to).toBe("2026-09-20");
  });

  it("cancels without generating anything", async () => {
    vi.mocked(previewVisitGeneration).mockResolvedValue(buildGenerationImpact());
    const user = await renderCalendar();

    await user.click(screen.getByRole("button", { name: "Generate visits" }));
    await screen.findByText("Visits to create");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(confirmVisitGeneration).not.toHaveBeenCalled();
  });
});


describe("a day over the branch's limit", () => {
  /** Three Colombo visits on one day, against a cap of two. */
  const crowded = () => [
    generated,
    buildVisit({
      id: "visit-crowd-1",
      visitDate: "2026-09-09",
      windowStartMinute: 630,
      customerName: "Union Bank Kadawatha",
      jobTypeName: "Rodent Control",
    }),
    buildVisit({
      id: "visit-crowd-2",
      visitDate: "2026-09-09",
      windowStartMinute: 720,
      customerName: "Union Bank Kadawatha",
      jobTypeName: "Rodent Control",
    }),
  ];

  it("says so on the day, not only in the generation panel", async () => {
    // The generation warning is shown once and the panel closes. The day goes
    // on carrying the work for weeks with nothing on the calendar saying so.
    mockVisits(crowded());
    await renderCalendar();

    expect(
      await within(grid()).findByText("Over the branch's daily limit")
    ).toBeInTheDocument();
  });

  it("says nothing on a day inside the limit", async () => {
    mockVisits([generated, locked, staffed]);
    await renderCalendar();

    expect(
      within(grid()).queryByText("Over the branch's daily limit")
    ).not.toBeInTheDocument();
  });

  it("does not count a cancelled visit towards the day", async () => {
    // The guard does not count it — cancelled work occupies no part of the day
    // — so a badge that does contradicts the generator the manager is about to
    // trust.
    mockVisits([
      ...crowded(),
      buildVisit({
        id: "visit-cancelled",
        visitDate: "2026-09-10",
        windowStartMinute: 630,
        status: "CANCELLED",
        customerName: "Union Bank Kadawatha",
        jobTypeName: "Rodent Control",
      }),
      buildVisit({
        id: "visit-live-1",
        visitDate: "2026-09-10",
        windowStartMinute: 720,
        customerName: "Union Bank Kadawatha",
        jobTypeName: "Rodent Control",
      }),
      buildVisit({
        id: "visit-live-2",
        visitDate: "2026-09-10",
        windowStartMinute: 810,
        customerName: "Union Bank Kadawatha",
        jobTypeName: "Rodent Control",
      }),
    ]);
    await renderCalendar();

    // The 9th is genuinely over the cap; the 10th carries two live visits and
    // one cancellation, which is not.
    expect(await within(grid()).findAllByText("Over the branch's daily limit")).toHaveLength(
      1
    );
  });

  it("counts each branch's day on its own", async () => {
    // Two Colombo and one Kandy on the same day is not three over a cap of
    // two: the limit is a branch's day, and the branches never share a crew.
    mockVisits([
      ...crowded().slice(0, 2),
      buildVisit({
        id: "visit-kandy",
        visitDate: "2026-09-09",
        windowStartMinute: 810,
        branchCode: "KANDY",
        customerName: "Union Bank Kadawatha",
        jobTypeName: "Rodent Control",
      }),
    ]);
    await renderCalendar();

    expect(
      within(grid()).queryByText("Over the branch's daily limit")
    ).not.toBeInTheDocument();
  });
});

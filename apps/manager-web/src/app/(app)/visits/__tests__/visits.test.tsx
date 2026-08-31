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

  it("cancels without generating anything", async () => {
    vi.mocked(previewVisitGeneration).mockResolvedValue(buildGenerationImpact());
    const user = await renderCalendar();

    await user.click(screen.getByRole("button", { name: "Generate visits" }));
    await screen.findByText("Visits to create");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(confirmVisitGeneration).not.toHaveBeenCalled();
  });
});

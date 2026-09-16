import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return {
    ...actual,
    fetchServiceAgreements: vi.fn(),
    fetchCustomers: vi.fn(),
    fetchJobTypes: vi.fn(),
    fetchSkills: vi.fn(),
    createServiceAgreement: vi.fn(),
    fetchSchedulePreview: vi.fn(),
    changeAgreementStatus: vi.fn(),
  };
});

import ServiceAgreementsPage from "../page";
import {
  ApiError,
  changeAgreementStatus,
  createServiceAgreement,
  fetchCustomers,
  fetchJobTypes,
  fetchSchedulePreview,
  fetchServiceAgreements,
  fetchSkills,
} from "@/lib/api-client";
import {
  buildCustomer,
  buildJobType,
  buildSchedulePreview,
  buildServiceAgreement,
  buildServiceSite,
} from "@/test/fixtures";

// The site is open Mon 06:00-22:00 and Wed 08:00-18:00 — deliberately
// different hours, so the read-only summary can prove it shows each
// weekday's own window rather than one hardcoded value.
const site = buildServiceSite({ id: "site-1", customerId: "customer-1" });
const customer = buildCustomer({ id: "customer-1", name: "Cinnamon Grand Colombo", sites: [site] });
const jobType = buildJobType({ id: "job-1", name: "Termite Control" });
const existingAgreement = buildServiceAgreement({ id: "agreement-1", status: "ACTIVE" });

beforeEach(() => {
  vi.mocked(fetchServiceAgreements).mockResolvedValue({
    items: [existingAgreement],
    total: 1,
    page: 1,
    pageSize: 200,
  });
  vi.mocked(fetchCustomers).mockResolvedValue({
    items: [customer],
    total: 1,
    page: 1,
    pageSize: 200,
  });
  vi.mocked(fetchJobTypes).mockResolvedValue([jobType]);
  vi.mocked(fetchSkills).mockResolvedValue([]);
  vi.mocked(createServiceAgreement).mockReset();
  vi.mocked(fetchSchedulePreview).mockReset();
  vi.mocked(changeAgreementStatus).mockReset();
});

async function openForm() {
  const user = userEvent.setup();
  render(<ServiceAgreementsPage />);
  await screen.findByText("Cinnamon Grand Colombo");
  await user.click(screen.getByRole("button", { name: "Add agreement" }));
  return user;
}

describe("ServiceAgreementsPage", () => {
  it("lists agreements from the API", async () => {
    render(<ServiceAgreementsPage />);
    expect(await screen.findByText("Cinnamon Grand Colombo")).toBeInTheDocument();
    expect(screen.getByText("Termite Control")).toBeInTheDocument();
  });

  it("names a cadence by its interval, not by its unit alone", async () => {
    // ULK: a fortnightly agreement (1 visit, every 2 weeks) was rendered
    // "1x / week" — the interval was dropped — so every fortnightly contract
    // read as weekly on the screen a manager answers "how often do we serve
    // this customer" from. A coordinator concluded the scheduler was dropping
    // visits; it was not.
    vi.mocked(fetchServiceAgreements).mockResolvedValue({
      items: [
        buildServiceAgreement({
          id: "agreement-fortnightly",
          customerName: "Synthetic Client 60",
          frequencyCount: 1,
          frequencyInterval: 2,
          frequencyUnit: "WEEK",
          frequencyLabel: "Fortnightly",
        }),
        buildServiceAgreement({
          id: "agreement-two-monthly",
          customerName: "Synthetic Client 79",
          frequencyCount: 1,
          frequencyInterval: 2,
          frequencyUnit: "MONTH",
          frequencyLabel: "Two-monthly",
        }),
      ],
      total: 2,
      page: 1,
      pageSize: 200,
    });

    render(<ServiceAgreementsPage />);

    expect(await screen.findByText("Fortnightly")).toBeInTheDocument();
    expect(screen.getByText("Two-monthly")).toBeInTheDocument();
    expect(screen.queryByText("1x / week")).not.toBeInTheDocument();
    expect(screen.queryByText("1x / month")).not.toBeInTheDocument();
  });

  it("lets a manager set the interval, so a fortnightly agreement can be created at all", async () => {
    const user = await openForm();

    const interval = screen.getByLabelText("Every");
    await user.clear(interval);
    await user.type(interval, "2");

    // The cadence is named back before it is saved: a manager should not have
    // to save an agreement to find out they built a weekly one.
    expect(await screen.findByText("fortnightly")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    await user.type(screen.getByLabelText("Start date"), "2026-09-17");

    vi.mocked(createServiceAgreement).mockResolvedValue(
      buildServiceAgreement({ frequencyInterval: 2, frequencyLabel: "Fortnightly" }),
    );
    vi.mocked(fetchSchedulePreview).mockResolvedValue(buildSchedulePreview());

    await user.click(screen.getByRole("button", { name: "Save agreement" }));

    await vi.waitFor(() =>
      expect(createServiceAgreement).toHaveBeenCalledWith(
        expect.objectContaining({ frequencyCount: 1, frequencyInterval: 2, frequencyUnit: "WEEK" }),
      ),
    );
  });

  it("is reachable by keyboard and exposes accessible labels for every field", async () => {
    await openForm();

    expect(screen.getByLabelText("Customer")).toBeInTheDocument();
    expect(screen.getByLabelText("Site")).toBeInTheDocument();
    expect(screen.getByLabelText("Job type")).toBeInTheDocument();
    expect(screen.getByLabelText("Visits")).toBeInTheDocument();
    expect(screen.getByLabelText("Crew size")).toBeInTheDocument();
    expect(screen.getByLabelText("Start date")).toBeInTheDocument();
    expect(screen.getByLabelText("Customer")).toHaveFocus();
  });

  it("excludes an inactive site from the picker, even for an active customer (ULK-O09)", async () => {
    const inactiveSite = buildServiceSite({
      id: "site-inactive",
      customerId: "customer-1",
      name: "Closed Warehouse",
      isActive: false,
    });
    vi.mocked(fetchCustomers).mockResolvedValue({
      items: [{ ...customer, sites: [site, inactiveSite] }],
      total: 1,
      page: 1,
      pageSize: 200,
    });

    const user = await openForm();
    await user.click(screen.getByLabelText("Site"));

    expect(await screen.findByRole("option", { name: site.name })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Closed Warehouse" })).not.toBeInTheDocument();
  });

  it("shows customer and site names after selection instead of their internal ids", async () => {
    const user = await openForm();
    const customerTrigger = screen.getByLabelText("Customer");

    await user.click(customerTrigger);
    await user.click(await screen.findByRole("option", { name: customer.name }));

    expect(customerTrigger).toHaveTextContent(customer.name);
    expect(customerTrigger).not.toHaveTextContent(customer.id);

    const siteTrigger = screen.getByLabelText("Site");
    await user.click(siteTrigger);
    await user.click(await screen.findByRole("option", { name: site.name }));

    expect(siteTrigger).toHaveTextContent(site.name);
    expect(siteTrigger).not.toHaveTextContent(site.id);
  });

  it("says the start date sets the cycle, not only when the work begins", async () => {
    // A fortnight belongs to the agreement: its periods are counted from this
    // day. Moving it re-phases every future one, and the next generation run
    // then plans different days — which is not something to discover from a
    // calendar that has quietly moved.
    await openForm();

    expect(
      screen.getByText(/The start date also sets the cycle/),
    ).toBeInTheDocument();
    expect(screen.getByText(/re-phases every future\s+period/)).toBeInTheDocument();
  });

  it("requires a start date before saving", async () => {
    const user = await openForm();

    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    await user.click(screen.getByRole("button", { name: "Save agreement" }));

    expect(await screen.findByText("Start date is required")).toBeInTheDocument();
    expect(createServiceAgreement).not.toHaveBeenCalled();
  });

  it("prevents marking a day preferred before it is allowed (subset enforcement)", async () => {
    const user = await openForm();

    expect(document.getElementById("preferred-FRIDAY")).toBeDisabled();

    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    expect(document.getElementById("preferred-MONDAY")).toBeEnabled();
    expect(document.getElementById("preferred-FRIDAY")).toBeDisabled();
  });

  it("un-checking an allowed day also drops it from preferred", async () => {
    const user = await openForm();

    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    await user.click(screen.getByLabelText("Mon", { selector: "#preferred-MONDAY" }));
    expect(document.getElementById("preferred-MONDAY")).toBeChecked();

    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    expect(document.getElementById("preferred-MONDAY")).not.toBeChecked();
    expect(document.getElementById("preferred-MONDAY")).toBeDisabled();
  });

  it("shows each weekday's own opening hours in the read-only summary", async () => {
    await openForm();

    // Monday: 06:00-22:00, Wednesday: 08:00-18:00 — different windows, both visible.
    const summary = await screen.findByText(/opening hours \(read-only/i);
    const list = summary.closest("div")?.querySelector("ul");
    expect(list?.textContent).toContain("Mon: 6:00 AM–10:00 PM");
    expect(list?.textContent).toContain("Wed: 8:00 AM–6:00 PM");
    expect(list?.textContent).toContain("Tue: Closed");
  });

  it("saves the agreement, then shows a loading state and the real preview, including shortfalls", async () => {
    const created = buildServiceAgreement({ id: "agreement-2" });
    vi.mocked(createServiceAgreement).mockResolvedValue(created);
    // Hold the preview response until after the loading state has been
    // asserted. A wall-clock timeout races with the user interactions above
    // on slower CI runners and can resolve before this assertion runs.
    let resolvePreview!: (preview: ReturnType<typeof buildSchedulePreview>) => void;
    const previewPromise = new Promise<ReturnType<typeof buildSchedulePreview>>((resolve) => {
      resolvePreview = resolve;
    });
    vi.mocked(fetchSchedulePreview).mockReturnValue(previewPromise);

    const user = await openForm();
    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    await user.type(screen.getByLabelText("Start date"), "2026-09-07");
    await user.click(screen.getByRole("button", { name: "Save agreement" }));

    expect(await screen.findByText("Service agreement created")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Calculating preview…");

    resolvePreview(
      buildSchedulePreview({
        shortfalls: [
          {
            periodStart: "2026-09-07",
            periodEnd: "2026-09-13",
            requested: 2,
            scheduled: 1,
            reason: "NOT_ENOUGH_ALLOWED_DAYS",
            message: "Only 1 of the 2 requested visits could be placed this week.",
          },
        ],
      })
    );

    expect(
      await screen.findByText("Only 1 of the 2 requested visits could be placed this week.")
    ).toBeInTheDocument();
    expect(screen.getByText(/2026-09-07/)).toBeInTheDocument();
  });

  it("shows an error if the preview fails to load, without losing the created agreement", async () => {
    vi.mocked(createServiceAgreement).mockResolvedValue(buildServiceAgreement());
    vi.mocked(fetchSchedulePreview).mockRejectedValue(
      new ApiError({ code: "UNKNOWN_ERROR", message: "Could not load the preview." })
    );

    const user = await openForm();
    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    await user.type(screen.getByLabelText("Start date"), "2026-09-07");
    await user.click(screen.getByRole("button", { name: "Save agreement" }));

    expect(await screen.findByText("Service agreement created")).toBeInTheDocument();
    expect(await screen.findByText("Could not load the preview.")).toBeInTheDocument();
  });

  it("surfaces a backend rejection (e.g. an unsatisfiable agreement) without closing the form", async () => {
    vi.mocked(createServiceAgreement).mockRejectedValue(
      new ApiError({ code: "AGREEMENT_UNSATISFIABLE", message: "No visit can be placed at all." })
    );

    const user = await openForm();
    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    await user.type(screen.getByLabelText("Start date"), "2026-09-07");
    await user.click(screen.getByRole("button", { name: "Save agreement" }));

    expect(await screen.findByText("No visit can be placed at all.")).toBeInTheDocument();
    // Still in the form, not the confirmation view.
    expect(screen.getByLabelText("Customer")).toBeInTheDocument();
  });

  it("pauses an active agreement from the table", async () => {
    vi.mocked(changeAgreementStatus).mockResolvedValue(
      buildServiceAgreement({ status: "PAUSED" })
    );
    const user = userEvent.setup();
    render(<ServiceAgreementsPage />);
    await screen.findByText("Cinnamon Grand Colombo");

    await user.click(screen.getByRole("button", { name: "Pause" }));

    expect(changeAgreementStatus).toHaveBeenCalledWith("agreement-1", { status: "PAUSED" });
  });

  it("refreshes with the filter in force when a status change finishes, not the one it started under", async () => {
    // A Pause request is still in flight when the manager switches to
    // Archived. The refresh that follows the Pause must ask for archived
    // rows; a stale one would ask for current rows and win the race, leaving
    // current agreements on screen under a control that says Archived.
    const archived = buildServiceAgreement({
      id: "agreement-archived",
      customerName: "Harbour Logistics",
      siteName: "Warehouse South",
      status: "ARCHIVED",
      isActive: false,
    });
    vi.mocked(fetchServiceAgreements).mockImplementation((query) =>
      Promise.resolve(
        query?.status === "ARCHIVED"
          ? { items: [archived], total: 1, page: 1, pageSize: 200 }
          : { items: [existingAgreement], total: 1, page: 1, pageSize: 200 }
      )
    );
    let finishPause!: () => void;
    vi.mocked(changeAgreementStatus).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishPause = () => resolve({ ...existingAgreement, status: "PAUSED" });
        })
    );

    const user = userEvent.setup();
    render(<ServiceAgreementsPage />);
    await screen.findByText("Cinnamon Grand Colombo");

    await user.click(screen.getByRole("button", { name: "Pause" }));
    await user.click(screen.getByLabelText("Status"));
    await user.click(await screen.findByRole("option", { name: "Archived" }));
    await screen.findByText("Harbour Logistics");

    const callsBefore = vi.mocked(fetchServiceAgreements).mock.calls.length;
    finishPause();
    await vi.waitFor(() =>
      expect(vi.mocked(fetchServiceAgreements).mock.calls.length).toBeGreaterThan(callsBefore)
    );
    const lastQuery = vi.mocked(fetchServiceAgreements).mock.calls.at(-1)?.[0];
    expect(lastQuery).toEqual(expect.objectContaining({ status: "ARCHIVED" }));

    expect(await screen.findByText("Harbour Logistics")).toBeInTheDocument();
    expect(screen.queryByText("Cinnamon Grand Colombo")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Status")).toHaveTextContent("Archived");
  });

  it("reaches archived agreements through the Status filter and labels them in text (ULK-O08)", async () => {
    // An import that reads an agreement as no longer serviced archives it, so
    // "Archived" is also how an imported-inactive agreement is found.
    const archived = buildServiceAgreement({
      id: "agreement-archived",
      customerName: "Harbour Logistics",
      siteName: "Warehouse South",
      status: "ARCHIVED",
      isActive: false,
    });
    vi.mocked(fetchServiceAgreements).mockImplementation((query) =>
      Promise.resolve(
        query?.status === "ARCHIVED"
          ? { items: [archived], total: 1, page: 1, pageSize: 200 }
          : { items: [existingAgreement], total: 1, page: 1, pageSize: 200 }
      )
    );

    const user = userEvent.setup();
    render(<ServiceAgreementsPage />);
    await screen.findByText("Cinnamon Grand Colombo");
    // The default look never asked for archived rows at all.
    expect(fetchServiceAgreements).toHaveBeenCalledWith(
      expect.not.objectContaining({ status: expect.anything() })
    );

    // The trigger must read as words, not as the enum value behind it.
    expect(screen.getByLabelText("Status")).toHaveTextContent("Active & paused");
    await user.click(screen.getByLabelText("Status"));
    await user.click(await screen.findByRole("option", { name: "Archived" }));

    expect(await screen.findByText("Harbour Logistics")).toBeInTheDocument();
    expect(fetchServiceAgreements).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ARCHIVED" })
    );

    const row = screen.getByRole("row", { name: /Harbour Logistics/ });
    // Labelled in text, not colour alone.
    expect(within(row).getByText("Archived")).toBeInTheDocument();
    // Read-only: an archived agreement offers no way back into scheduling.
    expect(within(row).queryByRole("button", { name: "Resume" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Pause" })).toBeNull();
  });

  it("renders a window ending at minute 1440 as ending at midnight, not noon", async () => {
    // The API accepts 1440 as an end. Folding hour 24 into a 12-hour clock
    // reads as 12:00 PM, which would show an end-of-day window ending at noon.
    const untilMidnight = buildServiceAgreement({
      id: "agreement-midnight",
      customerName: "Harbour Logistics",
      siteName: "Warehouse South",
      serviceWindowStartMinute: 9 * 60,
      serviceWindowEndMinute: 24 * 60,
    });
    vi.mocked(fetchServiceAgreements).mockResolvedValue({
      items: [untilMidnight],
      total: 1,
      page: 1,
      pageSize: 200,
    });

    render(<ServiceAgreementsPage />);

    const row = await screen.findByRole("row", { name: /Harbour Logistics/ });
    expect(within(row).getByText("9:00 AM – midnight")).toBeInTheDocument();
    expect(within(row).queryByText(/12:00 PM/)).not.toBeInTheDocument();
  });

  it("shows each saved agreement's own crew size and service window, saying the site's hours apply when it has none (ULK-O08)", async () => {
    const withWindow = buildServiceAgreement({
      id: "agreement-window",
      customerName: "Harbour Logistics",
      siteName: "Warehouse North",
      crewSize: 3,
      serviceWindowStartMinute: 9 * 60,
      serviceWindowEndMinute: 13 * 60,
    });
    const withoutWindow = buildServiceAgreement({
      id: "agreement-no-window",
      customerName: "Peak Hotels",
      siteName: "Rooftop Kitchen",
      crewSize: 5,
      serviceWindowStartMinute: null,
      serviceWindowEndMinute: null,
    });
    vi.mocked(fetchServiceAgreements).mockResolvedValue({
      items: [withWindow, withoutWindow],
      total: 2,
      page: 1,
      pageSize: 200,
    });

    render(<ServiceAgreementsPage />);

    const windowRow = await screen.findByRole("row", { name: /Harbour Logistics/ });
    expect(within(windowRow).getByText("3 people")).toBeInTheDocument();
    expect(within(windowRow).getByText("9:00 AM – 1:00 PM")).toBeInTheDocument();

    const noWindowRow = screen.getByRole("row", { name: /Peak Hotels/ });
    // Its own crew size, not the other agreement's.
    expect(within(noWindowRow).getByText("5 people")).toBeInTheDocument();
    expect(within(noWindowRow).getByText("Site's hours apply")).toBeInTheDocument();
    // And no invented window: not the other agreement's, and not a default
    // like 08:00-17:00 dressed up as this agreement's fact.
    expect(within(noWindowRow).queryByText(/AM|PM/)).toBeNull();
  });
});

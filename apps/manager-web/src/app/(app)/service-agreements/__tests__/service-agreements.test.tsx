import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
    previewVisitGeneration: vi.fn(),
    confirmVisitGeneration: vi.fn(),
    changeAgreementStatus: vi.fn(),
  };
});

import ServiceAgreementsPage from "../page";
import {
  ApiError,
  changeAgreementStatus,
  confirmVisitGeneration,
  createServiceAgreement,
  fetchCustomers,
  fetchJobTypes,
  fetchServiceAgreements,
  fetchSkills,
  previewVisitGeneration,
} from "@/lib/api-client";
import { buildCustomer, buildJobType, buildServiceAgreement, buildServiceSite } from "@/test/fixtures";

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
  vi.mocked(previewVisitGeneration).mockReset();
  vi.mocked(confirmVisitGeneration).mockReset();
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

  // Far enough out that a fixed future date reads clearly in assertions,
  // regardless of which day the suite actually runs on.
  const FAR_FUTURE_START = "2099-01-06";

  it("shows calendar placement without implying staffing or publication", async () => {
    const created = buildServiceAgreement({
      id: "agreement-2",
      startDate: FAR_FUTURE_START,
      branchCode: "COLOMBO",
      onboardingPlan: {
        status: "PLANNED",
        from: FAR_FUTURE_START,
        to: "2099-12-06",
        visitsPlanned: 24,
        shortfallPeriods: 0,
        overCapacityDays: 0,
        message: null,
      },
    });
    vi.mocked(createServiceAgreement).mockResolvedValue(created);

    const user = await openForm();
    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    await user.type(screen.getByLabelText("Start date"), FAR_FUTURE_START);
    await user.click(screen.getByRole("button", { name: "Save agreement" }));

    expect(await screen.findByText("Service agreement created")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Visits placed on calendar" })).toBeInTheDocument();
    expect(screen.getByText(/24 visits placed on the calendar between/)).toBeInTheDocument();
    expect(
      screen.getByText(/crew and vehicle assignment is still pending/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/published/i)).not.toBeInTheDocument();
    // The "existing work" guarantee is stated unconditionally.
    expect(
      screen.getByText(/every other customer's existing schedule is untouched/i)
    ).toBeInTheDocument();

    // The create response placed visit dates, but did not staff or publish them.
    expect(screen.queryByRole("button", { name: "Schedule now" })).not.toBeInTheDocument();
    expect(previewVisitGeneration).not.toHaveBeenCalled();
    expect(confirmVisitGeneration).not.toHaveBeenCalled();
  });

  it("shows placement shortfalls without implying that visits were staffed", async () => {
    const created = buildServiceAgreement({
      id: "agreement-shortfall",
      startDate: FAR_FUTURE_START,
      branchCode: "COLOMBO",
      onboardingPlan: {
        status: "PLANNED_WITH_SHORTFALLS",
        from: FAR_FUTURE_START,
        to: "2099-12-06",
        visitsPlanned: 20,
        shortfallPeriods: 3,
        overCapacityDays: 2,
        message: null,
      },
    });
    vi.mocked(createServiceAgreement).mockResolvedValue(created);

    const user = await openForm();
    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    await user.type(screen.getByLabelText("Start date"), FAR_FUTURE_START);
    await user.click(screen.getByRole("button", { name: "Save agreement" }));

    expect(await screen.findByRole("heading", { name: "Visits placed with warnings" })).toBeInTheDocument();
    expect(screen.getByText(/20 visits placed on the calendar between/)).toBeInTheDocument();
    expect(
      screen.getByText(/crew and vehicle assignment is still pending/)
    ).toBeInTheDocument();
    expect(screen.getByText(/3 periods could not fit all requested visit dates/)).toBeInTheDocument();
    expect(screen.getByText(/2 days are already carrying more than the branch plans for/)).toBeInTheDocument();

    expect(previewVisitGeneration).not.toHaveBeenCalled();
    expect(confirmVisitGeneration).not.toHaveBeenCalled();
  });

  it("shows over-capacity days without claiming zero placement shortfalls", async () => {
    const created = buildServiceAgreement({
      id: "agreement-over-capacity-only",
      startDate: FAR_FUTURE_START,
      branchCode: "COLOMBO",
      onboardingPlan: {
        status: "PLANNED_WITH_SHORTFALLS",
        from: FAR_FUTURE_START,
        to: "2099-12-06",
        visitsPlanned: 24,
        shortfallPeriods: 0,
        overCapacityDays: 2,
        message: null,
      },
    });
    vi.mocked(createServiceAgreement).mockResolvedValue(created);

    const user = await openForm();
    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    await user.type(screen.getByLabelText("Start date"), FAR_FUTURE_START);
    await user.click(screen.getByRole("button", { name: "Save agreement" }));

    expect(
      await screen.findByRole("heading", { name: "Visits placed with warnings" })
    ).toBeInTheDocument();
    expect(screen.getByText(/2 days are already carrying more than the branch plans for/)).toBeInTheDocument();
    expect(screen.queryByText(/0 periods could not fit all requested visit dates/)).not.toBeInTheDocument();

    expect(previewVisitGeneration).not.toHaveBeenCalled();
    expect(confirmVisitGeneration).not.toHaveBeenCalled();
  });

  it("shows why date placement failed, without losing the created agreement", async () => {
    const created = buildServiceAgreement({
      id: "agreement-failed",
      startDate: FAR_FUTURE_START,
      branchCode: "COLOMBO",
      onboardingPlan: {
        status: "FAILED",
        from: FAR_FUTURE_START,
        to: "2099-12-06",
        visitsPlanned: 0,
        shortfallPeriods: 0,
        overCapacityDays: 0,
        message: "Every allowed day is already at branch capacity for the next twelve months.",
      },
    });
    vi.mocked(createServiceAgreement).mockResolvedValue(created);

    const user = await openForm();
    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    await user.type(screen.getByLabelText("Start date"), FAR_FUTURE_START);
    await user.click(screen.getByRole("button", { name: "Save agreement" }));

    // The agreement was still created, even though no visit dates were placed.
    expect(await screen.findByText("Service agreement created")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Date placement failed" })).toBeInTheDocument();
    expect(
      screen.getByText(/the result below shows whether visit dates could be placed on the calendar/i)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/this agreement's visit dates are placed on the calendar/i)
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Every allowed day is already at branch capacity for the next twelve months.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/visits placed on the calendar between/)).not.toBeInTheDocument();

    expect(previewVisitGeneration).not.toHaveBeenCalled();
    expect(confirmVisitGeneration).not.toHaveBeenCalled();
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

  /**
   * An active agreement that has generated nothing must not be invisible.
   *
   * Synthetic Client 79 has an active two-monthly agreement and zero visits
   * in September, October, November and December. It appears on no calendar,
   * in no queue and in no schedule run — there is nothing of it to appear —
   * and two testers raised it independently before anything on screen said a
   * word about it. This list is the only place that can.
   */
  it("marks an agreement that has generated no visits, and gathers them behind a filter", async () => {
    const barren = buildServiceAgreement({
      id: "agreement-barren",
      customerName: "Synthetic Client 79",
      siteName: "Rear Store",
      status: "ACTIVE",
      isActive: true,
      generatedVisitCount: 0,
    });
    vi.mocked(fetchServiceAgreements).mockImplementation((query) =>
      Promise.resolve(
        query?.withoutVisits
          ? { items: [barren], total: 1, page: 1, pageSize: 200 }
          : { items: [existingAgreement, barren], total: 2, page: 1, pageSize: 200 }
      )
    );

    const user = userEvent.setup();
    render(<ServiceAgreementsPage />);
    await screen.findByText("Synthetic Client 79");

    // Said on the row, in words, without being asked for.
    const barrenRow = screen.getByRole("row", { name: /Synthetic Client 79/ });
    expect(within(barrenRow).getByText("No visits generated")).toBeInTheDocument();
    // And not said about an agreement that has produced work.
    const healthyRow = screen.getByRole("row", { name: /Cinnamon Grand Colombo/ });
    expect(within(healthyRow).queryByText("No visits generated")).toBeNull();

    // The default look asks the server for everything, not only these.
    expect(fetchServiceAgreements).toHaveBeenCalledWith(
      expect.not.objectContaining({ withoutVisits: expect.anything() })
    );

    expect(screen.getByLabelText("Visits generated")).toHaveTextContent("Any");
    await user.click(screen.getByLabelText("Visits generated"));
    await user.click(await screen.findByRole("option", { name: "None generated" }));

    await waitFor(() => {
      expect(screen.queryByText("Cinnamon Grand Colombo")).toBeNull();
    });
    expect(fetchServiceAgreements).toHaveBeenCalledWith(
      expect.objectContaining({ withoutVisits: true })
    );
    expect(screen.getByText("Synthetic Client 79")).toBeInTheDocument();
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

  describe("job duration slider", () => {
    it("initializes duration from the selected job type's default, in the field, the slider and the readable text", async () => {
      const user = await openForm();

      await user.click(screen.getByLabelText("Job type"));
      await user.click(await screen.findByRole("option", { name: "Termite Control" }));

      expect(screen.getByLabelText("Duration (minutes)")).toHaveValue(90);
      expect(screen.getByText("1 hour 30 minutes")).toBeInTheDocument();
      expect(screen.getByRole("slider", { name: "Job duration" })).toHaveValue("90");
    });

    it("moves the numeric field in exact 15-minute steps when the slider is used (60 → 75 → 90)", async () => {
      const user = await openForm();
      const slider = screen.getByRole("slider", { name: "Job duration" });
      const durationInput = screen.getByLabelText("Duration (minutes)") as HTMLInputElement;

      // The form's own default (60) — already on the slider's own grid
      // (min 15, step 15), so a single step lands on a real quarter-hour.
      expect(durationInput).toHaveValue(60);

      slider.focus();
      await user.keyboard("{ArrowRight}");
      expect(durationInput).toHaveValue(75);
      expect(screen.getByText("1 hour 15 minutes")).toBeInTheDocument();

      await user.keyboard("{ArrowRight}");
      expect(durationInput).toHaveValue(90);
      expect(screen.getByText("1 hour 30 minutes")).toBeInTheDocument();
    });

    it("moves a job type's own default in the same exact steps (90 → 105)", async () => {
      const user = await openForm();
      await user.click(screen.getByLabelText("Job type"));
      await user.click(await screen.findByRole("option", { name: "Termite Control" }));
      const durationInput = screen.getByLabelText("Duration (minutes)") as HTMLInputElement;
      expect(durationInput).toHaveValue(90);

      const slider = screen.getByRole("slider", { name: "Job duration" });
      slider.focus();
      await user.keyboard("{ArrowRight}");

      expect(durationInput).toHaveValue(105);
      expect(screen.getByText("1 hour 45 minutes")).toBeInTheDocument();
    });

    it("moves an off-grid manager-typed duration onto the slider's real grid once the slider is operated", async () => {
      const user = await openForm();
      const durationInput = screen.getByLabelText("Duration (minutes)") as HTMLInputElement;

      await user.clear(durationInput);
      await user.type(durationInput, "47");
      expect(durationInput).toHaveValue(47);

      const slider = screen.getByRole("slider", { name: "Job duration" });
      slider.focus();
      await user.keyboard("{ArrowRight}");

      // Base UI rounds the off-grid 47 to its nearest grid point (45) before
      // applying the step, landing on 60 rather than 47 + 15 = 62.
      expect(durationInput).toHaveValue(60);
      expect(screen.getByText("1 hour")).toBeInTheDocument();
    });

    it("keeps a manager-typed duration exact, without snapping it to the nearest slider step", async () => {
      const user = await openForm();
      const durationInput = screen.getByLabelText("Duration (minutes)");

      await user.clear(durationInput);
      await user.type(durationInput, "47");

      expect(durationInput).toHaveValue(47);
      expect(screen.getByText("47 minutes")).toBeInTheDocument();
      // The slider reflects the exact value too — never rounded to a step.
      expect(screen.getByRole("slider", { name: "Job duration" })).toHaveValue("47");
    });

    it("rejects a duration past 1440 minutes with the API's own bound, instead of silently clamping it", async () => {
      const user = await openForm();
      await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
      await user.type(screen.getByLabelText("Start date"), "2026-09-07");

      const durationInput = screen.getByLabelText("Duration (minutes)");
      await user.clear(durationInput);
      await user.type(durationInput, "1500");

      await user.click(screen.getByRole("button", { name: "Save agreement" }));

      expect(
        await screen.findByText("1440 minutes (24 hours) is the longest a single visit can run"),
      ).toBeInTheDocument();
      // The manager's own number is still there — not reset or clamped to 1440.
      expect(durationInput).toHaveValue(1500);
      expect(createServiceAgreement).not.toHaveBeenCalled();
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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
import { rangeForGeneration } from "@/lib/calendar";
import {
  buildCustomer,
  buildGenerationImpact,
  buildJobType,
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
    vi.mocked(previewVisitGeneration).mockResolvedValue(buildGenerationImpact());

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

  // Far enough out that `todayIso()` at real test-run time never overtakes
  // it — the page always asks about `max(startDate, today)`, and a fixed
  // future date keeps that comparison deterministic regardless of which day
  // the suite actually runs on.
  const FAR_FUTURE_START = "2099-01-06";
  const expectedWindow = rangeForGeneration(FAR_FUTURE_START, "month");

  it("saves the agreement, then shows scheduling progress and the generated dates, resources and conflicts", async () => {
    const created = buildServiceAgreement({
      id: "agreement-2",
      startDate: FAR_FUTURE_START,
      branchCode: "COLOMBO",
    });
    vi.mocked(createServiceAgreement).mockResolvedValue(created);
    // Hold the preview response until after the loading state has been
    // asserted. A wall-clock timeout races with the user interactions above
    // on slower CI runners and can resolve before this assertion runs.
    let resolvePreview!: (impact: ReturnType<typeof buildGenerationImpact>) => void;
    const previewPromise = new Promise<ReturnType<typeof buildGenerationImpact>>((resolve) => {
      resolvePreview = resolve;
    });
    vi.mocked(previewVisitGeneration).mockReturnValue(previewPromise);

    const user = await openForm();
    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    await user.type(screen.getByLabelText("Start date"), FAR_FUTURE_START);
    await user.click(screen.getByRole("button", { name: "Save agreement" }));

    expect(await screen.findByText("Service agreement created")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Calculating schedule preview…");
    // The "existing work" guarantee is stated up front, before the run even
    // answers — it holds regardless of what comes back.
    expect(
      screen.getByText(/every other customer's existing schedule is untouched/)
    ).toBeInTheDocument();

    expect(previewVisitGeneration).toHaveBeenCalledWith({
      from: FAR_FUTURE_START,
      to: expectedWindow.to,
      branchCode: "COLOMBO",
      serviceAgreementIds: ["agreement-2"],
    });

    resolvePreview(
      buildGenerationImpact({
        from: FAR_FUTURE_START,
        to: expectedWindow.to,
        additions: [
          {
            serviceAgreementId: "agreement-2",
            customerName: created.customerName,
            siteName: created.siteName,
            visitDate: FAR_FUTURE_START,
            windowStartMinute: 540,
            windowEndMinute: 1020,
            durationMinutes: 90,
            requiredCrewSize: 3,
            branchCode: "COLOMBO",
            isPreferredDay: true,
            placement: "EARLIEST",
          },
        ],
        shortfalls: [
          {
            serviceAgreementId: "agreement-2",
            customerName: created.customerName,
            siteName: created.siteName,
            periodStart: FAR_FUTURE_START,
            periodEnd: "2099-01-12",
            requested: 2,
            scheduled: 1,
            reason: "NOT_ENOUGH_ALLOWED_DAYS",
            reasons: ["NOT_ENOUGH_ALLOWED_DAYS"],
            message: "Only 1 of the 2 requested visits could be placed this week.",
          },
        ],
      })
    );

    // Generated dates and their proposed resources (window + crew size).
    const visitRow = (await screen.findByText("crew of 3", { exact: false })).closest("li")!;
    expect(within(visitRow).getByText("Preferred")).toBeInTheDocument();
    expect(screen.getByText(/9:00 AM–5:00 PM · crew of 3/)).toBeInTheDocument();

    // Unresolved capacity/staffing conflicts.
    expect(
      screen.getByText("Only 1 of the 2 requested visits could be placed this week.")
    ).toBeInTheDocument();
    // The stable reason code is read too, translated to words — never shown raw.
    expect(screen.getByText("Not enough allowed days")).toBeInTheDocument();
    expect(screen.queryByText("NOT_ENOUGH_ALLOWED_DAYS")).not.toBeInTheDocument();

    // A preview writes nothing, so an explicit action is offered rather than
    // treating the drawer as already done.
    expect(screen.getByRole("button", { name: "Schedule now" })).toBeInTheDocument();
  });

  it("shows every reason a shortfall failed for, not just the first", async () => {
    const created = buildServiceAgreement({
      id: "agreement-multi-reason",
      startDate: FAR_FUTURE_START,
      branchCode: "COLOMBO",
    });
    vi.mocked(createServiceAgreement).mockResolvedValue(created);
    vi.mocked(previewVisitGeneration).mockResolvedValue(
      buildGenerationImpact({
        from: FAR_FUTURE_START,
        to: expectedWindow.to,
        shortfalls: [
          {
            serviceAgreementId: "agreement-multi-reason",
            customerName: created.customerName,
            siteName: created.siteName,
            periodStart: FAR_FUTURE_START,
            periodEnd: "2099-01-12",
            requested: 2,
            scheduled: 0,
            reason: "NOT_ENOUGH_ALLOWED_DAYS",
            reasons: ["NOT_ENOUGH_ALLOWED_DAYS", "BRANCH_DAY_AT_CAPACITY"],
            message: "Only 0 of the 2 requested visits could be placed this week. The one allowed day is already full.",
          },
        ],
      })
    );

    const user = await openForm();
    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    await user.type(screen.getByLabelText("Start date"), FAR_FUTURE_START);
    await user.click(screen.getByRole("button", { name: "Save agreement" }));

    expect(await screen.findByText("Not enough allowed days")).toBeInTheDocument();
    expect(screen.getByText("Branch day at capacity")).toBeInTheDocument();
  });

  it("writes the previewed visits when a manager explicitly schedules them", async () => {
    const created = buildServiceAgreement({
      id: "agreement-2",
      startDate: FAR_FUTURE_START,
      branchCode: "COLOMBO",
    });
    vi.mocked(createServiceAgreement).mockResolvedValue(created);
    vi.mocked(previewVisitGeneration).mockResolvedValue(
      buildGenerationImpact({
        from: FAR_FUTURE_START,
        to: expectedWindow.to,
        additions: [
          {
            serviceAgreementId: "agreement-2",
            customerName: created.customerName,
            siteName: created.siteName,
            visitDate: FAR_FUTURE_START,
            windowStartMinute: 540,
            windowEndMinute: 1020,
            durationMinutes: 90,
            requiredCrewSize: 1,
            branchCode: "COLOMBO",
            isPreferredDay: false,
            placement: "EARLIEST",
          },
        ],
      })
    );
    vi.mocked(confirmVisitGeneration).mockResolvedValue(
      buildGenerationImpact({
        from: FAR_FUTURE_START,
        to: expectedWindow.to,
        isPreview: false,
        scheduleRunId: "run-1",
        additions: [
          {
            serviceAgreementId: "agreement-2",
            customerName: created.customerName,
            siteName: created.siteName,
            visitDate: FAR_FUTURE_START,
            windowStartMinute: 540,
            windowEndMinute: 1020,
            durationMinutes: 90,
            requiredCrewSize: 1,
            branchCode: "COLOMBO",
            isPreferredDay: false,
            placement: "EARLIEST",
          },
        ],
      })
    );

    const user = await openForm();
    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    await user.type(screen.getByLabelText("Start date"), FAR_FUTURE_START);
    await user.click(screen.getByRole("button", { name: "Save agreement" }));

    await user.click(await screen.findByRole("button", { name: "Schedule now" }));

    await waitFor(() =>
      expect(confirmVisitGeneration).toHaveBeenCalledWith({
        from: FAR_FUTURE_START,
        to: expectedWindow.to,
        branchCode: "COLOMBO",
        serviceAgreementIds: ["agreement-2"],
      })
    );

    // Written now, not merely proposed — the heading and the visit list both
    // reflect the confirmed run, and the action to write it again is gone.
    expect(await screen.findByRole("heading", { name: "Scheduled" })).toBeInTheDocument();
    expect(screen.getByText(/1 visit scheduled between/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Schedule now" })).not.toBeInTheDocument();
  });

  it("discards a stale preview from an earlier agreement closed and reopened for a new one", async () => {
    const agreementA = buildServiceAgreement({
      id: "agreement-a",
      customerName: "Agreement A Customer",
      startDate: FAR_FUTURE_START,
      branchCode: "COLOMBO",
    });
    const agreementB = buildServiceAgreement({
      id: "agreement-b",
      customerName: "Agreement B Customer",
      startDate: FAR_FUTURE_START,
      branchCode: "COLOMBO",
    });

    let resolvePreviewA!: (impact: ReturnType<typeof buildGenerationImpact>) => void;
    const previewAPromise = new Promise<ReturnType<typeof buildGenerationImpact>>((resolve) => {
      resolvePreviewA = resolve;
    });
    vi.mocked(createServiceAgreement).mockResolvedValueOnce(agreementA);
    vi.mocked(previewVisitGeneration).mockReturnValueOnce(previewAPromise);

    const user = await openForm();
    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    await user.type(screen.getByLabelText("Start date"), FAR_FUTURE_START);
    await user.click(screen.getByRole("button", { name: "Save agreement" }));

    expect(await screen.findByText("Service agreement created")).toBeInTheDocument();
    expect(screen.getByText("Agreement A Customer")).toBeInTheDocument();

    // Closed — via the still-enabled Done button — while A's preview is
    // still in flight, then reopened for a different agreement.
    await user.click(screen.getByRole("button", { name: "Done" }));

    vi.mocked(createServiceAgreement).mockResolvedValueOnce(agreementB);
    vi.mocked(previewVisitGeneration).mockResolvedValueOnce(
      buildGenerationImpact({ from: FAR_FUTURE_START, to: expectedWindow.to })
    );

    await user.click(screen.getByRole("button", { name: "Add agreement" }));
    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    await user.type(screen.getByLabelText("Start date"), FAR_FUTURE_START);
    await user.click(screen.getByRole("button", { name: "Save agreement" }));

    expect(await screen.findByText("Service agreement created")).toBeInTheDocument();
    expect(screen.getByText("Agreement B Customer")).toBeInTheDocument();

    // A's preview finally answers. Its result belongs to a drawer nobody is
    // looking at anymore and must not land on B's screen.
    await act(async () => {
      resolvePreviewA(
        buildGenerationImpact({
          from: FAR_FUTURE_START,
          to: expectedWindow.to,
          shortfalls: [
            {
              serviceAgreementId: "agreement-a",
              customerName: "Agreement A Customer",
              siteName: agreementA.siteName,
              periodStart: FAR_FUTURE_START,
              periodEnd: "2099-01-12",
              requested: 2,
              scheduled: 1,
              reason: "NOT_ENOUGH_ALLOWED_DAYS",
              reasons: ["NOT_ENOUGH_ALLOWED_DAYS"],
              message: "Stale message that belongs to agreement A.",
            },
          ],
        })
      );
      // Flushes the now-resolved (but stale) promise's continuation before
      // asserting nothing changed as a result of it.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByText("Stale message that belongs to agreement A.")).not.toBeInTheDocument();
    expect(screen.getByText("Agreement B Customer")).toBeInTheDocument();
  });

  it("discards a stale confirm from an earlier agreement closed mid-request", async () => {
    const agreementA = buildServiceAgreement({
      id: "agreement-a",
      customerName: "Agreement A Customer",
      startDate: FAR_FUTURE_START,
      branchCode: "COLOMBO",
    });
    const agreementB = buildServiceAgreement({
      id: "agreement-b",
      customerName: "Agreement B Customer",
      startDate: FAR_FUTURE_START,
      branchCode: "COLOMBO",
    });

    vi.mocked(createServiceAgreement).mockResolvedValueOnce(agreementA);
    vi.mocked(previewVisitGeneration).mockResolvedValueOnce(
      buildGenerationImpact({
        from: FAR_FUTURE_START,
        to: expectedWindow.to,
        additions: [
          {
            serviceAgreementId: "agreement-a",
            customerName: agreementA.customerName,
            siteName: agreementA.siteName,
            visitDate: FAR_FUTURE_START,
            windowStartMinute: 540,
            windowEndMinute: 1020,
            durationMinutes: 90,
            requiredCrewSize: 1,
            branchCode: "COLOMBO",
            isPreferredDay: false,
            placement: "EARLIEST",
          },
        ],
      })
    );

    let resolveConfirmA!: (impact: ReturnType<typeof buildGenerationImpact>) => void;
    const confirmAPromise = new Promise<ReturnType<typeof buildGenerationImpact>>((resolve) => {
      resolveConfirmA = resolve;
    });
    vi.mocked(confirmVisitGeneration).mockReturnValueOnce(confirmAPromise);

    const user = await openForm();
    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    await user.type(screen.getByLabelText("Start date"), FAR_FUTURE_START);
    await user.click(screen.getByRole("button", { name: "Save agreement" }));

    await user.click(await screen.findByRole("button", { name: "Schedule now" }));
    // Confirm is now in flight; Done stays enabled and closes the drawer
    // while it's still running — the exact case this fencing has to cover.
    await user.click(screen.getByRole("button", { name: "Done" }));

    vi.mocked(createServiceAgreement).mockResolvedValueOnce(agreementB);
    vi.mocked(previewVisitGeneration).mockResolvedValueOnce(
      buildGenerationImpact({ from: FAR_FUTURE_START, to: expectedWindow.to })
    );

    await user.click(screen.getByRole("button", { name: "Add agreement" }));
    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    await user.type(screen.getByLabelText("Start date"), FAR_FUTURE_START);
    await user.click(screen.getByRole("button", { name: "Save agreement" }));

    expect(await screen.findByText("Service agreement created")).toBeInTheDocument();
    expect(screen.getByText("Agreement B Customer")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Schedule preview" })).toBeInTheDocument();

    // A's confirm finally answers. It must not flip B's still-a-preview
    // screen over to "Scheduled".
    await act(async () => {
      resolveConfirmA(
        buildGenerationImpact({
          from: FAR_FUTURE_START,
          to: expectedWindow.to,
          isPreview: false,
          scheduleRunId: "run-a",
          additions: [
            {
              serviceAgreementId: "agreement-a",
              customerName: agreementA.customerName,
              siteName: agreementA.siteName,
              visitDate: FAR_FUTURE_START,
              windowStartMinute: 540,
              windowEndMinute: 1020,
              durationMinutes: 90,
              requiredCrewSize: 1,
              branchCode: "COLOMBO",
              isPreferredDay: false,
              placement: "EARLIEST",
            },
          ],
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByRole("heading", { name: "Schedule preview" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Scheduled" })).not.toBeInTheDocument();
    expect(screen.getByText("Agreement B Customer")).toBeInTheDocument();
  });

  it("shows a visit ending at midnight as midnight, not noon", async () => {
    const created = buildServiceAgreement({
      id: "agreement-midnight",
      startDate: FAR_FUTURE_START,
      branchCode: "COLOMBO",
    });
    vi.mocked(createServiceAgreement).mockResolvedValue(created);
    vi.mocked(previewVisitGeneration).mockResolvedValue(
      buildGenerationImpact({
        from: FAR_FUTURE_START,
        to: expectedWindow.to,
        additions: [
          {
            serviceAgreementId: "agreement-midnight",
            customerName: created.customerName,
            siteName: created.siteName,
            visitDate: FAR_FUTURE_START,
            windowStartMinute: 540,
            windowEndMinute: 1440,
            durationMinutes: 60,
            requiredCrewSize: 1,
            branchCode: "COLOMBO",
            isPreferredDay: false,
            placement: "EARLIEST",
          },
        ],
      })
    );

    const user = await openForm();
    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    await user.type(screen.getByLabelText("Start date"), FAR_FUTURE_START);
    await user.click(screen.getByRole("button", { name: "Save agreement" }));

    expect(await screen.findByText(/9:00 AM–midnight/)).toBeInTheDocument();
  });

  it("shows an error if the schedule preview fails to load, without losing the created agreement", async () => {
    vi.mocked(createServiceAgreement).mockResolvedValue(buildServiceAgreement());
    vi.mocked(previewVisitGeneration).mockRejectedValue(
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

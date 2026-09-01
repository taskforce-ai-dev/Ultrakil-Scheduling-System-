import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
    // A deliberate delay, so the loading state is actually observable here
    // instead of resolving in the same tick as the assertion below. 250ms
    // rather than the original 30ms: on a contended CI runner the two prior
    // `await`s (opening the form, saving) can themselves eat past 30ms of
    // wall-clock time, which resolves this mock before the assertion below
    // ever gets to see the loading state — 250ms leaves real headroom
    // without meaningfully slowing the suite.
    vi.mocked(fetchSchedulePreview).mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(
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
              ),
            250
          )
        )
    );

    const user = await openForm();
    await user.click(screen.getByLabelText("Mon", { selector: "#allowed-MONDAY" }));
    await user.type(screen.getByLabelText("Start date"), "2026-09-07");
    await user.click(screen.getByRole("button", { name: "Save agreement" }));

    expect(await screen.findByText("Service agreement created")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Calculating preview…");

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
});

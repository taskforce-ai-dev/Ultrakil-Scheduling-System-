import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { searchParamsRef } = vi.hoisted(() => ({
  searchParamsRef: { current: null as URLSearchParams | null },
}));

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return { ...actual, useSearchParams: () => searchParamsRef.current };
});

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return {
    ...actual,
    fetchScheduleRuns: vi.fn(),
    startScheduleRun: vi.fn(),
    cancelScheduleRun: vi.fn(),
    publishScheduleRun: vi.fn(),
  };
});

import ScheduleHistoryPage from "../page";
import {
  fetchScheduleRuns,
  publishScheduleRun,
  startScheduleRun,
  type ScheduleRun,
} from "@/lib/api-client";
import { buildScheduleRun } from "@/test/fixtures";

function mockRuns(items: ScheduleRun[]) {
  vi.mocked(fetchScheduleRuns).mockResolvedValue({
    items,
    total: items.length,
    page: 1,
    pageSize: 50,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.mocked(startScheduleRun).mockReset();
  vi.mocked(publishScheduleRun).mockReset();
  searchParamsRef.current = null;
});

async function renderPage() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<ScheduleHistoryPage />);
  await screen.findByRole("heading", { name: "Assign Crew" });
  return user;
}

describe("ScheduleHistoryPage", () => {
  it("picks up a running run's progress on a refresh (refresh/reconnect)", async () => {
    // The API has no push channel — a manager who reloads the page mid-run
    // must see the current truth on the very next poll, not a stale 0%.
    const running = buildScheduleRun({ id: "run-1", status: "RUNNING", progressPercent: 20 });
    mockRuns([running]);
    await renderPage();

    expect(await screen.findByText("Running — 20%")).toBeInTheDocument();

    mockRuns([{ ...running, progressPercent: 65 }]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(await screen.findByText("Running — 65%")).toBeInTheDocument();
  });

  it("collapses a rapid double-click into a single request", async () => {
    mockRuns([]);
    let resolveStart: (() => void) | undefined;
    vi.mocked(startScheduleRun).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStart = () => resolve(buildScheduleRun());
        })
    );
    await renderPage();

    const button = screen.getByRole("button", { name: /Start run/ });
    // Two clicks fired without awaiting between them — a genuine
    // double-click, not two sequential, fully-settled ones.
    await userEvent.click(button, { skipHover: true });
    await userEvent.click(button, { skipHover: true });

    expect(startScheduleRun).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveStart?.();
    });
  });

  it("names the published run as the one in force, above any newer draft", async () => {
    // The exact pile a manager reported: a failed attempt, a draft that staffed
    // everything, and below them the published run the crews actually got. The
    // list is honest history and answers none of "what are my crews doing".
    // The clock is pinned inside the published run's week, because "in force"
    // is a question about today.
    vi.setSystemTime(new Date("2026-09-09T08:00:00.000Z"));
    const published = buildScheduleRun({
      id: "run-live", status: "SUCCEEDED", isPublished: true,
      publishedAt: "2026-09-08T05:13:05.000Z", visitsScheduled: 11, visitsUnassigned: 6,
    });
    const draft = buildScheduleRun({
      id: "run-draft", status: "SUCCEEDED", isPublished: false,
      visitsScheduled: 17, visitsUnassigned: 0,
    });
    const failed = buildScheduleRun({ id: "run-failed", status: "FAILED" });
    mockRuns([failed, draft, published]);
    await renderPage();

    const current = await screen.findByRole("region", { name: "Current schedule" });
    expect(within(current).getByText(/11 of 17 visits have a crew/)).toBeInTheDocument();
    expect(within(current).getByText(/This is what the crews were given/)).toBeInTheDocument();
    // And the better draft is offered, not silently preferred.
    expect(within(current).getByText(/A newer draft is waiting/)).toBeInTheDocument();
    expect(within(current).getByText(/Nobody has been told about it/)).toBeInTheDocument();
  });

  /**
   * "Current schedule" means the schedule in force today, not the schedule
   * published most recently. Publishing a November week made the September
   * week the crews were actually working vanish from the panel on the very day
   * it was being worked.
   */
  it("names the published run covering today, not the one published most recently", async () => {
    vi.setSystemTime(new Date("2026-09-16T08:00:00.000Z"));
    const inForce = buildScheduleRun({
      id: "run-september", status: "SUCCEEDED", isPublished: true,
      rangeStart: "2026-09-14", rangeEnd: "2026-09-20",
      publishedAt: "2026-09-11T05:13:05.000Z", visitsScheduled: 11, visitsUnassigned: 6,
    });
    const november = buildScheduleRun({
      id: "run-november", status: "SUCCEEDED", isPublished: true,
      rangeStart: "2026-11-23", rangeEnd: "2026-11-29",
      publishedAt: "2026-09-15T16:06:51.000Z", visitsScheduled: 28, visitsUnassigned: 1,
    });
    mockRuns([november, inForce]);
    await renderPage();

    const current = await screen.findByRole("region", { name: "Current schedule" });
    expect(within(current).getByText(/2026-09-14 – 2026-09-20/)).toBeInTheDocument();
    expect(within(current).getByText(/11 of 17 visits have a crew/)).toBeInTheDocument();
    expect(within(current).queryByText(/2026-11-23/)).not.toBeInTheDocument();
  });

  it("does not claim a future published week is what the crews are working now", async () => {
    vi.setSystemTime(new Date("2026-09-16T08:00:00.000Z"));
    const november = buildScheduleRun({
      id: "run-november", status: "SUCCEEDED", isPublished: true,
      rangeStart: "2026-11-23", rangeEnd: "2026-11-29",
      publishedAt: "2026-09-15T16:06:51.000Z", visitsScheduled: 28, visitsUnassigned: 1,
    });
    mockRuns([november]);
    await renderPage();

    const current = await screen.findByRole("region", { name: "Current schedule" });
    expect(within(current).getByText(/no published schedule covers today/i)).toBeInTheDocument();
    expect(within(current).queryByText(/This is what the crews were given/)).not.toBeInTheDocument();
  });

  /**
   * A generation run staffs nobody by definition — "0 of 0 staffed" is not a
   * draft waiting on a decision, and offering it as one hid the real staffed
   * draft sitting below it.
   */
  it("offers the newest draft that can actually be published, not a generation run", async () => {
    vi.setSystemTime(new Date("2026-09-16T08:00:00.000Z"));
    const generationRun = buildScheduleRun({
      id: "run-generation", kind: "VISIT_GENERATION", status: "SUCCEEDED", isPublished: false,
      rangeStart: "2026-10-26", rangeEnd: "2026-12-06",
      visitsConsidered: 105, visitsScheduled: 0, visitsUnassigned: 0, publishReadiness: null,
    });
    const staffedDraft = buildScheduleRun({
      id: "run-draft", status: "SUCCEEDED", isPublished: false,
      rangeStart: "2026-09-21", rangeEnd: "2026-09-27",
      visitsScheduled: 17, visitsUnassigned: 0,
    });
    const live = buildScheduleRun({
      id: "run-live", status: "SUCCEEDED", isPublished: true,
      rangeStart: "2026-09-14", rangeEnd: "2026-09-20",
      publishedAt: "2026-09-11T05:13:05.000Z", visitsScheduled: 11, visitsUnassigned: 6,
    });
    mockRuns([generationRun, staffedDraft, live]);
    await renderPage();

    const current = await screen.findByRole("region", { name: "Current schedule" });
    const waiting = within(current).getByText(/A newer draft is waiting/);
    expect(waiting).toHaveTextContent("17 of 17 staffed for 2026-09-21 – 2026-09-27");
    expect(within(current).queryByText(/0 of 0 staffed/)).not.toBeInTheDocument();
    expect(within(current).queryByText(/2026-10-26/)).not.toBeInTheDocument();
  });

  it("says plainly when nothing is published, rather than implying the latest run is live", async () => {
    mockRuns([buildScheduleRun({ id: "run-a", status: "SUCCEEDED", isPublished: false })]);
    await renderPage();

    const current = await screen.findByRole("region", { name: "Current schedule" });
    expect(within(current).getByText(/no schedule is in force/)).toBeInTheDocument();
  });

  it("warns before publishing a run that leaves visits unassigned", async () => {
    const run = buildScheduleRun({
      id: "run-2",
      status: "SUCCEEDED",
      isPublished: false,
      visitsUnassigned: 3,
    });
    mockRuns([run]);
    const user = await renderPage();

    await user.click(await screen.findByRole("button", { name: "Publish" }));

    expect(
      await screen.findByText(/3 visits in this range could not be staffed/)
    ).toBeInTheDocument();
    const publishButton = screen.getByRole("button", { name: "Publish" });
    expect(publishButton).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: /I understand/i }));
    expect(publishButton).toBeDisabled();

    await user.type(
      screen.getByLabelText("Reason (required for partial schedules)"),
      "Manager reviewed the remaining unassigned visits.",
    );

    vi.mocked(publishScheduleRun).mockResolvedValue({ ...run, isPublished: true });
    await user.click(publishButton);

    expect(publishScheduleRun).toHaveBeenCalledWith("run-2", {
      acknowledgePartial: true,
      reason: "Manager reviewed the remaining unassigned visits.",
    });
  });

  it("publishes a partial run only after acknowledgement and a non-empty reason", async () => {
    const run = buildScheduleRun({
      id: "run-partial-reason",
      status: "SUCCEEDED",
      isPublished: false,
      visitsUnassigned: 1,
    });
    mockRuns([run]);
    const user = await renderPage();

    await user.click(await screen.findByRole("button", { name: "Publish" }));
    const publishButton = screen.getByRole("button", { name: "Publish" });
    const reason = screen.getByLabelText("Reason (required for partial schedules)");

    await user.click(screen.getByRole("checkbox", { name: /I understand/i }));
    expect(publishButton).toBeDisabled();
    await user.type(reason, "Reviewed the one visit that remains unassigned.");

    vi.mocked(publishScheduleRun).mockResolvedValue({ ...run, isPublished: true });
    expect(publishButton).toBeEnabled();
    await user.click(publishButton);

    expect(publishScheduleRun).toHaveBeenCalledWith("run-partial-reason", {
      acknowledgePartial: true,
      reason: "Reviewed the one visit that remains unassigned.",
    });
  });

  it("collapses a rapid double-click on Publish into a single request", async () => {
    const run = buildScheduleRun({
      id: "run-4",
      status: "SUCCEEDED",
      isPublished: false,
      visitsUnassigned: 0,
    });
    mockRuns([run]);
    let resolvePublish: (() => void) | undefined;
    vi.mocked(publishScheduleRun).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePublish = () => resolve({ ...run, isPublished: true });
        })
    );
    const user = await renderPage();

    await user.click(await screen.findByRole("button", { name: "Publish" }));
    const confirmButton = await screen.findByRole("button", { name: "Publish" });
    // Two clicks fired without awaiting between them — a genuine double-click,
    // not two sequential, fully-settled ones.
    await userEvent.click(confirmButton, { skipHover: true });
    await userEvent.click(confirmButton, { skipHover: true });

    expect(publishScheduleRun).toHaveBeenCalledTimes(1);
    expect(publishScheduleRun).toHaveBeenCalledWith("run-4", {});
    await act(async () => {
      resolvePublish?.();
    });
  });

  it("names the unconfirmed source data and refuses to publish until it is acknowledged", async () => {
    const run = buildScheduleRun({
      id: "run-unconfirmed",
      status: "SUCCEEDED",
      isPublished: false,
      visitsConsidered: 40,
      visitsScheduled: 40,
      visitsUnassigned: 0,
      publishReadiness: {
        state: "ACKNOWLEDGEMENT_REQUIRED",
        code: "SOURCE_DATA_UNCONFIRMED",
        message: "This run rests on source data that is still unconfirmed.",
        requiresPartialAcknowledgement: false,
        requiresProvenanceAcknowledgement: true,
        provenanceWarnings: [
          {
            code: "HOURS_UNCONFIRMED",
            message: "Opening hours for this visit are not confirmed: either the recorded hours are unconfirmed, or the visible 08:00–17:00 fallback is in use.",
            affectedVisitCount: 7,
          },
          {
            code: "SITE_BRANCH_UNCONFIRMED",
            message:
              "The service site branch is inferred from source data and needs manager confirmation.",
            affectedVisitCount: 2,
          },
        ],
      },
    });
    mockRuns([run]);
    const user = await renderPage();

    await user.click(await screen.findByRole("button", { name: "Publish" }));

    expect(await screen.findByText(/Opening hours for this visit are not confirmed/)).toBeInTheDocument();
    expect(screen.getByText(/service site branch is inferred/)).toBeInTheDocument();
    expect(screen.getByText("7 visits")).toBeInTheDocument();
    expect(screen.getByText("2 visits")).toBeInTheDocument();
    // Nothing unassigned, so the partial gate must stay out of the way.
    expect(screen.queryByText(/could not be staffed/)).not.toBeInTheDocument();

    const publishButton = screen.getByRole("button", { name: "Publish" });
    expect(publishButton).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: /source data that is not confirmed/i }));
    expect(publishButton).toBeDisabled();

    await user.type(
      screen.getByLabelText("Reason (required for unconfirmed source data)"),
      "Hours agreed with the site by phone.",
    );

    vi.mocked(publishScheduleRun).mockResolvedValue({ ...run, isPublished: true });
    expect(publishButton).toBeEnabled();
    await user.click(publishButton);

    expect(publishScheduleRun).toHaveBeenCalledWith("run-unconfirmed", {
      acknowledgeProvenance: true,
      reason: "Hours agreed with the site by phone.",
    });
  });

  it("still sends acknowledgePartial, and asks for both, when a partial run is also unconfirmed", async () => {
    const run = buildScheduleRun({
      id: "run-both",
      status: "SUCCEEDED",
      isPublished: false,
      visitsUnassigned: 2,
      publishReadiness: {
        state: "ACKNOWLEDGEMENT_REQUIRED",
        code: "PARTIAL_RESULTS",
        message: "This run left visits unassigned and rests on unconfirmed source data.",
        requiresPartialAcknowledgement: true,
        requiresProvenanceAcknowledgement: true,
        provenanceWarnings: [
          {
            code: "CREW_SIZE_UNCONFIRMED",
            message:
              "Crew size was not stated by the source and has not been confirmed by a manager.",
            affectedVisitCount: 1,
          },
        ],
      },
    });
    mockRuns([run]);
    const user = await renderPage();

    await user.click(await screen.findByRole("button", { name: "Publish" }));
    const publishButton = screen.getByRole("button", { name: "Publish" });

    await user.type(
      screen.getByLabelText("Reason (required for partial schedules)"),
      "Both reviewed with the branch manager.",
    );
    expect(publishButton).toBeDisabled();

    // The partial acknowledgement alone is not enough — the source-data gate
    // is still outstanding, and must not be swallowed by it.
    await user.click(
      screen.getByRole("checkbox", { name: /unassigned visits will not be dispatched/i }),
    );
    expect(publishButton).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: /source data that is not confirmed/i }));
    expect(publishButton).toBeEnabled();

    vi.mocked(publishScheduleRun).mockResolvedValue({ ...run, isPublished: true });
    await user.click(publishButton);

    expect(publishScheduleRun).toHaveBeenCalledWith("run-both", {
      acknowledgePartial: true,
      acknowledgeProvenance: true,
      reason: "Both reviewed with the branch manager.",
    });
  });

  it("asks for no source-data acknowledgement when every value is confirmed", async () => {
    const run = buildScheduleRun({
      id: "run-confirmed",
      status: "SUCCEEDED",
      isPublished: false,
      visitsUnassigned: 0,
      publishReadiness: {
        state: "READY",
        code: null,
        message: null,
        requiresPartialAcknowledgement: false,
        requiresProvenanceAcknowledgement: false,
        provenanceWarnings: [],
      },
    });
    mockRuns([run]);
    const user = await renderPage();

    await user.click(await screen.findByRole("button", { name: "Publish" }));

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Reason (optional)")).toBeInTheDocument();

    vi.mocked(publishScheduleRun).mockResolvedValue({ ...run, isPublished: true });
    await user.click(screen.getByRole("button", { name: "Publish" }));

    expect(publishScheduleRun).toHaveBeenCalledWith("run-confirmed", {});
  });

  it("stays quiet about the warning when nothing is left unassigned", async () => {
    const run = buildScheduleRun({
      id: "run-3",
      status: "SUCCEEDED",
      isPublished: false,
      visitsUnassigned: 0,
    });
    mockRuns([run]);
    const user = await renderPage();

    await user.click(await screen.findByRole("button", { name: "Publish" }));

    expect(screen.queryByText(/could not be staffed/)).not.toBeInTheDocument();
  });

  it("blocks publication of a zero-result run and says why", async () => {
    const empty = buildScheduleRun({
      id: "run-empty",
      visitsConsidered: 0,
      visitsScheduled: 0,
      visitsUnassigned: 0,
      isPublished: false,
    });
    mockRuns([empty]);
    await renderPage();

    expect(await screen.findByText("Draft — no dispatchable assignments")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();
  });

  it("distinguishes draft, published and superseded runs", async () => {
    mockRuns([
      buildScheduleRun({ id: "run-draft", status: "SUCCEEDED", isPublished: false }),
      buildScheduleRun({ id: "run-published", status: "SUCCEEDED", isPublished: true }),
      buildScheduleRun({ id: "run-superseded", status: "SUPERSEDED", isPublished: true }),
    ]);
    await renderPage();

    expect(await screen.findByText("Draft — ready to publish")).toBeInTheDocument();
    expect(screen.getByText("Post")).toBeInTheDocument();
    expect(screen.getByText("Superseded")).toBeInTheDocument();
  });

  it("shows an empty state when nothing has been generated yet", async () => {
    mockRuns([]);
    await renderPage();

    expect(await screen.findByText("No schedule runs yet")).toBeInTheDocument();
  });

  it("keeps Publish out of the scrolling part of the dialog, however long the gate list", async () => {
    // Measured on the live portal at 1280x720: a run with four
    // unconfirmed-source sections pushed this button to y=745.5 — visible and
    // enabled to anything that asked, and unclickable, because the point was
    // off the bottom of the screen. The gate list is exactly what makes the
    // dialog tall, so the more a schedule needed checking, the less
    // publishable it became. The gates scroll; the decision does not move.
    const run = buildScheduleRun({
      id: "run-tall",
      status: "SUCCEEDED",
      isPublished: false,
      visitsUnassigned: 3,
      publishReadiness: {
        state: "ACKNOWLEDGEMENT_REQUIRED",
        code: "PARTIAL_RESULTS",
        message: "This run left visits unassigned and rests on unconfirmed source data.",
        requiresPartialAcknowledgement: true,
        requiresProvenanceAcknowledgement: true,
        provenanceWarnings: [
          {
            code: "CREW_SIZE_UNCONFIRMED",
            message: "Crew size was not stated by the source and has not been confirmed.",
            affectedVisitCount: 4,
          },
          {
            code: "DAY_RULE_UNCONFIRMED",
            message: "Allowed service days were inferred and have not been confirmed.",
            affectedVisitCount: 6,
          },
          {
            code: "DURATION_UNCONFIRMED",
            message: "Visit duration was not stated by the source and has not been confirmed.",
            affectedVisitCount: 9,
          },
          {
            code: "HOURS_UNCONFIRMED",
            message: "Opening hours for this visit are not confirmed.",
            affectedVisitCount: 13,
          },
        ],
      },
    });
    mockRuns([run]);
    const user = await renderPage();

    await user.click(await screen.findByRole("button", { name: "Publish" }));

    const body = document.querySelector("[data-slot=dialog-body]");
    expect(body).not.toBeNull();

    // Everything variable-length is inside the region that scrolls.
    expect(body).toContainElement(screen.getByText(/Allowed service days were inferred/));
    expect(body).toContainElement(screen.getByText(/could not\s+be staffed/));
    expect(body).toContainElement(
      screen.getByLabelText("Reason (required for partial schedules)"),
    );

    // The decision is not.
    const publishButton = screen.getByRole("button", { name: "Publish" });
    expect(body).not.toContainElement(publishButton);
    expect(body).not.toContainElement(screen.getByRole("button", { name: "Cancel" }));
    expect(document.querySelector("[data-slot=dialog-footer]")).toContainElement(publishButton);
  });
});

describe("a visit-generation run in the history", () => {
  /**
   * Confirming "Generate visits" writes a run to account for what it did.
   * Listed beside the solver's runs it read as a failed schedule: "Draft — no
   * dispatchable assignments · Considered: 105 · Scheduled: 0", directly above
   * the real optimiser run.
   */
  const generation = () =>
    buildScheduleRun({
      id: "run-generation",
      kind: "VISIT_GENERATION",
      status: "SUCCEEDED",
      visitsConsidered: 105,
      visitsScheduled: 0,
      visitsUnassigned: 0,
      publishReadiness: null,
      isPublished: false,
    });

  it("is named as visit generation", async () => {
    mockRuns([generation()]);
    await renderPage();

    expect(await screen.findByText("Visit generation")).toBeInTheDocument();
  });

  it("is never called a draft, and never blamed for having no assignments", async () => {
    mockRuns([generation()]);
    await renderPage();
    await screen.findByText("Visit generation");

    expect(screen.queryByText(/Draft/)).not.toBeInTheDocument();
    expect(screen.queryByText(/dispatchable assignments/)).not.toBeInTheDocument();
  });

  it("says what the number it prints actually counts", async () => {
    // `visitsConsidered` is every visit the run accounted for — created,
    // changed, removed, protected and already correct alike. Printing it as
    // "105 visits generated" made a second run over the same range, which
    // creates nothing, claim another 105: the page accounted for 210 where
    // 105 exist. The number is honest, the word for it was not.
    mockRuns([generation()]);
    await renderPage();

    expect(await screen.findByText(/105 visits considered/)).toBeInTheDocument();
    expect(screen.queryByText(/105 visits generated/)).not.toBeInTheDocument();
    expect(screen.queryByText("Scheduled: ")).not.toBeInTheDocument();
    expect(screen.queryByText("Staffing failed: ")).not.toBeInTheDocument();
  });

  it("does not claim a second run over the same range generated them all again", async () => {
    // The shape that made it wrong: one run that created the work, and a
    // second over the same range that created nothing and found all of it
    // already correct. Both carry the same `visitsConsidered`.
    mockRuns([
      { ...generation(), id: "run-second" },
      { ...generation(), id: "run-first" },
    ]);
    await renderPage();

    expect(await screen.findAllByText(/105 visits considered/)).toHaveLength(2);
    expect(screen.queryByText(/visits generated/)).not.toBeInTheDocument();
  });

  it("offers nothing to publish", async () => {
    mockRuns([generation()]);
    await renderPage();
    await screen.findByText("Visit generation");

    expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();
  });
});

describe("ScheduleHistoryPage, arrived at from a run link", () => {
  it("marks the run the link named and brings it into view", async () => {
    // The operational visits list links a visit to the run that produced it.
    // Landing on a page of fifty runs with nothing picked out leaves a manager
    // to find a date range by eye, which is the job the link was meant to do.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    mockRuns([
      buildScheduleRun({ id: "older", rangeStart: "2026-09-01", rangeEnd: "2026-09-07" }),
      buildScheduleRun({ id: "wanted", rangeStart: "2026-09-15", rangeEnd: "2026-09-21" }),
    ]);
    searchParamsRef.current = new URLSearchParams("run=wanted");
    await renderPage();

    const highlighted = await screen.findByTestId("run-wanted");
    expect(highlighted).toHaveAttribute("aria-current", "true");
    expect(screen.getByTestId("run-older")).not.toHaveAttribute("aria-current");
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("marks nothing when the link names a run this page does not hold", async () => {
    mockRuns([buildScheduleRun({ id: "older" })]);
    searchParamsRef.current = new URLSearchParams("run=elsewhere");
    await renderPage();

    expect(await screen.findByTestId("run-older")).not.toHaveAttribute("aria-current");
  });
});

/**
 * ULK-O12. The list asked for the 50 most recent runs and said so, which was
 * honest but left every earlier run unreachable — including one a `?run=<id>`
 * link pointed straight at, which highlighted nothing and scrolled nowhere.
 */
describe("ScheduleHistoryPage pagination", () => {
  function runRange(from: number, count: number) {
    return Array.from({ length: count }, (_, index) =>
      buildScheduleRun({ id: `r${from + index}` }),
    );
  }

  /** Serves `total` runs in pages of 50, and answers an exact-id query. */
  function servePages(total: number, byId: Record<string, ScheduleRun> = {}) {
    vi.mocked(fetchScheduleRuns).mockImplementation(async (query) => {
      if (query?.ids?.length) {
        const found = query.ids.map((id) => byId[id]).filter(Boolean);
        return { items: found, total: found.length, page: 1, pageSize: 1 };
      }
      const page = query?.page ?? 1;
      const pageSize = query?.pageSize ?? 50;
      const start = (page - 1) * pageSize;
      return {
        items: runRange(start + 1, Math.max(0, Math.min(pageSize, total - start))),
        total,
        page,
        pageSize,
      };
    });
  }

  it("states the API's total and range instead of a truncation notice", async () => {
    servePages(120);
    await renderPage();

    expect(await screen.findByTestId("pagination-range")).toHaveTextContent(
      "Showing 1–50 of 120 runs",
    );
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
  });

  it("asks the API for the next page when Next is used", async () => {
    servePages(120);
    const user = await renderPage();
    await screen.findByTestId("run-r1");

    await user.click(screen.getByRole("button", { name: /Next/ }));

    expect(await screen.findByTestId("run-r51")).toBeInTheDocument();
    expect(fetchScheduleRuns).toHaveBeenCalledWith({ page: 2, pageSize: 50 });
    expect(screen.getByTestId("pagination-range")).toHaveTextContent("Showing 51–100 of 120 runs");
  });

  it("fetches a linked older run by id and highlights it (ULK-O12 deep link)", async () => {
    const ancient = buildScheduleRun({ id: "ancient", rangeStart: "2026-01-05" });
    // 300 runs: `ancient` is on no page this list would load first.
    servePages(300, { ancient });
    searchParamsRef.current = new URLSearchParams("run=ancient");
    await renderPage();

    const highlighted = await screen.findByTestId("run-ancient");
    expect(highlighted).toHaveAttribute("aria-current", "true");
    expect(fetchScheduleRuns).toHaveBeenCalledWith({ ids: ["ancient"], pageSize: 1 });
  });

  it("does not list the focused run twice when it is already on the page", async () => {
    const onPage = buildScheduleRun({ id: "r3" });
    servePages(120, { r3: onPage });
    searchParamsRef.current = new URLSearchParams("run=r3");
    await renderPage();

    await screen.findByTestId("run-r3");
    expect(screen.getAllByTestId("run-r3")).toHaveLength(1);
    // The row is on the page already, so no exact-id request is needed.
    expect(fetchScheduleRuns).not.toHaveBeenCalledWith(
      expect.objectContaining({ ids: ["r3"] }),
    );
  });

  it("drops the linked row once paging reaches the page it really lives on", async () => {
    const linked = buildScheduleRun({ id: "r51" });
    servePages(120, { r51: linked });
    searchParamsRef.current = new URLSearchParams("run=r51");
    const user = await renderPage();

    // Page 1 does not hold it, so it is fetched by id and shown at the top.
    await screen.findByTestId("run-r51");
    expect(screen.getAllByTestId("run-r51")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: /Next/ }));

    // Page 2 genuinely contains it — still exactly one row.
    expect(await screen.findByTestId("run-r52")).toBeInTheDocument();
    expect(screen.getAllByTestId("run-r51")).toHaveLength(1);
  });

  it("keeps Current schedule unchanged when paging to unrelated older runs", async () => {
    // The blocker Thiva caught on review: the in-force panel was derived from
    // the browsed page, so clicking Next — which changes no dispatch truth —
    // could make it announce that no schedule is in force.
    const publishedToday = buildScheduleRun({
      id: "in-force",
      status: "SUCCEEDED",
      isPublished: true,
      publishedAt: "2026-09-20T00:00:00.000Z",
      rangeStart: "2026-09-01",
      rangeEnd: "2036-09-30",
      visitsScheduled: 17,
      visitsUnassigned: 0,
    });
    const oldUnrelated = Array.from({ length: 50 }, (_, index) =>
      buildScheduleRun({
        id: `old-${index}`,
        isPublished: false,
        rangeStart: "2024-01-01",
        rangeEnd: "2024-01-07",
      }),
    );

    vi.mocked(fetchScheduleRuns).mockImplementation(async (query) => {
      if (query?.ids?.length) return { items: [], total: 0, page: 1, pageSize: 1 };
      const page = query?.page ?? 1;
      return {
        items: page === 1 ? [publishedToday, ...oldUnrelated.slice(0, 49)] : oldUnrelated,
        total: 100,
        page,
        pageSize: 50,
      };
    });

    const user = await renderPage();
    const before = (await screen.findByRole("region", { name: "Current schedule" })).textContent;
    expect(before).toContain("2026-09-01");

    await user.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByTestId("run-old-49");

    // Page 2 holds none of the published run, yet the panel must not move.
    expect(screen.queryByTestId("run-in-force")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Current schedule" }).textContent).toBe(before);
  });

  it("keeps polling a queued run that is not on the browsed page", async () => {
    const queued = buildScheduleRun({ id: "queued", status: "RUNNING", progressPercent: 20 });
    const oldUnrelated = Array.from({ length: 50 }, (_, index) =>
      buildScheduleRun({ id: `old-${index}`, status: "SUCCEEDED" }),
    );
    vi.mocked(fetchScheduleRuns).mockImplementation(async (query) => {
      if (query?.ids?.length) return { items: [], total: 0, page: 1, pageSize: 1 };
      const page = query?.page ?? 1;
      return {
        items: page === 1 ? [queued, ...oldUnrelated.slice(0, 49)] : oldUnrelated,
        total: 100,
        page,
        pageSize: 50,
      };
    });

    const user = await renderPage();
    await screen.findByTestId("run-queued");

    await user.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByTestId("run-old-49");
    expect(screen.queryByTestId("run-queued")).not.toBeInTheDocument();

    const callsBefore = vi.mocked(fetchScheduleRuns).mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(3500);
    });

    // The run is off-page, but its refresh must not silently stop.
    expect(vi.mocked(fetchScheduleRuns).mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("holds the pager down until a deferred page settles, without unmounting the rows", async () => {
    // Second review finding: `load` never set isLoading on a page change, so
    // `Pagination disabled={isLoading}` stayed false throughout the fetch and
    // a rapid second Next could advance again over the old rows.
    const firstPage = Array.from({ length: 50 }, (_, index) =>
      buildScheduleRun({ id: `p1-${index}` }),
    );
    const secondPage = Array.from({ length: 50 }, (_, index) =>
      buildScheduleRun({ id: `p2-${index}` }),
    );
    const deferredPageTwo = deferredRun();

    vi.mocked(fetchScheduleRuns).mockImplementation(async (query) => {
      if (query?.ids?.length) return { items: [], total: 0, page: 1, pageSize: 1 };
      if ((query?.page ?? 1) === 2) return deferredPageTwo.promise;
      return { items: firstPage, total: 150, page: 1, pageSize: 50 };
    });

    const user = await renderPage();
    await screen.findByTestId("run-p1-0");
    expect(screen.getByRole("button", { name: /Next/ })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /Next/ }));

    // Page 2 is in flight. Both controls are held down…
    expect(screen.getByRole("button", { name: /Next/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Previous/ })).toBeDisabled();
    // …and the rows already on screen are still there, not a loading skeleton.
    expect(screen.getByTestId("run-p1-0")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading" })).not.toBeInTheDocument();

    // A second click while disabled must not ask for page 3.
    await user.click(screen.getByRole("button", { name: /Next/ }));
    expect(vi.mocked(fetchScheduleRuns).mock.calls.filter((c) => c[0]?.page === 3)).toHaveLength(0);

    await act(async () => {
      deferredPageTwo.resolve({ items: secondPage, total: 150, page: 2, pageSize: 50 });
    });

    expect(await screen.findByTestId("run-p2-0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Next/ })).toBeEnabled();
  });

  it("does not hold the pager down for a background poll", async () => {
    // The poll runs every 3s while a run is queued. Disabling the pager on
    // each tick would make it unusable exactly when a manager is watching.
    const runs = [
      buildScheduleRun({ id: "queued", status: "RUNNING", progressPercent: 20 }),
      ...Array.from({ length: 49 }, (_, index) => buildScheduleRun({ id: `p1-${index}` })),
    ];
    vi.mocked(fetchScheduleRuns).mockImplementation(async (query) => {
      if (query?.ids?.length) return { items: [], total: 0, page: 1, pageSize: 1 };
      return { items: runs, total: 150, page: query?.page ?? 1, pageSize: 50 };
    });

    await renderPage();
    await screen.findByTestId("run-queued");
    expect(screen.getByRole("button", { name: /Next/ })).toBeEnabled();

    await act(async () => {
      vi.advanceTimersByTime(3500);
    });

    expect(screen.getByRole("button", { name: /Next/ })).toBeEnabled();
    expect(screen.getByTestId("run-queued")).toBeInTheDocument();
  });

  it("re-enables the pager when a poll starts mid-page-change", async () => {
    // Third review finding (1): a silent poll bumped the shared generation, so
    // the page request's finally skipped as stale and the poll's finally
    // skipped as silent. `isLoading` stayed true and the pager never came back.
    const queued = buildScheduleRun({ id: "queued", status: "RUNNING", progressPercent: 20 });
    const firstPage = [queued, ...Array.from({ length: 49 }, (_, i) => buildScheduleRun({ id: `p1-${i}` }))];
    const secondPage = Array.from({ length: 50 }, (_, i) => buildScheduleRun({ id: `p2-${i}` }));
    const deferredPageTwo = deferredRun();
    let pageTwoCalls = 0;

    vi.mocked(fetchScheduleRuns).mockImplementation(async (query) => {
      if (query?.ids?.length) return { items: [], total: 0, page: 1, pageSize: 1 };
      if ((query?.page ?? 1) === 2) {
        pageTwoCalls += 1;
        // Only the first page-2 request (the foreground one) is deferred; the
        // poll that follows answers straight away.
        if (pageTwoCalls === 1) return deferredPageTwo.promise;
        return { items: secondPage, total: 150, page: 2, pageSize: 50 };
      }
      return { items: firstPage, total: 150, page: 1, pageSize: 50 };
    });

    const user = await renderPage();
    await screen.findByTestId("run-queued");

    await user.click(screen.getByRole("button", { name: /Next/ }));
    expect(screen.getByRole("button", { name: /Next/ })).toBeDisabled();

    // A poll tick lands while page 2 is still pending.
    await act(async () => {
      vi.advanceTimersByTime(3500);
    });

    await act(async () => {
      deferredPageTwo.resolve({ items: secondPage, total: 150, page: 2, pageSize: 50 });
    });

    // The pager must come back, not stay disabled forever.
    expect(await screen.findByTestId("run-p2-0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Previous/ })).toBeEnabled();
  });

  it("does not let a page-2 summary response overwrite the panel after returning to page 1", async () => {
    // Third review finding (2): `loadSummary` fired on page 2 stayed in flight
    // while the manager went back to page 1. The page-1 load set the panel,
    // then the older summary landed and replaced it with staler rows.
    const inForce = buildScheduleRun({
      id: "in-force",
      isPublished: true,
      publishedAt: "2026-09-20T00:00:00.000Z",
      rangeStart: "2026-09-01",
      rangeEnd: "2036-09-30",
      visitsScheduled: 17,
      visitsUnassigned: 0,
    });
    // What the stale page-2-era summary would put back: nothing in force.
    const staleSummary = Array.from({ length: 50 }, (_, i) =>
      buildScheduleRun({ id: `stale-${i}`, isPublished: false }),
    );
    const firstPage = [inForce, ...Array.from({ length: 49 }, (_, i) => buildScheduleRun({ id: `p1-${i}` }))];
    const secondPage = Array.from({ length: 50 }, (_, i) => buildScheduleRun({ id: `p2-${i}` }));
    const deferredSummary = deferredRun();
    let summaryCalls = 0;

    vi.mocked(fetchScheduleRuns).mockImplementation(async (query) => {
      if (query?.ids?.length) return { items: [], total: 0, page: 1, pageSize: 1 };
      if ((query?.page ?? 1) === 2) return { items: secondPage, total: 150, page: 2, pageSize: 50 };
      // Page 1 is asked for both as the browsed page and as the summary
      // source; the first call made while on page 2 is the summary one.
      summaryCalls += 1;
      if (summaryCalls === 2) return deferredSummary.promise;
      return { items: firstPage, total: 150, page: 1, pageSize: 50 };
    });

    const user = await renderPage();
    const inForceText = (await screen.findByRole("region", { name: "Current schedule" })).textContent;
    expect(inForceText).toContain("2026-09-01");

    await user.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByTestId("run-p2-0");

    // Back to page 1 while that page-2 summary request is still outstanding.
    await user.click(screen.getByRole("button", { name: /Previous/ }));
    await screen.findByTestId("run-in-force");

    await act(async () => {
      deferredSummary.resolve({ items: staleSummary, total: 150, page: 1, pageSize: 50 });
    });

    // The older response must not reinstate "nothing in force".
    expect(screen.getByRole("region", { name: "Current schedule" }).textContent).toBe(inForceText);
  });

  it("shows page-2 rows, not just an enabled pager, when a poll ticks mid-navigation", async () => {
    // Fourth review pass: with the foreground fence decoupled, a poll starting
    // mid-page-change still bumped the data fence. The navigation's own
    // response was then discarded as stale, so the pager re-enabled while the
    // page-1 rows sat under the page-2 number — until the poll answered, or
    // forever if it hung.
    //
    // Two *separate* deferreds matter here. Sharing one lets the poll resolve
    // with page-2 data as well, which papers over the mismatch; the poll's
    // request is held open so the defect is actually reachable.
    const queued = buildScheduleRun({ id: "queued", status: "RUNNING", progressPercent: 20 });
    const firstPage = [queued, ...Array.from({ length: 49 }, (_, i) => buildScheduleRun({ id: `p1-${i}` }))];
    const secondPage = Array.from({ length: 50 }, (_, i) => buildScheduleRun({ id: `p2-${i}` }));
    const foregroundPageTwo = deferredRun();
    const pollPageTwo = deferredRun(); // deliberately never resolved
    let pageTwoCalls = 0;

    vi.mocked(fetchScheduleRuns).mockImplementation(async (query) => {
      if (query?.ids?.length) return { items: [], total: 0, page: 1, pageSize: 1 };
      if ((query?.page ?? 1) === 2) {
        pageTwoCalls += 1;
        return pageTwoCalls === 1 ? foregroundPageTwo.promise : pollPageTwo.promise;
      }
      return { items: firstPage, total: 150, page: 1, pageSize: 50 };
    });

    const user = await renderPage();
    await screen.findByTestId("run-queued");

    await user.click(screen.getByRole("button", { name: /Next/ }));

    // A poll tick lands while the navigation is still pending. It must stand
    // aside rather than fire a competing request that invalidates it.
    await act(async () => {
      vi.advanceTimersByTime(3500);
    });

    // The navigation's own response resolves first; the poll's stays open.
    await act(async () => {
      foregroundPageTwo.resolve({ items: secondPage, total: 150, page: 2, pageSize: 50 });
    });

    // The rows must actually be page 2's. An enabled pager over page-1 rows
    // under a page-2 number is the defect, not the fix.
    expect(await screen.findByTestId("run-p2-0")).toBeInTheDocument();
    expect(screen.queryByTestId("run-p1-0")).not.toBeInTheDocument();
    expect(screen.getByTestId("pagination-range")).toHaveTextContent("Showing 51–100 of 150 runs");
    expect(screen.getByRole("button", { name: /Previous/ })).toBeEnabled();
    expect(pageTwoCalls).toBe(1);
  });

  it("ignores a poll that was overtaken by a page change", async () => {
    const slowFirstPage = deferredRun();
    vi.mocked(fetchScheduleRuns).mockImplementation(async (query) => {
      if ((query?.page ?? 1) === 1) return slowFirstPage.promise;
      return { items: runRange(51, 50), total: 120, page: 2, pageSize: 50 };
    });

    render(<ScheduleHistoryPage />);
    await screen.findByRole("heading", { name: "Assign Crew" });

    // Resolve page 1 so the list and its pager are on screen.
    await act(async () => {
      slowFirstPage.resolve({ items: runRange(1, 50), total: 120, page: 1, pageSize: 50 });
    });
    await screen.findByTestId("run-r1");

    // A second page-1 request (the poll) is now left hanging while page 2 is asked for.
    const stalePoll = deferredRun();
    vi.mocked(fetchScheduleRuns).mockImplementation(async (query) => {
      if ((query?.page ?? 1) === 1) return stalePoll.promise;
      return { items: runRange(51, 50), total: 120, page: 2, pageSize: 50 };
    });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByTestId("run-r51");

    await act(async () => {
      stalePoll.resolve({ items: runRange(1, 50), total: 120, page: 1, pageSize: 50 });
    });

    // Page 1's rows must not reappear under a pager that reads page 2.
    expect(screen.getByTestId("run-r51")).toBeInTheDocument();
    expect(screen.queryByTestId("run-r1")).not.toBeInTheDocument();
  });
});

function deferredRun() {
  let resolve!: (value: Awaited<ReturnType<typeof fetchScheduleRuns>>) => void;
  const promise = new Promise<Awaited<ReturnType<typeof fetchScheduleRuns>>>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
});

async function renderPage() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<ScheduleHistoryPage />);
  await screen.findByRole("heading", { name: "Schedule History" });
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

    vi.mocked(publishScheduleRun).mockResolvedValue({ ...run, isPublished: true });
    await user.click(publishButton);

    expect(publishScheduleRun).toHaveBeenCalledWith("run-2", {});
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
    await act(async () => {
      resolvePublish?.();
    });
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

  it("requires an acknowledgement and reason before publishing unconfirmed source data", async () => {
    const run = buildScheduleRun({
      id: "run-provenance",
      visitsUnassigned: 0,
      publishReadiness: {
        state: "ACKNOWLEDGEMENT_REQUIRED",
        code: "SOURCE_DATA_UNCONFIRMED",
        message: "Source data needs manager confirmation.",
        requiresProvenanceAcknowledgement: true,
        provenanceWarnings: [
          {
            code: "HOURS_UNCONFIRMED",
            message: "Opening hours were not confirmed.",
            affectedVisitCount: 1,
          },
        ],
      },
    });
    mockRuns([run]);
    const user = await renderPage();

    await user.click(await screen.findByRole("button", { name: "Publish" }));

    expect(await screen.findByText(/Opening hours were not confirmed/)).toBeInTheDocument();
    const publishButton = screen.getByRole("button", { name: "Publish" });
    expect(publishButton).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: /I understand that unconfirmed source data/i }));
    expect(publishButton).toBeDisabled();

    await user.type(screen.getByLabelText(/Reason/), "Reviewed the source data.");
    vi.mocked(publishScheduleRun).mockResolvedValue({ ...run, isPublished: true });
    await user.click(publishButton);

    expect(publishScheduleRun).toHaveBeenCalledWith("run-provenance", {
      acknowledgeProvenance: true,
      reason: "Reviewed the source data.",
    });
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
    expect(screen.getByText("Published")).toBeInTheDocument();
    expect(screen.getByText("Superseded")).toBeInTheDocument();
  });

  it("shows an empty state when nothing has been generated yet", async () => {
    mockRuns([]);
    await renderPage();

    expect(await screen.findByText("No schedule runs yet")).toBeInTheDocument();
  });
});

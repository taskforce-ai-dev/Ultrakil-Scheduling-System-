import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
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

    vi.mocked(publishScheduleRun).mockResolvedValue({ ...run, isPublished: true });
    await user.click(screen.getByRole("button", { name: "Publish" }));

    expect(publishScheduleRun).toHaveBeenCalledWith("run-2", {});
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

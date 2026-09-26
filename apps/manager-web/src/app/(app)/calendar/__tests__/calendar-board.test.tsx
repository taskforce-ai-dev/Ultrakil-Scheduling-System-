import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return {
    ...actual,
    fetchCalendar: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    fetchCoverage: vi.fn().mockResolvedValue(null),
  };
});

import { CalendarBoard } from "../calendar-board";
import { fetchCalendar } from "@/lib/api-client";

afterEach(() => vi.useRealTimers());

describe("CalendarBoard", () => {
  it("renders the same loading shell across Colombo midnight for static HTML hydration", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T18:29:00.000Z"));
    const beforeMidnight = renderToString(<CalendarBoard />);
    vi.setSystemTime(new Date("2026-09-25T18:30:00.000Z"));
    const afterMidnight = renderToString(<CalendarBoard />);

    expect(afterMidnight).toBe(beforeMidnight);
  });
  it("renders the shared calendar board outside the route module", async () => {
    render(<CalendarBoard />);

    expect(await screen.findByRole("heading", { name: "Calendar" })).toBeInTheDocument();
  });

  it("allows the embedded Dispatch Board calendar to start in month view", async () => {
    render(<CalendarBoard initialView="month" />);

    expect(await screen.findByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "30 days" })).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps Today and 30 days anchored to the live Colombo day after midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T18:29:59.000Z"));
    vi.mocked(fetchCalendar).mockClear();
    render(<CalendarBoard />);

    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    fireEvent.click(screen.getByRole("button", { name: "30 days" }));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    expect(fetchCalendar).toHaveBeenLastCalledWith({ from: "2026-09-26", to: "2026-10-25" });
  });
});

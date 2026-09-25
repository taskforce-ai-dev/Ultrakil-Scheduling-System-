import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return {
    ...actual,
    fetchCalendar: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  };
});

import { CalendarBoard } from "../calendar-board";

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
});

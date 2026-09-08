import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return {
    ...actual,
    fetchCalendar: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  };
});

import { CalendarBoard } from "../calendar-board";

describe("CalendarBoard", () => {
  it("renders the shared calendar board outside the route module", async () => {
    render(<CalendarBoard />);

    expect(await screen.findByRole("heading", { name: "Calendar" })).toBeInTheDocument();
  });
});

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

let role: "ADMIN" | "MANAGER" = "MANAGER";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { fullName: "Portal User", role },
    logout: vi.fn(),
  }),
}));

import { AppShell } from "../app-shell";

function renderShell() {
  return render(<AppShell><div>Page content</div></AppShell>);
}

describe("AppShell", () => {
  it("renders the navigation links", () => {
    renderShell();
    expect(screen.getAllByRole("link", { name: "Dashboard" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Dispatch Board" }).length).toBeGreaterThan(0);
  });

  it.each(["MANAGER", "ADMIN"] as const)(
    "shows the Repair Center to the %s role",
    (visibleRole) => {
      role = visibleRole;
      renderShell();

      expect(screen.getAllByRole("link", { name: "Repair Center" }).length).toBeGreaterThan(0);
    },
  );

  it("is reachable by keyboard: Tab reaches a nav link", async () => {
    const user = userEvent.setup();
    renderShell();

    let found = false;
    for (let i = 0; i < 20 && !found; i += 1) {
      await user.tab();
      if (document.activeElement?.textContent?.includes("Customers")) {
        found = true;
      }
    }

    expect(found).toBe(true);
  });
});

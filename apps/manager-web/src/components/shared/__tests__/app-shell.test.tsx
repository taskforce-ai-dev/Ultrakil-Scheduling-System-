import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import { AppShell } from "../app-shell";
import { AuthProvider } from "@/lib/auth";

function renderShell() {
  return render(
    <AuthProvider>
      <AppShell>
        <div>Page content</div>
      </AppShell>
    </AuthProvider>
  );
}

describe("AppShell", () => {
  it("renders the navigation links", () => {
    renderShell();
    expect(screen.getAllByRole("link", { name: "Dashboard" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Dispatch Board" }).length).toBeGreaterThan(0);
  });

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

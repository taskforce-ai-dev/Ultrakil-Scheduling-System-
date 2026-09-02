import { test, expect } from "@playwright/test";

/**
 * Starts a real optimizer run against the real scheduler service, waits for
 * it to leave QUEUED/RUNNING, then publishes it. This is the slowest spec in
 * the suite by a wide margin — CP-SAT over a real week of agreements is
 * real computation, not a mock resolving instantly — so its timeout is
 * generous on purpose. Watching a run reach 100% here is also what proves
 * the schedule-history page's poll-on-refresh behaviour actually reflects
 * server truth, not stale client state.
 */
test("starts a schedule run, watches it finish, and publishes it", async ({ page }) => {
  await page.goto("/schedule-history");
  await expect(page.getByRole("heading", { name: "Schedule History" })).toBeVisible();

  await page.getByRole("button", { name: /^Start run$/ }).click();
  await expect(page.getByText(/Running — \d+%|Draft — ready to publish/).first()).toBeVisible({
    timeout: 15_000,
  });

  // Poll for the run to settle. A real CP-SAT search can run for the
  // configured time limit (20s default here) plus write-back time.
  await expect(page.getByText("Draft — ready to publish").first()).toBeVisible({
    timeout: 120_000,
  });

  const row = page
    .locator("tr", { has: page.getByText("Draft — ready to publish") })
    .first();
  await row.getByRole("button", { name: "Publish" }).click();

  // The trigger row is hidden behind the dialog's own modal boundary while
  // it's open, so this resolves to the dialog's confirm button alone — the
  // same pattern the page's own Vitest suite relies on.
  await page.getByRole("button", { name: "Publish" }).click();

  await expect(page.getByText("Published").first()).toBeVisible({ timeout: 15_000 });
});

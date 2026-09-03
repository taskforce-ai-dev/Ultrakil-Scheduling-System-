import { test, expect } from "@playwright/test";

/**
 * Starts a real optimizer run against the real scheduler service, waits for
 * it to leave QUEUED/RUNNING, then publishes it. This is the slowest spec in
 * the suite by a wide margin — CP-SAT over a real week of agreements is
 * real computation, not a mock resolving instantly. Watching a run reach
 * 100% here is also what proves the schedule-history page's
 * poll-on-refresh behaviour actually reflects server truth, not stale
 * client state.
 */
test("starts a schedule run, watches it finish, and publishes it", async ({ page }) => {
  // The suite's default (playwright.config.ts) is 30s, sized for the other
  // specs — this is the one test that genuinely needs minutes, for a real
  // optimizer search plus write-back, not a mock resolving instantly.
  test.setTimeout(180_000);

  await page.goto("/schedule-history");
  await expect(page.getByRole("heading", { name: "Schedule History" })).toBeVisible();

  await page.getByRole("button", { name: /^Start run$/ }).click();
  await expect(page.getByText(/Running — \d+%|Draft — ready to publish/).first()).toBeVisible({
    timeout: 15_000,
  });

  // A hard reload — new page load, no client state survives it — is the
  // literal ULK-O07 requirement ("preserve scheduler-run progress across
  // refresh"), not just the polling this page already does in place. The
  // API has no push channel (see page.tsx's top comment), so the only way
  // this can work is the page re-fetching current truth on mount; a stale
  // client would show nothing, an error, or a run stuck at its pre-reload
  // percentage.
  await page.reload();
  await expect(page.getByText(/Running — \d+%|Draft — ready to publish/).first()).toBeVisible({
    timeout: 15_000,
  });

  // Poll for the run to settle. A real CP-SAT search can run for the
  // configured time limit (20s default here) plus write-back time.
  await expect(page.getByText("Draft — ready to publish").first()).toBeVisible({
    timeout: 120_000,
  });

  // The runs list is a card list (<ul><li>), not a table.
  const row = page
    .locator("li", { has: page.getByText("Draft — ready to publish") })
    .first();
  await row.getByRole("button", { name: "Publish" }).click();

  // The trigger row is hidden behind the dialog's own modal boundary while
  // it's open, so this resolves to the dialog's confirm button alone — the
  // same pattern the page's own Vitest suite relies on.
  await page.getByRole("button", { name: "Publish" }).click();

  await expect(page.getByText("Published").first()).toBeVisible({ timeout: 15_000 });
});

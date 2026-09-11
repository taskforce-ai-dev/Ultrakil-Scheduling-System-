import { test, expect } from "./fixtures";
import { expectNoSeriousViolations } from "./accessibility";

/**
 * Starts a real optimizer run against the real scheduler service, waits for
 * it to leave QUEUED/RUNNING, then publishes it. This is the slowest spec in
 * the suite by a wide margin — CP-SAT over a real week of agreements is
 * real computation, not a mock resolving instantly. Watching a run reach
 * 100% here is also what proves the schedule-history page's
 * poll-on-refresh behaviour actually reflects server truth, not stale
 * client state.
 */
/**
 * The publish confirmation dialog can only be reached from a run that is still
 * a draft, and this journey publishes the week's visits — after which an
 * ordinary run finds nothing left to schedule and no draft can be produced.
 * The scan therefore belongs here, ahead of publication, rather than in the
 * accessibility spec where it silently depended on a leftover draft.
 */
test("publish confirmation dialog has no serious accessibility violations", async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto("/schedule-history");
  await expect(page.getByRole("heading", { name: "Schedule History" })).toBeVisible();

  const from = await page.locator("#run-from").inputValue();
  const to = await page.locator("#run-to").inputValue();
  const started = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/schedule-runs"),
  );
  await page.getByRole("button", { name: /^Start run$/ }).click();
  expect((await started).ok()).toBe(true);

  const row = page.locator("li", { hasText: `${from} – ${to}` }).first();
  await expect(row.getByText("Draft — ready to publish")).toBeVisible({ timeout: 120_000 });

  await row.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByRole("button", { name: "Publish" })).toBeVisible();
  await expectNoSeriousViolations(page, "Publish confirmation dialog");
});

test("starts a schedule run, watches it finish, and publishes it", async ({ page }) => {
  // The suite's default (playwright.config.ts) is 30s, sized for the other
  // specs — this is the one test that genuinely needs minutes, for a real
  // optimizer search plus write-back, not a mock resolving instantly.
  test.setTimeout(180_000);

  await page.goto("/schedule-history");
  await expect(page.getByRole("heading", { name: "Schedule History" })).toBeVisible();

  const from = await page.locator('#run-from').inputValue();
  const to = await page.locator('#run-to').inputValue();
  const started = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/schedule-runs'));
  await page.getByRole("button", { name: /^Start run$/ }).click();
  expect((await started).ok()).toBe(true);
  // The newest run in this exact range is the one just started. An older
  // unrelated draft must never satisfy the completion/publish assertions.
  const row = page.locator('li', { hasText: `${from} – ${to}` }).first();
  await expect(row.getByText(/Queued|Running — \d+%|Draft — ready to publish/)).toBeVisible({
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
  await expect(row.getByText(/Queued|Running — \d+%|Draft — ready to publish/)).toBeVisible({
    timeout: 15_000,
  });

  // Poll for the run to settle. A real CP-SAT search can run for the
  // configured time limit (20s default here) plus write-back time.
  await expect(row.getByText("Draft — ready to publish")).toBeVisible({
    timeout: 120_000,
  });

  // The runs list is a card list (<ul><li>), not a table.
  await row.getByRole("button", { name: "Publish" }).click();

  // This fixture is built from imported workbooks, so its opening hours, site
  // branches and agreement values carry the importer's cautious defaults.
  // Publishing work that rests on an assumption is a decision a manager makes
  // explicitly, so the dialog asks for an acknowledgement and a reason before
  // it will publish. Whether this run owes that depends on what the solver
  // picked, so answer the gate when it is raised rather than assuming it.
  const acknowledgement = page.getByRole("checkbox", {
    name: /source data that is not confirmed/i,
  });
  if (await acknowledgement.isVisible()) {
    await expect(page.getByText(/nobody has confirmed/i)).toBeVisible();
    await acknowledgement.check();
  }

  const partialAcknowledgement = page.getByRole("checkbox", {
    name: /unassigned visits will not be dispatched/i,
  });
  if (await partialAcknowledgement.isVisible()) {
    await partialAcknowledgement.check();
  }

  const reason = page.getByLabel(/^Reason/);
  if ((await reason.getAttribute("aria-required")) === "true") {
    await reason.fill("Reviewed the imported source data for this week.");
  }

  // The trigger row is hidden behind the dialog's own modal boundary while
  // it's open, so this resolves to the dialog's confirm button alone — the
  // same pattern the page's own Vitest suite relies on.
  const confirm = page.getByRole("button", { name: "Publish" });
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(row.getByText("Published", { exact: true })).toBeVisible({ timeout: 15_000 });
});

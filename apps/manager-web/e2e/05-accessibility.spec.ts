import { test, expect } from "./fixtures";
import { expectNoSeriousViolations } from "./accessibility";

/**
 * Automated accessibility scan (axe-core) of every top-level page, plus the
 * portal's forms, tables and dialogs opened along the way — the ULK-O07
 * requirement to check "forms, tables, dialogs and drag alternatives".
 *
 * Runs against the real, authenticated app (this project's storageState),
 * not isolated component markup, so results reflect what a manager actually
 * gets served — including real data, real table row counts, and whatever
 * axe can only see once a real API response has rendered.
 *
 * Scoped to serious/critical impact only. Axe's "minor"/"moderate" findings
 * are frequently debatable design opinions (contrast ratio precision,
 * landmark preferences) rather than things that block a screen-reader or
 * keyboard user; serious/critical are the ones that do. A broader pass is
 * easy to run by hand later (drop the withRules/impact filter below) once
 * this baseline is clean.
 */
const PAGES = [
  { path: "/dashboard", heading: "Dashboard" },
  { path: "/customers", heading: "Customers" },
  { path: "/service-agreements", heading: "Service Agreements" },
  { path: "/visits", heading: "Visit Calendar" },
  { path: "/calendar", heading: "Calendar" },
  { path: "/workforce", heading: "Workforce" },
  { path: "/vehicles", heading: "Vehicles" },
  { path: "/dispatch-board", heading: "Dispatch Board" },
  { path: "/unassigned-visits", heading: "Unassigned Visits" },
  { path: "/schedule-history", heading: "Schedule History" },
];


for (const { path, heading } of PAGES) {
  test(`${path} has no serious accessibility violations`, async ({ page }) => {
    await page.goto(path);
    // Let the page's own data load rather than scanning a loading skeleton —
    // that would just tell us loading states are accessible, not the real
    // content managers spend their day looking at.
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expectNoSeriousViolations(page, path);
  });
}

test("customer creation form has no serious accessibility violations", async ({ page }) => {
  await page.goto("/customers");
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByLabel("Customer name")).toBeVisible();
  await expectNoSeriousViolations(page, "Customer creation form");
});

test("service agreement creation form has no serious accessibility violations", async ({ page }) => {
  await page.goto("/service-agreements");
  await page.getByRole("button", { name: "Add agreement" }).click();
  await expect(page.locator("#customerId")).toBeVisible();
  await expectNoSeriousViolations(page, "Service agreement creation form");
});

test("visit generation dialog has no serious accessibility violations", async ({ page }) => {
  await page.goto("/visits");
  await page.getByRole("button", { name: "Generate visits" }).click();
  await expect(page.getByRole("heading", { name: "Generate visits" })).toBeVisible();
  await expect(
    page.getByText(/Nothing has been written yet\.|Could not work out what generation would change\./)
  ).toBeVisible({ timeout: 15_000 });
  await expectNoSeriousViolations(page, "Visit generation dialog");
});

test("dispatch board's manual override drawer has no serious accessibility violations", async ({
  page,
}) => {
  await page.goto("/dispatch-board");
  await page.waitForLoadState('networkidle');
  const editCrewButton = page.getByRole("button", { name: "Edit crew" }).first();
  if ((await editCrewButton.count()) === 0) {
    test.skip(true, "No scheduled visit for today in this environment — nothing to open.");
  }
  await editCrewButton.click();
  await expect(page.getByText(/^Edit crew — /)).toBeVisible({ timeout: 10_000 });
  await expectNoSeriousViolations(page, "Manual override drawer");
});


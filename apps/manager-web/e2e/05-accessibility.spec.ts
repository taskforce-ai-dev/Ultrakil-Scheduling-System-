import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";

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
  "/dashboard",
  "/customers",
  "/service-agreements",
  "/visits",
  "/workforce",
  "/vehicles",
  "/dispatch-board",
  "/unassigned-visits",
  "/schedule-history",
];

async function expectNoSeriousViolations(page: import("@playwright/test").Page, label: string) {
  const results = await new AxeBuilder({ page })
    .include("body")
    .exclude("[data-sonner-toaster]") // third-party toast internals, not this app's markup
    .analyze();

  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const details = serious
    .map(
      (v) =>
        `\n  [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} element(s))\n    ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(" "))
          .join("\n    ")}`
    )
    .join("");

  expect(serious, `${label} — serious/critical accessibility violations:${details}`).toHaveLength(0);
}

for (const path of PAGES) {
  test(`${path} has no serious accessibility violations`, async ({ page }) => {
    await page.goto(path);
    // Let the page's own data load rather than scanning a loading skeleton —
    // that would just tell us loading states are accessible, not the real
    // content managers spend their day looking at.
    await page.waitForLoadState("networkidle");
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
  await expectNoSeriousViolations(page, "Visit generation dialog");
});

test("dispatch board's manual override drawer has no serious accessibility violations", async ({
  page,
}) => {
  await page.goto("/dispatch-board");
  const editCrewButton = page.getByRole("button", { name: "Edit crew" }).first();
  if ((await editCrewButton.count()) === 0) {
    test.skip(true, "No scheduled visit for today in this environment — nothing to open.");
  }
  await editCrewButton.click();
  await expect(page.getByText(/^Edit crew — /)).toBeVisible({ timeout: 10_000 });
  await expectNoSeriousViolations(page, "Manual override drawer");
});

test("schedule run publish confirmation dialog has no serious accessibility violations", async ({
  page,
}) => {
  await page.goto("/schedule-history");
  const publishButton = page
    .locator("li", { has: page.getByText("Draft — ready to publish") })
    .first()
    .getByRole("button", { name: "Publish" });
  if ((await publishButton.count()) === 0) {
    test.skip(true, "No draft run waiting to publish in this environment.");
  }
  await publishButton.click();
  await expect(page.getByRole("button", { name: "Publish" })).toBeVisible();
  await expectNoSeriousViolations(page, "Publish confirmation dialog");
});

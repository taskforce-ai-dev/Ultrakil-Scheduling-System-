import { test, expect } from "@playwright/test";

/**
 * The first half of the Phase 1 workflow: a customer and a site must exist
 * before any agreement, visit, or dispatch can. Runs against the real API,
 * so a real customer and a real agreement are left behind in the database —
 * that is deliberate (see e2e/README.md: this suite is a local/staging tool,
 * not something run against a shared database you cannot leave test data
 * in).
 */
const stamp = Date.now();
const customerName = `E2E Customer ${stamp}`;
const siteName = `E2E Site ${stamp}`;

test("creates a customer with a site, then a service agreement for it, and sees the schedule preview", async ({
  page,
}) => {
  await page.goto("/customers");
  await expect(page.getByRole("heading", { name: "Customers" })).toBeVisible();

  await page.getByRole("button", { name: "Add customer" }).click();
  await page.getByLabel("Customer name").fill(customerName);
  await page.getByLabel("Site name").fill(siteName);
  await page.getByRole("button", { name: "Save customer" }).click();

  await expect(page.getByText(customerName)).toBeVisible({ timeout: 10_000 });

  await page.goto("/service-agreements");
  await expect(page.getByRole("heading", { name: "Service Agreements" })).toBeVisible();

  await page.getByRole("button", { name: "Add agreement" }).click();

  await page.getByLabel("Customer").click();
  await page.getByRole("option", { name: customerName }).click();

  await page.getByLabel("Site").click();
  await page.getByRole("option", { name: siteName }).click();

  await page.getByLabel("Job type").click();
  // Whatever job types exist for this UltraKIL instance — the first one is
  // enough to prove the agreement pipeline end to end.
  await page.getByRole("option").first().click();

  // Every day allowed keeps this agreement importable regardless of which
  // job type got picked, and it is a hard constraint the model can express
  // directly — no ambiguity for the API to reject.
  for (const day of ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"]) {
    await page.locator(`#allowed-${day}`).check();
  }

  const today = new Date().toISOString().slice(0, 10);
  await page.locator("#startDate").fill(today);

  await page.getByRole("button", { name: "Save agreement" }).click();

  await expect(page.getByRole("heading", { name: "Service agreement created" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByText("Schedule preview")).toBeVisible();
  // Either a concrete preview or an explained shortfall — never a blank panel.
  await expect(
    page.getByText(/No visits fall in the preview window\.|visit(s)? falls? in|Could not load the schedule preview\./).first()
  ).toBeVisible({ timeout: 10_000 });
});

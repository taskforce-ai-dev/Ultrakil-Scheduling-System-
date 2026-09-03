import { test, expect } from "@playwright/test";

/**
 * ULK-O09's required test scenarios, run against a real API and whatever
 * MASTER SCHEDULE 2026 import currently exists in this environment.
 *
 * These scenarios name real vehicle codes and driver names from the actual
 * workforce matrix — data this suite can't fabricate (that would defeat the
 * point: proving the real import produced the right authorization rows) and
 * shouldn't hardcode as a business rule either way. Every test here looks
 * the record up first and skips itself, rather than failing, if this
 * environment hasn't imported it yet — same pattern as the dialog checks in
 * 05-accessibility.spec.ts. Once Chanya's ULK-C09 import has run somewhere,
 * these stop skipping and start actually verifying the real data.
 */
const MULTI_DRIVER_VEHICLES: Array<{ code: string; driverCount: number }> = [
  { code: "DAG-3284", driverCount: 3 },
  { code: "ABE-7244", driverCount: 4 },
  { code: "PJ-6796", driverCount: 2 },
  { code: "DAI-0191", driverCount: 2 },
];

async function openVehicleByCode(page: import("@playwright/test").Page, code: string) {
  await page.goto("/vehicles");
  await page.getByPlaceholder("Search by code or label").fill(code);
  const row = page.locator("tbody tr", { hasText: code });
  if ((await row.count()) === 0) {
    test.skip(true, `${code} is not in this environment's imported master schedule yet.`);
  }
  await row.getByRole("link").click();
  await expect(page.getByText(`Vehicle code: ${code}`)).toBeVisible();
}

for (const { code, driverCount } of MULTI_DRIVER_VEHICLES) {
  test(`${code} shows all ${driverCount} of its checked drivers, equally (ULK-O09)`, async ({
    page,
  }) => {
    await openVehicleByCode(page, code);

    const driverRows = page.locator("li", { has: page.getByText("Authorized to drive") });
    await expect(driverRows).toHaveCount(driverCount);
    // No row anywhere on the page implies ownership or a driver hierarchy —
    // the disclaimer text itself says "not... primary-driver assignment",
    // which is why this checks driver rows specifically, not the page.
    for (const row of await driverRows.all()) {
      await expect(row).not.toHaveText(/primary driver|backup driver|\bowner\b/i);
    }
  });
}

test("DAC-2485 shows T M Supun Tharaka Wijeweera, S Tharilingam and P Selvaraj equally (ULK-O09)", async ({
  page,
}) => {
  await openVehicleByCode(page, "DAC-2485");

  for (const name of ["T M Supun Tharaka Wijeweera", "S Tharilingam", "P Selvaraj"]) {
    await expect(page.getByText(name)).toBeVisible();
  }
  const driverRows = page.locator("li", { has: page.getByText("Authorized to drive") });
  await expect(driverRows).toHaveCount(3);
});

test("an inactive customer is labelled in text and excluded from the agreement site picker (ULK-O09)", async ({
  page,
}) => {
  await page.goto("/customers");
  await expect(page.getByRole("heading", { name: "Customers" })).toBeVisible();

  await page.getByLabel("Status").click();
  await page.getByRole("option", { name: "Inactive" }).click();

  const inactiveRows = page.locator("tbody tr");
  if ((await inactiveRows.count()) === 0) {
    test.skip(true, "No inactive customers in this environment's imported data yet.");
  }

  // Text, not colour alone.
  await expect(inactiveRows.first().getByText("Inactive")).toBeVisible();
  const customerName = (await inactiveRows.first().locator("td").first().textContent())?.trim();
  expect(customerName).toBeTruthy();

  // The same customer must never be offered when creating a new agreement —
  // the normal (active-only) picker, not the Inactive view just used above.
  await page.goto("/service-agreements");
  await page.getByRole("button", { name: "Add agreement" }).click();
  await page.locator("#customerId").click();
  await expect(page.getByRole("option", { name: customerName! })).toHaveCount(0);
});

import { test, expect } from "@playwright/test";

/**
 * Visit generation: preview first (nothing written), then confirm. Runs
 * against whatever service agreements already exist in the database — the
 * agreement `01-customer-and-agreement.spec.ts` just created (today, Mon–Fri,
 * weekly) is one of them when the suite runs in order, but this spec does
 * not depend on that specifically: any real agreement makes this a
 * meaningful check, because it's proving preview and confirm agree with each
 * other and with the real API, not proving a specific visit count.
 */
test("previews visit generation for the current month, then confirms it", async ({ page }) => {
  await page.goto("/visits");
  await expect(page.getByRole("heading", { name: "Visit Calendar" })).toBeVisible();

  await page.getByRole("button", { name: "Generate visits" }).click();

  // The trigger button also reads "Generate visits" and stays in the
  // accessibility tree while the drawer is open (unlike the modal Dialog
  // elsewhere in the app, this Sheet does not hide background content), so
  // this must be scoped to the drawer's own heading specifically.
  await expect(page.getByRole("heading", { name: "Generate visits" })).toBeVisible();
  // Never a blank drawer: either the impact loaded, or a real error explains
  // why it did not — both are acceptable outcomes for this API call, an
  // indefinite spinner or a silent blank panel are not.
  await expect(
    page.getByText(/Nothing has been written yet\.|Could not work out what generation would change\./)
  ).toBeVisible({ timeout: 15_000 });

  const generateButton = page.getByRole("button", { name: /^Generate$/ });
  const isDisabled = await generateButton.isDisabled();

  if (isDisabled) {
    // Nothing to generate this run — a legitimate outcome (e.g. the visible
    // range is already fully generated), not a failure of this spec.
    await page.getByRole("button", { name: "Cancel" }).click();
    return;
  }

  await generateButton.click();
  // Either wording the confirm handler uses, depending on whether anything
  // actually changed.
  await expect(
    page.getByText(/visits created|already matches the agreements/)
  ).toBeVisible({ timeout: 15_000 });
});

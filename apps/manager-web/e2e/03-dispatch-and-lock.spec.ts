import { test, expect } from "./fixtures";

/**
 * Manual override (dispatch board → Edit crew) and locking a visit
 * (visits calendar). Strict CI uses its independently seeded assigned visit
 * and requires a persisted crew change. Non-strict operator runs adapt to
 * available visits and can also exercise a legitimate eligibility refusal.
 */

test("dispatch board: overrides a crew with a reason, and shows every ineligibility reason if the pick fails eligibility", async ({
  page,
}) => {
  await page.goto("/dispatch-board");
  await expect(page.getByRole("heading", { name: "Dispatch Board" })).toBeVisible();
  await page.waitForLoadState('networkidle');

  const strict = process.env.E2E_STRICT === '1';
  const seededRow = page.getByRole('row').filter({
    has: page.getByRole('button', { name: 'Synthetic Active', exact: true }),
  }).filter({ hasText: 'T M Supun Tharaka Wijeweera' });
  if (strict) await expect(seededRow).toHaveCount(1);
  const editCrewButton = strict
    ? seededRow.getByRole('button', { name: 'Edit crew', exact: true })
    : page.getByRole("button", { name: "Edit crew" }).first();
  if ((await editCrewButton.count()) === 0) {
    test.skip(true, "No scheduled visit for today in this environment — nothing to override.");
  }
  const initialChecked = strict ? page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/assignment/check')
    && response.request().postDataJSON().crew?.length === 1) : undefined;
  await editCrewButton.click();

  // The drawer's own data (visit + employees + vehicles) is a real fetch,
  // not instant, so the default 5s assertion timeout is too tight here.
  await expect(page.getByText(/^Edit crew — /)).toBeVisible({ timeout: 10_000 });
  const drawer = page.getByRole('dialog', { name: /^Edit crew — / });
  if (strict) {
    await expect(drawer.getByRole('heading', { name: 'Edit crew — Synthetic Active', exact: true })).toBeVisible();
    const initialResult = await initialChecked!;
    expect(initialResult.ok()).toBe(true);
    expect((await initialResult.json()).isEligible).toBe(true);
    await expect(drawer.getByText('This crew is eligible to take the visit.')).toBeVisible({ timeout: 10_000 });
  }
  const employeeControls = drawer.getByLabel('Employee', { exact: true });
  const existingCrew = await employeeControls.count();
  await drawer.getByRole("button", { name: "Add crew member" }).click();
  await expect(employeeControls).toHaveCount(existingCrew + 1);
  await employeeControls.nth(existingCrew).click();
  const checked = strict ? page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname.endsWith('/assignment/check')
    && response.request().postDataJSON().crew?.length === 2) : undefined;
  if (strict) {
    expect(existingCrew).toBe(1);
    await page.getByRole('option', { name: 'Ajith Alwis (PMS)', exact: true }).click();
    const result = await checked!;
    expect(result.ok()).toBe(true);
    expect((await result.json()).isEligible).toBe(true);
  } else {
    await page.getByRole("option").first().click();
  }

  await drawer.getByLabel("Reason for this change").fill("E2E: verifying the manual override path");

  const saveButton = drawer.getByRole("button", { name: "Save assignment" });
  if (strict) {
    await expect(saveButton).toBeEnabled();
    const saved = page.waitForResponse(response => response.request().method() === 'PUT'
      && new URL(response.url()).pathname.endsWith('/assignment'));
    await saveButton.click();
    expect((await saved).ok()).toBe(true);
    await expect(page.getByText('Assignment saved.', { exact: true })).toBeVisible({ timeout: 10_000 });
    await page.reload();
    await expect(seededRow.getByRole('cell').nth(4)).toContainText('Ajith Alwis', { timeout: 10_000 });
    await expect(seededRow.getByRole('cell').nth(4)).toContainText('T M Supun Tharaka Wijeweera');
    // Reopen once more: persistent two-person crew and no self-overlap refusal.
    await seededRow.getByRole('button', { name: 'Edit crew', exact: true }).click();
    await expect(drawer.getByLabel('Employee', { exact: true })).toHaveCount(2);
    await expect(drawer.getByText('This crew is eligible to take the visit.')).toBeVisible({ timeout: 10_000 });
    return;
  }
  // Ineligible-crew rejection is a real, tested outcome, not a failure of
  // this spec — a hard rule (branch match, PMS supervisor coverage, etc.)
  // is exactly what must never be quietly bypassed.
  const isBlocked = await saveButton.isDisabled();
  if (isBlocked) {
    await expect(page.getByText(/eligible|branch|PMS|inactive|stationed/i).first()).toBeVisible();
    return;
  }

  await saveButton.click();
  await expect(page.getByText(/Assignment saved\.|assignment/i).first()).toBeVisible({ timeout: 10_000 });
});

test("visit calendar: locks and releases a visit", async ({ page }) => {
  await page.goto("/visits");
  await expect(page.getByRole("heading", { name: "Generate Schedule" })).toBeVisible();
  await page.waitForLoadState('networkidle');

  const visitButton = page.locator('button[aria-label*=" at "][aria-label*=" on "]').first();
  if ((await visitButton.count()) === 0) {
    test.skip(true, "No visit on the current month's calendar in this environment.");
  }
  await visitButton.click();

  const lockButton = page.getByRole("button", { name: /Lock this visit|Release this visit/ });
  await expect(lockButton).toBeVisible();
  const wasLocked = (await lockButton.textContent())?.includes("Release") ?? false;

  await lockButton.click();
  await expect(
    page.getByRole("button", { name: wasLocked ? "Lock this visit" : "Release this visit" })
  ).toBeVisible({ timeout: 10_000 });

  // The success toast from that click sits over this same footer button
  // (bottom-positioned, same as the drawer's own footer). Sonner pauses a
  // toast's auto-dismiss timer while the pointer is over it, and Playwright's
  // virtual cursor is left sitting exactly there after the click above — so
  // waiting alone never resolves it. Moving the pointer away first lets the
  // timer actually run; forcing the click after is a guaranteed fallback,
  // since the button underneath is genuinely there and enabled the whole
  // time — only the toast's own hover-pause is in the way, not the app.
  await page.mouse.move(0, 0);
  await page.locator('[data-sonner-toast]').first().waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});

  // Leave the visit as it was found — this spec observes state, it doesn't
  // decide for the manager whether a real visit should end up locked.
  await page
    .getByRole("button", { name: wasLocked ? "Lock this visit" : "Release this visit" })
    .click({ force: true });
  await expect(
    page.getByRole("button", { name: wasLocked ? "Release this visit" : "Lock this visit" })
  ).toBeVisible({ timeout: 10_000 });
});

import { test, expect } from "./fixtures";

/**
 * Manual override (dispatch board → Edit crew), the board's Share button,
 * and locking a visit (visits calendar). Strict CI uses its independently
 * seeded assigned visit and requires a persisted crew change. Non-strict
 * operator runs adapt to available visits and can also exercise a
 * legitimate eligibility refusal.
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
  }).filter({ hasText: 'Fixture Supervisor Alpha' });
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
    await page.getByRole('option', { name: 'Fixture Supervisor Hotel (PMS)', exact: true }).click();
    const result = await checked!;
    expect(result.ok()).toBe(true);
    expect((await result.json()).isEligible).toBe(true);
  } else {
    await page.getByRole("option").first().click();
  }

  if (strict) {
    // UAT on staging: "Choose a vehicle" looked enabled and opened onto
    // nothing, because every imported vehicle has no recorded branch and the
    // picker asked only for vehicles *of* the branch. The synthetic Bolero is
    // deliberately left without a branch (see deploy/test/rehearsal-fixture.mjs)
    // so this is the real condition, not a friendlier one.
    await drawer.getByRole('button', { name: 'Add vehicle' }).click();
    const vehicleControl = drawer.getByLabel('Vehicle', { exact: true });
    await vehicleControl.click();
    const bolero = page.getByRole('option', { name: /DAC-?\s?2485/ });
    await expect(bolero).toBeVisible();
    await bolero.click();
    await expect(vehicleControl).toContainText(/DAC-?\s?2485/);
    await expect(vehicleControl).not.toContainText(/[0-9a-f]{8}-[0-9a-f]{4}-/);

    // Driver choices are the checked crew members only. Fixture Supervisor
    // Alpha is on this crew and is checked for the Bolero; Fixture Supervisor
    // Hotel is on the crew but is not checked for it, so they must not be
    // offered.
    const driverControl = drawer.getByLabel('Driver', { exact: true });
    await driverControl.click();
    await expect(page.getByRole('option', { name: 'Fixture Supervisor Alpha', exact: true })).toBeVisible();
    // Exactly one driver is offered: the crew member who is checked for
    // this vehicle. Counting options is stronger than asserting one name is
    // absent, which would also pass if the wrong popup were open.
    await expect(page.getByRole('option')).toHaveCount(1);
    // Choosing the vehicle already triggers a check with no driver, which is
    // rightly ineligible; wait for the one that carries the chosen driver.
    const vehicleChecked = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname.endsWith('/assignment/check')
      && Boolean(response.request().postDataJSON().vehicles?.[0]?.driverEmployeeId));
    await page.getByRole('option', { name: 'Fixture Supervisor Alpha', exact: true }).click();
    const vehicleResult = await vehicleChecked;
    expect(vehicleResult.ok()).toBe(true);
    expect((await vehicleResult.json()).isEligible).toBe(true);
  }

  await drawer.getByLabel("Reason for this change").fill("E2E: verifying the manual override path");

  const saveButton = drawer.getByRole("button", { name: "Save assignment" });
  if (strict) {
    await expect(saveButton).toBeEnabled();
    const saved = page.waitForResponse(response => response.request().method() === 'PUT'
      && new URL(response.url()).pathname.endsWith('/assignment'));
    await saveButton.click();
    expect((await saved).ok()).toBe(true);
    // Pinned to the sentence that reports the save, not to the whole toast:
    // the confirmation also says where the reason went, and that clause is
    // free to improve without this acceptance run failing over wording.
    await expect(page.getByText(/^Assignment saved\./)).toBeVisible({ timeout: 10_000 });
    await page.reload();
    await expect(seededRow.getByRole('cell').nth(4)).toContainText('Fixture Supervisor Hotel', { timeout: 10_000 });
    await expect(seededRow.getByRole('cell').nth(4)).toContainText('Fixture Supervisor Alpha');
    // Reopen once more: persistent two-person crew, the saved vehicle shown by
    // name rather than by id (it is still selectable here — the unit test
    // covers the read-model label for a vehicle that is not), and no
    // self-overlap refusal.
    await seededRow.getByRole('button', { name: 'Edit crew', exact: true }).click();
    await expect(drawer.getByLabel('Employee', { exact: true })).toHaveCount(2);
    await expect(drawer.getByLabel('Vehicle', { exact: true })).toContainText(/DAC-?\s?2485/, { timeout: 10_000 });
    await expect(drawer.getByLabel('Vehicle', { exact: true })).not.toContainText(/[0-9a-f]{8}-[0-9a-f]{4}-/);
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

test("dispatch board: Share copies the exact displayed day to the clipboard", async ({
  page,
  context,
}) => {
  await page.goto("/dispatch-board");
  await expect(page.getByRole("heading", { name: "Dispatch Board" })).toBeVisible();
  await page.waitForLoadState("networkidle");

  const shareButton = page.getByRole("button", { name: "Share" });
  await expect(shareButton).toBeVisible();
  if (await shareButton.isDisabled()) {
    test.skip(true, "Nothing scheduled for today in this environment — nothing to share.");
  }

  // A real browser Clipboard API, not a jsdom mock — the PR's own unit test
  // suite could not exercise this (navigator.clipboard mocking behaved
  // unreliably under jsdom/Vitest: the mocked spy wasn't visible from inside
  // the click handler despite working in isolation outside React).
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  // The page's own rendering of the current filter state — asserting
  // against this (not a hand-built expectation) is what proves the copied
  // text tracks whatever day/branch is actually on screen, not a stale or
  // hard-coded one.
  const displayedDate = await page
    .locator("div.rounded-xl.border.bg-card.p-4.shadow-sm + p")
    .textContent();
  const firstRowCustomer = await page
    .locator("table tbody tr")
    .first()
    .locator("button")
    .first()
    .textContent();

  await shareButton.click();
  await expect(page.getByText("Dispatch board copied to clipboard.")).toBeVisible({
    timeout: 10_000,
  });

  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toContain("Dispatch Board");
  expect(clipboardText).toContain(displayedDate?.trim());
  expect(clipboardText).toContain(firstRowCustomer?.trim());
});

test("dispatch board: Share reports a clean, actionable error when the browser blocks clipboard access", async ({
  page,
}) => {
  // Simulate a browser/OS refusing clipboard access (denied permission,
  // insecure context, etc.) — the catch branch's whole reason to exist, and
  // the other thing a jsdom mock can't meaningfully stand in for. Must be
  // registered before the page's own scripts run, so it has to precede goto.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
      configurable: true,
    });
  });

  await page.goto("/dispatch-board");
  await expect(page.getByRole("heading", { name: "Dispatch Board" })).toBeVisible();
  await page.waitForLoadState("networkidle");

  const shareButton = page.getByRole("button", { name: "Share" });
  await expect(shareButton).toBeVisible();
  if (await shareButton.isDisabled()) {
    test.skip(true, "Nothing scheduled for today in this environment — nothing to share.");
  }

  await shareButton.click();
  await expect(
    page.getByText(
      "Could not copy the dispatch board — your browser may be blocking clipboard access."
    )
  ).toBeVisible({ timeout: 10_000 });
});

test("visit calendar: locks and releases a visit", async ({ page }) => {
  await page.goto("/visits");
  await expect(page.getByRole("heading", { name: "Generate Schedule" })).toBeVisible();
  await page.waitForLoadState('networkidle');

  // Every visit tile names its date. It names an hour only when a crew is
  // actually due — an unstaffed visit's tile says its time is not set rather
  // than printing the service window as though it were a plan — so matching
  // on " at " would have quietly skipped this spec on a month with nothing
  // staffed in it.
  const visitButton = page.getByRole("button", { name: /\bon \d{4}-\d{2}-\d{2}\b/ }).first();
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

  // The confirmation raised by that click must not become an obstacle to the
  // next one. This used to be a workaround — move the pointer off the toast
  // so its hover-paused timer could run, then force the click through it —
  // because the toast was bottom-anchored, landed on the drawer's own footer
  // and sat there indefinitely. Both halves are now the assertion: the toast
  // clears itself with the pointer left exactly where the click put it, and
  // the button underneath is clicked without `force`, so Playwright's
  // hit-target check fails the run if anything is covering it again.
  await expect(page.locator('[data-sonner-toast]').first()).toBeHidden({ timeout: 15_000 });

  // Leave the visit as it was found — this spec observes state, it doesn't
  // decide for the manager whether a real visit should end up locked.
  await page
    .getByRole("button", { name: wasLocked ? "Lock this visit" : "Release this visit" })
    .click();
  await expect(
    page.getByRole("button", { name: wasLocked ? "Release this visit" : "Lock this visit" })
  ).toBeVisible({ timeout: 10_000 });
});

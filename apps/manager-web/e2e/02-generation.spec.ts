import { test, expect } from "./fixtures";
import type { Response } from '@playwright/test';
import type { GenerationImpact, PaginatedVisits } from '../src/lib/api-client';
import { assertGenerationPreview, assertGenerationPersisted } from './generation-proof.mjs';

async function readSuccessful<T>(pending: Promise<Response>): Promise<T> {
  const response = await pending;
  expect(response.ok()).toBe(true);
  return response.json();
}
const isVisitList = (response: Response) => response.request().method() === 'GET'
  && new URL(response.url()).pathname.endsWith('/api/visits');
const isGeneration = (action: 'preview' | 'confirm') => (response: Response) => response.request().method() === 'POST'
  && new URL(response.url()).pathname.endsWith(`/visit-generation/${action}`);

/**
 * Visit generation: preview first (nothing written), then confirm. Runs
 * against the existing service agreements — the
 * agreement `01-customer-and-agreement.spec.ts` just created (today, Mon–Fri,
 * weekly) is one of them when the suite runs in order, but this spec does
 * not depend on that specifically: any real agreement makes this a
 * meaningful check. Strict CI requires its imported Synthetic Mixed site to
 * appear among positive additions, an equal nonzero confirmation and new
 * matching database-backed records after a hard reload.
 */
test("previews visit generation for the current month, then confirms it", async ({ page }) => {
  const strict = process.env.E2E_STRICT === '1';
  const listing = strict ? page.waitForResponse(isVisitList) : undefined;
  await page.goto("/visits");
  await expect(page.getByRole("heading", { name: "Generate Schedule" })).toBeVisible();
  const before = listing ? await readSuccessful<PaginatedVisits>(listing) : undefined;

  const previewing = strict ? page.waitForResponse(isGeneration('preview')) : undefined;
  await page.getByRole("button", { name: "Generate Schedule" }).click();
  const preview = previewing ? await readSuccessful<GenerationImpact>(previewing) : undefined;

  // The page heading, the trigger button, and the drawer's own title all
  // read "Generate Schedule" and stay in the accessibility tree together
  // while the drawer is open (unlike the modal Dialog elsewhere in the app,
  // this Sheet does not hide background content), so this must be scoped to
  // the drawer's own heading specifically.
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Generate Schedule" })).toBeVisible();
  // Never a blank drawer: either the impact loaded, or a real error explains
  // why it did not — both are acceptable outcomes for this API call, an
  // indefinite spinner or a silent blank panel are not.
  await expect(
    page.getByText(/Nothing has been written yet\.|Could not work out what generation would change\./)
  ).toBeVisible({ timeout: 15_000 });

  const generateButton = page.getByRole("button", { name: /^Generate$/ });
  if (strict) {
    assertGenerationPreview(preview);
    await expect(page.getByText('Nothing has been written yet.')).toBeVisible();
    await expect(generateButton).toBeEnabled();
  }
  const isDisabled = await generateButton.isDisabled();

  if (isDisabled) {
    // Nothing to generate this run — a legitimate outcome (e.g. the visible
    // range is already fully generated), not a failure of this spec.
    await page.getByRole("button", { name: "Cancel" }).click();
    return;
  }

  const confirming = strict ? page.waitForResponse(isGeneration('confirm')) : undefined;
  await generateButton.click();
  if (confirming) {
    const confirmed = await readSuccessful<GenerationImpact>(confirming);
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.waitForLoadState('networkidle');
    const reloaded = page.waitForResponse(isVisitList);
    await page.reload();
    const after = await readSuccessful<PaginatedVisits>(reloaded);
    assertGenerationPersisted(preview, confirmed, before, after);
    await expect(page.getByRole('heading', { name: 'Generate Schedule' })).toBeVisible();
    return;
  }
  // Either wording the confirm handler uses, depending on whether anything
  // actually changed.
  await expect(
    page.getByText(/visits created|already matches the agreements/)
  ).toBeVisible({ timeout: 15_000 });
});

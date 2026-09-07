import { test as base } from '@playwright/test';
export { expect } from '@playwright/test';

// Freeze the browser's wall clock while leaving real timers/network active.
// Server fixtures use this same date; no actual staging clock is modified.
export const test = base.extend({
  page: async ({ page }, runTest) => {
    if (process.env.E2E_STRICT === '1') {
      await page.clock.setFixedTime(new Date(`${process.env.E2E_DATE}T06:00:00Z`));
    }
    await runTest(page);
  },
});

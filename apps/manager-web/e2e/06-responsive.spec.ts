import { test, expect, type Page } from "@playwright/test";

/**
 * ULK-O07's "verify laptop/tablet layouts" requirement. Two viewport sizes:
 *
 * - Laptop (1366x768): the common low end for a real manager's laptop
 *   screen — above the app shell's lg breakpoint (1024px), so the fixed
 *   sidebar nav should render.
 * - Tablet (768x1024, iPad portrait): below the lg breakpoint, so the
 *   collapsible hamburger/Sheet nav should render instead.
 *
 * The check that actually catches a broken responsive layout is document-
 * level horizontal overflow: nothing in this app should force the whole
 * page to scroll sideways. Individual wide content (the Table primitive,
 * the visits calendar grid) already scrolls internally via its own
 * overflow-x-auto container — see src/components/ui/table.tsx and the
 * visits calendar markup — so this only fails on a genuine regression, not
 * on those known/intentional internal scrollers.
 */
const LAPTOP = { width: 1366, height: 768 };
const TABLET = { width: 768, height: 1024 };

const PAGES: Array<{ path: string; heading: string }> = [
  { path: "/dashboard", heading: "Dashboard" },
  { path: "/customers", heading: "Customers" },
  { path: "/service-agreements", heading: "Service Agreements" },
  { path: "/visits", heading: "Visit Calendar" },
  { path: "/workforce", heading: "Workforce" },
  { path: "/vehicles", heading: "Vehicles" },
  { path: "/dispatch-board", heading: "Dispatch Board" },
  { path: "/unassigned-visits", heading: "Unassigned Visits" },
  { path: "/schedule-history", heading: "Schedule History" },
];

async function expectNoDocumentLevelHorizontalScroll(page: Page, label: string) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  // 1px tolerance for scrollbar/rounding noise, not a real overflow.
  expect(
    scrollWidth,
    `${label} — page scrolls horizontally (scrollWidth ${scrollWidth} > clientWidth ${clientWidth})`
  ).toBeLessThanOrEqual(clientWidth + 1);
}

for (const { path, heading } of PAGES) {
  test(`${path} has no horizontal overflow and a working sidebar at laptop width`, async ({
    page,
  }) => {
    await page.setViewportSize(LAPTOP);
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await page.waitForLoadState("networkidle");

    // Fixed sidebar, not the hamburger menu, is the laptop-width nav.
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open navigation menu" })).toBeHidden();

    await expectNoDocumentLevelHorizontalScroll(page, `${path} (laptop)`);
  });

  test(`${path} has no horizontal overflow and a working nav drawer at tablet width`, async ({
    page,
  }) => {
    await page.setViewportSize(TABLET);
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await page.waitForLoadState("networkidle");

    await expectNoDocumentLevelHorizontalScroll(page, `${path} (tablet)`);

    // Hamburger menu, not the fixed sidebar, is the tablet-width nav — and
    // it has to actually open and expose every nav link, not just render.
    const menuButton = page.getByRole("button", { name: "Open navigation menu" });
    await expect(menuButton).toBeVisible();
    await menuButton.click();
    await expect(page.getByRole("link", { name: "Schedule History" })).toBeVisible();
  });
}

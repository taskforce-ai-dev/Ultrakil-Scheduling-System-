import { defineConfig, devices } from "@playwright/test";

/**
 * Runs against a real dev stack (web + API + database), never against
 * mocked routes. These are the ULK-O07 acceptance journeys: the point is to
 * prove the manager portal works against the actual API and the actual hard
 * scheduling rules, which a mocked backend cannot exercise.
 *
 * Prerequisites (see e2e/README.md):
 *   - `pnpm dev:infra` (Postgres, Redis) and `pnpm dev:api` running
 *   - `pnpm dev:web` running
 *   - A signed-in-able user: E2E_EMAIL / E2E_PASSWORD env vars
 *
 * This config does not start the dev servers itself — orchestrating Next.js,
 * Nest, the scheduler and Postgres together is what `pnpm dev:*` already
 * does, and duplicating that here would just be a second, less reliable copy
 * of it.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  // Real writes against one real database — a second worker would be
  // fighting the first over the same customers, agreements and runs.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  timeout: 30_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: "e2e/.auth/user.json" },
      dependencies: ["setup"],
    },
  ],
});

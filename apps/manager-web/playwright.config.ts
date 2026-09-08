import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";
import { validateStrictEnvironment } from './e2e/strict-policy.mjs';

if (process.env.E2E_STRICT === '1') validateStrictEnvironment(process.env);

const artifactsDirectory = process.env.E2E_PRIVATE_ARTIFACTS_DIR ?? "../../.playwright-artifacts";

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
 *
 * Every output path below is pushed outside this directory on purpose:
 * `next dev`'s file watcher covers the whole `apps/manager-web` tree, and a
 * run writes a screenshot/video/trace file on every failure — inside that
 * tree, each write is a "file changed" event, which triggers a Fast Refresh
 * rebuild, which can itself touch `.next/`, which triggers another one. A
 * long or repeatedly-failing run turns that into a continuous rebuild loop
 * fighting the very dev server the suite is testing against — this is
 * confirmed against the real dev server, not theoretical.
 */
export default defineConfig({
  testDir: "./e2e",
  outputDir: join(artifactsDirectory, "test-results"),
  fullyParallel: false,
  // Real writes against one real database — a second worker would be
  // fighting the first over the same customers, agreements and runs.
  workers: 1,
  // Strict rehearsal is a disposable, deterministic database. Retrying a
  // stateful journey after it has written part of its workflow can only hide
  // the first failure or turn it into a misleading no-op failure.
  retries: process.env.E2E_STRICT === '1' ? 0 : process.env.CI ? 1 : 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: join(artifactsDirectory, "playwright-report") }],
    ...(process.env.E2E_STRICT === '1' ? [["./e2e/strict-reporter.mjs"] as [string]] : []),
  ],
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
      use: { ...devices["Desktop Chrome"], storageState: join(artifactsDirectory, ".auth", "user.json") },
      dependencies: ["setup"],
    },
  ],
});

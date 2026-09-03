# End-to-end tests

Playwright specs covering the ULK-O07 critical journeys: customer creation,
service agreement + preview, visit generation, dispatch/manual override,
locking, and publishing a schedule run.

These run against a **real dev stack** — the real API, the real database,
the real scheduler — never against mocked routes. That is the point of this
suite: `apps/manager-web/src/app/(app)/**/__tests__/*.test.tsx` (Vitest)
already covers component behaviour against a mocked `api-client`; what those
cannot catch is the frontend and the real backend disagreeing about a
contract, a hard scheduling rule, or an error shape. Only a real backend
catches that.

## Prerequisites

1. Infrastructure and API running:
   ```bash
   pnpm dev:infra   # Postgres, Redis
   pnpm dev:api     # from the repo root, in its own terminal
   pnpm dev:web     # from the repo root, in another terminal
   ```
2. A workforce matrix and master schedule imported (`pnpm db:seed`,
   `pnpm schedule:import` — see `data/README.md`), or at minimum
   `pnpm db:seed:demo` for fabricated data. The dispatch/generation/publish
   specs need real customers, agreements, employees and vehicles to work
   with — they do not fabricate that themselves, because a scheduling run
   only means something against a real workforce and real branch data.
3. A manager account to sign in as. Set:
   ```bash
   export E2E_EMAIL="you@example.com"
   export E2E_PASSWORD="..."
   ```
   Ask the Project Lead for a account if you don't already have one seeded.

## Running

```bash
pnpm test:e2e
```

First run installs the browser binaries if needed:

```bash
pnpm exec playwright install chromium
```

Open the HTML report after a run (especially a failure) with:

```bash
pnpm exec playwright show-report
```

## What each spec does, and what it needs already in the database

| Spec | Covers | Needs beforehand |
| --- | --- | --- |
| `01-customer-and-agreement.spec.ts` | Create a customer, create a service agreement for it, see the schedule preview | Nothing — creates its own customer |
| `02-generation.spec.ts` | Preview and confirm visit generation for the visible month | At least one active service agreement (created by the spec above, or from a real import) |
| `03-dispatch-and-lock.spec.ts` | Dispatch board → Edit crew (a manual override, with a reason) on today's date; lock/unlock a visit | At least one visit scheduled for today, which `02-generation.spec.ts` just created |
| `04-publish.spec.ts` | Start a schedule run, wait for it to finish, publish it | Nothing beyond agreements existing somewhere in the horizon used |
| `05-accessibility.spec.ts` | Automated axe-core scan (serious/critical only) of every top-level page, plus the customer/agreement/generation forms and the override/publish dialogs | Runs after 01-04 so those dialogs have real data to open; the override and publish dialog checks skip themselves (not fail) if nothing's there to open |
| `06-responsive.spec.ts` | No document-level horizontal scroll, and a working nav (fixed sidebar vs. hamburger/Sheet drawer), on every top-level page at a laptop width (1366×768) and a tablet width (768×1024) | Nothing — layout-only, doesn't touch data |

The numeric prefixes are load-bearing, not cosmetic: Playwright walks
`testDir` in filename order and this suite runs with `workers: 1` (see
`playwright.config.ts`) specifically so that order is also execution order.
`02-generation` relies on the agreement `01-customer-and-agreement` just
created, and `03-dispatch-and-lock` relies on a visit `02-generation` just
made. Renaming a file without preserving its position breaks that chain.

## Why this isn't wired into CI yet

CI has no seeded workforce matrix or master schedule, and Chanya's ULK-C07
staging setup is what's meant to provide one. Until that lands, this suite is
a local/staging tool, run by hand — see the ULK-O07 pull request for what's
outstanding there.

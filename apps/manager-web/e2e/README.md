# End-to-end tests

Playwright specs covering the ULK-O07 critical journeys: customer creation,
service agreement + preview, visit generation, dispatch/manual override,
locking, and publishing a schedule run.

These run against a **real stack** — API, database and scheduler — with
fabricated imports in CI and separately approved data for operator UAT. This
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
   with. The CI rehearsal generates its own fabricated inputs and imports them
   through the same real parser and database path.
3. An admin account to sign in as (the manual assignment journey needs admin
   write permission). Set:
   ```bash
   export E2E_EMAIL="you@example.com"
   export E2E_PASSWORD="..."
   ```
   Obtain an authorized test account from the Project Lead if needed.

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
| `03-dispatch-and-lock.spec.ts` | Dispatch board → Edit crew with a reason, persisted crew and reopen validation; lock/unlock a visit | Strict CI uses the seeded assigned Synthetic Active visit. Non-strict runs adapt to available visits. |
| `04-publish.spec.ts` | Start a schedule run, wait for it to finish, publish it | Nothing beyond agreements existing somewhere in the horizon used |
| `05-accessibility.spec.ts` | Automated axe-core scan (serious/critical only) of every top-level page, plus the customer/agreement/generation forms and override/publish dialogs | CI seeds populated dispatch and a separate draft. Any required skip fails strict acceptance. |
| `06-responsive.spec.ts` | No document-level horizontal scroll, and a working nav (fixed sidebar vs. hamburger/Sheet drawer), on every top-level page at a laptop width (1366×768) and a tablet width (768×1024) | Nothing — layout-only, doesn't touch data |
| `07-vehicle-drivers-and-inactive-clients.spec.ts` | DAG-3284/ABE-7244/PJ-6796/DAI-0191/DAC-2485 show all checked drivers equally; inactive customers/sites are labelled and excluded from agreement pickers | CI imports synthetic matrix/master workbooks containing all required shapes. Actual workbook verification remains a separate real-data UAT pass. Missing records fail strict acceptance. |

The numeric prefixes are load-bearing, not cosmetic: Playwright walks
`testDir` in filename order and this suite runs with `workers: 1` (see
`playwright.config.ts`) specifically so that order is also execution order.
`02-generation` relies on the agreement `01-customer-and-agreement` just
created. Strict dispatch uses its independently seeded assigned visit, so a
new unassigned visit cannot accidentally satisfy that workflow. Renaming files
without preserving their order changes the generation/publish sequence.

## Strict synthetic CI and real staging UAT

The `Staging lifecycle rehearsal` workflow runs this browser suite on PRs
regardless of their base and supports manual dispatch. From the repository root
on a Docker-authorized nonroot Linux account, run `python3 deploy/rehearse.py`
after installing dependencies, generating Prisma and installing Chromium. See
`docs/STAGING_RUNBOOK.md` for host prerequisites and the complete command sequence.

The runner generates private fabricated workbooks outside the repository and
uses a new Compose project, database ending `_test`, queue prefix and fixed
browser date. It supplies `E2E_STRICT=1` and the matching namespace variables;
do not manually point strict mode at a shared environment. All 48 journeys must
execute and pass. A missing/skipped test, expected failure, failed preview,
blocked generation or unsaved strict dispatch change blocks acceptance.

Oshadi retains O08 ownership: actual staging UAT, real-data O09 regression,
deployed screenshots, manager guide and demo preparation. CI synthetic results
do not satisfy that staging handoff. Thivarrakesh provides the verified C08
build/URL once an authorized staging environment exists. Her separate UI work
and `docs/manager` deliverables remain separate from this automation.

These suites write data. Use an explicitly authorized isolated database, never
a development/test database holding the real workforce. Auth state, browser
reports, traces, private inputs and backups are not uploaded by the rehearsal
workflow; treat operator reports as private and share only reviewed evidence.

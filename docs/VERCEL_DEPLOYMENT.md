# Vercel deployment contract

UltraKIL deploys as three Vercel Projects connected to this monorepo. The
manager portal, Nest API and FastAPI scheduler each have their own build and
stable URL; the API uses QStash for durable, request-driven schedule execution.
The Docker/Compose deployment remains supported separately for self-hosting.

Use a dedicated Neon project for staging and record its identity in the private
operator configuration. Provision production PostgreSQL separately.
`DATABASE_URL` remains deliberately blank in the checked-in template: never
copy the staging connection into production, and do not record either
credential in Git.

## Plan gate

The API's native Nest deployment uses Fluid Compute, whose current Hobby
default is 300 seconds, above the API's 55-second application execution budget.
Do not add a `functions` override for `src/main.ts`: Vercel's Nest preset owns
the generated function and rejects that pattern. The scheduler separately
declares a conservative 60-second cap. Vercel restricts Hobby to personal,
non-commercial use, however, so a commercial UltraKIL production deployment
requires an eligible paid plan or written approval from Vercel. Do not describe
Hobby as the production entitlement.

## Create the projects

Create one Vercel Project for each directory below, all connected to the same
Git repository:

| Project | Root Directory | Runtime | Entrypoint |
| --- | --- | --- | --- |
| manager web | `apps/manager-web` | Next.js | Next.js auto-detection |
| API | `apps/api` | NestJS / Node.js | `src/main.ts` |
| scheduler | `services/scheduler` | FastAPI / Python | `app/main.py` |

Enable **Include source files outside of the Root Directory** for all three
projects. The workspace lockfile and shared `packages/api-contracts` package
live above the application roots.

The checked-in `vercel.json` files keep build behavior explicit. The scheduler
also declares its function duration; the API uses Vercel's native Nest preset
and Fluid Compute duration described above. The scheduler's `pyproject.toml`
contains production dependencies, while `app/main.py` is a Vercel-recognized
FastAPI entrypoint.

## Staging and production topology

Keep a long-lived `staging` Git branch. Vercel treats it as a Preview branch;
its stable generated branch URL (or a domain assigned specifically to that
branch) is the UAT endpoint. Configure branch-specific Preview variables for
that branch. Ordinary pull-request deployment URLs may still be used for
isolated smoke tests, but must not replace the stable cross-service staging
wiring.

`main` remains the Production branch. Production uses different PostgreSQL and
QStash resources and independently generated secrets. Never point staging at
the production database.

Required URL wiring in each environment:

```text
manager: NEXT_PUBLIC_API_BASE_URL=https://<api-domain>/api
api:     API_PUBLIC_URL=https://<api-domain>
api:     API_CORS_ORIGINS=https://<manager-domain>
api:     SCHEDULER_BASE_URL=https://<scheduler-domain>
```

Use [`deploy/vercel-variables.example`](../deploy/vercel-variables.example) as a variable
name checklist. Add real values only in the Vercel dashboard. The API and
scheduler must receive the same `SCHEDULER_API_TOKEN`; the scheduler denies
`/solve` by default if that token is absent. Do not set
`SCHEDULER_ALLOW_UNAUTHENTICATED` on Vercel.

Set `SCHEDULE_DISPATCHER=qstash` on the Vercel API. In this mode the API does
not create a Redis or BullMQ connection. QStash signs the exact execute and
failure-callback URLs derived from `API_PUBLIC_URL` and `API_GLOBAL_PREFIX`, so
the public URL must be a pure HTTPS origin and the prefix must not contain
leading or trailing slashes.

## Staging schedule safety-net gate

Recovery has two independent triggers. Configure a recurring signed QStash
schedule for staging and production; use distinct environment credentials and
record both schedule IDs privately. QStash is the only recurring recovery
trigger available to the long-lived staging Preview branch.

Use `POST https://<public-api-host>/api/internal/schedule-runs/reconcile`,
destination `Content-Type: application/json`, body exactly `{}`, and cron
`*/5 * * * *` (every five minutes, UTC). Match each environment's stable
`API_PUBLIC_URL` and configured API prefix exactly. Follow the
[recovery schedule operator instructions](VERCEL_QSTASH_RECOVERY.md), including
plan/cadence validation and destination-header verification. Missing JSON
content type can prevent `rawBody` capture and cause 401 signature rejection.
Record signed smoke evidence from each recurring schedule: exact release SHA,
UTC delivery time, destination settings and a **204 No Content** result; keep
schedule/message IDs private and never publish signing credentials.

Vercel invokes cron jobs only on Production deployments, not Preview
deployments. Configure the daily Vercel Cron production-only fallback with the
server-only `CRON_SECRET`; it is not staging evidence and cannot recover a
missed staging schedule. Before UAT/sign-off, record a successful safe delivery
from the staging QStash schedule, production QStash schedule, and production
Vercel Cron fallback. Do not use a browser request or expose `CRON_SECRET`,
QStash tokens or signing keys to make either trigger work.

## Stable staging Deployment Protection gate

Vercel Deployment Protection runs before application code. Standard Protection
can therefore block browser-to-API, QStash-to-API and API-to-scheduler traffic
even though the API JWT, QStash signature verification and scheduler bearer
token are valid.

Before connecting the stable staging URLs, open **Settings → Deployment
Protection** for the API and scheduler Vercel Projects. On the current free
Hobby plan, set Deployment Protection to **None** on those backend projects
and retain it as long as staging is operational and its cross-service traffic
and QStash schedule are active. This applies to their Preview deployments
because Vercel's domain-specific Deployment Protection Exceptions are not a
Hobby feature. Restore Standard Protection only when pausing/decommissioning
staging, or after a paid domain-specific exception has been configured and
verified for the stable backend URLs. Before taking staging offline, disable
its QStash schedule and drain/cancel outstanding deliveries; do not leave the
schedule retrying against protected or offline endpoints. This makes the stable staging backend
URLs reachable, but does not remove UltraKIL's application controls: API
requests still require their normal JWT where applicable, QStash
execute/failure routes still verify their signatures, and `/solve` still
requires `SCHEDULER_API_TOKEN`.

If a future eligible plan provides a domain-specific exception, exempt only the
stable staging API and scheduler domains instead of every Preview deployment.
Do not use Protection Bypass for Automation for browser traffic and do not put
`VERCEL_AUTOMATION_BYPASS_SECRET`, an `x-vercel-protection-bypass` value, or a
bypass query parameter in `NEXT_PUBLIC_*` or any client bundle. A deliberate
automation-only bypass, if ever required, belongs only in a server-side test
runner secret store. There is no browser-exposed bypass secret.

## Controlled dispatcher and database cutover gate

Before routing a candidate API with a changed dispatcher or migration to an
environment database:

1. Provision an isolated PostgreSQL database for the target environment and
   record its provider/version without committing credentials.
2. Classify the target before migration. Do not call a database fresh merely
   because an application-table lookup failed: errors are blockers, not a fresh
   result.
3. For an **existing** database, put schedule creation, cancellation and imports
   into operator-maintained maintenance mode, wait for in-flight HTTP writes,
   drain or cancel every queued/running run through the supported workflow, and
   take or confirm a recoverable backup. Do not kill a solve and do not
   manufacture an outbox row for a legacy `RUNNING` run.
4. From the reviewed candidate checkout and a trusted operator environment with
   the target `DATABASE_URL`, select exactly one read-only guard path. For an
   existing Vercel database switching to QStash:

   ```bash
   pnpm --filter @ultrakil/api dispatch:cutover:check -- --target=qstash
   ```

   The guard defaults safe by requiring the explicit target. It rejects any
   `QUEUED`/`RUNNING` run, a missing active-run outbox, or an active outbox with
   the wrong provider. It is safe against a pre-outbox schema and never writes
   or backfills a `RUNNING` run.

   For a deliberately **fresh** database, use the separate positive emptiness
   check instead:

   ```bash
   pnpm --filter @ultrakil/api dispatch:cutover:check -- --fresh --target=qstash
   ```

   `--fresh` succeeds only when PostgreSQL confirms there are no application
   tables in the Prisma-owned `public` schema. Provider-managed schemas such as
   Neon's `neon_auth` do not make an otherwise new application database look
   occupied. The guard does not query `schedule_runs`, never treats a query
   error as fresh, and does not replace the existing-database guard.
5. Only after the applicable guard succeeds, run
   `pnpm --filter @ultrakil/api db:deploy` and record the command result and
   release SHA.
6. Confirm `pnpm --filter @ultrakil/api db:status` before routing the manager
   portal to the API.
7. Run the external-database operator workflow below. Its explicit apply step
   creates the initial administrator only if no users exist, preserves existing
   accounts, and imports both approved workbooks. Do not use the Docker staging
   command or the ordinary local seed/import commands for this release step.

Migration is intentionally not part of `vercel.json`'s build command: a build
may run more than once or concurrently, while schema and seed changes are a
single controlled release operation.

## External PostgreSQL workbook import

Run this only from a trusted operator machine at the reviewed release SHA with
Node 22 and the locked workspace dependencies installed. It is not a Vercel
build command, function, or browser action. It needs no Docker, Redis, QStash,
or `POSTGRES_*` configuration; it uses the explicit external `DATABASE_URL`.
No `.env` file is loaded automatically by this command.

Load these variables securely into the operator process environment. Do not
paste credentials into shell command arguments, Git, logs or chat:

- `DATABASE_URL`: the supported external PostgreSQL endpoint's URL, including
  `sslmode=require&sslaccept=strict` for encrypted, certificate-verified access.
  Only the `public` schema is supported: omit `schema` or specify `schema=public`;
  any other schema is rejected even when the host/database confirmation matches.
  This command is **public-CA-only**: the endpoint certificate must chain to the
  operator machine's unmodified public system CA roots. Custom CA and client
  certificate endpoints are unsupported. Certificate URL parameters and trust
  overrides (`SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `PGSSLROOTCERT`,
  `PGSSLCERT`, `PGSSLKEY`, `NODE_TLS_REJECT_UNAUTHORIZED`) are rejected. Do not
  disable certificate verification or install a private root to bypass this
  policy; such an endpoint requires a separately reviewed operator workflow.
  The supported endpoint must be accessible to the operator with import write rights.
- `ULTRAKIL_IMPORT_TARGET`: separately confirm `hostname:port/database` from
  that URL, including `:5432` when the URL omits its port. A mismatch fails
  before the importer runs. This confirmation does not grant production approval.
- `TECHNICIAN_MATRIX_PATH` and `MASTER_SCHEDULE_PATH`: absolute paths to the
  approved workbooks outside the checkout, owned by the current nonroot operator
  with mode exactly `0600`. Each containing directory must also be owned by that
  operator with mode exactly `0700`; group/world access, other owners and symlinks
  are rejected. Validation never changes file contents, ownership or permissions.
- Optional `MATRIX_MAPPING_PATH`: an approved private JSON file outside the
  checkout with the same file protections. If omitted, parser defaults apply;
  a supplied missing file fails instead of silently ignoring the override.
- Optional `STAGING_REPORT_DIR`: an operator-owned `0700` directory outside the
  checkout. Despite its shared import-runner name, it supports this Vercel
  workflow too. Omit it for aggregate output only. If supplied, each run creates
  a unique private report directory with a `0600` issue file containing PII.
- For apply, set `SEED_ADMIN_EMAIL`, `SEED_ADMIN_NAME`, and an independently
  generated `SEED_ADMIN_PASSWORD` of at least 24 characters. Existing accounts
  and passwords are preserved; credentials are required to avoid default-account
  creation if this is the first import.

First parse and validate both workbooks without connecting to PostgreSQL:

```bash
pnpm vercel:import --dry-run
```

Missing/unreadable inputs, zero employees/vehicles/customers/sites, or zero
importable agreements fail closed. Successful stdout contains numeric totals
and stable issue codes only; child errors and source text are withheld. Review
remaining data decisions privately. A successful dry-run proves parsing only,
not connectivity, migration readiness, actual import, or closure of uncertain
branches and unconfirmed opening hours.

After the maintenance/backup/cutover/migration gates above, review the dry-run
for this exact workbook pair and target, and obtain the required environment
authorization before executing the explicit write step:

```bash
pnpm vercel:import --apply
```

Both inputs are parsed before any database write. Apply then uses the existing
reference, matrix and schedule importers; it is not one transaction across all
three phases. A later failure may leave earlier upserts committed. Keep the
environment in maintenance, inspect privately, and use the recorded recovery
point if needed. Never claim rollback or a complete import from a failed run.
Re-import uses the existing stable keys and inactive-history preservation rules.
Record the release SHA, approved workbook checksums, sanitized dry-run/apply
totals and subsequent database checks. Real staging import remains pending until
`--apply` succeeds against the authorized target and those checks are recorded.
No workbook or detailed report belongs in the checkout or Vercel build artifacts.

## Release workflow

1. Keep the reviewed candidate out of the routing `staging` branch while the
   maintenance, backup, dispatcher guard and controlled database migration gate
   above complete.
2. Merge/promote that exact candidate to `staging` only after the guard and
   migration have succeeded, then confirm all three branch Preview deployments use the staging-only URLs,
   PostgreSQL database, QStash credentials and secrets.
3. Verify API liveness/readiness, manager login, CORS, an authenticated
   scheduler request, a QStash-backed schedule run, cancellation and
   terminal-failure recovery.
4. Complete real-data UAT against the exact staging SHA.
5. Before merge/promote to `main`, repeat the controlled gate against the
   production database using the exact accepted SHA: for an existing database,
   maintenance, drain/cancel, backup, existing-database guard, `db:deploy` and
   `db:status`; for a positively confirmed fresh database, `--fresh`,
   `db:deploy` and `db:status`. Only then merge/promote that exact SHA to
   `main`, which routes Production automatically, and verify the three
   Production deployments before sign-off.

The Docker path continues to use private PostgreSQL, Redis and BullMQ services.
Its scheduler opt-out is explicit and network-private; the local developer
scheduler binds to loopback. Those settings must not be copied to Vercel.

## QStash rollback gate

Do not change `SCHEDULE_DISPATCHER` back to BullMQ or promote an older API
while QStash may still deliver a schedule run. First keep maintenance enabled,
pause or delete the recurring QStash reconcile schedule, cancel or let every
QStash delivery reach a terminal state, and confirm the QStash dashboard has no
scheduled or retrying delivery for reconcile, execute or failure-callback routes.
The internal QStash routes are absent in BullMQ mode; a recurring reconcile
schedule left enabled would receive 404 responses. Then run:

```bash
pnpm --filter @ultrakil/api dispatch:cutover:check -- --target=bullmq
```

Only a successful guard permits the provider configuration change and rollback
deployment. If QStash cannot be shown drained, retain the QStash configuration
while rolling back compatible code or stop the rollback; do not rely on an old
API ignoring a later QStash delivery.
Restore that schedule only after switching back to QStash and verifying the
internal routes and a successful signed delivery at the accepted release SHA.

## Official references

- [Vercel Git branches and multiple preview phases](https://vercel.com/docs/git#multiple-preview-phases)
- [Vercel generated branch URLs](https://vercel.com/docs/deployments/generated-urls#generated-from-git)
- [Vercel monorepos](https://vercel.com/docs/monorepos)
- [NestJS on Vercel](https://vercel.com/docs/frameworks/backend/nestjs)
- [FastAPI on Vercel](https://vercel.com/docs/frameworks/backend/fastapi)
- [Vercel function limits](https://vercel.com/docs/functions/limitations)
- [Vercel Hobby plan](https://vercel.com/docs/plans/hobby)
- [QStash signing](https://upstash.com/docs/qstash/howto/signature)
- [Prisma 6 PostgreSQL TLS connection parameters](https://docs.prisma.io/docs/orm/v6/overview/databases/postgresql)
- [Vercel Deployment Protection](https://vercel.com/docs/deployment-protection)
- [Vercel Deployment Protection bypass methods](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection)
- [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs/quickstart)

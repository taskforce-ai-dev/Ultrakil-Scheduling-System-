# Vercel deployment contract

UltraKIL deploys as three Vercel Projects connected to this monorepo. The
manager portal, Nest API and FastAPI scheduler each have their own build and
stable URL; the API uses QStash for durable, request-driven schedule execution.
The Docker/Compose deployment remains supported separately for self-hosting.

No PostgreSQL service has been selected yet. `DATABASE_URL` is deliberately a
required blank in the checked-in template, and deployment must not proceed
until separate staging and production databases are provisioned.

## Plan gate

The checked-in functions use an explicit, conservative 60-second compatibility
cap. This remains valid whether or not Fluid Compute raises the account's
available ceiling. Vercel restricts Hobby to personal, non-commercial use,
however, so a commercial UltraKIL production deployment requires an eligible
paid plan or written approval from Vercel. Do not describe Hobby as the
production entitlement.

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

The checked-in `vercel.json` files keep builds and function duration explicit.
The scheduler's `pyproject.toml` contains production dependencies, while
`app/main.py` is a Vercel-recognized FastAPI entrypoint.

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

Vercel invokes cron jobs only on Production deployments, not Preview
deployments. The daily `CRON_SECRET` safety net is therefore production-only;
it is not staging evidence and cannot recover a missed staging schedule. Before
staging UAT, create and verify an explicit staging-only QStash schedule that
uses QStash signing to invoke the released safety-net/reconciliation endpoint.
Record its schedule ID and latest successful delivery in private release
evidence. Do not use a browser request or expose `CRON_SECRET`, QStash tokens
or signing keys to make staging scheduling work.

## Stable staging Deployment Protection gate

Vercel Deployment Protection runs before application code. Standard Protection
can therefore block browser-to-API, QStash-to-API and API-to-scheduler traffic
even though the API JWT, QStash signature verification and scheduler bearer
token are valid.

Before connecting the stable staging URLs, open **Settings → Deployment
Protection** for the API and scheduler Vercel Projects. On the current free
Hobby plan, set Deployment Protection to **None** on those backend projects for
the UAT window; this applies to their Preview deployments because Vercel's
domain-specific Deployment Protection Exceptions are not a Hobby feature.
Restore Standard Protection after UAT. This makes the stable staging backend
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

1. Put schedule creation, cancellation and imports into operator-maintained
   maintenance mode, and wait for in-flight HTTP writes to finish.
2. Drain or cancel every queued/running schedule run using the supported
   workflow; do not kill a solve and do not manufacture an outbox row for a
   legacy `RUNNING` run.
3. Provision an isolated PostgreSQL database for the target environment and
   record its provider/version without committing credentials.
4. Take or confirm a recoverable provider backup before migrating an existing
   database.
5. From the reviewed candidate checkout and a trusted operator environment with
   the target `DATABASE_URL`, run the read-only, explicit-provider guard. For
   the Vercel path, the target is QStash:

   ```bash
   pnpm --filter @ultrakil/api dispatch:cutover:check -- --target=qstash
   ```

   The guard defaults safe by requiring the explicit target. It rejects any
   `QUEUED`/`RUNNING` run, a missing active-run outbox, or an active outbox with
   the wrong provider. It is also safe against a pre-outbox schema and never
   writes or backfills a `RUNNING` run.
6. Only after the guard succeeds, run
   `pnpm --filter @ultrakil/api db:deploy` and record the command result and
   release SHA.
7. Run `pnpm --filter @ultrakil/api db:seed` to create the initial administrator
   only when the target has not already been provisioned.
8. Run the strict workbook dry-run and import workflow from the preserved C08
   runbook. Real workbook files and import reports containing personal data
   stay outside Git and Vercel build artifacts.
9. Confirm `pnpm --filter @ultrakil/api db:status` before routing the manager
   portal to the API.

Migration is intentionally not part of `vercel.json`'s build command: a build
may run more than once or concurrently, while schema and seed changes are a
single controlled release operation.

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
5. Merge the accepted release to `main`, apply the production migration gate,
   and verify the three Production deployments before sign-off.

The Docker path continues to use private PostgreSQL, Redis and BullMQ services.
Its scheduler opt-out is explicit and network-private; the local developer
scheduler binds to loopback. Those settings must not be copied to Vercel.

## QStash rollback gate

Do not change `SCHEDULE_DISPATCHER` back to BullMQ or promote an older API
while QStash may still deliver a schedule run. First keep maintenance enabled,
cancel or let every QStash schedule delivery reach a terminal state, and confirm
the QStash dashboard has no scheduled or retrying delivery for the execute or
failure-callback routes. Then run:

```bash
pnpm --filter @ultrakil/api dispatch:cutover:check -- --target=bullmq
```

Only a successful guard permits the provider configuration change and rollback
deployment. If QStash cannot be shown drained, retain the QStash configuration
while rolling back compatible code or stop the rollback; do not rely on an old
API ignoring a later QStash delivery.

## Official references

- [Vercel Git branches and multiple preview phases](https://vercel.com/docs/git#multiple-preview-phases)
- [Vercel generated branch URLs](https://vercel.com/docs/deployments/generated-urls#generated-from-git)
- [Vercel monorepos](https://vercel.com/docs/monorepos)
- [NestJS on Vercel](https://vercel.com/docs/frameworks/backend/nestjs)
- [FastAPI on Vercel](https://vercel.com/docs/frameworks/backend/fastapi)
- [Vercel function limits](https://vercel.com/docs/functions/limitations)
- [Vercel Hobby plan](https://vercel.com/docs/plans/hobby)
- [QStash signing](https://upstash.com/docs/qstash/howto/signature)
- [Vercel Deployment Protection](https://vercel.com/docs/deployment-protection)
- [Vercel Deployment Protection bypass methods](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection)
- [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs/quickstart)

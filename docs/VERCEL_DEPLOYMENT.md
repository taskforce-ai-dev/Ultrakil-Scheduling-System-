# Vercel deployment contract

UltraKIL deploys as three Vercel Projects connected to this monorepo. The
manager portal, Nest API and FastAPI scheduler each have their own build and
stable URL; the API uses QStash for durable, request-driven schedule execution.
The Docker/Compose deployment remains supported separately for self-hosting.

No PostgreSQL service has been selected yet. `DATABASE_URL` is deliberately a
required blank in the checked-in template, and deployment must not proceed
until separate staging and production databases are provisioned.

## Plan gate

The checked-in functions are capped at 60 seconds so they fit Vercel's current
Hobby technical limit. Vercel restricts Hobby to personal, non-commercial use,
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

Use [`deploy/vercel.env.example`](../deploy/vercel.env.example) as a variable
name checklist. Add real values only in the Vercel dashboard. The API and
scheduler must receive the same `SCHEDULER_API_TOKEN`; the scheduler denies
`/solve` by default if that token is absent. Do not set
`SCHEDULER_ALLOW_UNAUTHENTICATED` on Vercel.

Set `SCHEDULE_DISPATCHER=qstash` on the Vercel API. In this mode the API does
not create a Redis or BullMQ connection. QStash signs the exact execute and
failure-callback URLs derived from `API_PUBLIC_URL` and `API_GLOBAL_PREFIX`, so
the public URL must be a pure HTTPS origin and the prefix must not contain
leading or trailing slashes.

## Database provisioning gate

Before deploying an API against a new database:

1. Provision an isolated PostgreSQL database for the target environment and
   record its provider/version without committing credentials.
2. Take or confirm a recoverable provider backup before migrating an existing
   database.
3. From a trusted operator environment with the target `DATABASE_URL`, run
   `pnpm --filter @ultrakil/api db:deploy` and record the command result and
   release SHA.
4. Run `pnpm --filter @ultrakil/api db:seed` to create the initial administrator
   only when the target has not already been provisioned.
5. Run the strict workbook dry-run and import workflow from the preserved C08
   runbook. Real workbook files and import reports containing personal data
   stay outside Git and Vercel build artifacts.
6. Confirm `pnpm --filter @ultrakil/api db:status` before routing the manager
   portal to the API.

Migration is intentionally not part of `vercel.json`'s build command: a build
may run more than once or concurrently, while schema and seed changes are a
single controlled release operation.

## Release workflow

1. Merge the reviewed release candidate into the long-lived `staging` branch.
2. Confirm all three branch Preview deployments use the staging-only URLs,
   PostgreSQL database, QStash credentials and secrets.
3. Apply migrations/provisioning, then verify API liveness/readiness, manager
   login, CORS, an authenticated scheduler request, a QStash-backed schedule
   run, cancellation and terminal-failure recovery.
4. Complete real-data UAT against the exact staging SHA.
5. Merge the accepted release to `main`, apply the production migration gate,
   and verify the three Production deployments before sign-off.

The Docker path continues to use private PostgreSQL, Redis and BullMQ services.
Its scheduler opt-out is explicit and network-private; the local developer
scheduler binds to loopback. Those settings must not be copied to Vercel.

## Official references

- [Vercel Git branches and multiple preview phases](https://vercel.com/docs/git#multiple-preview-phases)
- [Vercel generated branch URLs](https://vercel.com/docs/deployments/generated-urls#generated-from-git)
- [Vercel monorepos](https://vercel.com/docs/monorepos)
- [NestJS on Vercel](https://vercel.com/docs/frameworks/backend/nestjs)
- [FastAPI on Vercel](https://vercel.com/docs/frameworks/backend/fastapi)
- [Vercel function limits](https://vercel.com/docs/functions/limitations)
- [Vercel Hobby plan](https://vercel.com/docs/plans/hobby)
- [QStash signing](https://upstash.com/docs/qstash/howto/signature)

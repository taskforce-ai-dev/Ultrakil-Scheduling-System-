# Vercel deployment contract

UltraKIL uses three Vercel Projects connected to this monorepo. No dedicated
staging server is required: Vercel Preview deployments are the review/test
environment, and the Production deployment is the live environment. Each
project gets a stable production `.vercel.app` domain; do not put a branch URL
or a deployment-specific URL into the API or CORS configuration.

## Create the projects

Create one Vercel Project for each directory below, all connected to the same
Git repository:

| Project | Root Directory | Runtime | Entrypoint |
| --- | --- | --- | --- |
| manager web | `apps/manager-web` | Next.js | Next.js auto-detection |
| API | `apps/api` | NestJS / Node.js | `src/main.ts` |
| scheduler | `services/scheduler` | FastAPI / Python | `app/main.py` |

The Vercel dashboard should have “Include source files outside of the Root
Directory” enabled for each project because the workspace lockfile and shared
`packages/api-contracts` package live above the application directories.
Vercel's monorepo support creates a separate deployment/domain for each root;
it does not require copying the repository three times.

The checked-in `vercel.json` files keep the install/build commands and function
duration explicit. Both backend functions are capped at 60 seconds, the Hobby
plan ceiling when Fluid Compute is not enabled. The scheduler's `app/main.py`
exports the FastAPI instance that Vercel detects, and the Nest API keeps its
existing `src/main.ts` entrypoint.

## Environment variables

Use [`deploy/vercel.env.example`](../deploy/vercel.env.example) as the variable
name checklist only. Add the real values in the Vercel dashboard, separately
for Preview and Production. Never commit, paste into ClickUp, or send a full
environment file containing `DATABASE_URL`, passwords, JWT secrets, Redis
credentials, or `SCHEDULER_API_TOKEN`.

Required stable URL wiring:

```text
manager-web: NEXT_PUBLIC_API_BASE_URL=https://<api-production-domain>.vercel.app/api
api:         API_CORS_ORIGINS=https://<manager-production-domain>.vercel.app
api:         SCHEDULER_BASE_URL=https://<scheduler-production-domain>.vercel.app
```

The current integrated UAT uses the three projects' stable production
`.vercel.app` domains. Preview deployments are still useful for checking an
individual change, but these static URL settings do not automatically
cross-wire a manager Preview to the matching API and scheduler Preview; do not
claim that they do or put a deployment-specific URL into shared configuration.
Keep the shared `SCHEDULER_API_TOKEN` secret identical in the API and scheduler
projects. The scheduler leaves `/health/live` and `/health/ready` public for
probes but requires that bearer token on `/solve`; its unauthenticated opt-out
defaults to false and is not set in the Vercel environment. Production Vercel
API validation requires the token and explicit HTTPS CORS and scheduler URLs.

Neon supplies the production PostgreSQL `DATABASE_URL`; Redis must be a
reachable managed Redis service because Vercel does not provide the local
Docker Redis container. Chanya should provide the exact connection values and
whether the provider needs any additional TLS query parameters before the
Production variables are entered.

## Preview and production workflow

1. Open a pull request. Vercel creates Preview deployments for the three
   connected projects, subject to the Hobby plan's build concurrency limit.
2. For integrated UAT today, exercise the manager portal against the stable
   Production API and scheduler domains. Preview deployments can be checked
   individually, but their service URLs are not automatically cross-wired.
3. Merge only after CI and review are green. The production branch deploys the
   three Production projects.
4. Verify `/api/health/live`, `/api/health/ready`, manager login, CORS, and a
   scheduler-authenticated request after each production deployment.

The existing Docker/Compose path remains the local and worker-compatible path:
`docker compose up postgres redis scheduler` still runs the full local stack;
those documented private Compose scheduler services explicitly set
`SCHEDULER_ALLOW_UNAUTHENTICATED=true`. The native `pnpm dev:scheduler`
launcher applies the same loopback-only opt-out. Never carry that setting into a
public deployment.
This deployment change does not add QStash or alter the schedule queue/lease
logic. Vercel Functions are request-driven and can scale to zero, so the
BullMQ schedule worker is not treated as a durable always-on worker by this
change; the queue-worker hosting decision is a separate follow-up.

## Official references

- [Vercel monorepos](https://vercel.com/docs/monorepos)
- [NestJS on Vercel](https://vercel.com/docs/frameworks/backend/nestjs)
- [FastAPI on Vercel](https://vercel.com/docs/frameworks/backend/fastapi)
- [Vercel function configuration](https://vercel.com/docs/project-configuration/vercel-json)
- [Vercel function limits](https://vercel.com/docs/functions/limitations)
- [Vercel environments](https://vercel.com/docs/deployments/environments)

# Vercel C08 release evidence

This is the active C08 checklist for the Vercel path. The historical
Docker-host checklist remains in [`C08_RELEASE_CHECKLIST.md`](C08_RELEASE_CHECKLIST.md).
Record every result against an exact commit SHA; unchecked items remain open.

## Platform and project gates

- [ ] The selected Vercel plan permits the intended UltraKIL use; Hobby is not
  recorded as approval for a commercial production deployment.
- [ ] Three Vercel Projects use roots `apps/manager-web`, `apps/api`, and
  `services/scheduler`, with outside-root source inclusion enabled.
- [ ] The long-lived `staging` Preview branch has stable branch URLs and
  branch-specific Preview variables for all three projects.
- [ ] `main` is the Production branch; its variables and resources are separate
  from staging.
- [ ] Both backend projects detect the expected runtime. Vercel's native Nest
  Fluid Compute duration exceeds the API's 55-second application budget, and
  the scheduler's checked-in 60-second Vercel ceiling is active.

## Environment and data gates

- [ ] The dedicated Neon staging target is identified in private operator
  evidence. Production PostgreSQL is provisioned separately, and staging cannot
  access production data or credentials.
- [ ] The target database backup/restore mechanism is recorded before applying
  migrations to existing data.
- [ ] `pnpm --filter @ultrakil/api db:deploy` and `db:status` pass against the
  target database at the release SHA.
- [ ] The trusted operator confirms the external `DATABASE_URL` and matching
  `ULTRAKIL_IMPORT_TARGET`, the `public` schema, and public-CA-only verified TLS.
  Custom CA/client-certificate endpoints and trust overrides are unsupported by
  this command. Inputs outside the checkout have mode `0600`, containing
  directories have mode `0700`, and both belong to the current nonroot operator.
  Non-default initial-admin credentials are ready for the explicit apply step.
- [ ] `pnpm vercel:import --dry-run` succeeds for both approved workbook
  checksums at the release SHA; only aggregate totals/issue codes are shared.
  Parsing success is not recorded as database import success.
- [ ] After environment authorization and maintenance/backup/migration gates,
  `pnpm vercel:import --apply` succeeds on the authorized external database.
  Record sanitized apply totals and subsequent database checks. The initial
  admin is created only if there are no users; existing credentials are preserved.
  Real import remains pending until this evidence exists. No workbook or private
  issue report is uploaded to Git, Vercel builds, or shared handover attachments.
- [ ] `SCHEDULE_DISPATCHER=qstash`, pure-HTTPS `API_PUBLIC_URL`, QStash token and
  both signing keys are configured on the API. Vercel does not require Redis.
- [ ] The same random `SCHEDULER_API_TOKEN` is configured on API and scheduler;
  `SCHEDULER_ALLOW_UNAUTHENTICATED` is absent.
- [ ] Manager/API/scheduler URLs and CORS use the stable URLs for the same
  environment. Secrets and database URLs are absent from Git and chat.
- [ ] A recurring signed QStash schedule is configured for staging and
  production with separate environment credentials; both schedule IDs are
  private release evidence. Staging does not rely on Vercel Cron.
- [ ] Each recurring schedule explicitly sends
  `POST https://<public-api-host>/api/internal/schedule-runs/reconcile` with
  destination `Content-Type: application/json`, body exactly `{}`, and cron
  `*/5 * * * *` (every five minutes, UTC), supported by the selected plan.
  The stable origin and configured API prefix match the accepted environment.
  Saved destination headers are verified, as missing JSON content type can
  cause 401 when the JSON parser does not supply `rawBody`.
- [ ] Signed smoke evidence from each recurring QStash schedule records the
  deployed SHA, UTC delivery time, destination settings and **204 No Content**
  response. Schedule/message IDs remain private; no tokens, signatures or
  signing keys are copied into shared evidence. An existing schedule without
  a successful signed delivery leaves this gate open.
- [ ] A daily Vercel Cron production-only fallback is configured with a
  server-only `CRON_SECRET`; Vercel cron runs only on Production, never Preview.
  `CRON_SECRET` is absent from browser-exposed variables and staging Preview.
- [ ] Recovery-trigger smoke evidence records a successful safe delivery from
  staging QStash, production QStash and the production Vercel Cron fallback.
- [ ] Deployment Protection is explicitly configured so stable staging API and
  scheduler traffic is reachable: on Hobby, retain None on the two backend
  projects as long as staging is operational and its cross-service traffic and
  QStash schedule are active. Restore Standard Protection only when pausing or
  decommissioning staging, or after a paid domain-specific exception is
  configured and verified for the stable backend domains. Before taking staging
  offline, disable its QStash schedule and drain/cancel outstanding deliveries.
  On an eligible plan, exempt only those stable domains. API JWT, QStash
  signatures and `SCHEDULER_API_TOKEN` remain enforced. No browser-exposed
  bypass secret, header or query parameter exists.
- [ ] Before the QStash cutover, operator maintenance is confirmed, active runs
  are drained/cancelled through supported flows, a recoverable backup exists,
  and `pnpm --filter @ultrakil/api dispatch:cutover:check -- --target=qstash`
  passes before `db:deploy`. The guard has not backfilled any `RUNNING` run.
- [ ] A deliberately fresh database is positively confirmed before migration
  only with `pnpm --filter @ultrakil/api dispatch:cutover:check -- --fresh --target=qstash`;
  it reports no application tables in the Prisma-owned `public` schema. A
  database error is not treated as fresh, and the fresh path is not used for
  an existing target.

## Staging acceptance

- [ ] All three staging branch deployments complete; record URLs, deployment
  timestamp and exact SHA.
- [ ] API liveness/readiness, manager login, CORS and authenticated `/solve`
  pass.
- [ ] A QStash-backed schedule run completes within its provider range/budget;
  duplicate delivery, cancellation and terminal-failure recovery are verified.
- [ ] O08/O09 real-data UAT, current screenshots, manager guide and demo script
  are attached to the handover evidence.

## Production acceptance

- [ ] Reviewed staging SHA is promoted/merged without unreviewed changes.
- [ ] Before merge/promote to `main`, the exact accepted SHA completes the
  production controlled gate: existing databases have maintenance, drain/cancel,
  backup, existing-database guard, `db:deploy` and `db:status`; a deliberately
  fresh database has the positive `--fresh` guard plus `db:deploy` and
  `db:status`. `main` is not used as a migration staging area because it routes
  Production automatically.
- [ ] All three Production deployments and post-deploy smoke checks pass.
- [ ] Any QStash-to-BullMQ rollback keeps maintenance enabled: pause or delete the recurring QStash reconcile schedule,
  prove QStash has no scheduled/retrying reconcile, execute or failure-callback
  deliveries, and record a
  passing `pnpm --filter @ultrakil/api dispatch:cutover:check -- --target=bullmq`
  before changing provider configuration or promoting the prior API.
  Restore that schedule only after switching back to QStash and verifying the
  internal routes and a successful signed delivery. BullMQ has no internal
  QStash routes, so an enabled recurring schedule would receive 404 responses.
- [ ] Rollback target, database recovery point, responsible operator and final
  handover are recorded.

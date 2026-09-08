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
- [ ] Both backend projects detect the expected runtime and enforce the
  checked-in 60-second function ceiling.

## Environment and data gates

- [ ] Separate staging and production PostgreSQL targets are identified;
  neither is assumed to be Neon and staging cannot access production data.
- [ ] The target database backup/restore mechanism is recorded before applying
  migrations to existing data.
- [ ] `pnpm --filter @ultrakil/api db:deploy` and `db:status` pass against the
  target database at the release SHA.
- [ ] Initial `db:seed` is run only when required, with non-default credentials.
- [ ] The strict Technician Matrix and Master Schedule dry-run/import gates are
  recorded without uploading either workbook or personal-data reports.
- [ ] `SCHEDULE_DISPATCHER=qstash`, pure-HTTPS `API_PUBLIC_URL`, QStash token and
  both signing keys are configured on the API. Vercel does not require Redis.
- [ ] The same random `SCHEDULER_API_TOKEN` is configured on API and scheduler;
  `SCHEDULER_ALLOW_UNAUTHENTICATED` is absent.
- [ ] Manager/API/scheduler URLs and CORS use the stable URLs for the same
  environment. Secrets and database URLs are absent from Git and chat.

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
- [ ] Production migrations and any required one-time provisioning pass before
  routing user traffic.
- [ ] All three Production deployments and post-deploy smoke checks pass.
- [ ] Rollback target, database recovery point, responsible operator and final
  handover are recorded.

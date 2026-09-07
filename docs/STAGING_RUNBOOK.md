# UltraKIL staging runbook

This is the repeatable C08 deployment path for the Phase 1 pilot. It deploys
PostgreSQL, Redis, the scheduling service, API, manager portal, health checks,
rotated container logs and a daily PostgreSQL backup. The real workbooks and
all secrets stay on the staging host and are never committed.

## 1. Host prerequisites

- A Linux host with Docker Engine 26+ and Docker Compose v2.
- At least 2 CPU cores, 4 GB RAM and 20 GB free disk for the pilot.
- TCP 3000 and 3001 restricted to the pilot network, or an HTTPS reverse proxy
  in front of both ports. Do not expose plain HTTP to the public internet.
- A DNS name and valid TLS certificate before external/customer UAT.

Create the deployment and import directories:

```bash
sudo install -d -m 0750 /opt/ultrakil/app /opt/ultrakil/import
sudo chown -R "$USER":"$USER" /opt/ultrakil/app /opt/ultrakil/import
```

Clone the repository into `/opt/ultrakil/app`, check out the exact reviewed
commit, and record its SHA in the C08 handover.

## 2. Configure secrets and URLs

```bash
cd /opt/ultrakil/app
cp deploy/staging.env.example deploy/staging.env
chmod 0600 deploy/staging.env
```

Replace every `replace-with-...` value. Generate unrelated random values for
PostgreSQL, Redis, JWT signing and the first admin password. If a password has
URL-reserved characters, URL-encode it in `DATABASE_URL`.

Set `NEXT_PUBLIC_API_BASE_URL` and `API_CORS_ORIGINS` to the browser-visible
staging URLs. The API URL is baked into the portal image, so rebuild `web` after
changing it. Do not paste `deploy/staging.env` into ClickUp, GitHub or chat.

## 3. Place the approved source workbooks

Copy the user-supplied files to these exact, space-free host paths:

```text
/opt/ultrakil/import/technician-matrix.xlsx
/opt/ultrakil/import/master-schedule-2026.xlsx
```

Restrict them to the deployment operator:

```bash
chmod 0600 /opt/ultrakil/import/*.xlsx
```

The directory is mounted read-only into the API container. The images and Git
build context explicitly exclude workbook data.

## 4. Build, migrate and import

Use one Compose invocation consistently:

```bash
docker compose --env-file deploy/staging.env -f deploy/compose.staging.yml build
docker compose --env-file deploy/staging.env -f deploy/compose.staging.yml up -d postgres redis scheduler
docker compose --env-file deploy/staging.env -f deploy/compose.staging.yml run --rm api pnpm --filter @ultrakil/api db:deploy
```

Inspect both imports without writing first. Keep the console output as C08
evidence and investigate any new parser error before proceeding:

```bash
docker compose --env-file deploy/staging.env -f deploy/compose.staging.yml run --rm api pnpm --filter @ultrakil/api db:seed -- --dry-run
docker compose --env-file deploy/staging.env -f deploy/compose.staging.yml run --rm api pnpm --filter @ultrakil/api schedule:import -- --dry-run
```

Then load the clean staging database:

```bash
docker compose --env-file deploy/staging.env -f deploy/compose.staging.yml run --rm api pnpm --filter @ultrakil/api db:seed
docker compose --env-file deploy/staging.env -f deploy/compose.staging.yml run --rm api pnpm --filter @ultrakil/api schedule:import
docker compose --env-file deploy/staging.env -f deploy/compose.staging.yml up -d api web backup
```

Do not load demo fixtures into staging. Re-running either real import is safe:
both importers use stable keys and update rather than duplicate.

## 5. Verify health and logs

```bash
docker compose --env-file deploy/staging.env -f deploy/compose.staging.yml ps
curl -fsS "http://staging-host:3001/api/health/live"
curl -fsS "http://staging-host:3001/api/health/ready"
curl -fsS "http://staging-host:3001/api/docs" >/dev/null
curl -fsS "http://staging-host:3000/login" >/dev/null
docker compose --env-file deploy/staging.env -f deploy/compose.staging.yml logs --since=10m api scheduler web
```

Every service must be healthy. API readiness must report database, queue and
scheduler as `up`. Container logs rotate at 10 MB with five files per service.
Treat any unhandled exception, restart loop, migration warning or failed health
probe as a release blocker.

## 6. Prove the C09/O09 change on real data

Before O08 is signed off, record screenshots and API/DB evidence for:

1. `DAG-3284`, `ABE-7244`, `PJ-6796`, `DAI-0191` and normalized `DAC-2485` show
   every checked driver with no ranking or primary-driver label.
2. Any checked driver on a multi-driver vehicle can be selected when that
   person is part of the crew.
3. An unchecked driver is rejected through both manual assignment and the
   optimizer path.
4. A vehicle with one checked driver is unavailable when that person cannot
   join the crew; the visit remains Unassigned with a structured reason.
5. Clearly red client/site records are inactive and produce no future visits.
6. Red headers, date cells and schedule marks do not deactivate valid records.
7. Historical visits for inactive records remain queryable.

Also verify that Kandy visits lacking a PMS-grade supervisor stay Unassigned.
That is an operational data blocker, not permission to weaken the PMS rule.

## 7. Backup and restore proof

The `backup` service writes one compressed logical backup per day and retains
seven days. Confirm the first archive and its gzip checksum:

```bash
docker compose --env-file deploy/staging.env -f deploy/compose.staging.yml exec backup sh -c 'ls -lh /backups && gzip -t /backups/*.sql.gz'
```

Test restore into a disposable database, never over the active staging
database:

```bash
docker compose --env-file deploy/staging.env -f deploy/compose.staging.yml exec postgres sh -c 'createdb -U "$$POSTGRES_USER" ultrakil_restore_test'
docker compose --env-file deploy/staging.env -f deploy/compose.staging.yml exec backup sh -c 'gzip -dc "$$(ls -1t /backups/ultrakil-*.sql.gz | head -1)"' | docker compose --env-file deploy/staging.env -f deploy/compose.staging.yml exec -T postgres sh -c 'psql -U "$$POSTGRES_USER" -d ultrakil_restore_test'
docker compose --env-file deploy/staging.env -f deploy/compose.staging.yml exec postgres sh -c 'dropdb -U "$$POSTGRES_USER" ultrakil_restore_test'
```

Record the backup filename, size, checksum result and disposable restore result
in C08. Never attach the database dump itself.

## 8. Rollback

Application rollback is a commit rollback, not a database reset:

1. Record the failing SHA and logs.
2. Check out the last green release SHA.
3. Rebuild `api` and `web`, then run `up -d` again.
4. Do not run a down migration unless a reviewed migration-specific rollback
   exists. Prisma migrations are forward-only by default.
5. Restore data only for confirmed corruption, using a verified backup and a
   separately approved maintenance window.

## 9. Handover evidence

C08 is complete only when its ClickUp comment includes:

- Deployed commit SHA and staging URLs.
- Migration status and clean real-import summaries.
- Health output for all services and ten minutes of clean logs.
- The seven C09/O09 checks above, including the normalized `DAC-2485` case.
- Backup checksum and disposable restore proof.
- Known non-code blockers: real opening hours, unmatched branch/town records
  and Kandy PMS-grade staffing.

O08 is complete only after Oshadi reruns the manager UAT on this exact deployed
SHA and attaches the guide, screenshots, demo script and pilot result with zero
critical or high-severity defects.

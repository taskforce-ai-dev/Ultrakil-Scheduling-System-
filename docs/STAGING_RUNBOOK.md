# UltraKIL staging runbook

This is the repeatable C08 deployment path for the Phase 1 pilot. It deploys
PostgreSQL, Redis, the scheduling service, API, manager portal, health checks,
rotated container logs and a daily PostgreSQL backup. The real workbooks and
all secrets stay on the staging host and are never committed.

C08 is based on accepted C07 `8c1ba7738108ca8f47a444b4be8113b36a3670d5`.
The sibling handoff was replayed separately; it is not evidence of a deployment.
Thivarrakesh handles C07/C08 during the takeover. Oshadi retains O08 evidence
and the separate UI work. No staging host is implied by this runbook.

## 1. Host prerequisites

- An authorized UltraKIL Linux host with Docker Engine 26+ and Docker Compose
  v2.24+; confirm host access, DNS, TLS and pilot access with Thivarrakesh.
- At least 2 CPU cores, 4 GB RAM and 20 GB free disk for the pilot.
- The supplied bindings are loopback-only. Use an HTTPS reverse proxy on the
  authorized host; expose only 443 to the approved pilot range (and 80 only if
  needed for certificate issuance). PostgreSQL, Redis and scheduler have no
  host ports. Do not publish 3000/3001 directly to the internet.
- A DNS name and valid TLS certificate before external/customer UAT.

Create the deployment and import directories:

```bash
test "$(id -u)" -ne 0
sudo install -d -m 0700 -o "$(id -u)" -g "$(id -g)" \
  /opt/ultrakil/app /opt/ultrakil/import /opt/ultrakil/import-config \
  /opt/ultrakil/import-reports /opt/ultrakil/backups
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

Passwords must have at least 24 characters; JWT must have at least 32. The
preflight rejects missing, placeholder, reused and short secrets without
printing values. `DATABASE_URL` must name the configured user/password/database
on `postgres:5432`, with only the optional `schema=public` query parameter.
Use a private credential manager for the first admin handover. Re-import leaves
existing accounts and passwords untouched.

Set `IMPORT_UID` and `IMPORT_GID` to the deployment operator's numeric
`id -u` and `id -g`, never zero. The nonroot import runner uses these IDs, so
operator-owned 0600 workbooks remain readable without granting public access.
Do not grant the API process access to the private inputs or report directory.
Set `BACKUP_UID`/`BACKUP_GID` to the same operator IDs and `BACKUP_DIR` to the
operator-owned 0700 backup directory. The backup tool refuses other ownership,
group/world access and symlinks. Its bind mount never creates a missing host path.

Give every validation stack a unique `COMPOSE_PROJECT_NAME`, for example
`ultrakil-validation-20260907-01`, and a new database ending in `_test`.
Use the same project name for every command; volumes and the BullMQ prefix are
scoped to it. Never run the destructive integration suites against staging.
Give each stack its own `BACKUP_DIR`, import/report directories and export work
directory as well: bind-mounted host paths are not scoped by the Compose project
name. Never point a disposable validation stack at the staging backup directory.

Set `NEXT_PUBLIC_API_BASE_URL` and `API_CORS_ORIGINS` to the browser-visible
staging URLs. The API URL is baked into the portal image, so rebuild `web` after
changing it. Do not paste `deploy/staging.env` into ClickUp, GitHub or chat.

For example, configure the host reverse proxy to send
`https://pilot.example.test/` to `http://127.0.0.1:3000`, and
`https://api.pilot.example.test/api/` to `http://127.0.0.1:3001/api/`, preserving
the `/api` prefix and forwarding Host/X-Forwarded-Proto. Set
`NEXT_PUBLIC_API_BASE_URL=https://api.pilot.example.test/api` and
`API_CORS_ORIGINS=https://pilot.example.test`; use the actual authorized names.
Terminate TLS with valid certificates, configure a 60-second proxy read timeout,
and verify login, CORS and API readiness through HTTPS before inviting users.
The examples' localhost URLs are only for an operator tunnel/local validation.
Never publish expanded `docker compose config` output: it contains secrets.

## 3. Place the approved source workbooks

Copy the user-supplied files to these exact, space-free host paths:

```text
/opt/ultrakil/import/technician-matrix.xlsx
/opt/ultrakil/import/master-schedule-2026.xlsx
```

Copy them as the deployment operator and restrict both explicit files:

```bash
chmod 0600 /opt/ultrakil/import/technician-matrix.xlsx \
  /opt/ultrakil/import/master-schedule-2026.xlsx
```

Only these two individual files are mounted read-only into the import runner;
missing source files are never replaced with auto-created host directories.
Place an approved optional `matrix-mapping.json` in `/opt/ultrakil/import-config`
with mode 0600. An absent mapping uses the existing parser defaults. Keep that
directory 0700 even when empty. The images and Git build context exclude
workbooks, private mappings, runtime env files, reports and backups at any depth.

## 4. Build, migrate and import

Use one Compose invocation consistently in the same operator shell:

```bash
compose() { docker compose --env-file deploy/staging.env -f deploy/compose.staging.yml "$@"; }
compose --profile tools config --quiet
compose --profile tools build
compose run --rm --no-deps migrate node deploy/staging-tool.mjs preflight
compose run --rm --no-deps import node deploy/staging-tool.mjs check-inputs
compose up -d --wait postgres redis scheduler
compose run --rm migrate
```

The one-shot `migrate` service runs only `prisma migrate deploy`. Both API and
the queue worker it hosts depend on that service completing successfully; a
failed migration prevents startup. A separate import command is always required.
Never use migrate reset/dev or demo fixtures on staging.

Inspect both inputs before any database writes. The wrapper fails nonzero for a
missing, unreadable, world-accessible or empty workbook, zero employees/vehicles,
zero customers/sites, or zero importable agreements. It parses both workbooks
before any real import. Keep its numeric summary as shared evidence:

```bash
compose run --rm import
```

Then load the clean staging database:

```bash
compose run --rm import node deploy/staging-tool.mjs import
compose up -d --wait api web
compose up -d --wait backup
```

The dedicated tooling image invokes packaged Prisma/tsx with Node directly;
it never downloads pnpm on the private runtime network. API carries production
dependencies and compiled code; web uses Next standalone output. All three
application images run nonroot, with an init process, read-only root, bounded
temporary storage, PID/memory/CPU limits and rotated logs. The API worker and
scheduler have a 180-second shutdown grace; validate draining before rollback.
The pilot limits leave host headroom, but must be load-tested on the actual host.

Re-running imports updates stable keys and preserves inactive history. It does
not close data decisions: the summary explicitly counts uncertain site branches,
and imported opening hours remain assumed/unconfirmed. A failed master import
can leave previously committed customer batches; investigate privately, correct
the input and rerun. It is not an all-or-nothing transaction across both files.

Dry run makes no database writes, but writes a detailed issue report to a new
0700 subdirectory under `/opt/ultrakil/import-reports`, with a 0600 JSON file.
The wrapper shares only counts and issue codes; child stdout/stderr and raw
exception messages are withheld. Detailed reports include private names and
source values: access them only in the protected operator session, retain only
for the approved import review period, and never attach them or raw import logs
to GitHub/ClickUp. The regular local seed/import commands retain their existing
optional-file behavior and verbose diagnostics; do not use them for shared
staging evidence. Use the wrapper above.

## 5. Verify health and logs

```bash
docker compose --env-file deploy/staging.env -f deploy/compose.staging.yml ps
curl -fsS "https://api.pilot.example.test/api/health/live"
curl -fsS "https://api.pilot.example.test/api/health/ready"
curl -fsS "https://api.pilot.example.test/api/docs" >/dev/null
curl -fsS "https://pilot.example.test/login" >/dev/null
docker compose --env-file deploy/staging.env -f deploy/compose.staging.yml logs --since=10m api scheduler web
```

Every service must be healthy. API readiness must report database, queue and
scheduler as `up`. Container logs rotate at 10 MB with five files per service.
Treat any unhandled exception, restart loop, migration warning or failed health
probe as a release blocker.

Base images are pinned to reviewed patch/distribution tags (Node 22.23.2
bookworm, Python 3.11.16 bookworm, PostgreSQL 16.15 Alpine 3.23 and Redis 7.4.11
Alpine 3.21). These tags were checked against the
[official-image manifests](https://github.com/docker-library/official-images/tree/master/library).
Tags can still be rebuilt for OS fixes: record the resolved image digests in
each release and use those exact digests for recovery. Rebuild and rerun image
checks when updating any pin; no immutable digest is invented here.

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

The `backup` service waits for successful migrations, writes an immediate backup
on startup, then one per day. Start it after the explicit import for the first
workforce snapshot, as shown above.
It uses PostgreSQL 16's compressed custom format (`pg_dump --format=custom
--file`), checks the process exit status, archive header and `pg_restore --list`,
and calculates SHA-256. This avoids a compression pipeline masking dump errors.
The archive and manifest are built in one private temporary directory on the
backup filesystem, fsynced, then published using atomic hard links that cannot
overwrite existing names. The `.dump.sha256` manifest is the completion marker;
an archive without its valid manifest is never a usable backup. Files are 0600.

Seven-day retention runs only after successful publication and deletes only
exact UltraKIL archive/manifest pairs owned by the operator with matching
checksums. Unrelated, corrupt, symlinked and incomplete files are preserved for
inspection. Graceful interruption removes only that invocation's temporary
files and any incomplete publication it created. SIGKILL, host loss or filesystem
failure can leave a private `.pending-*` directory or an unmarked archive;
inspect it and remove only its explicit validated path. Never bulk-delete the
backup directory. These incomplete files cannot pass verification or restore.

Create a one-shot backup before a release or rollback and keep its JSON evidence:

```bash
compose run --rm --no-deps backup backup
compose exec backup python3 /opt/ultrakil/recovery.py health
```

Set `archive` to the exact `/backups/...dump` path returned by that command,
not an arbitrary newest filename. Use a new unique restore target each time:

```bash
archive='/backups/ultrakil-YYYYMMDDTHHMMSSZ-12hex.dump' # replace with recorded path
restore_target='ultrakil_restore_20260907_01_test'     # replace with a new ID
compose run --rm --no-deps backup verify "$archive"
compose run --rm --no-deps backup restore "$archive" "$restore_target"
```

Restore accepts only a new `ultrakil_restore_<id>_test` database, distinct from
the configured source. It refuses unsafe names, an existing target, missing or
malformed manifests, corrupt archives and symlinks before creating anything.
It revokes public connection access, marks the target as disposable, and uses
`pg_restore --single-transaction --exit-on-error --no-owner --no-acl`. The tool
checks 26 required tables, at least nine successful migrations, no unfinished
migration, no reactivated imported-inactive records and no duplicate outbox
keys. It emits only numeric workforce/authorization/assignment/outbox/inactive/
history counts. Compare those with the pre-change count evidence in a quiescent
release window. A format check or a checksum alone is not restore proof.

Failed restores preserve the disposable database for authorized inspection;
client messages that could contain private rows are withheld from shared logs.
After reviewing the evidence, remove only the exact database created above:

```bash
compose run --rm --no-deps backup cleanup "$restore_target"
```

Cleanup refuses the source database, unsafe names and databases without the
tool's disposable marker. It does not force-disconnect active sessions. It can
remove a marked failed restore after its evidence is reviewed. If creating the
marker itself failed, cleanup refuses; inspect that exact new target before a
separately approved manual removal. This tool never replaces the staging DB.

The health probe fails when no completed backup exists, its timestamp is more
than `BACKUP_MAX_AGE_SECONDS` old (26 hours by default), or the newest completed
archive fails its checksum/format check. Keep the limit above the configured
daily interval and alert the operator on an unhealthy container; Docker health
alone does not send an alert. Host clock synchronization is required.

Record filename, bytes, checksum, restore counts and exact cleanup result in
C08. Never attach archives, private reports, decrypted bundles or SQL logs.

### Optional encrypted off-host copy

The `offhost` profile is disabled until Thivarrakesh supplies an authorized SSH
destination/user/path, upload credential, independently verified SSH host key,
an age public recipient, and a separately held recovery identity with a named
custodian and tested access procedure. Agree remote retention, capacity and
server-side immutability before enabling it. The decryption identity must never
be stored on the staging host or in this repository. Local backups alone do not
survive loss of the host.

Create operator-owned 0700 `/opt/ultrakil/export-work` and
`/opt/ultrakil/export-secrets`; put the upload key and pinned `known-hosts` file
at the configured exact paths with mode 0600. Reserve at least twice the largest
archive size in the work directory for the temporary plaintext bundle and
encrypted output. Fill the `EXPORT_*` settings in the private staging env file.
The remote directory must already exist and be dedicated to UltraKIL. The
upload account should have no application/database privileges.

```bash
compose --profile offhost build backup-export
compose --profile offhost run --rm --no-deps backup-export export "$archive"
```

The exporter verifies the local pair, packages that archive and its original
manifest, encrypts it with age, then uploads only ciphertext with an outer
SHA-256 manifest. Temporary remote names are renamed after successful transfer,
and the remote manifest is published last. SSH uses batch mode and strict host
key checking. The service has read-only backup/key mounts, no DB password and
its own egress network; the application network stays private. Output reports
transfer success separately from remote restore proof. A failed transfer can
leave encrypted `.part` files remotely; retain them for operator inspection,
then remove only exact names. No remote deletion/retention is automated here.

For an independent recovery drill, retrieve one exact completed encrypted pair
on the authorized recovery host; verify its outer checksum, decrypt the bundle
using the vault-held age identity, list its two expected archive/manifest names
before extracting into a new 0700 directory, and run `verify` then `restore`
against an isolated PostgreSQL 16 instance. Record count-only results. Do not
declare off-host recovery operational until this drill actually succeeds.

Local reproducible tests (synthetic data only):

```bash
python3 deploy/test/recovery.test.py
python3 deploy/test/compose.test.py
# PostgreSQL 16 client tools must be on PATH. The test requires explicit local
# PGHOST/PGPORT/PGUSER and installed API dependencies; it creates its own DBs.
PGHOST=127.0.0.1 PGPORT=55432 PGUSER=dev python3 deploy/test/recovery.postgres.test.py
```

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

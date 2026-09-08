#!/usr/bin/env python3
"""Private PostgreSQL 16 backups and disposable restore proofs (stdlib only).

The checksum manifest is the completion marker. No command restores over an
existing database. Raw client output never goes to shared container logs.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

ARCHIVE = re.compile(r"ultrakil-(\d{8}T\d{6}Z)-[0-9a-f]{12}\.dump\Z")
TARGET = re.compile(r"ultrakil_restore_[a-z0-9][a-z0-9_]*_test\Z")
DATABASE = re.compile(r"[a-z][a-z0-9_]{0,62}\Z")
MARKER = "ultrakil-disposable-restore-v1"
TABLES = (
    "_prisma_migrations", "branches", "users", "employees", "employee_skills",
    "employee_availability", "permanent_assignments", "vehicles", "vehicle_authorizations",
    "customers", "service_sites", "site_operating_hours", "job_types", "service_agreements",
    "service_agreement_day_rules", "service_agreement_required_skills", "service_agreement_versions",
    "generated_visits", "visit_unassigned_reasons", "assignments", "assignment_crew_members",
    "assignment_vehicles", "assignment_locks", "schedule_runs", "assignment_notification_outbox", "audit_events",
    "schedule_run_dispatch_outbox",
)


class RecoveryError(Exception):
    """Only messages authored here are safe for shared logs."""


def integer_setting(name, default, maximum=31536000):
    value = os.environ.get(name, str(default))
    if not value.isascii() or not value.isdigit() or not 1 <= int(value) <= maximum:
        raise RecoveryError(f"Invalid positive integer setting: {name}")
    return int(value)


def private_path(path, directory=False):
    try:
        info = path.lstat()
    except OSError:
        raise RecoveryError("Required private path is missing or unreadable") from None
    correct_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not correct_type or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RecoveryError("Recovery paths must be owned by the current user, private, and not symlinks")


def backup_directory():
    if os.getuid() == 0:
        raise RecoveryError("Recovery tools must run as a nonroot operator")
    directory = Path(os.environ.get("BACKUP_DIR", "/backups")).absolute()
    private_path(directory, directory=True)
    return directory


@contextmanager
def lock(directory, exclusive=True, lock_name=".recovery.lock"):
    # The lock file is persistent; kernel locks release even on SIGKILL.
    lock_path = directory / lock_name
    flags = os.O_RDONLY if not exclusive and lock_path.exists() else os.O_CREAT | os.O_RDWR
    descriptor = os.open(lock_path, flags | os.O_NOFOLLOW, 0o600)
    try:
        private_path(lock_path)
        fcntl.flock(descriptor, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
        yield
    finally:
        os.close(descriptor)


def run_client(command, input_text=None):
    # Keep pg_dump data in its --file, and discard SQL/table/row diagnostics.
    # A separate process group lets termination clean up an in-flight client.
    timeout = integer_setting("RECOVERY_CLIENT_TIMEOUT_SECONDS", 3600, 86400)
    child = subprocess.Popen(command, stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        output, _ = child.communicate(input_text.encode() if input_text is not None else None, timeout=timeout)
    except BaseException:
        try:
            os.killpg(child.pid, signal.SIGTERM)
            child.communicate(timeout=5)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
                child.communicate()
        raise
    if child.returncode:
        raise RecoveryError(f"{Path(command[0]).name} failed; private client output withheld")
    return output.decode("utf-8", errors="strict").strip()


def digest(path):
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            checksum.update(chunk)
    return checksum.hexdigest()


def archive_time(name):
    match = ARCHIVE.fullmatch(name)
    if not match:
        raise RecoveryError("Archive name is not an exact UltraKIL backup name")
    try:
        return datetime.strptime(match[1], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        raise RecoveryError("Archive timestamp is invalid") from None


def inspect_archive(path):
    private_path(path)
    with path.open("rb") as stream:
        if stream.read(5) != b"PGDMP" or path.stat().st_size <= 5:
            raise RecoveryError("Backup is empty or is not a PostgreSQL custom archive")
    run_client(["pg_restore", "--list", str(path)])


def verify(directory, archive):
    path = Path(archive).absolute()
    if path.parent.resolve() != directory.resolve():
        raise RecoveryError("Archive must be an explicit file in BACKUP_DIR")
    archive_time(path.name)
    private_path(path)
    manifest = path.with_name(path.name + ".sha256")
    private_path(manifest)
    expected = f"{digest(path)}  {path.name}\n".encode()
    # A strict one-line manifest cannot redirect checksum verification elsewhere.
    if manifest.stat().st_size != len(expected) or manifest.read_bytes() != expected:
        raise RecoveryError("Archive checksum or completion manifest is invalid")
    inspect_archive(path)
    return path


def sync_path(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def retain(directory, days):
    removed = 0
    cutoff = time.time() - days * 86400
    for manifest in directory.iterdir():
        if not manifest.name.endswith(".dump.sha256"):
            continue
        name = manifest.name.removesuffix(".sha256")
        try:
            if archive_time(name) >= cutoff:
                continue
            archive = verify(directory, directory / name)
        except (RecoveryError, OSError):
            # Foreign, incomplete, corrupt or unsafe files are never deleted.
            continue
        manifest.unlink()  # Withdraw the completion marker before removing data.
        archive.unlink()
        removed += 1
    sync_path(directory)
    return removed


def backup(directory):
    # Serialize all backup operations while leaving the publication lock
    # available for responsive health checks during a long dump.
    # Backups acquire .backup.lock before .recovery.lock; other operations only
    # acquire .recovery.lock, so lock acquisition cannot cycle.
    with lock(directory, lock_name=".backup.lock"):
        days = integer_setting("BACKUP_RETENTION_DAYS", 7, 36500)
        source_database()
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        name = f"ultrakil-{stamp}-{secrets.token_hex(6)}.dump"
        # TemporaryDirectory removes only this invocation's private directory.
        with tempfile.TemporaryDirectory(prefix=".pending-", dir=directory) as pending:
            archive = Path(pending) / name
            run_client(["pg_dump", "--no-password", "--format=custom", "--no-owner", "--no-acl", "--file", str(archive)])
            archive.chmod(0o600)
            inspect_archive(archive)
            checksum = digest(archive)
            manifest = Path(pending) / (name + ".sha256")
            manifest.write_text(f"{checksum}  {name}\n", encoding="ascii")
            manifest.chmod(0o600)
            sync_path(archive)
            sync_path(manifest)
            # link() atomically publishes without overwriting any existing name.
            # Both paths are on the destination filesystem. The manifest is last.
            # Keep the expensive dump and validation outside this lock so health checks
            # can inspect the last completed pair while a new backup is in progress.
            with lock(directory):
                published = []
                try:
                    os.link(archive, directory / name, follow_symlinks=False)
                    published.append(directory / name)
                    sync_path(directory)
                    os.link(manifest, directory / manifest.name, follow_symlinks=False)
                    published.append(directory / manifest.name)
                    sync_path(directory)
                except BaseException:
                    # Remove only links this invocation successfully created, marker first.
                    # A pre-existing collision is never added to this list or overwritten.
                    for path in reversed(published):
                        path.unlink()
                    sync_path(directory)
                    raise
                removed = retain(directory, days)
        return {"archive": str(directory / name), "bytes": (directory / name).stat().st_size,
                "sha256": checksum, "retainedPairsRemoved": removed}


def health(directory):
    max_age = integer_setting("BACKUP_MAX_AGE_SECONDS", 93600)
    completed = [path.name.removesuffix(".sha256") for path in directory.iterdir()
                 if path.name.endswith(".dump.sha256") and ARCHIVE.fullmatch(path.name.removesuffix(".sha256"))]
    if not completed:
        raise RecoveryError("No completed UltraKIL backup exists")
    newest = max(completed, key=archive_time)
    age = time.time() - archive_time(newest)
    if age < -300 or age > max_age:
        raise RecoveryError("Newest completed backup is stale or has a future timestamp")
    verify(directory, directory / newest)
    return {"backupHealthy": True, "ageSeconds": max(0, int(age))}


def source_database():
    source = os.environ.get("PGDATABASE", "")
    if not DATABASE.fullmatch(source):
        raise RecoveryError("PGDATABASE must explicitly name the source database")
    return source


def target_database(target):
    source = source_database()
    if not TARGET.fullmatch(target) or len(target) > 63 or target == source:
        raise RecoveryError("Target must be a new ultrakil_restore_<id>_test database distinct from PGDATABASE")


def sql(database, statement):
    return run_client(["psql", "-X", "--no-password", "--dbname", database, "--tuples-only", "--no-align",
                       "--set", "ON_ERROR_STOP=1", "--command", statement])


def counts(target):
    names = ",".join(f"'{name}'" for name in TABLES)
    statement = f'''BEGIN READ ONLY;
SELECT json_build_object(
 'tables', (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename IN ({names})),
 'migrations', (SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NOT NULL),
 'failedMigrations', (SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL),
 'employees', (SELECT count(*) FROM public.employees),
 'vehicleAuthorizations', (SELECT count(*) FROM public.vehicle_authorizations),
 'assignments', (SELECT count(*) FROM public.assignments),
 'outbox', (SELECT count(*) FROM public.assignment_notification_outbox),
 'dispatchOutbox', (SELECT count(*) FROM public.schedule_run_dispatch_outbox),
 'inactiveCustomers', (SELECT count(*) FROM public.customers WHERE NOT "isActive"),
 'inactiveSites', (SELECT count(*) FROM public.service_sites WHERE NOT "isActive"),
 'history', (SELECT count(*) FROM public.assignments WHERE status IN ('COMPLETED', 'SUPERSEDED')),
 'reactivatedImports', (SELECT count(*) FROM public.customers WHERE "isActive" AND "importedInactiveAt" IS NOT NULL)
    + (SELECT count(*) FROM public.service_sites WHERE "isActive" AND "importedInactiveAt" IS NOT NULL),
 'duplicateOutbox', (SELECT count(*) FROM (SELECT 1 FROM public.assignment_notification_outbox
    GROUP BY "assignmentId", "employeeId", "eventType" HAVING count(*) > 1) duplicates),
 'duplicateDispatchOutbox', (SELECT count(*) FROM (SELECT 1 FROM public.schedule_run_dispatch_outbox
    GROUP BY "scheduleRunId" HAVING count(*) > 1) duplicates),
 'invalidDispatchOutbox', (SELECT count(*) FROM public.schedule_run_dispatch_outbox WHERE
    attempts < 0
    OR (status = 'PENDING' AND "messageId" IS NOT NULL)
    OR (status = 'PUBLISHED' AND ("messageId" IS NULL OR attempts < 1 OR "lastAttemptAt" IS NULL))
    OR num_nonnulls("terminalFailureMessageId", "terminalFailureCode", "terminalFailureMessage", "terminalFailureAt") BETWEEN 1 AND 3
    OR ("terminalFailureAt" IS NOT NULL AND provider <> 'QSTASH')
    OR ("terminalFailureMessageId" IS NOT NULL AND "messageId" IS NOT NULL
        AND "terminalFailureMessageId" IS DISTINCT FROM "messageId")
    OR (status = 'CANCELLED' AND "terminalFailureAt" IS NOT NULL)),
 'invalidExecutionLeases', (SELECT count(*) FROM public.schedule_runs WHERE
    ("executionLeaseId" IS NULL) <> ("executionLeaseExpiresAt" IS NULL)
    OR "executionAttempt" < 0)
); COMMIT;'''
    result = sql(target, statement)
    # psql emits transaction command tags; only our one JSON row is accepted.
    rows = [line for line in result.splitlines() if line.startswith("{")]
    if len(rows) != 1:
        raise RecoveryError("Restore count evidence is missing")
    try:
        values = json.loads(rows[0])
    except ValueError:
        raise RecoveryError("Restore count evidence is malformed") from None
    expected = {"tables", "migrations", "failedMigrations", "employees", "vehicleAuthorizations", "assignments",
                "outbox", "dispatchOutbox", "inactiveCustomers", "inactiveSites", "history", "reactivatedImports",
                "duplicateOutbox", "duplicateDispatchOutbox", "invalidDispatchOutbox", "invalidExecutionLeases"}
    if not isinstance(values, dict) or set(values) != expected or any(type(value) is not int or value < 0 for value in values.values()):
        raise RecoveryError("Restore count evidence is incomplete")
    # Imported-inactive provenance can remain after an authorized manual
    # activation. Preserve/report that count; it is not corruption by itself.
    invalid_metrics = ("failedMigrations", "duplicateOutbox", "duplicateDispatchOutbox",
                       "invalidDispatchOutbox", "invalidExecutionLeases")
    if values["tables"] != len(TABLES) or values["migrations"] < 11 or any(values[key] for key in invalid_metrics):
        raise RecoveryError("Restored UltraKIL schema or count invariants failed; disposable database preserved")
    return values


def restore(directory, archive, target):
    target_database(target)
    path = verify(directory, archive)
    # Target regex excludes quotes; the exact name is safe in both SQL contexts.
    if sql("postgres", f"SELECT count(*) FROM pg_database WHERE datname = '{target}'") != "0":
        raise RecoveryError("Restore target already exists; no database changed")
    run_client(["createdb", "--no-password", "--template=template0", target])
    # No automatic drop on any failure: the operator inspects and cleans up explicitly.
    sql("postgres", f'''REVOKE CONNECT ON DATABASE "{target}" FROM PUBLIC''')
    sql("postgres", f'''COMMENT ON DATABASE "{target}" IS '{MARKER}' ''')
    run_client(["pg_restore", "--no-password", "--dbname", target, "--single-transaction", "--exit-on-error",
                "--no-owner", "--no-acl", str(path)])
    return {"restoredDatabase": target, "counts": counts(target)}


def cleanup(target):
    target_database(target)
    marker = sql("postgres", f"SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = '{target}'")
    if marker != MARKER:
        raise RecoveryError("Cleanup refused: database lacks the disposable restore marker")
    # No --force: active connections block deletion and require operator inspection.
    run_client(["dropdb", "--no-password", target])
    return {"removedDisposableDatabase": target}


def export(directory, archive):
    """Encrypt a verified pair for an explicitly configured SSH destination."""
    path = verify(directory, archive)
    recipient = os.environ.get("EXPORT_AGE_RECIPIENT", "")
    host = os.environ.get("EXPORT_SSH_HOST", "")
    user = os.environ.get("EXPORT_SSH_USER", "")
    remote = os.environ.get("EXPORT_REMOTE_DIR", "")
    if (not re.fullmatch(r"age1[0-9a-z]{58}", recipient)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{0,252}", host)
            or not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", user)
            or not re.fullmatch(r"/[A-Za-z0-9_/-]+", remote)
            or ".." in remote.split("/") or remote.strip("/") == ""):
        raise RecoveryError("Encrypted export needs an explicit age recipient and safe authorized SSH destination")
    key = Path(os.environ.get("EXPORT_SSH_KEY", "/export-secrets/ssh-key")).absolute()
    known = Path(os.environ.get("EXPORT_KNOWN_HOSTS", "/export-secrets/known-hosts")).absolute()
    private_path(key)
    private_path(known)
    port = integer_setting("EXPORT_SSH_PORT", 22, 65535)
    export_work = os.environ.get("EXPORT_WORK_DIR")
    if export_work:
        private_path(Path(export_work), directory=True)
    with tempfile.TemporaryDirectory(prefix="ultrakil-export-", dir=export_work) as temporary:
        bundle = Path(temporary) / "bundle.tar"
        with tarfile.open(bundle, "w") as tar:
            for member in (path, path.with_name(path.name + ".sha256")):
                tar.add(member, arcname=member.name, recursive=False)
        encrypted = Path(temporary) / f"{path.name}-{secrets.token_hex(6)}.tar.age"
        run_client(["age", "--recipient", recipient, "--output", str(encrypted), str(bundle)])
        private_path(encrypted)
        if encrypted.stat().st_size == 0:
            raise RecoveryError("Encryption produced an empty export")
        checksum = digest(encrypted)
        manifest = encrypted.with_name(encrypted.name + ".sha256")
        manifest.write_text(f"{checksum}  {encrypted.name}\n", encoding="ascii")
        destination = f"{remote.rstrip('/')}/{encrypted.name}"
        # Upload encrypted bytes only. Unique names and a last manifest distinguish
        # complete transfers. Server retention/immutability are provisioned separately.
        batch = f'''put "{encrypted}" "{destination}.part"
chmod 600 "{destination}.part"
rename "{destination}.part" "{destination}"
put "{manifest}" "{destination}.sha256.part"
chmod 600 "{destination}.sha256.part"
rename "{destination}.sha256.part" "{destination}.sha256"
'''
        run_client(["sftp", "-b", "-", "-P", str(port), "-i", str(key),
                    "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
                    "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={known}",
                    "-o", "ConnectTimeout=20", f"{user}@{host}"], input_text=batch)
        return {"exportedEncryptedFile": encrypted.name, "sha256": checksum,
                "remoteTransferSucceeded": True, "remoteRestoreVerified": False}


def interrupted(_signal, _frame):
    # InterruptedError is swallowed/retried by selectors inside communicate().
    raise RecoveryError("Recovery interrupted; no completion marker published for an incomplete archive")


def main():
    os.umask(0o077)
    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    for name in ("backup", "schedule", "health", "counts"):
        actions.add_parser(name)
    for name in ("verify", "restore", "export"):
        action = actions.add_parser(name)
        action.add_argument("archive")
        if name == "restore": action.add_argument("target")
    actions.add_parser("cleanup").add_argument("target")
    args = parser.parse_args()
    try:
        directory = backup_directory()
        if args.action == "schedule":
            interval = integer_setting("BACKUP_INTERVAL_SECONDS", 86400)
            while True:
                print(json.dumps(backup(directory)), flush=True)
                time.sleep(interval)
        if args.action == "backup":
            result = backup(directory)
            print(json.dumps(result), flush=True)
        else:
            with lock(directory, exclusive=args.action == "cleanup"):
                if args.action == "health": result = health(directory)
                elif args.action == "counts": result = {"counts": counts(source_database())}
                elif args.action == "verify":
                    result = {"verifiedArchive": str(verify(directory, args.archive))}
                elif args.action == "restore": result = restore(directory, args.archive, args.target)
                elif args.action == "cleanup": result = cleanup(args.target)
                elif args.action == "export": result = export(directory, args.archive)
                print(json.dumps(result), flush=True)
        return 0
    except RecoveryError as error:
        print(str(error), file=sys.stderr)
    except (OSError, ValueError, subprocess.TimeoutExpired, InterruptedError, KeyboardInterrupt):
        print("Recovery failed or was interrupted; private diagnostics withheld, no existing database overwritten", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())

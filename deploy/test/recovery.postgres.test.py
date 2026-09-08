"""Real PostgreSQL 16 roundtrip, restricted to newly created local synthetic DBs.

Requires PostgreSQL clients on PATH, PGHOST=127.0.0.1 (or localhost), explicit
PGPORT/PGUSER, the API's installed dependencies and Prisma-generated client.
No existing database is read, migrated, restored over, or deleted.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("recovery", ROOT / "deploy/recovery.py")
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


def run(command, env, success=True):
    result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=120)
    if (result.returncode == 0) != success:
        raise RuntimeError(f"Synthetic recovery check failed: {Path(command[0]).name}; client diagnostics withheld")
    return result.stdout.strip()


def main():
    host = os.environ.get("PGHOST", "")
    port = os.environ.get("PGPORT", "")
    user = os.environ.get("PGUSER", "")
    if host not in ("127.0.0.1", "localhost", "::1") or not port.isdigit() or not user:
        raise RuntimeError("Explicit local PGHOST, PGPORT and PGUSER are required")
    nonce = secrets.token_hex(6)
    source = f"ultrakil_backup_{nonce}_test"
    target = f"ultrakil_restore_{nonce}_test"
    env = {**os.environ, "PGDATABASE": source}
    hostname = f"[{host}]" if ":" in host else host
    password = quote(env.get("PGPASSWORD", ""), safe="")
    env["DATABASE_URL"] = f"postgresql://{quote(user, safe='')}:{password}@{hostname}:{port}/{source}?schema=public"
    completed = False
    with tempfile.TemporaryDirectory(prefix="ultrakil-recovery-postgres-") as temporary:
        env["BACKUP_DIR"] = temporary
        # Recovery helper functions below need the same client connection.
        os.environ.update(env)
        run(["createdb", "--no-password", "--template=template0", source], env)
        try:
            prisma = ROOT / "apps/api/node_modules/prisma/build/index.js"
            run(["node", str(prisma), "migrate", "deploy", "--schema", str(ROOT / "apps/api/prisma/schema.prisma")], env)
            run(["node", str(ROOT / "deploy/test/recovery-fixture.mjs")], env)
            before = recovery.counts(source)
            tool = [sys.executable, str(ROOT / "deploy/recovery.py")]
            assert json.loads(run(tool + ["counts"], env))["counts"] == before
            backed_up = json.loads(run(tool + ["backup"], env))
            archive = Path(backed_up["archive"])
            assert backed_up["sha256"] == hashlib.sha256(archive.read_bytes()).hexdigest()
            restored = json.loads(run(tool + ["restore", str(archive), target], env))
            assert restored["counts"] == before
            assert before["employees"] == 2 and before["vehicleAuthorizations"] == 2
            assert before["history"] == 1 and before["outbox"] == 1
            assert before["dispatchOutbox"] == 1
            assert before["duplicateDispatchOutbox"] == 0
            assert before["invalidDispatchOutbox"] == 0
            assert before["missingActiveDispatchOutbox"] == 0
            assert before["invalidExecutionLeases"] == 0
            assert before["inactiveCustomers"] == 1 and before["inactiveSites"] == 1
            assert before["reactivatedImports"] == 1  # Authorized manual activation is valid history.
            # Prove driver/crew/checkmark lineage, not just table existence.
            evidence = recovery.sql(target, '''SELECT count(*) FROM public.assignment_vehicles av
                JOIN public.vehicle_authorizations va ON va."vehicleId" = av."vehicleId" AND va."employeeId" = av."driverEmployeeId"
                JOIN public.assignment_crew_members ac ON ac."assignmentId" = av."assignmentId" AND ac."employeeId" = av."driverEmployeeId"''')
            assert evidence == "1"
            dispatch_evidence = recovery.sql(target, '''SELECT count(*) FROM public.schedule_run_dispatch_outbox d
                JOIN public.schedule_runs r ON r.id = d."scheduleRunId"
                WHERE d.provider = 'QSTASH' AND d.status = 'PUBLISHED'
                  AND d."messageId" = 'msg_recovery_synthetic' AND d.attempts = 1
                  AND d."lastAttemptAt" IS NOT NULL AND r.status = 'SUCCEEDED' ''')
            assert dispatch_evidence == "1"
            run(tool + ["restore", str(archive), target], env, success=False)
            assert recovery.counts(target) == before  # Existing target refusal preserves data.
            dispatch_valid = '''UPDATE public.schedule_run_dispatch_outbox SET
                provider = 'QSTASH', status = 'PUBLISHED', "messageId" = 'msg_recovery_synthetic',
                attempts = 1, "lastAttemptAt" = '2024-06-01T03:29:00Z',
                "terminalFailureMessageId" = NULL, "terminalFailureCode" = NULL,
                "terminalFailureMessage" = NULL, "terminalFailureAt" = NULL'''
            run_valid = '''UPDATE public.schedule_runs SET "executionLeaseId" = NULL,
                "executionLeaseExpiresAt" = NULL, "executionAttempt" = 1'''
            recovery.sql(target, '''UPDATE public.schedule_run_dispatch_outbox SET
                "terminalFailureMessageId" = 'msg_recovery_synthetic',
                "terminalFailureCode" = 'SYNTHETIC', "terminalFailureMessage" = 'Synthetic failure',
                "terminalFailureAt" = '2024-06-01T03:30:00Z' ''')
            assert recovery.counts(target) == before  # A complete, matching QStash callback can be deferred safely.
            recovery.sql(target, dispatch_valid)
            invalid_cases = (
                ("negative dispatch attempt", '''UPDATE public.schedule_run_dispatch_outbox SET
                    status = 'PENDING', "messageId" = NULL, attempts = -1, "lastAttemptAt" = NULL''', dispatch_valid),
                ("published zero attempts", '''UPDATE public.schedule_run_dispatch_outbox SET
                    attempts = 0''', dispatch_valid),
                ("pending message id", '''UPDATE public.schedule_run_dispatch_outbox SET
                    status = 'PENDING', "messageId" = 'impossible_pending_message' ''', dispatch_valid),
                ("published message id", '''UPDATE public.schedule_run_dispatch_outbox SET
                    "messageId" = NULL''', dispatch_valid),
                ("published last attempt", '''UPDATE public.schedule_run_dispatch_outbox SET
                    "lastAttemptAt" = NULL''', dispatch_valid),
                ("partial terminal marker", '''UPDATE public.schedule_run_dispatch_outbox SET
                    "terminalFailureMessageId" = 'msg_recovery_synthetic' ''', dispatch_valid),
                ("non-QStash terminal marker", '''UPDATE public.schedule_run_dispatch_outbox SET
                    provider = 'BULLMQ', "terminalFailureMessageId" = 'msg_recovery_synthetic',
                    "terminalFailureCode" = 'SYNTHETIC', "terminalFailureMessage" = 'Synthetic failure',
                    "terminalFailureAt" = '2024-06-01T03:30:00Z' ''', dispatch_valid),
                ("cancelled terminal marker", '''UPDATE public.schedule_run_dispatch_outbox SET
                    status = 'CANCELLED', "terminalFailureMessageId" = 'msg_recovery_synthetic',
                    "terminalFailureCode" = 'SYNTHETIC', "terminalFailureMessage" = 'Synthetic failure',
                    "terminalFailureAt" = '2024-06-01T03:30:00Z' ''', dispatch_valid),
                ("mismatched terminal message id", '''UPDATE public.schedule_run_dispatch_outbox SET
                    "terminalFailureMessageId" = 'different_message', "terminalFailureCode" = 'SYNTHETIC',
                    "terminalFailureMessage" = 'Synthetic failure',
                    "terminalFailureAt" = '2024-06-01T03:30:00Z' ''', dispatch_valid),
                ("partial execution lease", '''UPDATE public.schedule_runs SET
                    "executionLeaseId" = '00000000-0000-4000-8000-000000000001',
                    "executionLeaseExpiresAt" = NULL''', run_valid),
                ("negative execution attempt", '''UPDATE public.schedule_runs SET
                    "executionAttempt" = -1''', run_valid),
            )
            for label, mutation, repair in invalid_cases:
                recovery.sql(target, mutation)
                try:
                    try:
                        recovery.counts(target)
                    except recovery.RecoveryError:
                        pass
                    else:
                        raise AssertionError(f"{label} must fail restore evidence")
                    assert recovery.sql("postgres", f"SELECT count(*) FROM pg_database WHERE datname = '{target}'") == "1"
                finally:
                    recovery.sql(target, repair)
                assert recovery.counts(target) == before
            missing_run_id = "00000000-0000-4000-8000-000000000002"
            recovery.sql(target, f'''INSERT INTO public.schedule_runs
                (id, status, trigger, "rangeStart", "rangeEnd", "createdAt", "updatedAt") VALUES
                ('{missing_run_id}', 'QUEUED', 'MANUAL', '2024-06-01', '2024-06-01', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)''')
            try:
                try:
                    recovery.counts(target)
                except recovery.RecoveryError:
                    pass
                else:
                    raise AssertionError("Active schedule runs without a dispatch outbox must fail restore evidence")
                assert recovery.sql("postgres", f"SELECT count(*) FROM pg_database WHERE datname = '{target}'") == "1"
            finally:
                recovery.sql(target, f"DELETE FROM public.schedule_runs WHERE id = '{missing_run_id}'")
            assert recovery.counts(target) == before
            run(tool + ["health"], env)
            run(tool + ["cleanup", target], env)
            assert recovery.sql("postgres", f"SELECT count(*) FROM pg_database WHERE datname = '{target}'") == "0"
            # Corruption refuses creation, not merely SQL execution.
            archive.write_bytes(archive.read_bytes() + b"synthetic corruption")
            run(tool + ["restore", str(archive), target], env, success=False)
            assert recovery.sql("postgres", f"SELECT count(*) FROM pg_database WHERE datname = '{target}'") == "0"
            assert recovery.counts(source) == before
            completed = True
            print(json.dumps({"postgresRoundtrip": "passed", "counts": before,
                              "driverCrewAuthorizationPreserved": True, "existingTargetRefused": True,
                              "corruptionRefusedBeforeCreate": True}))
        finally:
            if completed:
                # This exact source was created by this invocation. No force/glob.
                run(["dropdb", "--no-password", source], env)
            else:
                print(f"Synthetic proof failed; inspect only {source} and {target}. No existing database was overwritten.", file=sys.stderr)


if __name__ == "__main__":
    main()

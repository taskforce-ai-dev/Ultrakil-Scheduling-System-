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
            backed_up = json.loads(run(tool + ["backup"], env))
            archive = Path(backed_up["archive"])
            assert backed_up["sha256"] == hashlib.sha256(archive.read_bytes()).hexdigest()
            restored = json.loads(run(tool + ["restore", str(archive), target], env))
            assert restored["counts"] == before
            assert before["employees"] == 2 and before["vehicleAuthorizations"] == 2
            assert before["history"] == 1 and before["outbox"] == 1
            assert before["inactiveCustomers"] == 1 and before["inactiveSites"] == 1
            # Prove driver/crew/checkmark lineage, not just table existence.
            evidence = recovery.sql(target, '''SELECT count(*) FROM public.assignment_vehicles av
                JOIN public.vehicle_authorizations va ON va."vehicleId" = av."vehicleId" AND va."employeeId" = av."driverEmployeeId"
                JOIN public.assignment_crew_members ac ON ac."assignmentId" = av."assignmentId" AND ac."employeeId" = av."driverEmployeeId"''')
            assert evidence == "1"
            run(tool + ["restore", str(archive), target], env, success=False)
            assert recovery.counts(target) == before  # Existing target refusal preserves data.
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

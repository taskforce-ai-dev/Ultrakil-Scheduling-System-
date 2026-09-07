"""Executable recovery tests with fake PostgreSQL clients; no real data needed."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "deploy/recovery.py"
FAKE = r'''#!/usr/bin/env python3
import json, os, pathlib, sys, time
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ["CLIENT_CALLS"], "a") as stream:
    stream.write(json.dumps([name, args]) + "\n")
mode = os.environ.get("FAIL_MODE", "")
state = pathlib.Path(os.environ["DB_STATE"])
if name == "pg_dump":
    target = pathlib.Path(args[args.index("--file") + 1])
    target.write_bytes(b"PGDMPsynthetic")
    if mode == "dump":
        print("PRIVATE CLIENT DATA", file=sys.stderr); sys.exit(1)
    if mode == "interrupt":
        pathlib.Path(os.environ["DUMP_STARTED"]).touch(); time.sleep(30)
    if mode == "empty": target.write_bytes(b"")
    if mode == "format": target.write_bytes(b"not an archive")
    if mode == "archive-collision":
        (pathlib.Path(os.environ["BACKUP_DIR"]) / target.name).write_bytes(b"existing archive")
    if mode == "manifest-collision":
        (pathlib.Path(os.environ["BACKUP_DIR"]) / (target.name + ".sha256")).write_bytes(b"existing manifest")
elif name == "pg_restore":
    if "--list" in args:
        if mode == "list": sys.exit(1)
        print("PRIVATE TABLE NAMES")
    elif mode == "restore":
        print("PRIVATE ROW DATA", file=sys.stderr); sys.exit(1)
elif name == "createdb":
    if state.exists(): sys.exit(1)
    state.write_text("created")
elif name == "dropdb":
    state.unlink()
elif name == "psql":
    query = args[args.index("--command") + 1]
    if "pg_database" in query and "shobj_description" not in query:
        print("1" if state.exists() else "0")
    elif "COMMENT ON DATABASE" in query:
        state.write_text("ultrakil-disposable-restore-v1")
    elif "shobj_description" in query:
        print(state.read_text() if state.exists() else "")
    elif "json_build_object" in query:
        if mode == "invariants": print('{"failedMigrations": 1}')
        else: print(os.environ["GOOD_COUNTS"])
elif name == "age":
    if mode == "encrypt": sys.exit(1)
    pathlib.Path(args[args.index("--output") + 1]).write_bytes(b"age-encryption.org/v1\nENCRYPTED")
elif name == "sftp":
    batch = sys.stdin.read()
    with open(os.environ["CLIENT_CALLS"], "a") as stream:
        stream.write(json.dumps(["sftp-batch", batch]) + "\n")
    if mode == "upload": sys.exit(1)
'''

GOOD_COUNTS = {
    "tables": 26, "migrations": 9, "failedMigrations": 0,
    "employees": 2, "vehicleAuthorizations": 2, "assignments": 1,
    "outbox": 1, "inactiveCustomers": 1, "inactiveSites": 1,
    "history": 1, "reactivatedImports": 0, "duplicateOutbox": 0,
}


class RecoveryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ultrakil-recovery-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.backups = self.root / "backups"
        self.backups.mkdir(mode=0o700)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for executable in ("pg_dump", "pg_restore", "psql", "createdb", "dropdb", "age", "sftp"):
            target = self.bin / executable
            target.write_text(FAKE)
            target.chmod(0o700)
        self.calls = self.root / "calls"
        self.env = {
            **os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}",
            "PGDATABASE": "ultrakil_staging", "PGHOST": "postgres", "PGUSER": "ultrakil",
            "BACKUP_DIR": str(self.backups), "CLIENT_CALLS": str(self.calls),
            "DB_STATE": str(self.root / "database"), "DUMP_STARTED": str(self.root / "started"),
            "GOOD_COUNTS": json.dumps(GOOD_COUNTS),
        }

    def run_tool(self, *args, success=True, **env):
        result = subprocess.run([sys.executable, str(TOOL), *args], env={**self.env, **env}, capture_output=True, text=True)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("PRIVATE", result.stdout + result.stderr)
        return result

    def published(self):
        return list(self.backups.glob("*.dump.sha256"))

    def create_pair(self, name="ultrakil-20000101T000000Z-aabbccddeeff.dump"):
        path = self.backups / name
        path.write_bytes(b"PGDMPsynthetic")
        path.chmod(0o600)
        manifest = path.with_name(path.name + ".sha256")
        manifest.write_text(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n")
        manifest.chmod(0o600)
        return path

    def call_log(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def test_backup_publishes_only_a_valid_private_archive_and_checksum(self):
        result = self.run_tool("backup")
        archive = Path(json.loads(result.stdout)["archive"])
        self.assertEqual(archive.read_bytes(), b"PGDMPsynthetic")
        self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(self.published()), 1)
        self.assertEqual(self.published()[0].stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(self.backups.glob(".pending-*")), [])
        dump = next(args for name, args in self.call_log() if name == "pg_dump")
        self.assertIn("--format=custom", dump)
        self.assertIn("--file", dump)
        self.run_tool("verify", str(archive))
        self.run_tool("health")

    def test_dump_empty_format_and_list_failures_never_publish_or_retain(self):
        old = self.create_pair()
        for mode in ("dump", "empty", "format", "list"):
            with self.subTest(mode=mode):
                self.run_tool("backup", success=False, FAIL_MODE=mode)
                self.assertEqual(len(self.published()), 1)
                self.assertTrue(old.exists())
                self.assertEqual(list(self.backups.glob(".pending-*")), [])

    def test_interruption_never_creates_a_completion_marker(self):
        process = subprocess.Popen([sys.executable, str(TOOL), "backup"], env={**self.env, "FAIL_MODE": "interrupt"}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        try:
            for _ in range(100):
                if Path(self.env["DUMP_STARTED"]).exists(): break
                if process.poll() is not None: self.fail(process.communicate()[1].decode())
                time.sleep(0.01)
            self.assertTrue(Path(self.env["DUMP_STARTED"]).exists())
            os.killpg(process.pid, signal.SIGTERM)
            process.communicate(timeout=5)
            self.assertNotEqual(process.returncode, 0)
            self.assertEqual(self.published(), [])
            self.assertEqual(list(self.backups.glob(".pending-*")), [])
        finally:
            if process.poll() is None: os.killpg(process.pid, signal.SIGKILL)

    def test_retention_deletes_only_valid_owned_exact_pairs_after_success(self):
        old = self.create_pair()
        unrelated = self.backups / "ultrakil-not-owned.dump"
        unrelated.write_bytes(b"keep")
        orphan = self.create_pair("ultrakil-20000101T000000Z-111111111111.dump")
        orphan.with_name(orphan.name + ".sha256").unlink()
        corrupt = self.create_pair("ultrakil-20000101T000000Z-222222222222.dump")
        corrupt.write_bytes(b"corrupt")
        self.run_tool("backup")
        self.assertFalse(old.exists())
        self.assertFalse(old.with_name(old.name + ".sha256").exists())
        self.assertTrue(all(path.exists() for path in (unrelated, orphan, corrupt)))

    def test_atomic_publication_never_clobbers_existing_archive_or_marker(self):
        old = self.create_pair()
        for mode, suffix, content in (("archive-collision", ".dump", b"existing archive"), ("manifest-collision", ".sha256", b"existing manifest")):
            self.run_tool("backup", success=False, FAIL_MODE=mode)
            self.assertTrue(any(path.read_bytes() == content for path in self.backups.iterdir() if path.name.endswith(suffix)))
            self.assertTrue(old.exists(), "failed publication must not trigger retention")
        self.assertEqual(len(list(self.backups.glob("*.dump"))), 2,
                         "only the original pair and foreign archive collision may remain")

    def test_corruption_malformed_manifest_missing_manifest_and_symlinks_are_rejected(self):
        archive = self.create_pair()
        manifest = archive.with_name(archive.name + ".sha256")
        self.run_tool("verify", str(archive))
        archive.write_bytes(b"PGDMPchanged")
        self.run_tool("verify", str(archive), success=False)
        archive = self.create_pair()
        manifest.write_text(f"{'0' * 64}  ../../other\n")
        self.run_tool("verify", str(archive), success=False)
        manifest.unlink()
        self.run_tool("verify", str(archive), success=False)
        archive = self.create_pair()
        outside = self.root / "outside"
        archive.rename(outside)
        archive.symlink_to(outside)
        self.run_tool("verify", str(archive), success=False)

    def test_health_fails_for_missing_stale_and_corrupt_newest_backups(self):
        self.run_tool("health", success=False)
        self.create_pair()
        self.run_tool("health", success=False)
        self.run_tool("backup")
        self.run_tool("health")
        archive = next(path for path in self.backups.glob("*.dump") if "20000101" not in path.name)
        archive.write_bytes(b"PGDMPcorrupt")
        self.run_tool("health", success=False)

    def test_world_accessible_directory_or_files_and_bad_settings_are_rejected(self):
        self.backups.chmod(0o755)
        self.run_tool("backup", success=False)
        self.backups.chmod(0o700)
        archive = self.create_pair()
        archive.chmod(0o644)
        self.run_tool("verify", str(archive), success=False)
        for value in ("0", "-1", "not-a-number"):
            self.run_tool("backup", success=False, BACKUP_RETENTION_DAYS=value)

    def test_restore_refuses_unsafe_live_existing_and_missing_targets_before_create(self):
        archive = self.create_pair()
        for target in ("ultrakil_staging", "postgres", "ultrakil_test", "ultrakil_restore_live", "ultrakil_restore_bad;drop_test", "ultrakil_restore_" + "x" * 70 + "_test"):
            self.run_tool("restore", str(archive), target, success=False)
        self.run_tool("restore", str(archive), "ultrakil_restore_live_test", success=False, PGDATABASE="ultrakil_restore_live_test")
        Path(self.env["DB_STATE"]).write_text("someone-else")
        self.run_tool("restore", str(archive), "ultrakil_restore_existing_test", success=False)
        self.assertFalse(any(name == "createdb" for name, _ in self.call_log()))

    def test_restore_uses_transaction_and_emits_only_counts_then_exact_cleanup(self):
        archive = self.create_pair()
        target = "ultrakil_restore_unit_test"
        restored = json.loads(self.run_tool("restore", str(archive), target).stdout)
        self.assertEqual(restored["counts"], GOOD_COUNTS)
        command = next(args for name, args in self.call_log() if name == "pg_restore" and "--list" not in args)
        for flag in ("--single-transaction", "--exit-on-error", "--no-owner", "--no-acl"):
            self.assertIn(flag, command)
        self.run_tool("cleanup", target)
        self.assertFalse(Path(self.env["DB_STATE"]).exists())

    def test_failed_restore_and_invariants_leave_database_for_private_inspection(self):
        archive = self.create_pair()
        for mode in ("restore", "invariants"):
            with self.subTest(mode=mode):
                self.run_tool("restore", str(archive), "ultrakil_restore_failed_test", success=False, FAIL_MODE=mode)
                self.assertTrue(Path(self.env["DB_STATE"]).exists())
                self.assertFalse(any(name == "dropdb" for name, _ in self.call_log()))
                Path(self.env["DB_STATE"]).unlink()

    def test_cleanup_refuses_foreign_database_even_with_safe_name(self):
        Path(self.env["DB_STATE"]).write_text("unrelated")
        self.run_tool("cleanup", "ultrakil_restore_foreign_test", success=False)
        self.assertFalse(any(name == "dropdb" for name, _ in self.call_log()))

    def export_env(self):
        key = self.root / "ssh-key"
        known = self.root / "known-hosts"
        for path in (key, known):
            path.write_text("synthetic fixture")
            path.chmod(0o600)
        return {"EXPORT_AGE_RECIPIENT": "age1" + "a" * 58, "EXPORT_SSH_HOST": "backup.example.invalid",
                "EXPORT_SSH_USER": "ultrakil", "EXPORT_REMOTE_DIR": "/approved/ultrakil",
                "EXPORT_SSH_KEY": str(key), "EXPORT_KNOWN_HOSTS": str(known)}

    def test_export_encrypts_first_and_publishes_remote_marker_last_with_pinned_host_key(self):
        archive = self.create_pair()
        self.run_tool("export", str(archive), **self.export_env())
        calls = self.call_log()
        self.assertTrue(any(name == "age" for name, _ in calls))
        sftp = next(args for name, args in calls if name == "sftp")
        self.assertIn("StrictHostKeyChecking=yes", sftp)
        self.assertIn("BatchMode=yes", sftp)
        batch = next(args for name, args in calls if name == "sftp-batch")
        self.assertIn(".tar.age.part", batch)
        self.assertTrue(batch.strip().endswith('.tar.age.sha256"'))
        self.assertNotIn(str(archive), batch)

    def test_export_rejects_missing_unsafe_config_corruption_and_encryption_failure_before_network(self):
        archive = self.create_pair()
        for changes in ({"EXPORT_SSH_HOST": "-bad"}, {"EXPORT_REMOTE_DIR": "/approved/../other"},
                        {"EXPORT_SSH_USER": "user;command"}, {"EXPORT_AGE_RECIPIENT": "invalid"}, {"FAIL_MODE": "encrypt"}):
            self.run_tool("export", str(archive), success=False, **{**self.export_env(), **changes})
            self.assertFalse(any(name == "sftp" for name, _ in self.call_log()))
        self.run_tool("export", str(archive), success=False)
        self.run_tool("export", str(archive), success=False, FAIL_MODE="upload", **self.export_env())


if __name__ == "__main__":
    unittest.main()

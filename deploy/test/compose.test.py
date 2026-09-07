"""Static release invariants; Docker lifecycle proof runs separately in CI."""
from pathlib import Path
import re
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]


class StagingComposeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = yaml.safe_load((ROOT / "deploy/compose.staging.yml").read_text())
        cls.services = cls.config["services"]

    def test_api_and_import_are_gated_on_successful_migration(self):
        for name in ("api", "import"):
            self.assertEqual(self.services[name]["depends_on"]["migrate"]["condition"], "service_completed_successfully")
        migrate = self.services["migrate"]
        self.assertEqual(migrate["restart"], "no")
        self.assertEqual(migrate["command"], ["node", "deploy/staging-tool.mjs", "migrate"])
        self.assertEqual(migrate["build"]["target"], "tooling")

    def test_private_services_have_no_host_ports_and_default_ports_are_loopback(self):
        for name in ("postgres", "redis", "scheduler", "migrate", "import", "backup"):
            self.assertNotIn("ports", self.services[name])
        for name in ("api", "web"):
            self.assertIn(":-127.0.0.1}", self.services[name]["ports"][0])
        self.assertTrue(self.config["networks"]["backend"]["internal"])
        example = (ROOT / "deploy/staging.env.example").read_text()
        self.assertNotIn("=0.0.0.0", example)
        self.assertIn("COMPOSE_PROJECT_NAME", self.config["name"])

    def test_custom_services_have_init_memory_pid_and_filesystem_limits(self):
        for name in ("api", "web", "scheduler", "migrate", "import"):
            service = self.services[name]
            self.assertTrue(service["init"], name)
            self.assertTrue(service["read_only"], name)
            self.assertIn("mem_limit", service, name)
            self.assertIn("pids_limit", service, name)
            self.assertIn("cpus", service, name)
            self.assertEqual(service["cap_drop"], ["ALL"])
            self.assertTrue(all(mount.startswith("/") for mount in service["tmpfs"]), name)
        self.assertEqual(self.services["api"]["stop_grace_period"], "180s")
        # Preserve the official entrypoint's privilege drop to the redis user.
        self.assertEqual(self.services["redis"]["command"][0], "redis-server")

    def test_only_import_runner_mounts_explicit_inputs_without_host_creation(self):
        self.assertNotIn("volumes", self.services["api"])
        importer = self.services["import"]
        self.assertEqual(importer["profiles"], ["tools"])
        self.assertIn("IMPORT_UID", importer["user"])
        mounts = {mount["target"]: mount for mount in importer["volumes"]}
        for target in ("/import/technician-matrix.xlsx", "/import/master-schedule-2026.xlsx", "/import-config"):
            self.assertTrue(mounts[target]["read_only"])
            self.assertFalse(mounts[target]["bind"]["create_host_path"])
        self.assertFalse(mounts["/reports"]["bind"]["create_host_path"])

    def test_images_pin_patch_and_distribution_versions(self):
        for service in self.services.values():
            if "image" in service:
                self.assertRegex(service["image"], r":\d+\.\d+(?:\.\d+)?-alpine\d+\.\d+$")
        for file in ("deploy/api.Dockerfile", "deploy/web.Dockerfile", "services/scheduler/Dockerfile"):
            content = (ROOT / file).read_text()
            for image in re.findall(r"^FROM (\S+)", content, re.MULTILINE):
                if ":" in image:
                    self.assertRegex(image, r":\d+\.\d+\.\d+-.*bookworm")
            self.assertRegex(content, r"(?m)^USER (?:node|scheduler)$")

    def test_operations_use_packaged_executables_and_app_runtimes_are_pruned(self):
        api = (ROOT / "deploy/api.Dockerfile").read_text()
        runtime = api.split("FROM base AS runtime")[1]
        self.assertIn("/out/api/node_modules", runtime)
        self.assertNotIn("corepack", runtime)
        self.assertNotIn("/workspace/apps/api/src", runtime)
        tooling = api.split("FROM base AS tooling")[1].split("FROM base AS runtime")[0]
        self.assertIn("/workspace/apps/api/node_modules", tooling)
        self.assertIn("/workspace/node_modules", tooling)
        self.assertNotIn("RUN corepack", tooling)
        web = (ROOT / "deploy/web.Dockerfile").read_text().split("AS runtime")[1]
        self.assertIn(".next/standalone", web)
        self.assertIn('"apps/manager-web/server.js"', web)
        self.assertNotIn("COPY --from=build /workspace /workspace", web)

    def test_backup_is_private_testable_and_has_a_staleness_probe(self):
        backup = self.services["backup"]
        self.assertEqual(backup["command"], ["schedule"])
        self.assertEqual(backup["depends_on"]["migrate"]["condition"], "service_completed_successfully")
        self.assertEqual(backup["build"]["dockerfile"], "deploy/recovery.Dockerfile")
        self.assertNotIn("user", backup, "The image's real recovery account must not be overridden")
        self.assertTrue(backup["read_only"])
        self.assertEqual(backup["healthcheck"]["test"], ["CMD", "python3", "/opt/ultrakil/recovery.py", "health"])
        mount = backup["volumes"][0]
        self.assertEqual(mount["target"], "/backups")
        self.assertFalse(mount["bind"]["create_host_path"])
        self.assertNotIn("postgres_backups", self.config["volumes"])

    def test_optional_export_has_separate_egress_and_read_only_backup_access(self):
        exporter = self.services["backup-export"]
        self.assertNotIn("user", exporter, "OpenSSH must resolve the image's fixed account with getpwuid")
        self.assertEqual(exporter["profiles"], ["offhost"])
        self.assertEqual(exporter["networks"], ["export-egress"])
        self.assertNotIn("PGPASSWORD", exporter["environment"])
        mounts = {mount["target"]: mount for mount in exporter["volumes"]}
        self.assertTrue(mounts["/backups"]["read_only"])
        self.assertTrue(mounts["/export-secrets/ssh-key"]["read_only"])
        self.assertTrue(mounts["/export-secrets/known-hosts"]["read_only"])
        self.assertFalse(self.config["networks"]["export-egress"].get("internal", False))

    def test_recovery_image_has_a_fixed_nonroot_passwd_account(self):
        image = (ROOT / "deploy/recovery.Dockerfile").read_text()
        self.assertRegex(image, r"addgroup[^\n]*-g 10001 recovery")
        self.assertRegex(image, r"adduser[^\n]*-u 10001[^\n]*-G recovery[^\n]*recovery")
        self.assertRegex(image, r"(?m)^USER recovery$")
        env = (ROOT / "deploy/staging.env.example").read_text()
        self.assertNotIn("BACKUP_UID=", env)
        self.assertNotIn("BACKUP_GID=", env)

    def test_every_build_context_excludes_private_inputs_at_any_depth(self):
        # Scanner rules use /i. Docker does not: every alphabetic literal in
        # every category must explicitly match either letter case.
        private_globs = [
            "**/*.env", "**/*.env.*", "**/*.xls", "**/*.xlsx", "**/*.xlsm", "**/*.csv",
            "**/matrix-mapping.json", "**/job-types.json", "**/*import-report*.json",
            "**/incoming", "**/private", "**/reports", "**/backups", "**/import-reports",
            "**/export-work", "**/export-secrets", "**/*.age",
            "**/*.sql.gz", "**/*.sql.xz", "**/*.sql.zip", "**/*.dump", "**/*.backup",
            "**/*.bak", "**/*.pgdump", "**/*.pem", "**/*.key",
        ]
        required_patterns = {"**/..*"} | {
            "".join(f"[{letter}{letter.upper()}]" if letter.isalpha() else letter for letter in pattern)
            for pattern in private_globs
        }
        contexts = {service["build"]["context"] for service in self.services.values() if "build" in service}
        for context in contexts:
            file = (ROOT / "deploy" / context / ".dockerignore").resolve()
            self.assertTrue(file.is_file(), str(file))
            patterns = set(file.read_text().splitlines())
            self.assertTrue(required_patterns.issubset(patterns), f"{file}: missing {sorted(required_patterns - patterns)}")


if __name__ == "__main__":
    unittest.main()

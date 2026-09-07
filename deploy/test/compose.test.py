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

    def test_every_build_context_excludes_private_inputs_at_any_depth(self):
        required_patterns = {
            "**/*.[xX][lL][sS]", "**/*.[xX][lL][sS][xXmM]", "**/*.[cC][sS][vV]",
            "**/matrix-mapping.json", "**/job-types.json", "**/..*",
            "**/.env", "**/.env.*", "**/*.env", "**/*.env.*",
            "**/*import-report*.json", "**/private", "**/reports", "**/backups",
        }
        contexts = {service["build"]["context"] for service in self.services.values() if "build" in service}
        for context in contexts:
            file = (ROOT / "deploy" / context / ".dockerignore").resolve()
            self.assertTrue(file.is_file(), str(file))
            patterns = set(file.read_text().splitlines())
            self.assertTrue(required_patterns.issubset(patterns), str(file))


if __name__ == "__main__":
    unittest.main()

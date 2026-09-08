import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import urllib.error


REHEARSE = Path(__file__).resolve().parents[1] / 'rehearse.py'
spec = importlib.util.spec_from_file_location('rehearse', REHEARSE)
rehearse = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rehearse)


class FailureProofTests(unittest.TestCase):
    def setUp(self):
        self.dependencies = {name: {'Status': 'running', 'Running': True, 'Health': {'Status': 'healthy'}}
                             for name in ['postgres', 'redis', 'scheduler']}
        self.migration = {'State': {'Status': 'exited', 'Running': False, 'ExitCode': 23, 'OOMKilled': False,
                                    'Error': '', 'StartedAt': '2026-09-07T00:00:00Z'},
                          'Image': 'sha256:recorded', 'Config': {'Cmd': ['node', '-e', 'process.exit(23)']}}

    def proof(self, code=1, migration=None, dependencies=None, api=None):
        rehearse.assert_migration_failure(code, dependencies or self.dependencies,
                                         migration or self.migration, api, 'sha256:recorded')

    def test_only_intended_migration_failure_proves_gate(self):
        self.proof()
        for code in [0, 23, 125, 127]:
            with self.subTest(code=code), self.assertRaises(RuntimeError):
                self.proof(code=code)
        for code in [0, 1, 127, 137]:
            migration = copy.deepcopy(self.migration)
            migration['State']['ExitCode'] = code
            with self.subTest(migration_exit=code), self.assertRaises(RuntimeError):
                self.proof(migration=migration)

    def test_unhealthy_dependency_or_wrong_artifact_cannot_false_green(self):
        for name in self.dependencies:
            dependencies = copy.deepcopy(self.dependencies)
            dependencies[name]['Health']['Status'] = 'unhealthy'
            with self.subTest(service=name), self.assertRaises(RuntimeError):
                self.proof(dependencies=dependencies)
        for key, value in [('Image', 'sha256:other'), ('Config', {'Cmd': ['node', 'missing.js']})]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.proof(migration={**self.migration, key: value})
        with self.assertRaises(RuntimeError):
            self.proof(migration={**self.migration, 'State': {**self.migration['State'], 'OOMKilled': True}})

    def test_api_that_started_even_then_exited_is_not_blocked(self):
        self.proof(api={'Status': 'created', 'Running': False, 'StartedAt': '0001-01-01T00:00:00Z'})
        for state in [{'Status': 'running', 'Running': True},
                      {'Status': 'exited', 'Running': False, 'StartedAt': '2026-09-07T00:00:00Z'}]:
            with self.subTest(state=state), self.assertRaises(RuntimeError):
                self.proof(api=state)


class CleanupTests(unittest.TestCase):
    def invoke(self, outcomes, original=None):
        calls = []

        def execute(command, **kwargs):
            calls.append(command)
            outcome = outcomes[len(calls) - 1]
            if isinstance(outcome, Exception):
                raise outcome
            return subprocess.CompletedProcess(command, outcome, stdout='PRIVATE', stderr='PRIVATE')

        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            try:
                rehearse.cleanup_projects(['docker', 'compose'], {}, 'synthetic', '/tmp/synthetic', original, execute)
            finally:
                self.assertEqual(len(calls), 2)
                self.assertTrue(all('-v' not in call and '--volumes' not in call for call in calls))
                self.assertNotIn('PRIVATE', output.getvalue())
        return output.getvalue()

    def test_success_requires_both_projects_to_stop(self):
        self.assertIn('"teardownFailures": 0', self.invoke([0, 0]))
        for outcomes in [[1, 0], [0, 1], [OSError('PRIVATE'), 1]]:
            with self.subTest(outcomes=outcomes), self.assertRaises(RuntimeError):
                self.invoke(outcomes)

    def test_cleanup_does_not_publish_private_evidence_path(self):
        output = self.invoke([0, 0])
        self.assertNotIn('/tmp/synthetic', output)
        self.assertIn('"privateEvidencePreserved": 1', output)

    def test_cleanup_failure_preserves_original_exception(self):
        original = ValueError('original failure')
        try:
            try:
                raise original
            finally:
                self.invoke([1, OSError('PRIVATE')], original)
        except ValueError as caught:
            self.assertIs(caught, original)
            self.assertTrue(any('teardown' in note for note in caught.__notes__))


class StrictBrowserDiagnosticsTests(unittest.TestCase):
    def test_missing_or_invalid_report_falls_back_without_private_content(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'strict-browser.json'
            for body in [None, '{PRIVATE_TOKEN', 'x' * (rehearse.STRICT_BROWSER_DIAGNOSTIC_MAX_BYTES + 1)]:
                if body is None:
                    path.unlink(missing_ok=True)
                else:
                    path.write_text(body)
                diagnostic = rehearse.load_strict_browser_diagnostic(path)
                self.assertEqual(diagnostic, rehearse.unavailable_strict_browser_diagnostic())
                self.assertNotIn('PRIVATE_TOKEN', json.dumps(diagnostic))

    def test_loader_reconstructs_only_allowlisted_diagnostic_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'strict-browser.json'
            path.write_text(json.dumps({
                'status': 'failed',
                'counts': {'total': 1, 'passed': 0, 'failed': 1, 'skipped': 0, 'timedOut': 0,
                           'interrupted': 0, 'notRun': 0, 'unexpected': 0},
                'failures': [{'file': '02-generation.spec.ts', 'line': 73, 'status': 'failed',
                              'error': 'PRIVATE_TOKEN https://example.invalid'}],
            }))
            self.assertEqual(rehearse.load_strict_browser_diagnostic(path), rehearse.unavailable_strict_browser_diagnostic())

            path.write_text(json.dumps({
                'status': 'failed',
                'counts': {'total': 1, 'passed': 0, 'failed': 1, 'skipped': 0, 'timedOut': 0,
                           'interrupted': 0, 'notRun': 0, 'unexpected': 0},
                'failures': [{'file': '05-accessibility.spec.ts', 'line': 51, 'status': 'failed',
                              'case': '/calendar',
                              'axeRules': ['color-contrast', 'scrollable-region-focusable']}],
            }))
            diagnostic = rehearse.load_strict_browser_diagnostic(path)
            self.assertEqual(diagnostic['failures'], [{
                'file': '05-accessibility.spec.ts', 'line': 51, 'status': 'failed',
                'case': '/calendar', 'axeRules': ['color-contrast', 'scrollable-region-focusable'],
            }])
            self.assertNotIn('PRIVATE_TOKEN', json.dumps(diagnostic))

            for field, value in [('case', 'PRIVATE_TOKEN'), ('axeRules', ['PRIVATE_TOKEN'])]:
                unsafe = {
                    'status': 'failed',
                    'counts': {'total': 1, 'passed': 0, 'failed': 1, 'skipped': 0, 'timedOut': 0,
                               'interrupted': 0, 'notRun': 0, 'unexpected': 0},
                    'failures': [{'file': '05-accessibility.spec.ts', 'line': 51, 'status': 'failed',
                                  field: value}],
                }
                path.write_text(json.dumps(unsafe))
                self.assertEqual(rehearse.load_strict_browser_diagnostic(path),
                                 rehearse.unavailable_strict_browser_diagnostic())

            for field, value in [
                ('case', None),
                ('case', {}),
                ('axeRules', [{}]),
                ('axeRules', ['color-contrast', 1]),
            ]:
                malformed = {
                    'status': 'failed',
                    'counts': {'total': 1, 'passed': 0, 'failed': 1, 'skipped': 0, 'timedOut': 0,
                               'interrupted': 0, 'notRun': 0, 'unexpected': 0},
                    'failures': [{'file': '05-accessibility.spec.ts', 'line': 51, 'status': 'failed',
                                  field: value}],
                }
                path.write_text(json.dumps(malformed))
                self.assertEqual(rehearse.load_strict_browser_diagnostic(path),
                                 rehearse.unavailable_strict_browser_diagnostic())

    def test_runner_publishes_only_reconstructed_diagnostic_and_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'strict-browser.json'
            path.write_text(json.dumps({
                'status': 'failed',
                'counts': {'total': 1, 'passed': 0, 'failed': 1, 'skipped': 0, 'timedOut': 0,
                           'interrupted': 0, 'notRun': 0, 'unexpected': 0},
                'failures': [{'file': '02-generation.spec.ts', 'line': 73, 'status': 'failed'}],
            }))
            output = io.StringIO()
            with contextlib.redirect_stdout(output), self.assertRaisesRegex(RuntimeError, 'raw diagnostics withheld'):
                rehearse.run_strict_browser(['private-command'], {}, path,
                                            execute=lambda *args, **kwargs: subprocess.CompletedProcess(
                                                args[0], 1, stdout=b'PRIVATE_TOKEN', stderr=b'PRIVATE_TOKEN'))
            self.assertNotIn('PRIVATE_TOKEN', output.getvalue())
            self.assertIn('02-generation.spec.ts', output.getvalue())


def healthy_state(restart_count=0):
    return {
        'State': {
            'Status': 'running',
            'Running': True,
            'Health': {'Status': 'healthy'},
        },
        'RestartCount': restart_count,
    }


class Response:
    def __init__(self, status=200, body=b'{}'):
        self.status = status
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self, _size=-1):
        body, self._body = self._body, b''
        return body


class Clock:
    def __init__(self):
        self.value = 0.0
        self.sleeps = []

    def monotonic(self):
        return self.value

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.value += seconds


def runtime_container(identifier, networks):
    return {'Id': identifier, 'NetworkSettings': {'Networks': {name: {} for name in networks}}}


def runtime_network(*identifiers):
    return {'Containers': {identifier: {} for identifier in identifiers}}


class RuntimeNetworkTopologyTests(unittest.TestCase):
    def setUp(self):
        self.project = 'ultrakil-rehearsal-synthetic'
        self.backend = f'{self.project}_backend'
        self.ingress = f'{self.project}_ingress'
        self.api = runtime_container('api-id', [self.backend, self.ingress])
        self.web = runtime_container('web-id', [self.ingress])
        self.backend_network = runtime_network('api-id', 'backup-id')
        self.ingress_network = runtime_network('api-id', 'web-id')

    def test_accepts_exact_api_and_web_runtime_memberships(self):
        rehearse.assert_runtime_network_topology(
            self.project, self.api, self.web, self.backend_network, self.ingress_network,
        )

    def test_rejects_wrong_membership_or_private_service_on_ingress(self):
        wrong_api = runtime_container('api-id', [self.backend])
        with self.assertRaisesRegex(RuntimeError, 'runtime network topology'):
            rehearse.assert_runtime_network_topology(
                self.project, wrong_api, self.web, self.backend_network, self.ingress_network,
            )
        exposed_ingress = runtime_network('api-id', 'web-id', 'redis-id')
        with self.assertRaisesRegex(RuntimeError, 'runtime network topology'):
            rehearse.assert_runtime_network_topology(
                self.project, self.api, self.web, self.backend_network, exposed_ingress,
            )
        with self.assertRaisesRegex(RuntimeError, 'runtime network topology'):
            rehearse.assert_runtime_network_topology(
                self.project, self.api, self.web, runtime_network('api-id', 'web-id', 'exporter-id'),
                self.ingress_network, backup_export_container_id='exporter-id',
            )

    def test_requires_exact_selected_loopback_port(self):
        rehearse.assert_selected_loopback_port('API', '127.0.0.1:31234', 31234)
        for endpoint in ('0.0.0.0:31234', '127.0.0.1:31235', '127.0.0.1:31234\n[::1]:31234'):
            with self.subTest(endpoint=endpoint), self.assertRaisesRegex(RuntimeError, 'host port mapping'):
                rehearse.assert_selected_loopback_port('API', endpoint, 31234)


class HostReadinessTests(unittest.TestCase):
    def test_retries_transient_transport_failures_until_api_is_ready(self):
        clock = Clock()
        attempts = []
        outcomes = [
            urllib.error.URLError(ConnectionRefusedError()),
            TimeoutError(),
            Response(body=b'{"status":"ok"}'),
        ]

        def opener(_url, timeout):
            attempts.append(timeout)
            outcome = outcomes.pop(0)
            if isinstance(outcome, BaseException):
                raise outcome
            return outcome

        rehearse.wait_for_host_readiness(
            'API', 'http://127.0.0.1:1/api/health/ready', rehearse.require_api_ready,
            inspect=lambda: healthy_state(), opener=opener,
            monotonic=clock.monotonic, sleep=clock.sleep,
        )

        self.assertEqual(len(attempts), 3)
        self.assertEqual(clock.sleeps, [0.25, 0.25])
        self.assertTrue(all(timeout <= 1 for timeout in attempts))

    def test_bounds_persistent_transport_failure_to_ten_seconds(self):
        clock = Clock()
        attempts = 0

        def opener(_url, timeout):
            nonlocal attempts
            attempts += 1
            raise urllib.error.URLError(ConnectionRefusedError())

        with self.assertRaisesRegex(RuntimeError, 'API host readiness did not become available'):
            rehearse.wait_for_host_readiness(
                'API', 'http://127.0.0.1:1/api/health/ready', rehearse.require_api_ready,
                inspect=lambda: healthy_state(), opener=opener,
                monotonic=clock.monotonic, sleep=clock.sleep,
            )

        self.assertEqual(clock.value, 10.0)
        self.assertEqual(attempts, 40)

    def test_rejects_non_success_and_bad_api_readiness_responses_without_retry(self):
        for response in [
            Response(status=503, body=b'{"status":"ok"}'),
            Response(body=b'SYNTHETIC_PRIVATE_BODY'),
            Response(body=json.dumps({'status': 'degraded'}).encode()),
        ]:
            with self.subTest(response=response.status):
                clock = Clock()
                attempts = 0

                def opener(_url, timeout):
                    nonlocal attempts
                    attempts += 1
                    return response

                with self.assertRaisesRegex(RuntimeError, 'API host readiness returned invalid response') as caught:
                    rehearse.wait_for_host_readiness(
                        'API', 'http://127.0.0.1:1/api/health/ready', rehearse.require_api_ready,
                        inspect=lambda: healthy_state(), opener=opener,
                        monotonic=clock.monotonic, sleep=clock.sleep,
                    )

                self.assertEqual(attempts, 1)
                self.assertEqual(clock.sleeps, [])
                self.assertNotIn('SYNTHETIC_PRIVATE_BODY', str(caught.exception))

    def test_rejects_web_non_200_without_retry(self):
        clock = Clock()
        attempts = 0

        def opener(_url, timeout):
            nonlocal attempts
            attempts += 1
            return Response(status=204)

        with self.assertRaisesRegex(RuntimeError, 'web host readiness returned invalid response'):
            rehearse.wait_for_host_readiness(
                'web', 'http://127.0.0.1:1/login', rehearse.require_web_ready,
                inspect=lambda: healthy_state(), opener=opener,
                monotonic=clock.monotonic, sleep=clock.sleep,
            )

        self.assertEqual(attempts, 1)
        self.assertEqual(clock.sleeps, [])

    def test_rejects_container_restart_after_host_probe(self):
        states = iter([healthy_state(), healthy_state(restart_count=1)])

        with self.assertRaisesRegex(RuntimeError, 'API host readiness container is not stable'):
            rehearse.wait_for_host_readiness(
                'API', 'http://127.0.0.1:1/api/health/ready', rehearse.require_api_ready,
                inspect=lambda: next(states), opener=lambda _url, timeout: Response(body=b'{"status":"ok"}'),
            )

    def test_rejects_unhealthy_container_before_host_probe(self):
        state = healthy_state()
        state['State']['Health']['Status'] = 'unhealthy'
        attempts = 0

        def opener(_url, timeout):
            nonlocal attempts
            attempts += 1
            return Response(body=b'{"status":"ok"}')

        with self.assertRaisesRegex(RuntimeError, 'API host readiness container is not stable'):
            rehearse.wait_for_host_readiness(
                'API', 'http://127.0.0.1:1/api/health/ready', rehearse.require_api_ready,
                inspect=lambda: state, opener=opener,
            )

        self.assertEqual(attempts, 0)


if __name__ == '__main__':
    unittest.main()

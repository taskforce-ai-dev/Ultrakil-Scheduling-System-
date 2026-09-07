import contextlib
import copy
import importlib.util
import io
from pathlib import Path
import subprocess
import unittest

spec = importlib.util.spec_from_file_location('rehearse', Path(__file__).resolve().parents[1] / 'rehearse.py')
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


if __name__ == '__main__':
    unittest.main()

#!/usr/bin/env python3
"""Disposable synthetic Docker lifecycle proof. No registry push or deployment."""
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
HOST_READINESS_TIMEOUT_SECONDS = 10
HOST_READINESS_RETRY_SECONDS = 0.25
HOST_READINESS_REQUEST_TIMEOUT_SECONDS = 1
STRICT_BROWSER_DIAGNOSTIC_MAX_BYTES = 16 * 1024
STRICT_BROWSER_STATUSES = {'passed', 'failed', 'timedOut', 'interrupted'}
STRICT_BROWSER_RESULT_STATUSES = {'passed', 'failed', 'skipped', 'timedOut', 'interrupted', 'notRun', 'unexpected'}
STRICT_BROWSER_COUNT_KEYS = ('passed', 'failed', 'skipped', 'timedOut', 'interrupted', 'notRun', 'unexpected')
STRICT_BROWSER_SOURCE_FILES = {
    '01-customer-and-agreement.spec.ts', '02-generation.spec.ts', '03-dispatch-and-lock.spec.ts',
    '04-publish.spec.ts', '05-accessibility.spec.ts', '06-responsive.spec.ts',
    '07-vehicle-drivers-and-inactive-clients.spec.ts', 'auth.setup.ts',
}


class HostReadinessResponseError(Exception):
    pass


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def assert_host_probe_container(label, container):
    state = container.get('State', {})
    if (state.get('Status') != 'running' or state.get('Running') is not True
            or state.get('Health', {}).get('Status') != 'healthy'
            or container.get('RestartCount') != 0):
        raise RuntimeError(f'{label} host readiness container is not stable')


def assert_selected_loopback_port(label, endpoint, port):
    if endpoint != f'127.0.0.1:{port}':
        raise RuntimeError(f'{label} host port mapping is not the selected loopback port')


def assert_runtime_network_topology(project, api, web, backend, ingress, backup_export_container_id=None):
    backend_name = f'{project}_backend'
    ingress_name = f'{project}_ingress'
    api_id = api.get('Id')
    web_id = web.get('Id')
    api_networks = api.get('NetworkSettings', {}).get('Networks')
    web_networks = web.get('NetworkSettings', {}).get('Networks')
    backend_containers = backend.get('Containers')
    ingress_containers = ingress.get('Containers')
    if (not isinstance(api_id, str) or not api_id or not isinstance(web_id, str) or not web_id
            or not isinstance(api_networks, dict) or not isinstance(web_networks, dict)
            or not isinstance(backend_containers, dict) or not isinstance(ingress_containers, dict)
            or set(api_networks) != {backend_name, ingress_name}
            or set(web_networks) != {ingress_name}
            or api_id not in backend_containers or web_id in backend_containers
            or (backup_export_container_id is not None and backup_export_container_id in backend_containers)
            or set(ingress_containers) != {api_id, web_id}):
        raise RuntimeError('runtime network topology is invalid')


def require_api_ready(response):
    if response.status != 200:
        raise HostReadinessResponseError
    payload = json.load(response)
    if not isinstance(payload, dict) or payload.get('status') != 'ok':
        raise HostReadinessResponseError


def require_web_ready(response):
    if response.status != 200:
        raise HostReadinessResponseError


def wait_for_host_readiness(label, url, validate, *, inspect, opener=urllib.request.urlopen,
                            monotonic=time.monotonic, sleep=time.sleep):
    deadline = monotonic() + HOST_READINESS_TIMEOUT_SECONDS
    while True:
        assert_host_probe_container(label, inspect())
        try:
            remaining = deadline - monotonic()
            if remaining <= 0:
                raise RuntimeError(f'{label} host readiness did not become available within 10 seconds')
            with opener(url, timeout=min(HOST_READINESS_REQUEST_TIMEOUT_SECONDS, remaining)) as response:
                validate(response)
        except urllib.error.HTTPError:
            raise RuntimeError(f'{label} host readiness returned invalid response') from None
        except (HostReadinessResponseError, json.JSONDecodeError, UnicodeDecodeError):
            raise RuntimeError(f'{label} host readiness returned invalid response') from None
        except (ConnectionRefusedError, TimeoutError, urllib.error.URLError):
            transient_failure = True
        else:
            transient_failure = False
        finally:
            assert_host_probe_container(label, inspect())

        if not transient_failure:
            return
        remaining = deadline - monotonic()
        if remaining <= 0:
            raise RuntimeError(f'{label} host readiness did not become available within 10 seconds')
        sleep(min(HOST_READINESS_RETRY_SECONDS, remaining))


def run(label, command, env=None, expected=0, stdin=None):
    result = subprocess.run(command, cwd=ROOT, env=env, input=stdin, text=True, capture_output=True)
    if result.returncode != expected:
        # Child diagnostics may include expanded environment values. Keep them
        # private; CI shares only the failing step and return code.
        raise RuntimeError(f'{label} failed (exit {result.returncode}); raw diagnostics withheld')
    print(json.dumps({'step': label, 'passed': 1}), flush=True)
    return result.stdout.strip()


def unavailable_strict_browser_diagnostic():
    return {'status': 'unavailable', 'counts': {'total': 0, **{key: 0 for key in STRICT_BROWSER_COUNT_KEYS}}, 'failures': []}


def write_unavailable_strict_browser_diagnostic(path):
    path.write_text(json.dumps(unavailable_strict_browser_diagnostic()), encoding='utf-8')


def load_strict_browser_diagnostic(path):
    fallback = unavailable_strict_browser_diagnostic()
    try:
        if path.stat().st_size > STRICT_BROWSER_DIAGNOSTIC_MAX_BYTES:
            return fallback
        payload = json.loads(path.read_bytes().decode('utf-8'))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return fallback
    if not isinstance(payload, dict) or set(payload) != {'status', 'counts', 'failures'}:
        return fallback
    status, counts, failures = payload['status'], payload['counts'], payload['failures']
    if status not in STRICT_BROWSER_STATUSES or not isinstance(counts, dict) or set(counts) != {'total', *STRICT_BROWSER_COUNT_KEYS}:
        return fallback
    if any(type(counts[key]) is not int or not 0 <= counts[key] <= 10_000 for key in counts):
        return fallback
    if counts['total'] != sum(counts[key] for key in STRICT_BROWSER_COUNT_KEYS) or not isinstance(failures, list) or len(failures) > counts['total']:
        return fallback
    safe_failures = []
    for failure in failures:
        if (not isinstance(failure, dict) or set(failure) != {'file', 'line', 'status'}
                or failure['file'] not in STRICT_BROWSER_SOURCE_FILES or type(failure['line']) is not int
                or not 0 < failure['line'] <= 100_000 or failure['status'] not in STRICT_BROWSER_RESULT_STATUSES
                or failure['status'] == 'passed'):
            return fallback
        safe_failures.append({'file': failure['file'], 'line': failure['line'], 'status': failure['status']})
    if status == 'passed' and (counts['total'] < 48 or counts['passed'] != counts['total']):
        return fallback
    return {'status': status, 'counts': {'total': counts['total'], **{key: counts[key] for key in STRICT_BROWSER_COUNT_KEYS}},
            'failures': safe_failures}


def run_strict_browser(command, env, diagnostic_path, execute=subprocess.run):
    try:
        result = execute(command, cwd=ROOT, env=env, capture_output=True)
    except OSError:
        result = None
    diagnostic = load_strict_browser_diagnostic(diagnostic_path)
    passed = result is not None and result.returncode == 0 and diagnostic['status'] == 'passed'
    print(json.dumps({'step': 'strict browser acceptance', 'passed': int(passed), 'strictBrowser': diagnostic}), flush=True)
    if not passed:
        raise RuntimeError('strict browser acceptance failed; raw diagnostics withheld')


def assert_dependencies_healthy(dependencies):
    if set(dependencies) != {'postgres', 'redis', 'scheduler'} or any(
            state.get('Status') != 'running' or state.get('Running') is not True
            or state.get('Health', {}).get('Status') != 'healthy' for state in dependencies.values()):
        raise RuntimeError('Migration failure proof requires healthy dependencies')


def assert_migration_failure(compose_exit, dependencies, migration, api_state, expected_image):
    assert_dependencies_healthy(dependencies)
    state = migration.get('State', {})
    if (compose_exit != 1 or migration.get('Image') != expected_image
            or migration.get('Config', {}).get('Cmd') != ['node', '-e', 'process.exit(23)']
            or state.get('Status') != 'exited' or state.get('Running') is not False
            or state.get('ExitCode') != 23 or state.get('OOMKilled') is not False
            or state.get('Error') or not state.get('StartedAt')
            or state['StartedAt'].startswith('0001-')):
        raise RuntimeError('Migration failure proof did not observe the intended exit 23 from the recorded image')
    # A container that started and subsequently failed does not prove startup
    # gating. It must either be absent or still never-started in created state.
    if api_state is not None and (api_state.get('Status') != 'created' or api_state.get('Running') is not False
            or not api_state.get('StartedAt', '').startswith('0001-')):
        raise RuntimeError('API started despite the failed migration')


def cleanup_projects(compose, env, project, directory, original_error=None, execute=subprocess.run):
    failures = 0
    for name in [project, f'{project}-fail']:
        try:
            result = execute([*compose, '-p', name, 'down', '--remove-orphans'], cwd=ROOT, env=env,
                             capture_output=True, timeout=180)
            failed = result.returncode != 0
        except (OSError, subprocess.TimeoutExpired):
            failed = True
        failures += int(failed)
        print(json.dumps({'teardownProject': name, 'failed': int(failed)}), flush=True)
    print(json.dumps({'privateEvidencePreserved': 1, 'volumesPreserved': 1,
                      'teardownFailures': failures}), flush=True)
    if failures:
        message = f'Rehearsal teardown failed for {failures} project(s); raw diagnostics withheld; inspect private state.'
        if original_error is not None:
            original_error.add_note(message)
        else:
            raise RuntimeError(message)


def main():
    os.umask(0o077)
    if os.getuid() == 0:
        raise RuntimeError('Run as a nonroot Docker-authorized operator')
    token = secrets.token_hex(6)
    project = f'ultrakil-rehearsal-{token}'
    # Bind mounts need to be traversable by their explicit container UID. Each
    # child is 0700; the common parent contains no data and is traverse-only.
    directory = Path(tempfile.mkdtemp(prefix='ultrakil-rehearsal-', dir='/tmp'))
    directory.chmod(0o711)
    paths = {name: directory / name for name in ['import', 'config', 'reports', 'backup']}
    for path in paths.values():
        path.mkdir(mode=0o700)
    playwright_artifacts = paths['reports'] / 'playwright'
    playwright_artifacts.mkdir(mode=0o700)
    strict_browser_diagnostic = paths['reports'] / 'strict-browser.json'
    write_unavailable_strict_browser_diagnostic(strict_browser_diagnostic)
    run('private recovery ownership', ['sudo', 'chown', '10001:10001', str(paths['backup'])])
    api_port, web_port = free_port(), free_port()
    while api_port == web_port:
        web_port = free_port()
    api_url = f'http://127.0.0.1:{api_port}/api'
    web_url = f'http://127.0.0.1:{web_port}'
    env = {'COMPOSE_PROJECT_NAME': project, 'POSTGRES_DB': f'ultrakil_rehearsal_{token}_test',
           'POSTGRES_USER': 'ultrakil', 'POSTGRES_PASSWORD': secrets.token_hex(24),
           'REDIS_PASSWORD': secrets.token_hex(24), 'JWT_SECRET': secrets.token_hex(32),
           'SEED_ADMIN_PASSWORD': secrets.token_hex(24), 'SEED_ADMIN_EMAIL': 'rehearsal@example.invalid',
           'SEED_ADMIN_NAME': 'Synthetic rehearsal administrator', 'NEXT_PUBLIC_API_BASE_URL': api_url,
           'API_CORS_ORIGINS': web_url, 'API_BIND_ADDRESS': '127.0.0.1', 'API_PORT': str(api_port),
           'WEB_BIND_ADDRESS': '127.0.0.1', 'WEB_PORT': str(web_port),
           'IMPORT_DIR': str(paths['import']), 'IMPORT_CONFIG_DIR': str(paths['config']),
           'IMPORT_REPORT_DIR': str(paths['reports']), 'BACKUP_DIR': str(paths['backup']),
           'IMPORT_UID': str(os.getuid()), 'IMPORT_GID': str(os.getgid()), 'COMPOSE_PARALLEL_LIMIT': '1'}
    env['DATABASE_URL'] = f'postgresql://ultrakil:{env["POSTGRES_PASSWORD"]}@postgres:5432/{env["POSTGRES_DB"]}?schema=public'
    envfile = directory / 'rehearsal.env'
    envfile.write_text('\n'.join(f'{key}={value}' for key, value in env.items()) + '\n')
    child_env = {**os.environ, **env}
    compose = ['docker', 'compose', '--env-file', str(envfile), '-f', str(ROOT / 'deploy/compose.staging.yml')]

    def dc(label, *args, expected=0):
        return run(label, [*compose, *args], child_env, expected)

    def tool(label, service, *args):
        return json.loads(dc(label, 'run', '--rm', '--no-deps', '-T', service, *args))

    def lifecycle(command, expected=0):
        output = dc(f'maintenance {command}', 'run', '--rm', '--no-deps', '-T',
            '-e', 'MAINTENANCE_GATE_CONFIRMED=yes', '-e', 'REDIS_HOST=redis', '-e', f'BULLMQ_PREFIX={project}',
            'migrate', 'node', 'deploy/lifecycle.mjs', command, expected=expected)
        return json.loads(output) if expected == 0 else None

    def probe(action):
        dc(f'synthetic maintenance {action}', 'run', '--rm', '--no-deps', '-T', '-e', f'BULLMQ_PREFIX={project}',
           '-v', f'{ROOT / "deploy/test/maintenance-probe.mjs"}:/workspace/deploy/test/maintenance-probe.mjs:ro',
           'migrate', 'node', 'deploy/test/maintenance-probe.mjs', action)

    def inspect_host_probe_container(service):
        container = subprocess.run([*compose, 'ps', '-q', service], cwd=ROOT, env=child_env,
                                   text=True, capture_output=True)
        cid = container.stdout.strip()
        if container.returncode != 0 or not cid or len(cid.splitlines()) != 1:
            raise RuntimeError(f'{service} host readiness container is not stable')
        result = subprocess.run(['docker', 'inspect', '--format', '{{json .}}', cid], cwd=ROOT,
                                env=child_env, text=True, capture_output=True)
        if result.returncode != 0:
            raise RuntimeError(f'{service} host readiness container is not stable')
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError:
            raise RuntimeError(f'{service} host readiness container is not stable') from None

    def inspect_runtime_network(network):
        result = subprocess.run(['docker', 'network', 'inspect', '--format', '{{json .}}', network], cwd=ROOT,
                                env=child_env, text=True, capture_output=True)
        if result.returncode != 0:
            raise RuntimeError('runtime network inspection failed')
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError:
            raise RuntimeError('runtime network inspection failed') from None

    original_error = None
    try:
        run('synthetic workbook generation', ['node', 'deploy/test/rehearsal-fixture.mjs', 'workbooks', str(paths['import'])])
        dc('Compose config', '--profile', 'tools', '--profile', 'offhost', 'config', '--quiet')
        dc('build all release images', '--profile', 'tools', '--profile', 'offhost', 'build')
        images = json.loads(dc('resolve image manifest', '--profile', 'tools', '--profile', 'offhost', 'config', '--format', 'json'))
        resolved = {}
        for service in ['api', 'web', 'scheduler', 'migrate', 'import', 'backup', 'backup-export']:
            tag = images['services'][service].get('image', f'{project}-{service}')
            identity = run(f'{service} image ID', ['docker', 'image', 'inspect', '--format', '{{.Id}}', tag])
            resolved[service] = identity
            uid = run(f'{service} nonroot account', ['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'sh', identity,
                '-c', 'test "$(id -u)" -ne 0 && getent passwd "$(id -u)" >/dev/null && id -u'])
            if not uid.isdigit() or int(uid) == 0:
                raise RuntimeError('Invalid image UID')
        sha = run('source SHA', ['git', 'rev-parse', 'HEAD'])
        print(json.dumps({'commit': sha, 'images': resolved}), flush=True)
        (directory / 'release-images.json').write_text(json.dumps({'commit': sha, 'images': resolved}))
        for service in ['api', 'migrate']:
            run(f'{service} offline Prisma OpenSSL', ['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'sh', resolved[service],
                '-c', 'openssl version >/dev/null && cd /workspace/apps/api && node -e "const {PrismaClient}=require(\'@prisma/client\'); new PrismaClient()"'])
        run('offline migration tooling', ['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'node', resolved['migrate'],
            'apps/api/node_modules/prisma/build/index.js', '--version'])
        run('offline import tooling', ['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'node', resolved['import'],
            'apps/api/node_modules/tsx/dist/cli.mjs', '--version'])
        recovery_probe = '''set -eu
getent passwd "$(id -u)" >/dev/null
pg_dump --version >/dev/null
age-keygen -o /tmp/identity 2>/tmp/age-keygen.log
recipient=$(age-keygen -y /tmp/identity)
printf synthetic | age -r "$recipient" -o /tmp/probe.age
age -d -i /tmp/identity /tmp/probe.age | grep -qx synthetic
ssh -G -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/tmp/known-hosts -o ConnectTimeout=1 backup@127.0.0.1 >/tmp/ssh-config
test -s /tmp/ssh-config
set +e
sftp -b /dev/null -P 22 -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/tmp/known-hosts -o ConnectTimeout=1 backup@127.0.0.1 >/tmp/sftp.out 2>/tmp/sftp.err
code=$?
set -e
test "$code" -ne 0
! grep -Eqi 'no user exists|bad configuration|unknown option|illegal option|unsupported option' /tmp/sftp.err
grep -Eqi 'connection refused|network is unreachable|connection closed' /tmp/sftp.err
'''
        run('offline recovery encryption and SSH parsing', ['docker', 'run', '--rm', '--network', 'none', '--read-only',
            '--tmpfs', '/tmp:mode=1777', '--entrypoint', 'sh', resolved['backup'], '-c', recovery_probe])
        dc('start isolated dependencies', 'up', '-d', '--wait', '--wait-timeout', '180', 'postgres', 'redis', 'scheduler')
        for service in ['postgres', 'redis']:
            cid = dc(f'{service} dependency container', 'ps', '-q', service)
            resolved[service] = run(f'{service} dependency image ID', ['docker', 'inspect', '--format', '{{.Image}}', cid])
        (directory / 'release-images.json').write_text(json.dumps({'commit': sha, 'images': resolved}))
        dc('clean migrations', 'run', '--rm', '-T', 'migrate')
        dc('idempotent migrations', 'run', '--rm', '-T', 'migrate')
        dry = tool('strict import dry run', 'import', 'node', 'deploy/staging-tool.mjs', 'import', '--dry-run')
        if dry['parsed']['employees'] != 8 or dry['parsed']['vehicles'] != 5:
            raise RuntimeError('Synthetic input count mismatch')
        tool('strict import first pass', 'import', 'node', 'deploy/staging-tool.mjs', 'import')
        tool('strict import second pass', 'import', 'node', 'deploy/staging-tool.mjs', 'import')
        dc('seed isolated browser fixtures', 'run', '--rm', '--no-deps', '-T', '-v',
           f'{ROOT / "deploy/test/rehearsal-fixture.mjs"}:/workspace/deploy/test/rehearsal-fixture.mjs:ro',
           'migrate', 'node', 'deploy/test/rehearsal-fixture.mjs', 'seed')
        dc('start complete stack', 'up', '-d', '--wait', '--wait-timeout', '180', 'api', 'web', 'backup')
        api_container = inspect_host_probe_container('api')
        web_container = inspect_host_probe_container('web')
        backup_export_container_id = dc('backup exporter remains inactive', '--profile', 'offhost', 'ps', '-aq',
                                        'backup-export') or None
        assert_runtime_network_topology(
            project, api_container, web_container, inspect_runtime_network(f'{project}_backend'),
            inspect_runtime_network(f'{project}_ingress'), backup_export_container_id,
        )
        assert_selected_loopback_port('API', dc('API loopback port mapping', 'port', 'api', '3001'), api_port)
        assert_selected_loopback_port('web', dc('web loopback port mapping', 'port', 'web', '3000'), web_port)
        wait_for_host_readiness('API', api_url + '/health/ready', require_api_ready,
                                inspect=lambda: inspect_host_probe_container('api'))
        wait_for_host_readiness('web', web_url + '/login', require_web_ready,
                                inspect=lambda: inspect_host_probe_container('web'))
        run_strict_browser(['corepack', 'pnpm', '--filter', '@ultrakil/manager-web', 'test:e2e'], {
            **child_env, 'E2E_STRICT': '1', 'E2E_REHEARSAL_ID': token, 'E2E_DATABASE_NAME': env['POSTGRES_DB'],
            'E2E_BULLMQ_PREFIX': project, 'E2E_BASE_URL': web_url, 'E2E_API_URL': api_url, 'E2E_DATE': '2026-09-07',
            'E2E_EMAIL': env['SEED_ADMIN_EMAIL'], 'E2E_PASSWORD': env['SEED_ADMIN_PASSWORD'],
            'E2E_PRIVATE_ARTIFACTS_DIR': str(playwright_artifacts),
            'E2E_STRICT_DIAGNOSTIC_FILE': str(strict_browser_diagnostic),
        }, strict_browser_diagnostic)
        dc('verify inactive generation and preserved history', 'run', '--rm', '--no-deps', '-T', '-v',
           f'{ROOT / "deploy/test/rehearsal-fixture.mjs"}:/workspace/deploy/test/rehearsal-fixture.mjs:ro',
           'migrate', 'node', 'deploy/test/rehearsal-fixture.mjs', 'verify')
        # No clients remain in this isolated rehearsal. On real staging the
        # operator must close reverse-proxy ingress and wait for HTTP writes.
        dc('maintenance closes web ingress', 'stop', 'web')
        lifecycle('pause')
        dc('stop application workers safely', 'stop', 'api', 'scheduler')
        probe('active-run')
        lifecycle('check', expected=1)
        probe('settle-run')
        probe('queued-job')
        lifecycle('check', expected=1)
        probe('remove-probe-job')
        lifecycle('check')
        before = lifecycle('snapshot')
        counts = tool('source count evidence', 'backup', 'counts')['counts']
        archived = tool('one shot pre rollback backup', 'backup', 'backup')
        tool('verify exact archive', 'backup', 'verify', archived['archive'])
        target = f'ultrakil_restore_{token}_test'
        restored = tool('restore exact archive', 'backup', 'restore', archived['archive'], target)
        if restored['counts'] != counts:
            raise RuntimeError('Restored counts do not match quiescent source')
        if counts['history'] < 1 or counts['outbox'] < 1 or counts['inactiveSites'] != 2:
            raise RuntimeError('Recovery fixture evidence incomplete')
        tool('cleanup exact disposable restore', 'backup', 'cleanup', target)
        print(json.dumps({'backupBytes': archived['bytes'], 'backupSha256': archived['sha256'], 'restoreCounts': counts}), flush=True)
        override = directory / 'rollback.json'
        override.write_text(json.dumps({'services': {service: {'image': resolved[service], 'pull_policy': 'never'}
            for service in ['api', 'web', 'scheduler']}}))
        # This first-release rehearsal restarts the exact recorded artifacts.
        # Cross-version compatibility remains a release-specific review gate.
        dc('restart exact scheduler artifact', '-f', str(override), 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', 'scheduler')
        dc('restart exact API artifact', '-f', str(override), 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', 'api')
        if lifecycle('snapshot') != before:
            raise RuntimeError('Publication changed during application restart')
        lifecycle('resume')
        lifecycle('pause')
        if lifecycle('snapshot') != before:
            raise RuntimeError('Publication replayed after queue resume')
        lifecycle('resume')
        dc('restart exact web artifact', '-f', str(override), 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--wait', 'web')
        for service in ['api', 'web', 'scheduler']:
            cid = dc(f'{service} rollback container', 'ps', '-q', service)
            if run(f'{service} rollback identity', ['docker', 'inspect', '--format', '{{.Image}}', cid]) != resolved[service]:
                raise RuntimeError('Rollback used an unrecorded artifact')
        # Logs are inspected for hard failures without publishing raw lines.
        logs = dc('inspect service logs privately', 'logs', '--no-color', 'api', 'web', 'scheduler')
        if any(marker in logs for marker in ['UnhandledPromiseRejection', 'FATAL', 'Traceback (most recent call last)']):
            raise RuntimeError('Service logs contain a fatal runtime failure')
        print(json.dumps({'healthyServices': 6, 'rollbackPublicationChanges': 0, 'rawLogLinesPublished': 0}), flush=True)
        dc('stop rehearsal applications', 'stop', 'api', 'web', 'scheduler', 'backup')
        failed_project = f'{project}-fail'
        bad = directory / 'failed-migration.json'
        services = {service: {'image': resolved[service], 'pull_policy': 'never'}
                    for service in ['postgres', 'redis', 'scheduler', 'migrate', 'api']}
        services['migrate']['command'] = ['node', '-e', 'process.exit(23)']
        bad.write_text(json.dumps({'services': services}))
        failed_compose = [*compose, '-p', failed_project, '-f', str(bad)]
        def inspect_failure_service(service, optional=False):
            cid = run(f'failure project {service} container', [*failed_compose, 'ps', '-a', '-q', service], child_env)
            if optional and not cid:
                return None
            if not cid or len(cid.splitlines()) != 1:
                raise RuntimeError('Failure project container evidence missing or ambiguous')
            return json.loads(run(f'failure project {service} state', ['docker', 'inspect', '--format', '{{json .}}', cid]))

        run('start failure project dependencies', [*failed_compose, 'up', '-d', '--no-build', '--pull', 'never',
            '--wait', '--wait-timeout', '180', 'postgres', 'redis', 'scheduler'], child_env)
        dependencies = {service: inspect_failure_service(service)['State'] for service in ['postgres', 'redis', 'scheduler']}
        assert_dependencies_healthy(dependencies)
        result = subprocess.run([*failed_compose, 'up', '-d', '--no-build', '--pull', 'never', 'api'],
                                cwd=ROOT, env=child_env, capture_output=True)
        migration = inspect_failure_service('migrate')
        api = inspect_failure_service('api', optional=True)
        dependencies = {service: inspect_failure_service(service)['State'] for service in ['postgres', 'redis', 'scheduler']}
        assert_migration_failure(result.returncode, dependencies, migration, api['State'] if api else None, resolved['migrate'])
        print(json.dumps({'migrationFailureBlockedApi': 1, 'strictAcceptanceCompleted': 1, 'requiredBrowserJourneys': 48}), flush=True)
    except BaseException as error:
        original_error = error
        raise
    finally:
        # Preserve volumes and private evidence. CI runners dispose of their
        # own filesystem; this script never deletes a volume or flushes Redis.
        cleanup_projects(compose, child_env, project, directory, original_error)


if __name__ == '__main__':
    main()

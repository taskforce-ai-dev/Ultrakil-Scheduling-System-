#!/usr/bin/env python3
"""Disposable synthetic Docker lifecycle proof. No registry push or deployment."""
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def run(label, command, env=None, expected=0, stdin=None):
    result = subprocess.run(command, cwd=ROOT, env=env, input=stdin, text=True, capture_output=True)
    if result.returncode != expected:
        # Child diagnostics may include expanded environment values. Keep them
        # private; CI shares only the failing step and return code.
        raise RuntimeError(f'{label} failed (exit {result.returncode}); raw diagnostics withheld')
    print(json.dumps({'step': label, 'passed': 1}), flush=True)
    return result.stdout.strip()


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
           'API_CORS_ORIGINS': web_url, 'API_PORT': str(api_port), 'WEB_PORT': str(web_port),
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
        with urllib.request.urlopen(api_url + '/health/ready', timeout=10) as response:
            if json.load(response)['status'] != 'ok':
                raise RuntimeError('API readiness failed')
        with urllib.request.urlopen(web_url + '/login', timeout=10) as response:
            if response.status != 200:
                raise RuntimeError('Next standalone startup failed')
        run('strict browser acceptance', ['corepack', 'pnpm', '--filter', '@ultrakil/manager-web', 'test:e2e'], {
            **child_env, 'E2E_STRICT': '1', 'E2E_REHEARSAL_ID': token, 'E2E_DATABASE_NAME': env['POSTGRES_DB'],
            'E2E_BULLMQ_PREFIX': project, 'E2E_BASE_URL': web_url, 'E2E_API_URL': api_url, 'E2E_DATE': '2026-09-07',
            'E2E_EMAIL': env['SEED_ADMIN_EMAIL'], 'E2E_PASSWORD': env['SEED_ADMIN_PASSWORD'],
        })
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
        bad.write_text(json.dumps({'services': {'migrate': {'command': ['node', '-e', 'process.exit(23)']}}}))
        failed_compose = [*compose, '-p', failed_project, '-f', str(bad)]
        result = subprocess.run([*failed_compose, 'up', '-d', 'api'], cwd=ROOT, env=child_env, capture_output=True)
        if result.returncode == 0:
            raise RuntimeError('Injected migration failure did not stop startup')
        running = run('failed migration API gate', ['docker', 'ps', '-q', '--filter', f'label=com.docker.compose.project={failed_project}',
            '--filter', 'label=com.docker.compose.service=api'])
        if running:
            raise RuntimeError('API ran after migration failure')
        print(json.dumps({'migrationFailureBlockedApi': 1, 'strictAcceptanceCompleted': 1, 'requiredBrowserJourneys': 48}), flush=True)
    finally:
        # Preserve volumes and private evidence. CI runners dispose of their
        # own filesystem; this script never deletes a volume or flushes Redis.
        for name in [project, f'{project}-fail']:
            subprocess.run([*compose, '-p', name, 'down', '--remove-orphans'], cwd=ROOT, env=child_env, capture_output=True)
        print(json.dumps({'privateEvidenceDirectory': str(directory), 'volumesPreserved': 1}), flush=True)


if __name__ == '__main__':
    main()

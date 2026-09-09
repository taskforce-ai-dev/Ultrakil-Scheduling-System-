"""Validate synthetic rehearsal inputs with real parsers/imports on a NEW local DB."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]


def run(args, env, cwd=ROOT):
    result = subprocess.run(args, env=env, cwd=cwd, text=True, capture_output=True, timeout=90)
    if result.returncode:
        raise RuntimeError(f'Synthetic rehearsal fixture failed: {Path(args[0]).name}; private diagnostics withheld')
    return result.stdout.strip()


def main():
    host, port, user = (os.environ.get(key, '') for key in ['PGHOST', 'PGPORT', 'PGUSER'])
    if host not in ['127.0.0.1', 'localhost'] or not port.isdigit() or not user:
        raise RuntimeError('Require explicit local PGHOST/PGPORT/PGUSER')
    database = f'ultrakil_rehearsal_{secrets.token_hex(6)}_test'
    env = {**os.environ, 'PGDATABASE': database, 'SEED_ADMIN_EMAIL': 'synthetic@example.invalid',
           'SEED_ADMIN_PASSWORD': secrets.token_hex(24), 'SEED_ADMIN_NAME': 'Synthetic test operator'}
    env['DATABASE_URL'] = f'postgresql://{quote(user, safe="")}:{quote(env.get("PGPASSWORD", ""), safe="")}@{host}:{port}/{database}?schema=public'
    success = False
    with tempfile.TemporaryDirectory(prefix='ultrakil-rehearsal-', dir='/tmp') as temporary:
        env.update({'TECHNICIAN_MATRIX_PATH': f'{temporary}/technician-matrix.xlsx',
                    'MASTER_SCHEDULE_PATH': f'{temporary}/master-schedule-2026.xlsx',
                    'MATRIX_MAPPING_PATH': f'{temporary}/absent-mapping.json'})
        run(['createdb', '--no-password', '--template=template0', database], env)
        try:
            run(['node', 'deploy/test/rehearsal-fixture.mjs', 'workbooks', temporary], env)
            prisma = str(ROOT / 'apps/api/node_modules/prisma/build/index.js')
            for _ in range(2):
                run(['node', prisma, 'migrate', 'deploy', '--schema', str(ROOT / 'apps/api/prisma/schema.prisma')], env)
            importer = ['node', str(ROOT / 'apps/api/node_modules/tsx/dist/cli.mjs'), 'scripts/staging-import.ts']
            parsed = json.loads(run([*importer, '--dry-run'], env, ROOT / 'apps/api'))['parsed']
            assert parsed['employees'] == 8 and parsed['vehicles'] == 5
            assert parsed['publicTransportEmployees'] == 2
            assert parsed['customers'] == 3 and parsed['sites'] == 4
            assert parsed['scheduleIssues']['RECORD_INACTIVE'] == 2
            for _ in range(2):
                run(importer, env, ROOT / 'apps/api')
            run(['node', 'deploy/test/rehearsal-fixture.mjs', 'seed'], env)
            run(['node', 'deploy/test/rehearsal-fixture.mjs', 'verify'], env)
            print(json.dumps({'syntheticRehearsalFixture': 'passed', 'parsed': parsed,
                              'migrationPasses': 2, 'importPasses': 2, 'seedSucceeded': 1}))
            success = True
        finally:
            if success:
                run(['dropdb', '--no-password', database], env)
            else:
                print(f'Synthetic database preserved for inspection: {database}')


if __name__ == '__main__':
    main()

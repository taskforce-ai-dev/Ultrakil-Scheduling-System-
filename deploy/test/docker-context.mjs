// Docker/BuildKit is the authority for .dockerignore matching. This test exports
// a scratch image containing only fabricated fixtures; no image pull is needed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const forbidden = [
  'matrix-mapping.json', 'job-types.json', 'deploy/matrix-mapping.json', 'config/deep/job-types.json',
  'data/Staff.xlsx', 'MASTER.XLSX', 'app/Client.XlSx', 'app/legacy.XLS', 'nested/macro.xLsM', 'nested/clients.CsV',
  '.env', 'app/.env.production', 'deploy/staging.env', 'app/staging.env.bak',
  'private/data.json', 'nested/reports/issues.json', '..private/import-run/issues.json',
  'backups/archive.sql.gz', 'nested/master-schedule-import-report.json', '.venv/lib/data.py',
];
const allowed = ['app/main.py', 'app/solver/model.py', 'requirements.txt', 'package.json',
  'apps/api/src/main.ts', 'apps/manager-web/src/app/page.tsx', 'packages/api-contracts/src/index.ts',
  'deploy/staging-tool.mjs', 'data/matrix-mapping.example.json'];

for (const ignorePath of ['.dockerignore', 'services/scheduler/.dockerignore']) {
  const temporary = mkdtempSync(join(tmpdir(), 'ulk-docker-context-'));
  try {
    const context = join(temporary, 'context');
    const output = join(temporary, 'export');
    mkdirSync(context);
    copyFileSync(resolve(root, ignorePath), join(context, '.dockerignore'));
    for (const path of [...forbidden, ...allowed]) {
      const target = join(context, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, 'synthetic context fixture\n');
    }
    const dockerfile = join(temporary, 'Dockerfile');
    writeFileSync(dockerfile, 'FROM scratch\nCOPY . /\n');
    execFileSync('docker', ['build', '--progress=plain', '--output', `type=local,dest=${output}`, '--file', dockerfile, context], {
      encoding: 'utf8', stdio: 'pipe', env: { ...process.env, DOCKER_BUILDKIT: '1' },
    });
    for (const path of forbidden) assert.equal(existsSync(join(output, path)), false, `${ignorePath} leaked synthetic ${path}`);
    for (const path of allowed) assert.equal(existsSync(join(output, path)), true, `${ignorePath} omitted required ${path}`);
    console.log(`${ignorePath}: ${forbidden.length} private fixtures excluded; ${allowed.length} source/template fixtures retained.`);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

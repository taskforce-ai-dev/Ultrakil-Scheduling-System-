// Docker/BuildKit is the authority for .dockerignore matching. This test exports
// a scratch image containing only fabricated fixtures; no image pull is needed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { privatePathFixtures, publicPathFixtures } from './private-path-fixtures.mjs';

const root = resolve(import.meta.dirname, '../..');
const forbidden = [...privatePathFixtures, '.venv/lib/data.py'];
const allowed = publicPathFixtures;

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

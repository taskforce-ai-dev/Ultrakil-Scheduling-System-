import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('git failure cannot expose synthetic private paths through stderr or an uncaught error object', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ulk-git-failure-'));
  try {
    writeFileSync(join(directory, 'git'), `#!${process.execPath}\nprocess.stdout.write('incoming/SYNTHETIC_PRIVATE_CLIENT.xlsx\\0');\nprocess.stderr.write('SYNTHETIC_PRIVATE_DIAGNOSTIC');\nprocess.exit(37);\n`, { mode: 0o700 });
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../../scripts/check-private-files.mjs')], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}` }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Private-file scan failed: unable to read tracked paths. Inspect in a protected local session.\n');
    assert.ok(!result.stderr.includes('SYNTHETIC_PRIVATE'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

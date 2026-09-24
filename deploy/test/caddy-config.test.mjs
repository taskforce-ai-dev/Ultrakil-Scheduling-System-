import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const configPath = resolve(root, 'deploy/caddy/Caddyfile');
const ultrakilFragmentPath = resolve(root, 'deploy/caddy/Caddyfile.ultrakil');
const smokePath = resolve(root, 'deploy/caddy/smoke-test.sh');
const stagingRunbookPath = resolve(root, 'docs/STAGING_RUNBOOK.md');

function config() {
  assert.ok(existsSync(configPath), 'deploy/caddy/Caddyfile must exist');
  return readFileSync(configPath, 'utf8');
}

function ultrakilFragment() {
  assert.ok(existsSync(ultrakilFragmentPath), 'deploy/caddy/Caddyfile.ultrakil must exist');
  return readFileSync(ultrakilFragmentPath, 'utf8');
}

function siteBlock(caddyfile, hostname) {
  const start = caddyfile.indexOf(`${hostname} {`);
  assert.notEqual(start, -1, `${hostname} site block is required`);
  const end = caddyfile.indexOf('\n}', start);
  assert.notEqual(end, -1, `${hostname} site block must close`);
  return caddyfile.slice(start, end + 2);
}

function headerValue(caddyfile, name) {
  const line = caddyfile.split('\n').find((value) => value.trimStart().startsWith(`${name} `));
  assert.ok(line, `${name} must be configured`);
  return line;
}

test('Caddy template preserves the current portal and both API proxy routes', () => {
  const caddyfile = ultrakilFragment();
  assert.match(siteBlock(caddyfile, 'ultrakil.taskforceai.tech'), /reverse_proxy 127\.0\.0\.1:3000/);
  for (const hostname of ['api.ultrakil.taskforceai.tech', 'ultrakil-api.taskforceai.tech']) {
    assert.match(siteBlock(caddyfile, hostname), /reverse_proxy 127\.0\.0\.1:3001/);
  }
});

test('global Caddy template imports the isolated UltraKIL site fragment', () => {
  const global = config();
  assert.match(global, /import Caddyfile\.ultrakil/);
  for (const hostname of ['ultrakil.taskforceai.tech', 'api.ultrakil.taskforceai.tech', 'ultrakil-api.taskforceai.tech']) {
    const siteDeclaration = new RegExp(`^${hostname.replaceAll('.', '\\.')}\\s*\\{`, 'gm');
    assert.doesNotMatch(global, siteDeclaration);
    assert.equal([...ultrakilFragment().matchAll(siteDeclaration)].length, 1,
      `${hostname} must be defined exactly once in the fragment`);
  }
});

test('Caddy template supplies host-only security headers and strips implementation headers', () => {
  const caddyfile = ultrakilFragment();
  assert.match(caddyfile, /Strict-Transport-Security "max-age=31536000"/);
  assert.doesNotMatch(headerValue(caddyfile, 'Strict-Transport-Security'), /includeSubDomains|preload/i);
  assert.match(caddyfile, /X-Content-Type-Options "nosniff"/);
  assert.match(caddyfile, /Referrer-Policy "strict-origin-when-cross-origin"/);
  assert.match(caddyfile, /X-Frame-Options "DENY"/);
  assert.match(caddyfile, /Permissions-Policy "/);
  assert.match(caddyfile, /clipboard-read=\(self\), clipboard-write=\(self\)/);
  assert.doesNotMatch(caddyfile, /clipboard-read=\(\)/);
  assert.doesNotMatch(caddyfile, /clipboard-write=\(\)/);
  assert.match(caddyfile, /-Server/);
  assert.match(caddyfile, /-X-Powered-By/);
});

const expectedPermissionsPolicy = 'permissions-policy: clipboard-read=(self), clipboard-write=(self), geolocation=()';

const finalHeaders = [
  'strict-transport-security: max-age=31536000',
  'x-content-type-options: nosniff',
  'referrer-policy: strict-origin-when-cross-origin',
  'x-frame-options: DENY',
  expectedPermissionsPolicy,
  "content-security-policy-report-only: frame-ancestors 'none'",
].join('\n');

function runSmokeWithHeaders(headers) {
  const directory = mkdtempSync(resolve(tmpdir(), 'ulk-caddy-smoke-'));
  const fixture = resolve(directory, 'headers.txt');
  const fakeCurl = resolve(directory, 'curl');
  try {
    writeFileSync(fixture, headers);
    writeFileSync(fakeCurl, `#!/usr/bin/env sh\nset -eu\nout=''\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = '--dump-header' ]; then out=\"$2\"; shift 2; continue; fi\n  shift\ndone\ncp \"$FAKE_CURL_HEADERS\" \"$out\"\n`);
    chmodSync(fakeCurl, 0o755);
    return spawnSync(smokePath, [], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        CURL_BIN: fakeCurl,
        FAKE_CURL_HEADERS: fixture,
        PORTAL_URL: 'https://portal.example.test/login',
        API_URL: 'https://api.example.test/api/health/ready',
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('Caddy smoke test validates the final redirect response rather than an earlier hop', () => {
  assert.match(readFileSync(smokePath, 'utf8'), /CURL_BIN=/);
  const onlyEarlierHopHasHeaders = `HTTP/2 302\n${finalHeaders}\nserver: Caddy\nlocation: https://portal.example.test/login\n\nHTTP/2 200\ncontent-type: text/html\n\n`;
  const failed = runSmokeWithHeaders(onlyEarlierHopHasHeaders);
  assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);

  const onlyFinalHopHasHeaders = `HTTP/2 302\nlocation: https://portal.example.test/login\n\nHTTP/2 200\n${finalHeaders}\n\n`;
  const passed = runSmokeWithHeaders(onlyFinalHopHasHeaders);
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);

  const finalRedirect = `HTTP/2 302\n${finalHeaders}\nlocation: https://portal.example.test/login\n\n`;
  const redirectFailed = runSmokeWithHeaders(finalRedirect);
  assert.notEqual(redirectFailed.status, 0, redirectFailed.stdout + redirectFailed.stderr);
});

test('Caddy smoke test refuses a final response that blocks the Share acceptance readback', () => {
  const clipboardReadDenied = finalHeaders.replace(
    expectedPermissionsPolicy,
    'permissions-policy: clipboard-read=(), clipboard-write=(self), geolocation=()',
  );
  const failed = runSmokeWithHeaders(`HTTP/2 200\n${clipboardReadDenied}\n\n`);
  assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
});

test('Caddy template starts CSP in report-only mode without changing authentication or throttling', () => {
  const caddyfile = ultrakilFragment();
  assert.match(caddyfile, /Content-Security-Policy-Report-Only "/);
  assert.match(caddyfile, /frame-ancestors 'none'/);
  assert.match(caddyfile, /connect-src 'self' https:\/\/ultrakil-api\.taskforceai\.tech https:\/\/api\.ultrakil\.taskforceai\.tech/);
  assert.doesNotMatch(caddyfile, /\n\s*Content-Security-Policy "/);
  assert.doesNotMatch(caddyfile, /rate_limit|basicauth|forward_auth/i);
});

test('mixed-host Caddy runbook refuses an automated fragment merge to prevent duplicate UltraKIL routes', () => {
  const runbook = readFileSync(stagingRunbookPath, 'utf8');
  assert.match(runbook, /Automated mixed-host\s+merge is intentionally unsupported/i);
  assert.match(runbook, /Do not use this path to replace existing UltraKIL blocks/i);
  assert.match(runbook, /every transitive import/i);
  assert.match(runbook, /exactly once/i);
  assert.match(runbook, /If any\s+host appears other than exactly once(?: in that effective configuration)?, stop/i);
  assert.doesNotMatch(runbook, /import \/etc\/caddy\/Caddyfile\.ultrakil\.next/);
  assert.doesNotMatch(runbook, /Use the fragment merge path instead/i);
});

test('Caddy runbook records host validation as author evidence rather than reviewer approval', () => {
  const runbook = readFileSync(stagingRunbookPath, 'utf8');
  assert.match(runbook, /The 2026-09-24 recheck returned Caddy `v2\.6\.2`/);
  assert.match(runbook, /17999a34c8de3fe8b141bfe0e87756b439d434f1e696eb2ae6c30463653c13b0/);
  assert.match(runbook, /caddy\s+adapt --config \/dev\/stdin --adapter\s+caddyfile/);
  assert.match(runbook, /caddy\s+validate --config \/dev\/stdin --adapter\s+caddyfile/);
  assert.match(runbook, /not an independent-reviewer\s+attestation/i);
});

function runbookShellBlock(runbook, anchor) {
  const anchorOffset = runbook.indexOf(anchor);
  assert.notEqual(anchorOffset, -1, `missing runbook section: ${anchor}`);
  const fenceStart = runbook.indexOf('```bash\n', anchorOffset);
  const fenceEnd = runbook.indexOf('\n```', fenceStart);
  assert.notEqual(fenceStart, -1, `missing shell block after: ${anchor}`);
  assert.notEqual(fenceEnd, -1, `unterminated shell block after: ${anchor}`);
  return runbook.slice(fenceStart + '```bash\n'.length, fenceEnd).split('\n');
}

function commandIndex(lines, command, from = 0) {
  const index = lines.indexOf(command, from);
  assert.notEqual(index, -1, `missing command: ${command}`);
  return index;
}

function expectOrderedCommands(lines, commands) {
  let previous = -1;
  for (const command of commands) {
    const index = commandIndex(lines, command, previous + 1);
    assert.ok(index > previous, `expected after ${lines[previous]}: ${command}`);
    previous = index;
  }
}

test('Caddy runbook snapshots and restores a matching wrapper-fragment pair across first and later rollbacks', () => {
  const runbook = readFileSync(stagingRunbookPath, 'utf8');
  const deploy = runbookShellBlock(runbook, 'For an UltraKIL-only host, install and reload only during a release window:');
  const rollback = runbookShellBlock(runbook, 'restore the matching pre-change wrapper/fragment snapshot');

  const createSnapshot = 'sudo install -d -o root -g root -m 0700 /etc/caddy/.ultrakil-candidate /etc/caddy/.ultrakil-previous';
  const snapshotWrapper = 'sudo cp -a /etc/caddy/Caddyfile /etc/caddy/.ultrakil-previous/Caddyfile';
  const fragmentExists = 'if sudo test -e /etc/caddy/Caddyfile.ultrakil; then';
  const snapshotFragment = '  sudo cp -a /etc/caddy/Caddyfile.ultrakil /etc/caddy/.ultrakil-previous/Caddyfile.ultrakil';
  const firstDeployMarker = '  sudo install -o root -g root -m 0600 /dev/null /etc/caddy/.ultrakil-previous/fragment-absent';
  const validateSnapshot = 'sudo caddy validate --config /etc/caddy/.ultrakil-previous/Caddyfile --adapter caddyfile';
  const installFragment = 'sudo install -o root -g root -m 0644 /etc/caddy/.ultrakil-candidate/Caddyfile.ultrakil /etc/caddy/Caddyfile.ultrakil';
  const installWrapper = 'sudo install -o root -g root -m 0644 /etc/caddy/.ultrakil-candidate/Caddyfile /etc/caddy/Caddyfile';
  const validateLive = 'sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile';
  const reload = 'sudo caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile';

  expectOrderedCommands(deploy, [createSnapshot, snapshotWrapper, fragmentExists, snapshotFragment, 'else', firstDeployMarker, 'fi', validateSnapshot, installFragment, installWrapper, validateLive, reload]);
  assert.equal(deploy.filter(line => line === reload).length, 1, 'deploy must reload exactly once after both installs');
  assert.ok(commandIndex(deploy, snapshotFragment) < commandIndex(deploy, 'else'), 'existing fragment must be copied before the absent-fragment branch');
  assert.ok(commandIndex(deploy, firstDeployMarker) > commandIndex(deploy, 'else'), 'absence marker must only be created when the old fragment is absent');

  const markerExists = 'if sudo test -f /etc/caddy/.ultrakil-previous/fragment-absent; then';
  const removeIntroducedFragment = '  sudo rm -f /etc/caddy/Caddyfile.ultrakil';
  const restoreFragment = '  sudo cp -a /etc/caddy/.ultrakil-previous/Caddyfile.ultrakil /etc/caddy/Caddyfile.ultrakil';
  const restoreWrapper = 'sudo cp -a /etc/caddy/.ultrakil-previous/Caddyfile /etc/caddy/Caddyfile';

  expectOrderedCommands(rollback, [validateSnapshot, markerExists, removeIntroducedFragment, 'else', restoreFragment, 'fi', restoreWrapper, validateLive, reload]);
  assert.equal(rollback.filter(line => line === reload).length, 1, 'rollback must reload exactly once after both restores');
  assert.ok(commandIndex(rollback, removeIntroducedFragment) < commandIndex(rollback, 'else'), 'marker branch must remove a first-deploy fragment');
  assert.ok(commandIndex(rollback, restoreFragment) > commandIndex(rollback, 'else'), 'non-marker branch must restore the prior fragment');
});

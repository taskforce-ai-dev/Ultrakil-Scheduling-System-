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
  assert.match(config(), /import Caddyfile\.ultrakil/);
});

test('Caddy template supplies host-only security headers and strips implementation headers', () => {
  const caddyfile = ultrakilFragment();
  assert.match(caddyfile, /Strict-Transport-Security "max-age=31536000"/);
  assert.doesNotMatch(headerValue(caddyfile, 'Strict-Transport-Security'), /includeSubDomains|preload/i);
  assert.match(caddyfile, /X-Content-Type-Options "nosniff"/);
  assert.match(caddyfile, /Referrer-Policy "strict-origin-when-cross-origin"/);
  assert.match(caddyfile, /X-Frame-Options "DENY"/);
  assert.match(caddyfile, /Permissions-Policy "/);
  assert.match(caddyfile, /clipboard-read=\(\), clipboard-write=\(self\)/);
  assert.doesNotMatch(caddyfile, /clipboard-write=\(\)/);
  assert.match(caddyfile, /-Server/);
  assert.match(caddyfile, /-X-Powered-By/);
});

const finalHeaders = [
  'strict-transport-security: max-age=31536000',
  'x-content-type-options: nosniff',
  'referrer-policy: strict-origin-when-cross-origin',
  'x-frame-options: DENY',
  'permissions-policy: geolocation=()',
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
});

test('Caddy template starts CSP in report-only mode without changing authentication or throttling', () => {
  const caddyfile = ultrakilFragment();
  assert.match(caddyfile, /Content-Security-Policy-Report-Only "/);
  assert.match(caddyfile, /frame-ancestors 'none'/);
  assert.match(caddyfile, /connect-src 'self' https:\/\/ultrakil-api\.taskforceai\.tech https:\/\/api\.ultrakil\.taskforceai\.tech/);
  assert.doesNotMatch(caddyfile, /\n\s*Content-Security-Policy "/);
  assert.doesNotMatch(caddyfile, /rate_limit|basicauth|forward_auth/i);
});

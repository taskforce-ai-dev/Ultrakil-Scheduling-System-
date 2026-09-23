import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const configPath = resolve(root, 'deploy/caddy/Caddyfile');

function config() {
  assert.ok(existsSync(configPath), 'deploy/caddy/Caddyfile must exist');
  return readFileSync(configPath, 'utf8');
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
  const caddyfile = config();
  assert.match(siteBlock(caddyfile, 'ultrakil.taskforceai.tech'), /reverse_proxy 127\.0\.0\.1:3000/);
  for (const hostname of ['api.ultrakil.taskforceai.tech', 'ultrakil-api.taskforceai.tech']) {
    assert.match(siteBlock(caddyfile, hostname), /reverse_proxy 127\.0\.0\.1:3001/);
  }
});

test('Caddy template supplies host-only security headers and strips implementation headers', () => {
  const caddyfile = config();
  assert.match(caddyfile, /Strict-Transport-Security "max-age=31536000"/);
  assert.doesNotMatch(headerValue(caddyfile, 'Strict-Transport-Security'), /includeSubDomains|preload/i);
  assert.match(caddyfile, /X-Content-Type-Options "nosniff"/);
  assert.match(caddyfile, /Referrer-Policy "strict-origin-when-cross-origin"/);
  assert.match(caddyfile, /X-Frame-Options "DENY"/);
  assert.match(caddyfile, /Permissions-Policy "/);
  assert.match(caddyfile, /-Server/);
  assert.match(caddyfile, /-X-Powered-By/);
});

test('Caddy template starts CSP in report-only mode without changing authentication or throttling', () => {
  const caddyfile = config();
  assert.match(caddyfile, /Content-Security-Policy-Report-Only "/);
  assert.match(caddyfile, /frame-ancestors 'none'/);
  assert.match(caddyfile, /connect-src 'self' https:\/\/ultrakil-api\.taskforceai\.tech https:\/\/api\.ultrakil\.taskforceai\.tech/);
  assert.doesNotMatch(caddyfile, /\n\s*Content-Security-Policy "/);
  assert.doesNotMatch(caddyfile, /rate_limit|basicauth|forward_auth/i);
});

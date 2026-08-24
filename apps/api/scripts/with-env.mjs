#!/usr/bin/env node
/**
 * Runs a command with the repository-root `.env` loaded.
 *
 * pnpm runs workspace scripts with the package directory as the working
 * directory, so the Prisma CLI looks for `.env` in `apps/api` and never finds
 * the single root `.env` the whole repo shares. Rather than asking everyone to
 * keep two copies of the same file in sync, this wrapper loads the root file
 * first and then hands over to the real command.
 *
 * Values already present in the environment always win, so CI — which sets real
 * environment variables and has no `.env` file — is unaffected. A missing `.env`
 * is not an error for the same reason.
 *
 *   node scripts/with-env.mjs prisma migrate deploy
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Nearest first: a package-local .env overrides the shared root one.
const candidates = [
  resolve(here, '..', '.env'),
  resolve(here, '..', '..', '..', '.env'),
];

/** Minimal .env parser: KEY=VALUE, `#` comments, optional quotes, no expansion. */
function parseEnv(contents) {
  const result = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    if (!key) continue;

    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

for (const file of candidates) {
  if (!existsSync(file)) continue;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  process.stderr.write('with-env: no command given\n');
  process.exit(1);
}

const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
child.on('error', (error) => {
  process.stderr.write(`with-env: failed to run "${command}": ${error.message}\n`);
  process.exit(1);
});

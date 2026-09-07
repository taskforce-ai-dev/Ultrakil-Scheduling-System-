import { spawnSync } from 'node:child_process';
import { accessSync, constants, lstatSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const fail = key => { throw new Error(`Invalid staging configuration: ${key}. Values are withheld.`); };

export function validateReleaseConfig(env) {
  const secrets = ['POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'JWT_SECRET', 'SEED_ADMIN_PASSWORD'];
  for (const key of secrets) {
    const value = env[key];
    if (!value || value.trim() !== value || value.length < (key === 'JWT_SECRET' ? 32 : 24)
      || /replace-with|change-me|changeme|placeholder/i.test(value)) fail(key);
  }
  if (new Set(secrets.map(key => env[key])).size !== secrets.length) fail('independent secrets');
  for (const key of ['POSTGRES_USER', 'POSTGRES_DB']) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(env[key] ?? '')) fail(key);
  }
  try {
    const url = new URL(env.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== 'postgres'
      || url.port !== '5432' || decodeURIComponent(url.username) !== env.POSTGRES_USER
      || decodeURIComponent(url.password) !== env.POSTGRES_PASSWORD
      || url.pathname !== `/${env.POSTGRES_DB}` || url.hash
      || [...url.searchParams].some(([key, value]) => key !== 'schema' || value !== 'public')) fail('DATABASE_URL');
  } catch { fail('DATABASE_URL'); }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.SEED_ADMIN_EMAIL ?? '')) fail('SEED_ADMIN_EMAIL');
  if (!env.SEED_ADMIN_NAME?.trim()) fail('SEED_ADMIN_NAME');

  const checkUrl = (value, key, path) => {
    try {
      const url = new URL(value);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
        || url.username || url.password || url.search || url.hash || url.pathname !== path) fail(key);
    } catch { fail(key); }
  };
  checkUrl(env.NEXT_PUBLIC_API_BASE_URL, 'NEXT_PUBLIC_API_BASE_URL', '/api');
  for (const value of (env.API_CORS_ORIGINS ?? '').split(',')) checkUrl(value.trim(), 'API_CORS_ORIGINS', '/');
}

export function validateImportFiles(env) {
  if (process.getuid?.() === 0) fail('IMPORT_UID must be nonzero');
  for (const key of ['TECHNICIAN_MATRIX_PATH', 'MASTER_SCHEDULE_PATH']) {
    try {
      if (!env[key]) fail(key);
      const stat = lstatSync(env[key]);
      if (!stat.isFile() || stat.size === 0 || (stat.mode & 0o007)) fail(key);
      accessSync(env[key], constants.R_OK);
    } catch { fail(key); }
  }
  if (env.STAGING_REPORT_DIR) {
    try {
      const stat = lstatSync(env.STAGING_REPORT_DIR);
      const fromRepository = relative(root, realpathSync(env.STAGING_REPORT_DIR));
      if (!fromRepository.startsWith('..')) fail('STAGING_REPORT_DIR');
      if (!stat.isDirectory() || (stat.mode & 0o077) || stat.uid !== process.getuid()) fail('STAGING_REPORT_DIR');
      accessSync(env.STAGING_REPORT_DIR, constants.W_OK | constants.X_OK);
    } catch { fail('STAGING_REPORT_DIR'); }
  }
}

// Child stdout/stderr is never forwarded: parser/ORM failures can quote PII.
// Only the numeric summary produced by staging-import.ts may reach shared logs.
export function safeImportSummary(output) {
  let summary;
  try { summary = JSON.parse(output.trim()); } catch {
    throw new Error('Import summary is invalid; raw output withheld.');
  }
  const safe = value => {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0;
    return value && !Array.isArray(value) && typeof value === 'object'
      && Object.entries(value).every(([key, child]) => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) && safe(child));
  };
  const allowed = ['parsed', 'matrix', 'schedule'];
  if (!summary.parsed || Object.keys(summary).some(key => !allowed.includes(key)) || !safe(summary)) {
    throw new Error('Import summary is invalid; raw output withheld.');
  }
  return JSON.stringify(summary);
}

export async function runTool(args, env = process.env, execute = spawnSync) {
  const [command, option] = args;
  if (!['preflight', 'migrate', 'import', 'check-inputs'].includes(command)
    || args.length > 2 || (option && !(command === 'import' && option === '--dry-run'))) {
    throw new Error('Unsupported staging command. Use preflight, migrate, check-inputs or import [--dry-run].');
  }
  validateReleaseConfig(env);
  if (command === 'preflight') return 'Staging configuration valid.';
  if (command === 'import' || command === 'check-inputs') validateImportFiles(env);
  if (command === 'check-inputs') return 'Required inputs are readable by the import identity.';

  const childArgs = command === 'migrate'
    ? [resolve(root, 'apps/api/node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema=prisma/schema.prisma']
    : [resolve(root, 'apps/api/node_modules/tsx/dist/cli.mjs'), 'scripts/staging-import.ts', ...(option ? [option] : [])];
  const result = execute(process.execPath, childArgs, {
    cwd: resolve(root, 'apps/api'), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`${command === 'migrate' ? 'Migration' : 'Import'} failed. Raw output withheld; inspect in a protected operator session.`);
  return command === 'migrate' ? 'Migrations applied successfully.' : safeImportSummary(result.stdout);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTool(process.argv.slice(2)).then(message => console.log(message)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

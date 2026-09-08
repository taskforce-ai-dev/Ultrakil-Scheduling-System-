/** Trusted operator command, never a Vercel build step or public HTTP route. */
import { spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { safeImportSummary, validateImportFiles } from './staging-tool.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fail = key => { throw new Error(`Invalid operator import configuration: ${key}. Values are withheld.`); };

function validateTarget(env, apply) {
  // This command supports provider certificates chained to the operator's
  // public system CA roots, not custom roots or client-certificate endpoints.
  for (const key of ['SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
    'PGSSLROOTCERT', 'PGSSLCERT', 'PGSSLKEY', 'NODE_TLS_REJECT_UNAUTHORIZED']) {
    if (env[key]) fail('public-CA-only TLS');
  }
  try {
    const url = new URL(env.DATABASE_URL);
    const allowed = new Set(['sslmode', 'sslaccept', 'schema', 'connection_limit',
      'pool_timeout', 'connect_timeout', 'pgbouncer', 'statement_cache_size']);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname
      || !url.username || !url.password || url.hash || !/^\/[^/]+$/.test(url.pathname)
      || url.searchParams.get('sslmode') !== 'require' || url.searchParams.get('sslaccept') !== 'strict'
      || (url.searchParams.has('schema') && url.searchParams.get('schema') !== 'public')
      || [...url.searchParams.keys()].some(key => !allowed.has(key) || url.searchParams.getAll(key).length !== 1)) {
      fail('DATABASE_URL');
    }
    // The operator confirms the intended host, port and database separately;
    // credentials never appear in argv, diagnostics, or the returned evidence.
    if (env.ULTRAKIL_IMPORT_TARGET !== `${url.hostname}:${url.port || '5432'}${url.pathname}`) {
      fail('ULTRAKIL_IMPORT_TARGET');
    }
  } catch { fail('DATABASE_URL / ULTRAKIL_IMPORT_TARGET'); }
  if (apply) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.SEED_ADMIN_EMAIL ?? '')) fail('SEED_ADMIN_EMAIL');
    if (!env.SEED_ADMIN_NAME?.trim()) fail('SEED_ADMIN_NAME');
    const password = env.SEED_ADMIN_PASSWORD;
    if (!password || password.trim() !== password || password.length < 24
      || /replace-with|change-me|changeme|placeholder/i.test(password)) fail('SEED_ADMIN_PASSWORD');
  }
}

function externalPrivateFile(path) {
  try {
    if (!isAbsolute(path)) fail('absolute private input path');
    const operator = process.getuid?.();
    const stat = lstatSync(path);
    const parent = lstatSync(dirname(path));
    const fromRepository = relative(root, realpathSync(path));
    if (operator === undefined || operator === 0 || !stat.isFile() || !stat.size
      || stat.uid !== operator || (stat.mode & 0o777) !== 0o600
      || !parent.isDirectory() || parent.uid !== operator || (parent.mode & 0o777) !== 0o700
      || (fromRepository !== '..' && !fromRepository.startsWith(`..${sep}`))) fail('private input file');
  } catch { fail('private input file'); }
}

export async function runTool(args, env = process.env, execute = spawnSync) {
  if (args.length !== 1 || !['--dry-run', '--apply'].includes(args[0])) {
    throw new Error('Use --dry-run or --apply; an implicit import is refused.');
  }
  validateTarget(env, args[0] === '--apply');
  if (env.STAGING_REPORT_DIR && !isAbsolute(env.STAGING_REPORT_DIR)) fail('absolute report directory');
  validateImportFiles(env);
  for (const key of ['TECHNICIAN_MATRIX_PATH', 'MASTER_SCHEDULE_PATH']) externalPrivateFile(env[key]);
  if (env.MATRIX_MAPPING_PATH) externalPrivateFile(env.MATRIX_MAPPING_PATH);

  // Reuse the strict two-workbook parser/importer. It parses both inputs before
  // creating PrismaClient or seeding, and preserves existing admin credentials.
  // An absent mapping explicitly selects parser defaults, not a Docker mount.
  const childArgs = ['--import', 'tsx', resolve(root, 'apps/api/scripts/staging-import.ts'),
    ...(args[0] === '--dry-run' ? ['--dry-run'] : [])];
  let result;
  try {
    result = execute(process.execPath, childArgs, {
      cwd: resolve(root, 'apps/api'), env: { ...env, MATRIX_MAPPING_PATH: env.MATRIX_MAPPING_PATH ?? '' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
    });
  } catch { throw new Error('Operator import failed. Raw output withheld.'); }
  if (result.error || result.status !== 0) throw new Error('Operator import failed. Raw output withheld.');
  return safeImportSummary(result.stdout);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTool(process.argv.slice(2)).then(summary => console.log(summary)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

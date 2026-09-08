import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const tool = () => import('../vercel-import.mjs');
const summary = JSON.stringify({ parsed: { employees: 1, vehicles: 1, customers: 1, sites: 1, importableAgreements: 1 } });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ulk-vercel-import-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const matrix = join(directory, 'matrix.xlsx');
  const schedule = join(directory, 'schedule.xlsx');
  for (const path of [matrix, schedule]) writeFileSync(path, 'synthetic fixture', { mode: 0o600 });
  return { directory, env: {
    DATABASE_URL: 'postgresql://operator:private-password@db.example.test:6543/ultrakil_staging?sslmode=require&sslaccept=strict',
    TECHNICIAN_MATRIX_PATH: matrix, MASTER_SCHEDULE_PATH: schedule,
    SEED_ADMIN_EMAIL: 'admin@example.test', SEED_ADMIN_NAME: 'Pilot Administrator',
    SEED_ADMIN_PASSWORD: 'independent-admin-password-012345',
    ULTRAKIL_IMPORT_TARGET: 'db.example.test:6543/ultrakil_staging',
  } };
}

test('external PostgreSQL dry-run works without Docker PostgreSQL/Redis configuration', async t => {
  const { env } = fixture(t);
  const { runTool } = await tool();
  const result = await runTool(['--dry-run'], env, (_command, args, options) => {
    assert.ok(args.includes('--dry-run'));
    assert.equal(options.env.DATABASE_URL, env.DATABASE_URL);
    assert.equal(options.env.MATRIX_MAPPING_PATH, '');
    assert.equal(options.env.REDIS_PASSWORD, undefined);
    return { status: 0, stdout: summary, stderr: '' };
  });
  assert.equal(result, summary);
});

test('explicit apply passes the confirmed external target to the existing importer', async t => {
  const { env } = fixture(t);
  const { runTool } = await tool();
  assert.equal(await runTool(['--apply'], env, (_command, args, options) => {
    assert.ok(args.some(arg => arg.endsWith('scripts/staging-import.ts')));
    assert.ok(!args.includes('--dry-run'));
    assert.equal(options.env.DATABASE_URL, env.DATABASE_URL);
    return { status: 0, stdout: summary, stderr: '' };
  }), summary);
});

test('rejects implicit import, misspelled modes, and extra arguments before execution', async t => {
  const { env } = fixture(t);
  const { runTool } = await tool();
  for (const args of [[], ['import'], ['--dryrun'], ['--apply', '--dry-run']]) {
    await assert.rejects(runTool(args, env, () => assert.fail('must not execute')), /Use --dry-run or --apply/);
  }
});

test('requires a matching explicit target and a verified TLS PostgreSQL URL', async t => {
  const { env } = fixture(t);
  const { runTool } = await tool();
  for (const changed of [
    { DATABASE_URL: undefined }, { DATABASE_URL: 'https://private-password@example.test/db' },
    { DATABASE_URL: env.DATABASE_URL.replace('sslmode=require', 'sslmode=disable') },
    { DATABASE_URL: env.DATABASE_URL.replace('sslaccept=strict', 'sslaccept=accept_invalid_certs') },
    { DATABASE_URL: env.DATABASE_URL + '&sslmode=disable' },
    { ULTRAKIL_IMPORT_TARGET: undefined }, { ULTRAKIL_IMPORT_TARGET: 'db.example.test:6543/production' },
  ]) {
    await assert.rejects(runTool(['--apply'], { ...env, ...changed }, () => assert.fail('must not execute')),
      error => !error.message.includes('private-password') && /Invalid operator import configuration/.test(error.message));
  }
});

test('requires non-default initial administrator credentials only for apply', async t => {
  const { env } = fixture(t);
  const { runTool } = await tool();
  const execute = () => ({ status: 0, stdout: summary });
  assert.equal(await runTool(['--dry-run'], { ...env, SEED_ADMIN_PASSWORD: undefined }, execute), summary);
  for (const changed of [{ SEED_ADMIN_PASSWORD: undefined }, { SEED_ADMIN_PASSWORD: 'ultrakil-change-me' },
    { SEED_ADMIN_EMAIL: 'invalid' }, { SEED_ADMIN_NAME: '' }]) {
    await assert.rejects(runTool(['--apply'], { ...env, ...changed }, () => assert.fail('must not execute')),
      /Invalid operator import configuration/);
  }
});

test('rejects public inputs, missing mapping files, and private inputs inside the checkout', async t => {
  const { env } = fixture(t);
  const { runTool } = await tool();
  chmodSync(env.TECHNICIAN_MATRIX_PATH, 0o644);
  await assert.rejects(runTool(['--dry-run'], env), /Invalid/);
  chmodSync(env.TECHNICIAN_MATRIX_PATH, 0o600);
  await assert.rejects(runTool(['--dry-run'], { ...env, MATRIX_MAPPING_PATH: '/missing/ulk-mapping.json' }), /Invalid/);
  const inside = join(root, '..private-import-test-' + process.pid);
  writeFileSync(inside, '{}', { mode: 0o600 });
  t.after(() => rmSync(inside));
  await assert.rejects(runTool(['--dry-run'], { ...env, MATRIX_MAPPING_PATH: inside }), /Invalid/);
});

test('requires absolute paths so validation and the importer resolve the same private files', async t => {
  const { directory, env } = fixture(t);
  const { runTool } = await tool();
  const mapping = join(directory, 'mapping.json');
  writeFileSync(mapping, '{}', { mode: 0o600 });
  for (const changed of [{ MATRIX_MAPPING_PATH: relative(process.cwd(), mapping) },
    { STAGING_REPORT_DIR: relative(process.cwd(), directory) },
    { TECHNICIAN_MATRIX_PATH: relative(process.cwd(), env.TECHNICIAN_MATRIX_PATH) }]) {
    await assert.rejects(runTool(['--dry-run'], { ...env, ...changed }, () => assert.fail('must not execute')), /Invalid/);
  }
});

test('forwards only a validated external mapping and private report directory', async t => {
  const { directory, env } = fixture(t);
  const { runTool } = await tool();
  const mapping = join(directory, 'mapping.json');
  writeFileSync(mapping, '{}', { mode: 0o600 });
  const configured = { ...env, MATRIX_MAPPING_PATH: mapping, STAGING_REPORT_DIR: directory };
  assert.equal(await runTool(['--dry-run'], configured, (_command, _args, options) => {
    assert.equal(options.env.MATRIX_MAPPING_PATH, mapping);
    assert.equal(options.env.STAGING_REPORT_DIR, directory);
    return { status: 0, stdout: summary };
  }), summary);
});

test('withholds child errors and rejects source text in successful output', async t => {
  const { env } = fixture(t);
  const { runTool } = await tool();
  for (const result of [{ status: 1, stderr: 'PRIVATE CUSTOMER private-password' },
    { status: 0, stdout: JSON.stringify({ parsed: { customer: 'PRIVATE CUSTOMER' } }) }]) {
    await assert.rejects(runTool(['--dry-run'], env, () => result), error => !/PRIVATE|private-password/.test(error.message));
  }
});

test('actual CLI dry-runs synthetic workbooks without database access or private report output', async t => {
  const { directory, env } = fixture(t);
  const require = createRequire(resolve(root, 'apps/api/package.json'));
  const ExcelJS = require('exceljs');
  const matrix = new ExcelJS.Workbook();
  matrix.addWorksheet('Matrix').addRows([
    ['', '', '', '', '', 'Company'],
    ['', 'No.', 'Name Of Technician', 'Station Location', 'Designation', 'Van( 04 People) CAB-1234'],
    ['Colombo Branch', '1', 'PRIVATE TECHNICIAN', '', 'PMS', '✓'],
  ]);
  await matrix.xlsx.writeFile(env.TECHNICIAN_MATRIX_PATH);
  const schedule = new ExcelJS.Workbook();
  schedule.addWorksheet('Main').addRows([
    ['Title'], ['', 'Client', '', 'Location', 'Treatment', 'Frequency', 'Day'],
    ['', 'PRIVATE CUSTOMER', '', 'PRIVATE SITE Colombo', 'GPC', 'Monthly', 'Monday'],
  ]);
  await schedule.xlsx.writeFile(env.MASTER_SCHEDULE_PATH);
  const result = spawnSync(process.execPath, [resolve(root, 'deploy/vercel-import.mjs'), '--dry-run'], {
    env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, `strict external-database dry-run must succeed: ${result.stderr}`);
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /PRIVATE|private-password/);
  assert.equal(JSON.parse(result.stdout).parsed.importableAgreements, 1);
  const { readdirSync } = await import('node:fs');
  assert.deepEqual(readdirSync(directory).sort(), ['matrix.xlsx', 'schedule.xlsx']);
});

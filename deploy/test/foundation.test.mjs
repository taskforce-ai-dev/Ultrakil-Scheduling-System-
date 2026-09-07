import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { privatePathReason } from '../../scripts/check-private-files.mjs';
import { validateReleaseConfig, validateImportFiles, runTool, safeImportSummary } from '../staging-tool.mjs';

const root = resolve(import.meta.dirname, '../..');
const valid = () => ({
  POSTGRES_USER: 'ultrakil', POSTGRES_DB: 'ultrakil_staging',
  POSTGRES_PASSWORD: 'db-value-with-entropy-123456789',
  DATABASE_URL: 'postgresql://ultrakil:db-value-with-entropy-123456789@postgres:5432/ultrakil_staging?schema=public',
  REDIS_PASSWORD: 'redis-value-with-entropy-123456789', JWT_SECRET: 'jwt-value-with-entropy-123456789012345',
  SEED_ADMIN_EMAIL: 'pilot@example.test', SEED_ADMIN_PASSWORD: 'admin-value-with-entropy-123456789',
  SEED_ADMIN_NAME: 'Pilot Administrator',
  NEXT_PUBLIC_API_BASE_URL: 'http://localhost:3001/api', API_CORS_ORIGINS: 'http://localhost:3000',
});

test('private paths are rejected at every depth while explicit examples remain allowed', () => {
  for (const path of ['.env', 'apps/api/.env.production', 'deploy/staging.env', 'deploy/staging.env.bak',
    'deploy/staging.local.env', 'incoming/Workbook.XLSX', 'nested/data/matrix-mapping.json',
    'data/job-types.json', 'data/master-schedule-import-report.json', 'deploy/reports/issues.json',
    'private/a.json', '..private/import-run/issues.json', 'nested/..private/report.json',
    'backups/archive.sql.gz', 'snapshot.dump', 'dump.sql.gz']) {
    assert.ok(privatePathReason(path), path);
  }
  for (const path of ['.env.example', 'deploy/staging.env.example', 'data/matrix-mapping.example.json',
    'apps/api/prisma/migrations/20260420_init/migration.sql', 'deploy/test/foundation.test.mjs']) {
    assert.equal(privatePathReason(path), null, path);
  }
});

test('git ignores runtime env variants and private inputs, but tracks templates', () => {
  const paths = ['deploy/staging.env', 'deploy/staging.env.bak', 'deploy/staging.local.env',
    'incoming/nested/workbook.xlsx', 'private/issues.json', 'deploy/reports/detail.json'];
  for (const path of paths) {
    const result = spawnSync('git', ['check-ignore', '--no-index', '-q', path], { cwd: root });
    assert.equal(result.status, 0, path);
  }
  assert.equal(spawnSync('git', ['check-ignore', '--no-index', '-q', 'deploy/staging.env.example'], { cwd: root }).status, 1);
});

test('preflight accepts loopback development URLs or HTTPS staging URLs', () => {
  assert.doesNotThrow(() => validateReleaseConfig(valid()));
  assert.doesNotThrow(() => validateReleaseConfig({ ...valid(),
    NEXT_PUBLIC_API_BASE_URL: 'https://api.pilot.example.test/api', API_CORS_ORIGINS: 'https://pilot.example.test' }));
});

test('preflight rejects missing/default secrets without echoing values', () => {
  for (const key of ['POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'JWT_SECRET', 'SEED_ADMIN_PASSWORD']) {
    for (const value of ['', 'replace-with-long-random-credentials-12345', 'ultrakil-change-me', 'short']) {
      assert.throws(() => validateReleaseConfig({ ...valid(), [key]: value }), error => {
        assert.ok(error.message.includes(key));
        if (value) assert.ok(!error.message.includes(value));
        return true;
      });
    }
  }
});

test('preflight requires independent secrets and matching database coordinates', () => {
  const env = valid();
  assert.throws(() => validateReleaseConfig({ ...env, REDIS_PASSWORD: env.POSTGRES_PASSWORD }));
  for (const url of [env.DATABASE_URL.replace('@postgres', '@unrelated'), env.DATABASE_URL.replace('5432', '5433'),
    env.DATABASE_URL.replace('ultrakil_staging', 'other'), env.DATABASE_URL.replace('db-value', 'wrong-value'),
    'not-a-url', `${env.DATABASE_URL}&host=unrelated`, env.DATABASE_URL.replace('schema=public', 'schema=private')]) {
    assert.throws(() => validateReleaseConfig({ ...env, DATABASE_URL: url }), /DATABASE_URL/);
  }
});

test('preflight rejects public HTTP URLs, URL credentials and wildcard CORS', () => {
  for (const value of ['http://staging.example.test/api', 'https://user:pass@staging.example.test/api', 'https://staging.example.test/']) {
    assert.throws(() => validateReleaseConfig({ ...valid(), NEXT_PUBLIC_API_BASE_URL: value }));
  }
  for (const value of ['*', 'http://staging.example.test', 'https://staging.example.test/path']) {
    assert.throws(() => validateReleaseConfig({ ...valid(), API_CORS_ORIGINS: value }));
  }
});

test('import preflight requires both readable, nonempty regular files and a private report directory', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'ulk-import-test-'));
  try {
    const env = { TECHNICIAN_MATRIX_PATH: resolve(dir, 'matrix.xlsx'), MASTER_SCHEDULE_PATH: resolve(dir, 'schedule.xlsx'), STAGING_REPORT_DIR: resolve(dir, 'reports') };
    mkdirSync(env.STAGING_REPORT_DIR, { mode: 0o700 });
    assert.throws(() => validateImportFiles(env), /TECHNICIAN_MATRIX_PATH/);
    writeFileSync(env.TECHNICIAN_MATRIX_PATH, 'synthetic', { mode: 0o600 });
    assert.throws(() => validateImportFiles(env), /MASTER_SCHEDULE_PATH/);
    writeFileSync(env.MASTER_SCHEDULE_PATH, '', { mode: 0o600 });
    assert.throws(() => validateImportFiles(env), /MASTER_SCHEDULE_PATH/);
    writeFileSync(env.MASTER_SCHEDULE_PATH, 'synthetic', { mode: 0o600 });
    assert.doesNotThrow(() => validateImportFiles(env));
    assert.throws(() => validateImportFiles({ ...env, MASTER_SCHEDULE_PATH: dir }));
    chmodSync(env.STAGING_REPORT_DIR, 0o755);
    assert.throws(() => validateImportFiles(env), /STAGING_REPORT_DIR/);
    chmodSync(env.STAGING_REPORT_DIR, 0o700);
    chmodSync(env.MASTER_SCHEDULE_PATH, 0o644);
    assert.throws(() => validateImportFiles(env), /MASTER_SCHEDULE_PATH/);
    const alias = resolve(dir, 'alias.xlsx');
    symlinkSync(env.TECHNICIAN_MATRIX_PATH, alias);
    assert.throws(() => validateImportFiles({ ...env, TECHNICIAN_MATRIX_PATH: alias }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tool rejects unsupported commands before invoking anything', async () => {
  let called = false;
  await assert.rejects(runTool(['db:reset'], valid(), () => { called = true; }), /command/);
  assert.equal(called, false);
});

test('report preflight rejects a repository child whose name begins with two dots', () => {
  const inputs = mkdtempSync(resolve(tmpdir(), 'ulk-input-test-'));
  const reportDirectory = mkdtempSync(resolve(root, '..private-test-'));
  try {
    const env = {
      TECHNICIAN_MATRIX_PATH: resolve(inputs, 'matrix.xlsx'), MASTER_SCHEDULE_PATH: resolve(inputs, 'schedule.xlsx'),
      STAGING_REPORT_DIR: reportDirectory,
    };
    writeFileSync(env.TECHNICIAN_MATRIX_PATH, 'synthetic', { mode: 0o600 });
    writeFileSync(env.MASTER_SCHEDULE_PATH, 'synthetic', { mode: 0o600 });
    assert.throws(() => validateImportFiles(env), /STAGING_REPORT_DIR/);
    assert.deepEqual(readdirSync(reportDirectory), []);
  } finally {
    rmSync(reportDirectory, { recursive: true, force: true });
    rmSync(inputs, { recursive: true, force: true });
  }
});

test('failed migration preserves failure without exposing child secret output', async () => {
  await assert.rejects(runTool(['migrate'], valid(), () => ({ status: 1, stderr: valid().POSTGRES_PASSWORD })), error => {
    assert.match(error.message, /Migration failed/);
    assert.ok(!error.message.includes(valid().POSTGRES_PASSWORD));
    return true;
  });
});

test('import summary rejects raw names or error messages', () => {
  assert.equal(safeImportSummary('{"parsed":{"employees":37,"issues":{"ROW_SKIPPED":1}}}'), '{"parsed":{"employees":37,"issues":{"ROW_SKIPPED":1}}}');
  for (const output of ['private raw log', '{"parsed":{"employees":"PRIVATE NAME"}}', '{"error":"PRIVATE NAME"}']) {
    assert.throws(() => safeImportSummary(output), error => {
      assert.ok(!error.message.includes('PRIVATE'));
      assert.ok(!error.message.includes('private raw log'));
      return true;
    });
  }
});

test('secret scan runs against this tracked tree', () => {
  execFileSync(process.execPath, ['scripts/check-private-files.mjs'], { cwd: root });
});

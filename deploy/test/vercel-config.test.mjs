import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), 'utf8'));
}

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

test('declares three independent Vercel project configurations', () => {
  const projects = [
    ['apps/manager-web/vercel.json', 'apps/manager-web'],
    ['apps/api/vercel.json', 'apps/api'],
    ['services/scheduler/vercel.json', 'services/scheduler'],
  ];

  for (const [configPath, rootDirectory] of projects) {
    const config = readJson(configPath);
    assert.equal(config.$schema, 'https://openapi.vercel.sh/vercel.json');
    const projectRoot = resolve(root, rootDirectory);
    assert.equal(statSync(projectRoot).isDirectory(), true);
    assert.equal(existsSync(resolve(projectRoot, 'package.json')) || rootDirectory === 'services/scheduler', true);
  }
});

test('uses the current Nest and FastAPI entrypoints with a Hobby-safe duration', () => {
  const api = readJson('apps/api/vercel.json');
  const scheduler = readJson('services/scheduler/vercel.json');

  assert.equal(api.functions['src/main.ts'].maxDuration, 60);
  assert.equal(scheduler.functions['app/main.py'].maxDuration, 60);
  assert.equal(api.buildCommand, 'pnpm prisma:generate && pnpm build');
  assert.match(read('apps/api/src/main.ts'), /NestFactory/);
  assert.match(read('services/scheduler/app/main.py'), /app = FastAPI\(/);
});

test('declares scheduler runtime dependencies for Vercel Python builds', () => {
  const pyproject = read('services/scheduler/pyproject.toml');

  assert.match(pyproject, /dependencies\s*=\s*\[/);
  for (const dependency of ['fastapi', 'ortools', 'uvicorn', 'pydantic', 'pydantic-settings']) {
    assert.match(pyproject, new RegExp(`^\\s*"${dependency}[^\\n]*"`, 'm'));
  }
  for (const developmentOnly of ['pytest', 'httpx', 'ruff']) {
    assert.doesNotMatch(pyproject, new RegExp(`^\\s*"${developmentOnly}[^\\n]*"`, 'm'));
  }
});

test('keeps the manager build explicit for the monorepo package', () => {
  const manager = readJson('apps/manager-web/vercel.json');

  assert.equal(manager.framework, 'nextjs');
  assert.equal(manager.buildCommand, 'pnpm build');
  assert.equal(manager.installCommand, 'pnpm install --frozen-lockfile');
});

test('documents stable environment URLs and non-secret Vercel setup', () => {
  const env = read('deploy/vercel.env.example');

  assert.match(env, /^NEXT_PUBLIC_API_BASE_URL=https:\/\/YOUR_API_ENVIRONMENT_DOMAIN\.vercel\.app\/api$/m);
  assert.match(env, /^API_CORS_ORIGINS=https:\/\/YOUR_MANAGER_ENVIRONMENT_DOMAIN\.vercel\.app$/m);
  assert.match(env, /^SCHEDULER_BASE_URL=https:\/\/YOUR_SCHEDULER_ENVIRONMENT_DOMAIN\.vercel\.app$/m);
  assert.match(env, /^SCHEDULER_API_TOKEN=$/m);
  assert.doesNotMatch(env, /^SCHEDULER_ALLOW_UNAUTHENTICATED=/m);
  assert.doesNotMatch(env, /postgres(?:ql)?:\/\/[^\s]+:[^\s@]+@/i);
});

test('protects a publicly deployed scheduler solve route', () => {
  const scheduler = read('services/scheduler/app/main.py');
  const client = read('apps/api/src/scheduling/optimizer/scheduler.client.ts');

  assert.match(scheduler, /HTTPBearer/);
  assert.match(scheduler, /compare_digest/);
  assert.match(scheduler, /Depends\(_require_scheduler_token\)/);
  assert.match(client, /Authorization/);
  assert.match(client, /scheduler\.apiToken/);
});

test('explains branch-based staging, production, QStash and preserved Docker', () => {
  const docs = read('docs/VERCEL_DEPLOYMENT.md');

  assert.match(docs, /apps\/manager-web/);
  assert.match(docs, /apps\/api/);
  assert.match(docs, /services\/scheduler/);
  assert.match(docs, /Preview/);
  assert.match(docs, /Production/);
  assert.match(docs, /long-lived `staging` Git branch/);
  assert.match(docs, /branch-specific Preview variables/);
  assert.match(docs, /SCHEDULE_DISPATCHER=qstash/);
  assert.match(docs, /db:deploy/);
  assert.doesNotMatch(docs, /Neon supplies/);
  assert.doesNotMatch(docs, /managed Redis/);
  assert.match(read('docs/VERCEL_RELEASE_CHECKLIST.md'), /Production/);
  assert.match(read('docs/VERCEL_RELEASE_CHECKLIST.md'), /staging/);
  assert.match(read('deploy/vercel.env.example'), /SCHEDULE_DISPATCHER=qstash/);
  assert.doesNotMatch(read('docs/C08_RELEASE_CHECKLIST.md'), /Current deployment target: Vercel/);
  assert.match(docs, /Docker\/Compose/);
  assert.match(docs, /No PostgreSQL service has been selected yet/);
});

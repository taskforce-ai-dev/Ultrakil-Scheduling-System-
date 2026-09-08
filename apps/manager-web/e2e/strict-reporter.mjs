import { dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renameSync, writeFileSync } from 'node:fs';
import { assertStrictResults } from './strict-results.mjs';

const REPORTER_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const STRICT_SOURCE_FILES = new Set([
  '01-customer-and-agreement.spec.ts',
  '02-generation.spec.ts',
  '03-dispatch-and-lock.spec.ts',
  '04-publish.spec.ts',
  '05-accessibility.spec.ts',
  '06-responsive.spec.ts',
  '07-vehicle-drivers-and-inactive-clients.spec.ts',
  'auth.setup.ts',
]);
const RESULT_STATUSES = new Set(['passed', 'failed', 'skipped', 'timedOut', 'interrupted']);
const COUNT_KEYS = ['passed', 'failed', 'skipped', 'timedOut', 'interrupted', 'notRun', 'unexpected'];

function normalizedResultStatus(test) {
  if (test.expectedStatus !== 'passed') return 'unexpected';
  const result = test.results.at(-1);
  if (!result) return 'notRun';
  return RESULT_STATUSES.has(result.status) ? result.status : 'failed';
}

function failureLocation(test) {
  const result = test.results.at(-1);
  return safeLocation(result?.error?.location) ?? safeLocation(test.location);
}

function safeLocation(location) {
  if (!location || typeof location.file !== 'string' || !Number.isSafeInteger(location.line) || location.line < 1) return null;
  const file = resolve(location.file);
  const name = basename(file);
  if (dirname(file) !== REPORTER_DIRECTORY || !STRICT_SOURCE_FILES.has(name)) return null;
  return { file: name, line: location.line };
}

function normalizedRunStatus(status) {
  if (status === 'timedout') return 'timedOut';
  return RESULT_STATUSES.has(status) && status !== 'skipped' ? status : 'failed';
}

export function buildStrictDiagnostic(tests, runStatus) {
  const counts = Object.fromEntries(COUNT_KEYS.map(key => [key, 0]));
  const failures = [];
  for (const test of tests) {
    const status = normalizedResultStatus(test);
    counts[status] += 1;
    if (status !== 'passed') {
      const location = failureLocation(test);
      if (location) failures.push({ ...location, status });
    }
  }
  let strictPassed = false;
  try {
    assertStrictResults(tests);
    strictPassed = true;
  } catch {
    // The policy error may contain implementation detail. Only its normalized outcome is exported.
  }
  const status = normalizedRunStatus(runStatus);
  return {
    status: strictPassed && status === 'passed' ? 'passed' : status === 'passed' ? 'failed' : status,
    counts: { total: tests.length, ...counts },
    failures,
  };
}

export function writeStrictDiagnostic(path, diagnostic) {
  if (typeof path !== 'string' || !path) return;
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(diagnostic), { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

export default class StrictReporter {
  onBegin(_config, suite) { this.suite = suite; }
  onEnd(result) {
    if (process.argv.includes('--list')) return;
    const diagnostic = buildStrictDiagnostic(this.suite?.allTests() ?? [], result.status);
    try {
      writeStrictDiagnostic(process.env.E2E_STRICT_DIAGNOSTIC_FILE, diagnostic);
    } catch {
      // The rehearsal prewrites a safe unavailable result for this path.
    }
    if (diagnostic.status !== 'passed') {
      return { status: 'failed' };
    }
  }
}

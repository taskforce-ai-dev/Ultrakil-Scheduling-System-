#!/usr/bin/env node
/**
 * Starts the Python scheduling service using its own virtual environment.
 *
 * The obvious script — `cd services/scheduler && uvicorn ...` — only works if
 * you remembered to activate the venv first, and fails with a bare
 * "'uvicorn' is not recognized" that says nothing about why. Worse, if a
 * *different* venv happens to be active, it silently runs against the wrong
 * interpreter.
 *
 * This resolves the interpreter explicitly, so `pnpm dev:scheduler` works from
 * any shell with nothing activated, and says exactly what to do when the
 * environment is missing.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serviceDir = join(repoRoot, 'services', 'scheduler');
const isWindows = process.platform === 'win32';

const venvPython = isWindows
  ? join(serviceDir, '.venv', 'Scripts', 'python.exe')
  : join(serviceDir, '.venv', 'bin', 'python');

if (!existsSync(venvPython)) {
  const create = isWindows
    ? 'py -3.11 -m venv .venv\n  .venv\\Scripts\\activate'
    : 'python3.11 -m venv .venv\n  source .venv/bin/activate';

  process.stderr.write(
    [
      '',
      `The scheduler virtual environment is missing: ${venvPython}`,
      '',
      'Create it with Python 3.11 (not 3.14 — see services/scheduler/requirements.txt):',
      '',
      '  cd services/scheduler',
      `  ${create}`,
      '  pip install -r requirements.txt -r requirements-dev.txt',
      '  cd ../..',
      '',
      'Then run `pnpm dev:scheduler` again.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

const port = process.env.SCHEDULER_PORT || '8000';

// Spawning the interpreter directly (an .exe on Windows) means no shell is
// needed, and `python -m uvicorn` avoids depending on the console script
// being on PATH.
const child = spawn(
  venvPython,
  ['-m', 'uvicorn', 'app.main:app', '--reload', '--port', port],
  { cwd: serviceDir, stdio: 'inherit' },
);

child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
child.on('error', (error) => {
  process.stderr.write(`Failed to start the scheduler: ${error.message}\n`);
  process.exit(1);
});

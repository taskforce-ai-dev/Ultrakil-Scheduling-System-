import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const examples = new Set(['.env.example', 'deploy/staging.env.example',
  'data/matrix-mapping.example.json', 'data/job-types.example.json']);

export function privatePathReason(path) {
  if (examples.has(path)) return null;
  if (/(^|\/)\.\.[^/]+(\/|$)/.test(path)) return 'ambiguous private path';
  if (/(^|\/)\.env($|\.)|\.env($|\.)/i.test(path)) return 'runtime environment';
  if (/\.(xlsx?|xlsm|csv)$/i.test(path)) return 'private workbook/data';
  if (/(^|\/)(matrix-mapping|job-types)\.json$/i.test(path)) return 'private mapping';
  if (/(^|\/)(incoming|private|reports|backups|import-reports|export-work|export-secrets)(\/|$)/i.test(path)
    || /import-report[^/]*\.json$/i.test(path)) return 'private report or backup';
  if (/\.(sql\.(gz|xz|zip)|dump|backup|bak|pgdump|pem|key|age)$/i.test(path)) return 'backup or key';
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const rejected = paths.filter(path => privatePathReason(path));
  if (rejected.length) {
    // Paths themselves can include client names. Review them in a private shell.
    console.error(`Private-file scan failed: ${rejected.length} prohibited tracked path(s). Inspect locally and rotate any exposed credentials.`);
    process.exitCode = 1;
  } else console.log('Private-file scan passed.');
}

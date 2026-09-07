// Cover every privatePathReason category in lower, upper and mixed case. These
// fabricated paths are shared by the scanner and real Docker context checks.
const categoryPaths = [
  '.env', 'nested/.env.production', 'deploy/staging.env', 'nested/staging.env.bak',
  'data/workbook.xls', 'workbook.xlsx', 'nested/workbook.xlsm', 'nested/data.csv',
  'matrix-mapping.json', 'deploy/matrix-mapping.json', 'job-types.json', 'nested/job-types.json',
  'incoming/fixture.txt', 'private/fixture.txt', 'nested/reports/fixture.txt',
  'backups/fixture.txt', 'nested/import-reports/fixture.txt',
  'export-secrets/ssh-key', 'nested/export-work/bundle.tar', 'backup.tar.age',
  'nested/master-schedule-import-report.json', 'nested/import-report-details.json',
  'archive.sql.gz', 'nested/archive.sql.xz', 'archive.sql.zip', 'snapshot.dump',
  'nested/snapshot.backup', 'snapshot.bak', 'nested/snapshot.pgdump', 'credential.pem', 'nested/credential.key',
  '..private/fixture.txt', 'nested/..private/fixture.txt',
];

const mixedCase = path => [...path].map((character, index) => index % 2 ? character.toUpperCase() : character).join('');
export const privatePathFixtures = [...new Set(categoryPaths.flatMap(path => [path, path.toUpperCase(), mixedCase(path)]))];
export const publicPathFixtures = ['app/main.py', 'app/solver/model.py', 'requirements.txt', 'package.json',
  'apps/api/src/main.ts', 'apps/manager-web/src/app/page.tsx', 'packages/api-contracts/src/index.ts',
  'deploy/staging-tool.mjs', 'data/matrix-mapping.example.json', 'data/job-types.example.json'];

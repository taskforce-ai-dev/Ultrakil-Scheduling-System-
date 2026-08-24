# `data/` — local input files

This folder holds the source workbooks the seed importer reads. **Nothing real
in here is committed.** `.gitignore` blocks `*.xlsx`, `*.xls` and `*.csv`, and CI
fails the build if a real workbook is ever tracked.

## Why it is not committed

The technician matrix contains real staff names and grades. It is operational
personnel data, so it lives on each developer's machine and on the server, never
in git history.

## Files

| File | Committed? | Purpose |
| --- | --- | --- |
| `technician-matrix.xlsx` | No | The real UltraKIL workforce matrix. Ask the Project Lead for the current copy. |
| `matrix-mapping.json` | No (optional) | Overrides the importer's column mapping when the workbook's headers differ from the defaults. |
| `job-types.json` | No (optional) | Job type reference data taken from the signed proposal. |

## Setting it up

1. Copy the current `Technician Matrix.xlsx` into this folder and rename it to
   `technician-matrix.xlsx`, or point `TECHNICIAN_MATRIX_PATH` in your `.env` at
   wherever you keep it.
2. Preview what the importer will do, without writing to the database:

   ```bash
   pnpm --filter @ultrakil/api db:seed -- --dry-run
   ```

   The dry run prints every column it recognised, every column it treated as a
   vehicle, and every row it refused to guess at.

3. When the preview looks right, run the real import:

   ```bash
   pnpm db:seed
   ```

The import is idempotent — running it twice produces no duplicate employees and
no duplicate vehicle authorizations.

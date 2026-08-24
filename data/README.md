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
| `matrix-mapping.json` | No | Column mapping overrides, and the branch for each permanently stationed site. Start from `matrix-mapping.example.json`. |
| `matrix-mapping.example.json` | Yes | Template for the above, with comments. |
| `job-types.json` | No (optional) | Job type reference data taken from the signed proposal. |

## Two things the workbook does not say

The importer reports these rather than guessing, because a wrong guess here
becomes a wrong crew on a real job.

**1. Which branch a permanently stationed employee belongs to.** Rows under
*"Station Technicians at Serveral Location at permanen"* give a site — AuseeOats,
Wattura resort, Jetwin Blue/Beach, Maththala Airport, Lion Brewery, Logipark
International — but never a branch. Staff may only serve their own branch, so
the importer will not infer one. Map each site in `matrix-mapping.json` (see
`matrix-mapping.example.json`); any site left unmapped is reported and skipped.

**2. Whether every designation is a PMS grade.** The rule names Senior PMS, PMS,
Assistant PMS, SPMS and APMS. The workbook also contains *"Pest Management
Executive"*, which is not on that list, so it is currently treated as
**non-supervisory**. If that person should be able to supervise a job, say so
and it gets added — but promoting an unrecognised grade automatically would let
a job pass the PMS-supervisor rule without a real supervisor on the crew.

Every run lists the designations it did not count as PMS grades, so this stays
visible rather than buried.

## Setting it up

1. Copy the current `Technician Matrix.xlsx` into this folder and rename it to
   `technician-matrix.xlsx`, or point `TECHNICIAN_MATRIX_PATH` in your `.env` at
   wherever you keep it.
2. Check how the workbook is being read, before parsing anything:

   ```bash
   pnpm db:seed -- --inspect
   ```

   Prints the sheet names, the grid size, and the first twelve rows with their
   column indices. Use this when a column has moved or been renamed.

3. Preview what the importer will do, without writing to the database:

   ```bash
   pnpm db:seed -- --dry-run
   ```

   The dry run prints the header row it found, every column it treated as a
   skill, every vehicle with its seat capacity, employee counts per branch, the
   designations it did not count as PMS grades, and every row it refused to
   guess at.

4. When the preview looks right, run the real import:

   ```bash
   pnpm db:seed
   ```

The import is idempotent — running it twice produces no duplicate employees and
no duplicate vehicle authorizations.

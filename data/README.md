# `data/` — local input files

This folder holds the source workbooks the seed importer reads. **Nothing real
in here is committed.** `.gitignore` blocks `*.xlsx`, `*.xls` and `*.csv`, and CI
fails the build if a real workbook is ever tracked.

## No copy of the matrix?

You do not need one to work on the app. Run `pnpm db:seed:demo` for a
fabricated workforce — fourteen invented employees across both branches, with
supervisors, stationed staff, vehicles and authorizations. It refuses to run
against a database holding real imported staff, so it cannot overwrite this
folder's data by accident.

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

## Two things the workbook does not say — both now answered

The workbook leaves two questions open. The importer never guesses at either;
it reports them. Both were confirmed with UltraKIL on **24 August 2026** and the
answers are built into the defaults, so no configuration is needed for the
current matrix.

**1. Which branch a permanently stationed employee belongs to.** Rows under
*"Station Technicians at Serveral Location at permanen"* give a site but never a
branch. **Confirmed: all of them are Colombo.** These sites are built in:

| Site | Branch |
| --- | --- |
| AuseeOats | COLOMBO |
| Wattura resort | COLOMBO |
| Jetwin Blue/Beach | COLOMBO |
| Maththala Airport | COLOMBO |
| Lion Brewery | COLOMBO |
| Logipark International | COLOMBO |

A **new** site added to the workbook is still reported and skipped until someone
confirms its branch — staff may only serve their own branch, and a wrong guess
puts the wrong crew on a real job. Add new sites to `permanentSiteBranches` in
`matrix-mapping.json`, or to the defaults in
`apps/api/src/workforce/matrix-import/mapping.ts`.

**2. Whether every designation is a PMS grade.** The rules name Senior PMS, PMS,
Assistant PMS, SPMS and APMS. The workbook also contains *"Pest Management
Executive"*. **Confirmed: the executive is not a PMS grade** — a crew still needs
one of the five above, and the executive does not satisfy that requirement.

The workbook's own spellings are recognised, including its typo:

| In the workbook | Counted as PMS? |
| --- | --- |
| `Senoir PMS` *(the workbook's spelling)* | ✅ yes |
| `Pest Management Supervisor(PMS)` | ✅ yes |
| `Assistant PMS`, `SPMS`, `APMS` | ✅ yes |
| `Pest Management Executive` | ❌ no |
| `Senior/Junior Pest Management Teschnician`, `PMT`, `JPMT`, `JPMT-New` | ❌ no |

Every run still lists the designations it did not count, so a grade added to the
workbook later cannot slip through unnoticed.

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

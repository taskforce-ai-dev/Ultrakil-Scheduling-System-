# ULK-O08 — Known limitations

Compiled from the O08 UAT pass. Grouped by what a manager needs to know
before/during the pilot, versus what's tracked as an engineering follow-up.

## Explicitly Phase 2 (not built, by design)

Per the project's own rules, these are intentionally out of scope for
Phase 1 and are **not bugs**:

- **PMS tablet view** for supervisors in the field.
- **Worker mobile app** for technicians.
- **Push notifications.**

The Phase 1 data model is kept compatible with adding these later, but
there is no UI for any of them today.

## Release-relevant findings from this UAT pass

1. **[New, live production defect] Assignment save fails on the deployed
   API — Prisma interactive-transaction timeout.** Found during the
   deployed real-data pass, 2026-09-09: `PUT /api/visits/{id}/assignment`
   returns `500 INTERNAL_ERROR` on every attempt (reproduced 3/3,
   09:20:48–09:21:43 UTC), each attempt slower than the last (5300ms →
   5328ms → 8847ms), all over the transaction's 5000ms budget. Root cause
   in the Vercel runtime logs:
   ```
   PrismaClientKnownRequestError: Transaction API error: Transaction already
   closed: ... The timeout for this transaction was 5000 ms, however 8847 ms
   passed since the start of the transaction.
   ```
   at `apps/api/src/scheduling/eligibility/assignments.service.js:93`,
   inside the transaction opened at line 74 (`AssignmentsService.assign`).
   **Blocks every O08/O09 scenario that saves a new or changed
   assignment** — reopen/save, driver removal/revalidation included.
   Reported to the API owner (Thivarrakesh) with this trace, ~09:22 UTC.
   Full detail in `uat/ULK-O08-uat-results.md`, "Deployed real-data UAT
   pass," scenario 1. **This is release-blocking** — O08 cannot be marked
   complete while this stands.

2. **[Fixed on current main, partially confirmed on deployed real data]
   Re-opening an already-assigned visit could show false "double-booked"
   errors against itself.** This is a **historical local-UAT finding**, not
   a current defect: during the local UAT pass, re-opening a just-saved
   visit's "Edit crew" drawer — with no changes made — showed
   `EMPLOYEE_DOUBLE_BOOKED` / `VEHICLE_DOUBLE_BOOKED` errors comparing the
   visit's own saved assignment against itself, and disabled Save. Root
   cause was the eligibility check not excluding the visit's own current
   assignment from its own overlap query. **Current `main` already fixes
   this** — `AssignmentsService.check()` now passes the visit's existing
   draft assignment as `excludeAssignmentId` into the eligibility service
   (`apps/api/src/scheduling/eligibility/assignments.service.ts`,
   `eligibility.service.ts`), tracing back to the ULK-C07 baseline. See
   `uat/ULK-O08-uat-results.md` for the original repro and the fix
   verification.
   **Deployed real-data pass, 2026-09-09:** re-opening an already-published
   visit showed no false self-overlap error — but the Validation panel
   never actually ran (blocked earlier by the visit's publish-lock), so
   this isn't a clean confirmation. A full save-then-reopen cycle on a
   fresh manual assignment was attempted to get a clean test, but couldn't
   complete because of defect #1 above (Save itself fails). **Before pilot
   sign-off:** once #1 is fixed, re-run reopen/save on a freshly-saved
   (non-published) assignment and capture a clean "no false conflict"
   screenshot (see #9 below for why the old screenshots can't be reused).

3. **Local pass used fabricated demo data; a deployed real-data pass has
   since covered part of this.** Per `data/README.md`, the real workbooks
   (`technician-matrix.xlsx`, `master-schedule-2026.xlsx`) contain real
   personnel/customer data and are never committed to the repository, so
   the local pass used `pnpm db:seed:demo`'s 14 fabricated employees and 3
   fabricated customers. Every rule in this document has been proven to
   work mechanically against demo data. **Update, 2026-09-09:** a deployed
   pass against `https://ultrakil-manager-web.vercel.app` with the actual
   imported workbook data has since confirmed DAC-2485 (see #12 below) and
   unauthorized-driver rejection directly; reopen/save, inactive records,
   and the Kandy-no-PMS-supervisor scenario remain unconfirmed against real
   data (see #1 and #13).

4. **Demo-seeded vehicles ship with no branch assigned**
   (`pnpm db:seed:demo` leaves every vehicle's branch null), so the
   assignment editor's vehicle picker — which filters by the visit's branch
   — offers nothing until a vehicle has a branch. Worked around locally for
   this UAT pass via direct database updates (not a code or seed-script
   change). Worth a demo-seed follow-up so a fresh demo environment can
   exercise vehicle assignment without a manual fix.

5. **No inactive customer/site existed in demo data.** One site and one
   customer were deactivated directly in the local database to exercise
   the O09 inactive-record scenarios (not through the manager portal —
   see next point).

6. **Manager-web has no deactivate/reactivate control for customers or
   sites.** `isActive` is read-only in the UI in this phase; it's set only
   by the master-schedule import. If a manager is expected to be able to
   deactivate a customer or site themselves during the pilot — e.g. when a
   contract ends — rather than always going through a re-import, that's a
   gap worth confirming with the Project Lead before sign-off. If it's
   intentional (deactivation is import-driven only), the manager guide
   already reflects that.

7. **A crew can't currently be split across multiple vehicles.** Each
   vehicle assigned to a visit is validated against the *entire* on-site
   crew count, not a share of it — so assigning a second, smaller vehicle
   to carry the overflow doesn't satisfy the capacity check the way you
   might expect. Documented in the manager guide as a usage note; worth
   confirming with the Project Lead whether this is the intended design.

8. **"Save assignment" silently stays disabled until "Reason for this
   change" is filled in**, even after every validation check passes and
   the panel says the crew is eligible. There's no separate message
   telling the manager this is why Save won't activate. Low severity (the
   guide now documents the recovery step), but worth a small UX
   improvement — surfacing it as a visible requirement, the same way every
   other blocking condition is shown, rather than a silent disabled state.

9. **Three "clean save" screenshots in the original draft were actually
   evidence of the now-fixed defect #2, captured before the fix.**
   `valid-assignment-saved-toast.png`, `o09-scenarioA-driver-chaminda-saved.png`,
   and `o09-scenarioB-driver-kamala-saved.png` were cited as clean-save
   evidence in `uat/ULK-O08-uat-results.md`, `manager-guide.md`, and
   `demonstration-script.md`. On review, all three show the Validation
   panel flagging `EMPLOYEE_DOUBLE_BOOKED` / a self-comparison error
   against the assignment just saved — the pre-fix self-overlap behavior
   described in #2, taken against the local-UAT baseline before the
   `excludeAssignmentId` fix landed. Reclassified as historical defect
   evidence throughout this branch, not current-behavior evidence. Genuine
   clean-save screenshots (no errors visible under the toast) still need to
   be captured on the deployed app, against the fixed baseline — an attempt
   was made during the 2026-09-09 deployed pass but couldn't complete
   because of defect #1 (Save itself fails). Do not reuse the three above
   for that purpose.

10. **Add Agreement form displays a raw internal UUID instead of the
    customer/site name once selected**
    (`add-agreement-form-full.png`, used in the manager guide). The
    dropdown's own option list correctly shows names
    (`apps/manager-web/src/app/(app)/service-agreements/page.tsx:538-540`,
    `:560-562`); only the closed trigger fails to resolve the id back to
    its label. Not a data-exposure issue — these are internal identifiers
    in fabricated demo data, not customer PII — but confusing for a
    manager and the screenshot needs retaking once fixed. Low severity,
    triaged for the manager-web owner (front-end files out of scope for
    this docs-only pass).

11. **The previously-cited "148/148" test count was stale.** Re-running
    `pnpm exec vitest run` from `apps/manager-web` on this branch for this
    correction pass reports **166 passed (166)**, 17 test files, 0 failed.
    Full console output is saved as auditable evidence at
    `uat/test-run-evidence-manager-web.txt`.

12. **[New, confirmed on deployed real data] DAC-2485 has exactly three
    authorized drivers, as O09 names it.** Checked directly against the
    real imported vehicle on `https://ultrakil-manager-web.vercel.app`,
    2026-09-09: P Selvaraj, S Tharilingam, T M Supun Tharaka Wijeweera
    (PMS-grade), each an equal "Authorized to drive" row with the correct
    ownership disclaimer. Matches expected exactly — closes the local
    pass's item 4 gap (DAC-2485 didn't exist in demo data).

13. **[New] The real imported dataset currently has no inactive
    customers/sites and no unassigned Kandy visits**, so two O08/O09
    scenarios can't be demonstrated against real data right now: inactive
    records producing no future jobs, and Kandy remaining unassigned when
    no PMS-qualified supervisor is available. Not a defect — the Customers
    list (filtered Inactive) reports "every customer on record is
    currently active," and Unassigned Visits (filtered Kandy) reports
    "every visit currently has a valid crew and vehicle assignment." A
    positive side-confirmation: the Unassigned Visits conflict-type filter
    does list `Missing PMS supervisor` as a first-class category, so the
    mechanism exists — there's just no live instance to screenshot today.

14. **[New, minor] DAC-2485's vehicle record shows "Unassigned branch,"
    while all three of its authorized drivers are tagged "Colombo."**
    Observed directly on the deployed vehicle detail page. Not confirmed
    as a defect — could be a genuine gap in the vehicle's imported branch
    field, or intentional (a vehicle not yet assigned to a branch can still
    have branch-tagged authorized drivers). Worth a one-line confirmation
    from the API/import owner before sign-off.

## Not a defect, but worth calling out to managers

- Permanently stationed employees are **not** filtered out of the crew
  picker for other sites (unlike branch isolation, which is filtered
  proactively) — they're rejected only after being added, via a validation
  error. Functionally correct (nothing invalid can be saved), just a
  slightly different user experience than the branch check. Documented in
  the manager guide.

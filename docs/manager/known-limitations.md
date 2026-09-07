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

1. **Re-opening an already-assigned visit can show false "double-booked"
   errors against itself.** After saving a valid crew/vehicle assignment,
   simply re-opening that same visit's "Edit crew" drawer — with no changes
   made — shows `EMPLOYEE_DOUBLE_BOOKED` / `VEHICLE_DOUBLE_BOOKED` errors
   comparing the visit's own saved assignment against itself, and disables
   Save. The underlying save is unaffected (confirmed correct on the
   read-only Dispatch Board view), but a manager currently cannot make a
   *further* edit to an already-assigned visit in place. Root cause: the
   `POST /visits/{visitId}/assignment/check` endpoint doesn't appear to
   exclude the visit's own current assignment from its own overlap check.
   This is a backend fix — flagged for the API owner, not corrected in this
   pass (backend files were out of scope this round). See
   `uat/ULK-O08-uat-results.md` for the full repro.
   **Suggested severity: high** — blocks a routine manager workflow
   (swapping a sick technician, changing a vehicle) — recommend the API
   owner confirms before pilot sign-off.

2. **No staging environment exists yet.** All UAT evidence in this pass is
   from a local development stack seeded with fabricated demo data — see
   below. The O08 release gate "screenshots match the deployed staging
   interface" cannot be satisfied until a staging host exists with the
   real data imported (this is ULK-O08's stated dependency on ULK-C08).

3. **This pass used fabricated demo data, not the real technician matrix
   or master schedule.** Per `data/README.md`, the real workbooks
   (`technician-matrix.xlsx`, `master-schedule-2026.xlsx`) contain real
   personnel/customer data and are never committed to the repository, and
   weren't available in this environment. `pnpm db:seed:demo`'s 14
   fabricated employees and 3 fabricated customers were used instead. Every
   rule in this document has been proven to work mechanically; a second
   pass against the real imported data (on staging, once available) is
   still required before final sign-off — including the specific
   `DAC-2485` vehicle named in ULK-O09, which doesn't exist in the demo
   set.

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

## Not a defect, but worth calling out to managers

- Permanently stationed employees are **not** filtered out of the crew
  picker for other sites (unlike branch isolation, which is filtered
  proactively) — they're rejected only after being added, via a validation
  error. Functionally correct (nothing invalid can be saved), just a
  slightly different user experience than the branch check. Documented in
  the manager guide.

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

1. **[Fixed, deployed, and independently confirmed] Assignment save
   failed on the deployed API — Prisma interactive-transaction
   timeout.** Found during the deployed real-data pass, 2026-09-09:
   `PUT /api/visits/{id}/assignment` returned `500 INTERNAL_ERROR` on every
   attempt (reproduced 3/3, 09:20:48–09:21:43 UTC), each attempt slower
   than the last (5300ms → 5328ms → 8847ms), all over the transaction's
   5000ms budget. Root cause in the Vercel runtime logs:
   ```
   PrismaClientKnownRequestError: Transaction API error: Transaction already
   closed: ... The timeout for this transaction was 5000 ms, however 8847 ms
   passed since the start of the transaction.
   ```
   at `apps/api/src/scheduling/eligibility/assignments.service.js:93`,
   inside the transaction opened at line 74 (`AssignmentsService.assign`).
   Reported to the API owner (Thivarrakesh) with this trace, ~09:22 UTC.
   **Fixed and deployed ~10:17 UTC 2026-09-09** as
   `6fe1838ef2513d4214d4dc1846388a3b59d6711d` (PR #49, keeps manager
   eligibility writes in the transaction). The API owner's own
   verification against the canonical deployed manager/API (~10:23 UTC):
   reopen → eligibility check `HTTP 200`, no self-conflict; one save with
   a UAT audit reason → `HTTP 200`; follow-up `GET`/eligibility check →
   both `HTTP 200`; no runtime errors in Vercel post-deploy.
   **Independently confirmed through the manager portal UI itself,
   ~16:50 UTC 2026-09-09** (this UAT pass has no network access to the
   deployed app, so the click-through was performed by whoever had
   deployed access, from this document's exact steps, with screenshots
   committed to the branch): a fresh manual assignment on a previously
   unassigned visit saved successfully with an "Assignment saved" toast
   and no server error, and reopening that same visit's Edit crew drawer
   immediately showed "This crew is eligible to take the visit" with no
   false `EMPLOYEE_DOUBLE_BOOKED`/`VEHICLE_DOUBLE_BOOKED` error. Full
   detail in `uat/ULK-O08-uat-results.md`. **Not release-blocking any
   more.** Current DigitalOcean staging commit `b694823` passed a fresh
   authenticated save, follow-up GET, and eligibility recheck with no
   self-overlap conflict.

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
   **Current staging confirmation, 2026-09-10:** a mutable assignment was
   saved and immediately rechecked on deployed commit `b694823`. The API
   returned HTTP 200 and no self-overlap conflict. Publication-history
   assignments remain intentionally read-only.

3. **Local pass used fabricated demo data; a deployed real-data pass has
   since covered part of this.** Per `data/README.md`, the real workbooks
   (`technician-matrix.xlsx`, `master-schedule-2026.xlsx`) contain real
   personnel/customer data and are never committed to the repository, so
   the local pass used `pnpm db:seed:demo`'s 14 fabricated employees and 3
   fabricated customers. Every rule in this document has been proven to
   work mechanically against demo data. **Update, 2026-09-10:** the current
   DigitalOcean staging release also passed privacy-safe real-data audits for
   DAC-2485 normalization, authorized/unauthorized drivers, inactive-site
   future-job exclusion, assignment save/reopen, and backup/restore. Kandy
   has no active agreement or generated visit in this import, so the
   no-PMS outcome cannot be demonstrated with a live row.

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

7. **Each visit currently supports exactly one vehicle.** Assigning more
   than one is rejected as `TOO_MANY_VEHICLES`; the manager must keep one
   vehicle large enough for the entire crew and release the others. The
   current release does not split a crew across multiple vehicles. This is
   documented in the manager guide and remains a possible Phase 2 workflow
   enhancement if multi-vehicle transport is later required.

8. **"Save assignment" silently stays disabled until "Reason for this
   change" is filled in**, even after every validation check passes and
   the panel says the crew is eligible. There's no separate message
   telling the manager this is why Save won't activate. Low severity (the
   guide now documents the recovery step), but worth a small UX
   improvement — surfacing it as a visible requirement, the same way every
   other blocking condition is shown, rather than a silent disabled state.

9. **Three screenshots in the original draft showed the historical
   self-overlap defect rather than a clean save.** They were removed from
   this release documentation so a manager cannot mistake old failure
   evidence for current behavior. Current staging save/reopen evidence is
   retained privately because it contains imported operational data.

10. **[Fixed] Add Agreement previously displayed a raw internal ID after
    selecting a customer or site.** The selectors now map stored IDs to
    visible names, with an automated regression covering both fields. The
    obsolete screenshot was removed.

11. **The previously-cited test count was stale.** The current manager suite
    reports **180 passed**, 18 test files, 0 failed, including assignment
    driver removal and selected-label regressions. GitHub CI is the
    authoritative release record.

12. **[Confirmed on current staging] DAC-2485 is normalized once and has
    exactly three equal driver authorizations.** No owner or primary-driver
    priority is represented. Individual names are omitted from this public
    report; the required count and rule passed the protected data audit.

13. **The current real import has 28 inactive sites, no inactive customers,
    and no future visit referencing an inactive record.** It has no active
    Kandy agreement or generated Kandy visit, so the no-PMS rule cannot be
    demonstrated with a live row. The workforce audit still confirms zero
    PMS-qualified Kandy supervisors; no bypass was introduced.

14. **[New, minor] DAC-2485's vehicle record shows "Unassigned branch,"
    while all three of its authorized drivers are tagged "Colombo."**
    Observed directly on the deployed vehicle detail page. Not confirmed
    as a defect — could be a genuine gap in the vehicle's imported branch
    field, or intentional (a vehicle not yet assigned to a branch can still
    have branch-tagged authorized drivers). Worth a one-line confirmation
    from the API/import owner before sign-off.

15. **[Covered automatically] Driver removal/revalidation.** The manager UI
    regression removes the selected driver from the crew and verifies that
    the vehicle's driver selection clears immediately to `No crew member is
    authorized`. The API also rejects a vehicle without an authorized crew
    driver. A human may repeat the click-through during business acceptance,
    but this is no longer an untested release gap.

## Not a defect, but worth calling out to managers

- Permanently stationed employees are **not** filtered out of the crew
  picker for other sites (unlike branch isolation, which is filtered
  proactively) — they're rejected only after being added, via a validation
  error. Functionally correct (nothing invalid can be saved), just a
  slightly different user experience than the branch check. Documented in
  the manager guide.

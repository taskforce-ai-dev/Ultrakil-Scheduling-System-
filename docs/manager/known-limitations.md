# ULK-O08 — Known limitations

Compiled from the O08 UAT pass. Grouped by what a manager needs to know
before/during the pilot, versus what's tracked as an engineering follow-up.

## Current staging release — 24 September 2026

The current application release is PR #75 merged as
`500daf80a85aea18ca5e5d74d2552739b7e3fb57`, with the Caddy-only PR #76
update merged as `a8174accb7d99248ba415fe78bb227c49aac23e9`. The exact-head pipelines
passed, all six staging services are healthy with zero restarts, and an
authenticated read-only browser smoke loaded all 11 manager routes with zero
page exceptions, API HTTP errors or console errors.

This proves the deployed release is ready for management testing. It does not
close these operational decisions:

1. **Site branch confirmation:** 408 imported sites retain uncertain branch
   provenance: 394 active and 14 inactive, across 131 customers. The workbook
   cannot close this automatically: 367 of those sites have no address and 174
   carry only a site name; only 41 carry an address or region string. They use
   the disclosed Colombo fallback until management confirms the correct branch.
2. **Different-site travel time:** the Technical Director approved the
   60-minute different-site rule and exact repair plan
   `a34167e60fd3b47fb210d88ba372dd3687e47c4f113f407dd08c38583b414485`.
   The repair replaced 11 future assignments and withdrew none. Post-repair,
   all 150 published candidates were checked: zero current/future findings
   remain selectable, employee overlap/travel pairs are zero, vehicle
   overlap/travel pairs are zero, and 55 historical findings remain immutable.
3. **Staffing horizon:** the repair covered already-published assignments; the
   remaining future visits stay pending until a manager runs and publishes the
   appropriate dispatch horizon. A 24 September full-year audit restored the
   live database into an isolated disposable clone and ran seven non-overlapping
   optimizer windows from 24 September 2026 through the rolling-horizon boundary
   on 24 September 2027. The first six runs considered and staffed all 1,506
   pending visits through 18 September with zero unassigned. Count-only SQL
   proved that the remaining 19–24 September tail held zero generated visits in
   both live staging and the restored clone; the seventh run therefore succeeded
   with zero work rather than hiding unaudited visits. The 1,506 resulting drafts
   had zero employee/vehicle overlap or travel conflicts, short or overstaffed
   crews, missing PMS supervisors, missing skills, invalid transport,
   unauthorized drivers, branch/permanent-site violations or absence violations.
   These drafts were audit evidence on the clone, not schedules published to the
   live system.
4. **Synthetic staging capacity:** the existing visible staging-only team is
   two `SYNTHETIC/TEST` employees and one `SYNTHETIC/TEST` vehicle. The
   full-year optimizer audit above proves the current future workload has no
   compliant-capacity refusal, so this release added no synthetic resources.
   A later workload must still prove an actual shortage before more are added.
5. **Authentication hardening:** failed login attempts are constant-time and
   identity-safe in logs, but no failed-attempt throttle is implemented yet.
   Controlled staging UAT may continue; production sign-off must include an
   approved throttling policy and verified implementation.

The final post-catch-up backup is
`ultrakil-20260924T175533Z-310c0698fc7e.dump` with SHA-256
`d504632d624db101e781488359a265a5901b2b920b386e81720d670ab5aa83fb`.
It passed manifest/archive verification and restored into an isolated marked
database with 27 required tables, 18 successful migrations, zero failed
migrations, zero duplicate outbox keys and the same clean scheduling
invariants. That clone supplied the full-year optimizer evidence above; its
API container, Redis namespace and disposable database were removed after the
count-only results were recorded.

The detailed findings below are the historical O08 record. Where an older
commit, count or deployment is quoted, this current-release section takes
precedence.

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

4. **[Resolved] Vehicle branch handling is now consistent.** The Technician
   Matrix does not state vehicle branches, so the importer now assigns every
   matrix vehicle to Colombo on both create and update; re-import also repairs
   legacy null branches. The assignment editor asks the API which vehicles can
   serve the visit branch (`servesBranch`). A manually created legacy vehicle
   with no recorded branch remains usable, a vehicle recorded in a different
   branch is never offered, and an empty result is explained on screen.

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

8. **[Fixed] "Save assignment" now explains what it is waiting for.** The
   button carries a visible and accessible description for every blocker,
   including the required reason, missing crew, eligibility validation,
   loading and active locks. Clicking it while only the reason is missing
   also focuses the required reason box. Deterministic manager tests cover
   the visible message, accessible description and focus behavior.

9. **Three screenshots in the original draft showed the historical
   self-overlap defect rather than a clean save.** They were removed from
   this release documentation so a manager cannot mistake old failure
   evidence for current behavior. Current staging save/reopen evidence is
   retained privately because it contains imported operational data.

10. **[Fixed] Add Agreement previously displayed a raw internal ID after
    selecting a customer or site.** The selectors now map stored IDs to
    visible names, with an automated regression covering both fields. The
    obsolete screenshot was removed.

11. **The previously-cited fixed test count was stale.** Test totals continue
    to grow, so this handover no longer freezes a number in prose. Exact-head
    GitHub CI is the authoritative release record, including assignment-driver
    removal, selected-label and Save-blocker regressions.

12. **[Confirmed on current staging] DAC-2485 is normalized once and has
    exactly three equal driver authorizations.** No owner or primary-driver
    priority is represented. Individual names are omitted from this public
    report; the required count and rule passed the protected data audit.

13. **The current real import has 28 inactive sites, no inactive customers,
    and no future visit referencing an inactive record.** It has no active
    Kandy agreement or generated Kandy visit, so the no-PMS rule cannot be
    demonstrated with a live row. The workforce audit still confirms zero
    PMS-qualified Kandy supervisors; no bypass was introduced.

14. **[Resolved] DAC-2485 and every other matrix-imported vehicle now default
    to Colombo.** The matrix still states only who may drive each vehicle, not
    its branch; Colombo is the Technical Director's explicit operational
    default. Driver authorizations remain independent checkmarks with no owner
    or primary-driver priority. The current live audit found zero active
    vehicles outside or unmapped from Colombo.

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

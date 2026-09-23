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
   more.** Staging commit `b694823` passed a fresh authenticated save,
   follow-up GET, and eligibility recheck with no self-overlap conflict.
   **Reconfirmed on `main@13b2456`, 2026-09-22** — and this time through
   the manager portal directly rather than at the API: scenario C1 of the
   deployed UAT saved a real assignment and reopened it from the Dispatch
   Board, with validation reading *"This crew is eligible to take the
   visit."* and no save failure. See
   `uat/ULK-O08-O09-deployed-uat-13b2456.md`.

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
   **Staging confirmation, 2026-09-10:** a mutable assignment was saved and
   immediately rechecked on deployed commit `b694823`. The API returned
   HTTP 200 and no self-overlap conflict. Publication-history assignments
   remain intentionally read-only.
   **Confirmed again on `main@13b2456`, 2026-09-22, in the UI.** This closes
   the "partially confirmed" qualifier in this item's heading: UAT scenario
   C1 saved a real assignment (crew of two, one vehicle, its authorised
   driver), then reopened that visit's Edit crew drawer from the Dispatch
   Board. Validation read *"This crew is eligible to take the visit."* with
   **no** `EMPLOYEE_DOUBLE_BOOKED` or `VEHICLE_DOUBLE_BOOKED` raised against
   the visit's own crew member or its own vehicle. The historical defect
   does not reproduce on this release.

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

4. **[Resolved] Vehicles with no recorded branch were never offered.**
   Imported vehicles have no branch (the Technician Matrix does not state
   one), and the assignment editor's vehicle picker filtered by the visit's
   exact branch, so on real data it opened onto nothing while the
   eligibility engine would have accepted those vehicles. The picker now
   asks the API which vehicles can serve the branch (`servesBranch`): those
   recorded in it plus those with none recorded. A vehicle recorded in a
   different branch is still never offered, and an empty result is now
   explained on screen rather than presented as an enabled control.

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
   **Observed on `main@13b2456`, 2026-09-22 (UAT C2), with one clarification
   worth recording:** the vehicle picker *does* allow a second vehicle to be
   attached — the rule is enforced at the **save boundary**, not in the
   picker. Attempting to save two returned *"Unavailable vehicle — 2
   vehicles are assigned to this visit (…); a crew travels in one."* with
   the guidance *"Keep the one vehicle that seats the whole crew and release
   the rest for other visits."* Permissive picker, strict validation — the
   same pattern as driver authorisation. Nothing invalid can be saved, but a
   manager can build an invalid selection before being told.

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

12. **[Confirmed on `main@13b2456`] DAC-2485 is normalized once and has
    exactly three equal driver authorizations.** No owner or primary-driver
    priority is represented. Individual names are omitted from this public
    report; the required count and rule passed the protected data audit.
    **Re-verified directly on 2026-09-23 (UAT A5/A6).** The vehicle detail
    page shows exactly three authorized-driver rows, none containing
    "primary driver", "backup driver" or "owner". Normalisation was checked
    two ways rather than one: searching `DAC-2485` returned a single row,
    and searching the bare digits `2485` — which matches any separator
    spelling — returned that **same single row**, ruling out a duplicate
    stored as `DAC2485` or `DAC 2485` that a hyphenated search could not
    have detected.

13. **[Counts superseded — re-stated for `main@13b2456`]** The figure "28
    inactive sites" belonged to the `b694823` import and **must not be
    carried forward**; the dataset changed with the release. What the
    2026-09-23 deployed pass established on `main@13b2456`:

    - **No inactive customers** — confirmed by hand, the `/customers`
      Inactive filter returns *"No inactive customers — Every customer on
      record is currently active."* (unchanged in kind from the previous
      import).
    - **Inactive *sites* exist in quantity**, and no exact total is claimed
      here because none was counted exhaustively. Observed on individual
      customers: CUST-03 *"48 active, 15 inactive"*, CUST-04 Main
      Premises *"89 active, 5 inactive"*, CUST-05 *"31 active, 4
      inactive"*, CUST-07 *"54 active, 3 inactive"*, CUST-06
      *"7 active, 1 inactive"*, plus CUST-02 and CUST-08. A page-wide
      find returned 33 matches on one page of the customer list alone, so
      the true total exceeds the old 28 and is not established.
    - **"No future visit referencing an inactive record" is sampled, not
      proven.** Three customers holding seven inactive sites between them
      were filtered across future months and returned zero visits — but
      none of them has *any* future work, so the rule was never exercised.
      Establishing the invariant needs a query over visits joined to site
      status. Treat this line as an open backend item, not a confirmed
      property.
    - **No Kandy work exists in any state** — checked three ways
      (unassigned queue with no date filter, dispatch board, and calendar
      across September and October 2026), so the no-PMS rule still cannot
      be demonstrated with a live row, and there is equally no wrongly
      *assigned* Kandy visit. The workforce audit still confirms zero
      PMS-qualified Kandy supervisors; no bypass was introduced.

14. **[Superseded on `main@13b2456` — the branch is now recorded]** This
    item previously read that DAC-2485's vehicle record showed *"Unassigned
    branch"* while all three of its authorized drivers were tagged
    *"Colombo"*. **That is no longer what the deployed portal shows.** On
    2026-09-23 the `/vehicles` row for DAC-2485 reads *Bolero Truck (2
    People) DAC-2485* with **Branch: Colombo**, Seats 2, Authorized drivers
    3, Status Available — so a branch has since been recorded against it and
    vehicle and drivers now agree. The explanation below is retained because
    it still describes how imported vehicles arrive and why an unassigned
    branch is expected before a manager records one; it is no longer a
    statement about this particular vehicle.
    Not a defect. The Technician Matrix records who may drive a vehicle but
    never which branch the vehicle belongs to, so every imported vehicle
    arrives with no branch until a manager records one under **Vehicles**.
    Driver authorizations come from the matrix checkmarks and are
    independent of the vehicle's branch. Such a vehicle can be offered for
    any branch's work (see item 4) and publication flags it as unconfirmed
    source data until its branch is recorded.

15. **[Covered automatically] Driver removal/revalidation.** The manager UI
    regression removes the selected driver from the crew and verifies that
    the vehicle's driver selection clears immediately to `No crew member is
    authorized`. The API also rejects a vehicle without an authorized crew
    driver. A human may repeat the click-through during business acceptance,
    but this is no longer an untested release gap.
    **That human click-through has now been done, on `main@13b2456`,
    2026-09-22 (UAT C4).** Removing the selected driver from a saved crew
    cleared the driver field immediately to *"No crew member is
    authorized"* — it did not silently retain a driver who had left the
    crew — and validation re-fired three rules at once. The guidance text
    also adapted correctly, from naming a specific eligible person to
    *"Add someone authorized for this vehicle to the crew, or use a vehicle
    the crew can drive"*, since nobody remaining was authorised.

## Not a defect, but worth calling out to managers

- Permanently stationed employees are **not** filtered out of the crew
  picker for other sites (unlike branch isolation, which is filtered
  proactively) — they're rejected only after being added, via a validation
  error. Functionally correct (nothing invalid can be saved), just a
  slightly different user experience than the branch check. Documented in
  the manager guide.

# ULK-O08 — UAT results (working draft)

Environment: local dev stack (Postgres 16 + Redis, API on :3001, scheduler on
:8000, manager-web on :3000), seeded with `pnpm db:seed:demo` — **fabricated**
demo data (14 employees, 7 vehicles, 3 customers), not the real UltraKIL
technician matrix or master schedule. See "Known limitations" at the bottom
for why, and what still needs to run against real data + staging.

Login: `admin@taskforceai.tech` (seeded admin).

Demo vehicles ship with no branch set (`branchId = NULL`); the assignment
editor's vehicle picker filters by the visit's branch, so no vehicle was
selectable until a branch was assigned. Fixed locally by setting
`CAB-2288` → COLOMBO, `PJ-5510` → COLOMBO, `BFT 9134` → KANDY, `LM-3067` →
KANDY directly in the local database (no repository file changed — this is a
demo-seed data gap, not a code change). Flagged under known limitations.

---

## Scenario: Colombo/Kandy branch isolation

**Result: PASS.**

Opening the crew editor for a Colombo visit (Harbour View Hotel — Main
Building) and clicking "Choose an employee" offers only the 9 Colombo
employees; none of the 5 Kandy employees (Ajith Dissanayake, Bandula Herath,
Nadeeka Kumarasiri, Thilini Ekanayake, Upali Senanayake) appear. Enforcement
is proactive (filtered out of the picker), not just a post-hoc validation
error.

Screenshot: `screenshots/branch-isolated-crew-picker.png`

---

## Scenario: permanently stationed staff

**Result: PASS**, with one bug found along the way (see Defects).

Employee detail page for a permanently stationed employee states the rule in
plain language: *"Malani Serasinghe — Permanently stationed at Greenfield
Brewery. Permanently stationed staff cannot be moved to another site, and
never count toward mobile crew capacity."*

Unlike branch isolation, permanently-stationed employees are **not** filtered
out of the crew picker for a different site — they can be selected, but
adding one to a visit at a different site produces a blocking validation
error:

> **Permanent-staff restriction** `EMPLOYEE_PERMANENTLY_STATIONED`
> Malani Serasinghe is permanently stationed elsewhere and cannot be sent to
> Harbour View — Main Building.
> **What to do:** Assign a mobile crew member instead.

Screenshots: `screenshots/permanent-station-employee-detail.png`,
`screenshots/permanent-station-validation-and-reopen-bug.png`

---

## Scenario: missing PMS supervisor

**Result: PASS.**

Assigning a single non-PMS technician (Chaminda Peiris, grade PMT) to a job
that requires a PMS-grade supervisor on site produces:

> **Missing PMS supervisor** `NO_PMS_SUPERVISOR_AVAILABLE`
> Every job needs a PMS-grade supervisor on site, and nobody in this crew is
> one.
> **What to do:** Add a Senior PMS, PMS, Assistant PMS, SPMS or APMS from
> COLOMBO.

`Save assignment` stays disabled until satisfied. The employee picker also
visibly tags PMS-grade candidates inline (e.g. "Kamala Wijesinghe (PMS)"),
so a manager can tell at a glance who qualifies without opening Workforce.

Screenshot: `screenshots/missing-pms-and-crew-size-validation.png`

---

## Scenario: variable crew size

**Result: PASS.**

The same validation pass above also produced, for the same under-crewed
visit:

> **Insufficient crew** `CREW_TOO_SMALL`
> Harbour View Hotel — Harbour View — Main Building needs 2 on site; 1 is
> assigned.
> **What to do:** Add 1 more, or reduce the crew size on the agreement if the
> job really is smaller.

Required crew size is read per service agreement (confirmed via the Service
Agreements list, where different agreements carry different implied crew
requirements) rather than a fixed constant — this is what "variable crew
size" means in practice in this app, and it is enforced.

Screenshot: `screenshots/missing-pms-and-crew-size-validation.png`

---

## Scenario: allowed vs preferred days

**Result: PASS (evidenced from existing data + earlier automated coverage).**

Service Agreements list shows allowed/preferred days per agreement, with
preferred always a subset of allowed, e.g.:

| Site | Allowed | Preferred |
| --- | --- | --- |
| Harbour View — Kitchens | Mon, Wed, Fri, Sat | Wed, Sat |
| Harbour View — Main Building | Mon, Tue, Wed | Tue |
| Hill Country — Drying Floor | Tue, Thu, Sat | Sat |
| Greenfield Brewery — Plant | Thu, Fri | Fri |

The agreement form itself enforces the subset rule live (unchecking an
allowed day also drops it from preferred; a day can't be marked preferred
before it's allowed) — already covered by
`apps/manager-web/src/app/(app)/service-agreements/__tests__/service-agreements.test.tsx`,
which passes.

Screenshot: `screenshots/service-agreements-allowed-vs-preferred-days.png`

---

## Scenario: variable service hours

**Result: evidenced structurally; full walk-through still pending** (see
Follow-ups). The visit-generation preview (`screenshots/generate-visits-preview.png`)
confirms visits are generated per agreement/site rather than from a single
global schedule, which is the mechanism that lets service hours vary by
site and day. A dedicated screenshot of the site operating-hours editor
showing two different days with different hours for the same site is still
needed for the manager guide.

---

## Scenario: vehicle authorization

**Result: PASS.**

For the Colombo visit above, once a vehicle (Van CAB-2288) is added, the
Driver dropdown for that vehicle offers only its two authorized employees
(Chaminda Peiris, Kamala Wijesinghe) — confirmed by reading the actual
option list, not just visually. No ownership or primary-driver concept
exists in the UI; authorization is a flat checkmark per employee/vehicle
pair, matching the project rule.

The full crew (2 people, PMS-satisfied) + vehicle + driver combination was
then saved successfully — this doubles as the "one valid schedule" example
for the demonstration script.

Screenshots: `screenshots/vehicle-authorized-driver-picker.png`,
`screenshots/valid-assignment-saved-toast.png`,
`screenshots/dispatch-board-valid-assignment-persisted.png`

---

## Defects found

### 1. Re-opening an already-assigned visit shows false "double-booked" errors against itself — investigating severity

After saving a valid assignment (crew + vehicle + driver) on a visit, simply
re-opening that same visit's "Edit crew" drawer — with **no changes made** —
immediately shows:

- `Employee overlap / EMPLOYEE_DOUBLE_BOOKED` for every crew member,
  claiming they're "already on another job" at the exact same time/date —
  the "other job" is this same visit's own just-saved assignment.
- `Vehicle overlap / VEHICLE_DOUBLE_BOOKED` for the assigned vehicle, same
  cause.

`Save assignment` is disabled the whole time, so **a manager cannot currently
make any further edit to an already-assigned visit** (swap a sick employee,
change the vehicle, adjust the time) — every re-open is blocked by the tool
treating the visit's own existing assignment as a conflict with itself.

This reproduced consistently (confirmed on a completely untouched re-open,
screenshot below, and again after adding one more crew member).

The check call is `POST /visits/{visitId}/assignment/check` — the visit ID
is already in the URL, so the fix (excluding the visit's own current
assignment from its own overlap check) belongs in the API's eligibility
logic, not in manager-web. **Flagging for the API owner rather than fixing
myself**, since this session's scope is UI/UAT only and backend files are
off-limits this round.

Severity judgment call: this blocks a core manager workflow (editing a
published/assigned visit) but does not corrupt data and has a workaround
(use "Remove crew" and rebuild from scratch instead of editing in place).
Given the O08 release gate requires zero unresolved critical/high defects,
recommend the API owner assess and confirm severity/fix before pilot
sign-off.

Screenshot: `screenshots/permanent-station-validation-and-reopen-bug.png`
(shows the false overlap errors alongside the correct
`EMPLOYEE_PERMANENTLY_STATIONED` error in the same validation list, proving
the permanent-station check itself is unaffected — only the overlap check is
wrong).

---

## Known limitations of this UAT pass

1. **Not the real employee matrix or master schedule.** Per
   `data/README.md`, `technician-matrix.xlsx` and `master-schedule-2026.xlsx`
   are never committed (real personnel/customer data) and aren't available
   in this sandbox. This pass used `pnpm db:seed:demo`'s fabricated 14-person
   workforce and 3 fabricated customers. Every rule above is proven to work
   *mechanically*; O08 also requires the same walk-through against the real
   imported data, which needs either the real workbook or a staging
   environment with it already imported (see the O08 ClickUp task's staging
   dependency on ULK-C08, and today's reply to Whyshni: no staging host
   exists yet).
2. **Demo vehicles need a branch assigned by hand.** `pnpm db:seed:demo`
   leaves every vehicle's `branchId` null, so the assignment editor's vehicle
   picker (which filters by the visit's branch) shows zero vehicles until one
   is set. Worked around locally via direct SQL for this UAT session only —
   not a code or migration change. Worth a demo-seed follow-up (owner: API)
   so a fresh demo environment can exercise vehicle assignment out of the
   box.
3. **No inactive customer/site exists in demo data yet**, so the O09
   inactive-label/exclusion scenarios still need to be run (see O09 section,
   in progress).
4. **Release gate "screenshots match the deployed staging interface"
   cannot be satisfied yet** — there is no staging deployment. All
   screenshots in this document are from local dev.

---

## Still to do

- O09 change-request UAT (7 sub-scenarios) — in progress.
- Variable service hours: dedicated site operating-hours screenshot.
- Manager guide, demonstration script, final known-limitations doc.
- Re-run everything above against real data once available.

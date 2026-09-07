# ULK-O08 — UAT results (working draft)

Status: locally executable scenarios complete. Held for the staging URL and
final UAT gate per Whyshni's instruction (2026-09-07) — **not marked
complete, PR #36 not merged into the release candidate.**

## Environment — exact setup commands

Run from the repo root, in this order. No secrets were used or requested;
`JWT_SECRET` below is a throwaway local-only value, not a real credential.

```bash
# Infra (local Postgres 16 + Redis, run directly — not Docker, which cannot
# pull images in this sandbox)
service postgresql start
redis-server --daemonize yes --port 6379

# DB + role (local only)
sudo -u postgres psql -c "CREATE ROLE ultrakil WITH LOGIN PASSWORD 'ultrakil_local_dev';"
sudo -u postgres psql -c "ALTER ROLE ultrakil CREATEDB;"
sudo -u postgres psql -c "CREATE DATABASE ultrakil OWNER ultrakil;"

# Env
cp .env.example .env
# JWT_SECRET set to a throwaway local value in .env (not committed, not real)

# Schema + demo data
pnpm --filter @ultrakil/api prisma:generate
pnpm db:migrate
pnpm db:seed:demo

# Services (three terminals / background processes)
cd services/scheduler && python3 -m venv .venv && source .venv/bin/activate \
  && pip install -q -r requirements.txt && uvicorn app.main:app --port 8000
pnpm --filter @ultrakil/api start:dev
pnpm --filter @ultrakil/manager-web dev
```

Verified up with:

```bash
curl -s http://localhost:8000/health/live
curl -s http://localhost:3001/api/health/ready
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/login
```

**Dataset:** `pnpm db:seed:demo` — **fabricated** demo data (14 employees, 7
vehicles, 3 customers), not the real UltraKIL technician matrix or master
schedule (never committed, unavailable in this sandbox — see Known
limitations). Login used throughout: `admin@taskforceai.tech` /
`ultrakil-change-me` (seed default, local-only, not a real credential).

**One-time local dataset fix, not a code change:** demo vehicles ship with
`branchId = NULL`; the assignment editor's vehicle picker filters by the
visit's branch, so no vehicle was selectable until one was set:

```sql
UPDATE vehicles SET "branchId" = (SELECT id FROM branches WHERE code='COLOMBO') WHERE code = 'CAB-2288';
UPDATE vehicles SET "branchId" = (SELECT id FROM branches WHERE code='KANDY')   WHERE code = 'LM-3067';
UPDATE vehicles SET "branchId" = (SELECT id FROM branches WHERE code='COLOMBO') WHERE code = 'PJ-5510';
UPDATE vehicles SET "branchId" = (SELECT id FROM branches WHERE code='KANDY')   WHERE code = 'BFT 9134';
```

**Second one-time local dataset fix:** no inactive customer/site existed in
demo data, needed for the O09 inactive-record scenarios:

```sql
UPDATE service_sites SET "isActive" = false WHERE name = 'Harbour View — Kitchens';
UPDATE customers SET "isActive" = false WHERE name = 'Greenfield Brewery';
UPDATE service_sites SET "isActive" = false
  WHERE "customerId" = (SELECT id FROM customers WHERE name = 'Greenfield Brewery');
```

Both are local database edits only — no migration, seed script, or
application file was changed. Flagged under Known limitations as a
demo-seed gap.

Every scenario below was driven with Playwright against the real running
stack (not mocked) — the exact commands are the Playwright locator calls
shown, equivalent to a manager's real clicks; each "Actual result" is the
literal text/option list read back from the live app, not an assumption.

---

## Scenario: Colombo/Kandy branch isolation

**Result: PASS.**

**Dataset:** Visit — Harbour View Hotel, Harbour View — Main Building,
2026-09-08 08:00–12:00 (Colombo). Compared against the full Workforce list:
9 Colombo employees, 5 Kandy employees (Ajith Dissanayake, Bandula Herath,
Nadeeka Kumarasiri, Thilini Ekanayake, Upali Senanayake).

**Commands:**
```
goto /dispatch-board, set date input = 2026-09-08
click "Edit crew" on the Harbour View Hotel row
click "Add crew member" → click "Choose an employee"
read all getByRole('option') text
```

**Expected result:** Only the 9 Colombo employees appear; none of the 5
Kandy employees appear (Colombo visit, branch isolation is a hard rule).

**Actual result:** Option list = exactly the 9 Colombo employees (Chaminda
Peiris, Dilrukshi Amarasena, Kamala Wijesinghe (PMS), Malani Serasinghe,
Nimal Rajapaksha (PMS), Priyantha Bandaranayake (PMS), Ruwan Gunasekara,
Sanduni Liyanage, Sunil Abeykoon (PMS)). 0 Kandy employees present. Matches
expected — enforcement is proactive (filtered out of the picker), not just
a post-hoc validation error.

Screenshot: `screenshots/branch-isolated-crew-picker.png`

---

## Scenario: permanently stationed staff

**Result: PASS**, with one bug found along the way (see Defects).

**Dataset:** Employee — Malani Serasinghe (Colombo, PMT, permanently
stationed at Greenfield Brewery). Visit — Harbour View Hotel, Harbour View
— Main Building, 2026-09-08 (a *different* site than her permanent one).

**Commands:**
```
goto /workforce → click "Malani Serasinghe" → read employee detail page text
goto /dispatch-board, date=2026-09-08 → "Edit crew" → "Add crew member"
  → "Choose an employee" → select option "Malani Serasinghe"
read Validation panel text
```

**Expected result:** Employee detail page states the permanent-station rule
in plain text. Adding her to a visit at a different site is rejected with a
named error and a suggested fix; `Save assignment` stays disabled.

**Actual result:** Employee detail page: *"Malani Serasinghe — Permanently
stationed at Greenfield Brewery. Permanently stationed staff cannot be
moved to another site, and never count toward mobile crew capacity."*
Selecting her for the Harbour View visit produced:

> **Permanent-staff restriction** `EMPLOYEE_PERMANENTLY_STATIONED`
> Malani Serasinghe is permanently stationed elsewhere and cannot be sent to
> Harbour View — Main Building.
> **What to do:** Assign a mobile crew member instead.

Matches expected. Note: unlike branch isolation, she is **not** filtered
out of the picker beforehand — selectable, then rejected on add. Functions
correctly either way (nothing invalid can be saved).

Screenshots: `screenshots/permanent-station-employee-detail.png`,
`screenshots/permanent-station-validation-and-reopen-bug.png`

---

## Scenario: missing PMS supervisor

**Result: PASS.**

**Dataset:** Employee — Chaminda Peiris (Colombo, grade PMT, not
PMS-grade). Visit — Harbour View Hotel, Harbour View — Main Building,
2026-09-08 (agreement requires a PMS-grade supervisor on site, crew size 2).

**Commands:**
```
goto /dispatch-board, date=2026-09-08 → "Edit crew" → "Add crew member"
  → select "Chaminda Peiris" (sole crew member)
read Validation panel text; read Save-assignment disabled state
```

**Expected result:** A crew with zero PMS-grade members is rejected with a
named error and a concrete fix; Save stays disabled.

**Actual result:**

> **Missing PMS supervisor** `NO_PMS_SUPERVISOR_AVAILABLE`
> Every job needs a PMS-grade supervisor on site, and nobody in this crew is
> one.
> **What to do:** Add a Senior PMS, PMS, Assistant PMS, SPMS or APMS from
> COLOMBO.

`Save assignment` confirmed disabled. Matches expected. The employee picker
also visibly tags PMS-grade candidates inline (e.g. "Kamala Wijesinghe
(PMS)").

Screenshot: `screenshots/missing-pms-and-crew-size-validation.png`

---

## Scenario: variable crew size

**Result: PASS.**

**Dataset:** Three different agreements' stated crew requirements, read
directly from the Service Agreements list and cross-checked against live
validation errors: Harbour View — Main Building = 2, Hill Country — Drying
Floor = 3, Greenfield Brewery — Plant = 3.

**Commands:**
```
goto /service-agreements → read table (Customer/Site/crew-implied columns)
goto /dispatch-board → open each visit's "Edit crew" with an under-sized
  crew → read the CREW_TOO_SMALL validation text for the required number
```

**Expected result:** Required crew size differs per agreement (not a fixed
constant), and each is enforced with the specific number named.

**Actual result:** With 1 person assigned to Harbour View — Main Building:

> **Insufficient crew** `CREW_TOO_SMALL`
> Harbour View Hotel — Harbour View — Main Building needs 2 on site; 1 is
> assigned.

With 2 people assigned to Hill Country — Drying Floor:

> Hill Country Tea Factory — Hill Country — Drying Floor needs 3 on site; 2
> are assigned.

Two different required numbers confirmed live from two different
agreements — matches expected.

Screenshot: `screenshots/missing-pms-and-crew-size-validation.png`,
`screenshots/crew-size-and-missing-skill-validation.png`

---

## Scenario: allowed vs preferred days

**Result: PASS.**

**Dataset:** All 4 demo service agreements, read from the Service
Agreements list:

| Site | Allowed | Preferred |
| --- | --- | --- |
| Harbour View — Kitchens | Mon, Wed, Fri, Sat | Wed, Sat |
| Harbour View — Main Building | Mon, Tue, Wed | Tue |
| Hill Country — Drying Floor | Tue, Thu, Sat | Sat |
| Greenfield Brewery — Plant | Thu, Fri | Fri |

**Commands:**
```
goto /service-agreements → read table
(subset-enforcement UI behaviour already covered by an existing, passing
 automated test — see below, not re-driven manually this pass)
```

**Expected result:** Preferred days are always a subset of allowed days;
the create/edit form enforces this live (can't mark a day preferred before
it's allowed; unchecking an allowed day also drops it from preferred).

**Actual result:** Preferred ⊆ Allowed holds for all 4 live agreements
(table above). Live subset-enforcement in the form is covered by
`pnpm exec vitest run apps/manager-web/src/app/(app)/service-agreements/__tests__/service-agreements.test.tsx`
— specifically "prevents marking a day preferred before it is allowed
(subset enforcement)" and "un-checking an allowed day also drops it from
preferred," both passing (part of the 148/148 suite run this session).
Matches expected.

Screenshot: `screenshots/service-agreements-allowed-vs-preferred-days.png`

---

## Scenario: variable service hours

**Result: PASS.**

**Dataset:** New site created via the Add-customer form (not saved to the
database — form state only, sufficient to prove the UI mechanism): Monday
08:00 AM–05:00 PM, Wednesday 06:00 AM–12:00 PM, all other days left with no
window.

**Commands:**
```
goto /customers → "Add customer" → fill Customer name, Site name
click "Add a window on Monday" → fill start=08:00, end=17:00
click "Add a window on Wednesday" → fill start=06:00, end=12:00
read all input[type=time] values; read Tuesday/Thursday sections
```

**Expected result:** Each weekday's opening-hours window is configured
independently; a day with no window entered is closed; more than one
window per day is supported.

**Actual result:** Monday shows 08:00 AM to 05:00 PM; Wednesday shows
06:00 AM to 12:00 PM; Tuesday and Thursday both show "Closed" with no
values carried over from Monday/Wednesday. Helper text confirms design
intent: *"A day with no window is closed. Add more than one window (e.g. a
lunch break) for the same day."* Matches expected.

Screenshot: `screenshots/variable-service-hours-per-day.png`

---

## Scenario: vehicle authorization

**Result: PASS.**

**Dataset:** Vehicle — Van CAB-2288 (Colombo, seats 4), authorized drivers:
Chaminda Peiris, Kamala Wijesinghe (per `vehicle_authorizations` table).
Visit — Harbour View Hotel, Harbour View — Main Building, 2026-09-08.

**Commands:**
```
goto /dispatch-board, date=2026-09-08 → "Edit crew"
  → add crew: Chaminda Peiris, Kamala Wijesinghe (PMS)
  → "Add vehicle" → select "Van( 04 People) CAB-2288"
  → click Driver combobox → read getByRole('option').allTextContents()
fill "Reason for this change" → click "Save assignment"
```

**Expected result:** Driver dropdown for CAB-2288 offers only its checked
drivers (Chaminda Peiris, Kamala Wijesinghe), nobody else, no
ownership/primary-driver concept anywhere. A complete valid crew + vehicle
+ driver combination saves successfully.

**Actual result:** `driver options: [ 'Chaminda Peiris', 'Kamala Wijesinghe' ]`
— read directly from the DOM, matches expected exactly. After selecting
Chaminda Peiris as driver and filling Reason, `Save assignment` succeeded
("Assignment saved" toast); confirmed persisted on a fresh page reload of
the Dispatch Board (Supervisor: Kamala Wijesinghe, Crew: Chaminda Peiris +
Kamala Wijesinghe, Vehicle: Van CAB-2288 (Chaminda Peiris)). This is also
the "one valid schedule" example used in the demonstration script.

Screenshots: `screenshots/vehicle-authorized-driver-picker.png`,
`screenshots/valid-assignment-saved-toast.png`,
`screenshots/dispatch-board-valid-assignment-persisted.png`

---

## O09 change-request UAT

All 7 required sub-scenarios were run against demo data. `DAC-2485` (the
real vehicle named explicitly in O09) doesn't exist in this dataset — see
Known limitations; `LM-3067`, a demo vehicle with 3 checked drivers
spanning both branches, stood in for the general mechanism.

### 1. All checked drivers shown for one company vehicle (+ DAC-2485)

**Result: PASS** (LM-3067 stand-in); **DAC-2485 itself pending real data.**

**Dataset:** Vehicle — Bolero Truck LM-3067 (Kandy, seats 2), authorized
drivers per `vehicle_authorizations`: Ajith Dissanayake (Kandy), Bandula
Herath (Kandy), Chaminda Peiris (Colombo).

**Commands:**
```
goto /vehicles → click "Bolero Truck( 02 People) LM-3067"
read authorized-drivers list and any ownership/primary-driver language
```

**Expected result:** All 3 authorized drivers listed as equal rows; no
ownership or primary-driver language anywhere on the page.

**Actual result:** All 3 listed (Ajith Dissanayake, Bandula Herath,
Chaminda Peiris), each row reading only "Authorized to drive," plus an
explicit page-level disclaimer: *"Every employee listed here is authorized
to drive this vehicle — this is not an ownership or primary-driver
assignment."* Matches expected.

Screenshot: `screenshots/o09-all-checked-drivers-lm3067.png`

### 2. Same multi-driver vehicle, two different checked drivers, two valid scenarios

**Result: PASS.**

**Dataset:** Vehicle — Van CAB-2288 (2 checked drivers: Chaminda Peiris,
Kamala Wijesinghe). Visit A — Harbour View — Main Building, 2026-09-08.
Visit B — Harbour View — Kitchens, 2026-09-09.
(Note: LM-3067 itself was tried first for this scenario but its 2-seat
capacity can't cover the only compatible Kandy job's 3-person crew
requirement — see the `VEHICLE_CAPACITY_EXCEEDED` finding below. CAB-2288
was used instead as the cleanest same-mechanism substitute — same
"multiple checked drivers on one vehicle" property, no capacity conflict.)

**Commands:**
```
Visit A: assign crew [Chaminda Peiris, Kamala Wijesinghe (PMS)], vehicle
  CAB-2288, driver = Chaminda Peiris, reason filled → Save assignment
Visit B: assign crew [Kamala Wijesinghe (PMS), Dilrukshi Amarasena],
  vehicle CAB-2288, driver = Kamala Wijesinghe, reason filled
  → Save assignment
```

**Expected result:** Both save independently and successfully, each with a
different driver for the same vehicle.

**Actual result:** Visit A saved with driver Chaminda Peiris ("Assignment
saved"). Visit B saved with driver Kamala Wijesinghe ("Assignment saved").
Both confirmed independently persisted. Matches expected.

Screenshots: `screenshots/o09-scenarioA-driver-chaminda-saved.png`,
`screenshots/o09-scenarioB-driver-kamala-saved.png`

### 3. An unchecked employee cannot be selected or saved as driver

**Result: PASS.**

**Dataset:** Vehicle — LM-3067 (checked: Ajith Dissanayake, Bandula
Herath, Chaminda Peiris). Employee — Nadeeka Kumarasiri (Kandy, **not**
checked for LM-3067).

**Commands:**
```
goto Kandy visit "Edit crew" → add crew [Ajith Dissanayake, Nadeeka Kumarasiri]
  → "Add vehicle" → select LM-3067 → click Driver combobox
  → read getByRole('option').allTextContents()
```

**Expected result:** Driver dropdown offers only Ajith Dissanayake (the
one crew member checked for LM-3067); Nadeeka does not appear even though
she's in the crew.

**Actual result:** `driver options: [ 'Ajith Dissanayake' ]` — Nadeeka
absent from the list. Matches expected; an unauthorized employee cannot be
selected, let alone saved, as driver.

Screenshot: `screenshots/o09-unauthorized-driver-excluded.png`

### 4. A driver removed from the crew is revalidated

**Result: PASS.**

**Dataset:** Vehicle — Pickup PJ-5510 (Colombo). Crew — Ruwan Gunasekara
(driver), Sunil Abeykoon (PMS). Visit — Greenfield Brewery — Plant,
2026-10-02.

**Commands:**
```
Build valid state: crew [Ruwan Gunasekara, Sunil Abeykoon (PMS)],
  vehicle PJ-5510, driver = Ruwan Gunasekara
click "Remove crew member" on Ruwan Gunasekara's row (not the vehicle row)
read Vehicles section driver field; read Validation panel text
```

**Expected result:** Removing the driver from the crew clears the
vehicle's driver field and re-triggers validation, flagging the vehicle as
having no authorized driver in the (now-reduced) crew.

**Actual result:** Driver field reverted to placeholder "Driver" after
Ruwan's crew row was removed. Validation immediately showed:

> **No authorized driver** `NO_AUTHORIZED_DRIVER`
> Pickup( 03 People) PJ-5510 has no authorized driver in this crew.
> **What to do:** Sunil Abeykoon in this crew is authorized — name one of
> them as the driver.

Matches expected exactly, including naming the correct remaining eligible
crew member.

Screenshots: `screenshots/before-driver-removed-from-crew.png`,
`screenshots/after-driver-removed-revalidated.png`

### 5. Inactive clients/sites labelled in text, not colour alone

**Result: PASS.**

**Dataset:** Site — Harbour View — Kitchens (customer Harbour View Hotel
remains active) set `isActive = false`. Customer — Greenfield Brewery (and
its one site) set `isActive = false`. (Local DB edit — see Environment
section; no inactive record existed in the seed by default.)

**Commands:**
```
goto /customers with Status=ACTIVE → read row text for Harbour View Hotel
goto /customers, set Status filter=INACTIVE → read row text/badge for
  Greenfield Brewery
```

**Expected result:** Text labels, not colour-only cues, for both the
partially-inactive customer and the fully-inactive one.

**Actual result:** Harbour View Hotel (still Active) row: Sites column
reads **"1 active, 1 inactive"** in plain text. Greenfield Brewery, under
the Inactive filter: Sites column reads **"0 active, 1 inactive"**, Status
column shows an **"Inactive"** badge with a distinct icon (not colour
alone). Matches expected.

Screenshots: `screenshots/o09-active-customer-with-inactive-site-label.png`,
`screenshots/o09-inactive-customer-labeled.png`

### 6. Inactive records excluded from scheduling controls, generate no visits

**Result: PASS.**

**Dataset:** Same inactive site/customer as above.

**Commands:**
```
goto /service-agreements → "Add agreement" → click #customerId
  → read getByRole('option').allTextContents()  (expect no Greenfield Brewery)
select "Harbour View Hotel" → click #serviceSiteId
  → read listbox options  (expect only Main Building, not Kitchens)
goto /visits → "Generate visits" → read preview body text for "Kitchens"
```

**Expected result:** The inactive site is excluded from its (still-active)
customer's site picker; the inactive customer is excluded from the
customer picker entirely; visit generation proposes nothing for either.

**Actual result:** Customer picker options = `['Harbour View Hotel', 'Hill
Country Tea Factory']` — Greenfield Brewery absent. Site picker for
Harbour View Hotel = `['Harbour View — Main Building']` — Kitchens absent.
Generate-visits preview text does not mention "Kitchens" anywhere. Matches
expected on all three checks.

Screenshot: `screenshots/o09-inactive-site-excluded-from-picker.png`

### 7. Historical information remains accessible

**Result: PASS.**

**Dataset:** Greenfield Brewery — Plant visit generated on 2026-10-02,
before Greenfield Brewery was deactivated.

**Commands:**
```
(after deactivating Greenfield Brewery)
goto /dispatch-board, date=2026-10-02 → read row for Greenfield Brewery
```

**Expected result:** A visit generated before deactivation stays visible
and editable — deactivation affects future scheduling, not existing
records.

**Actual result:** The 2026-10-02 Greenfield Brewery — Plant visit is
still listed on the Dispatch Board, with its "Edit crew" action still
available, after the customer was set inactive. Matches expected.

Screenshot: `screenshots/o09-historical-info-still-accessible.png`

---

## Additional validation coverage found along the way (bonus evidence for the manager guide)

Beyond the specific rules O08/O09 named, the same UAT pass surfaced two more
validation categories worth including in the manager guide's error-recovery
section, since a manager will hit them in real use:

- **`SKILL_NOT_HELD`** — "This job needs MBR_FUMIGATION and nobody in the
  crew holds it." (crew has the right headcount and PMS grade, but not the
  right skill). Observed live on Greenfield Brewery — Plant, 2026-10-02,
  with crew [Ruwan Gunasekara, Sunil Abeykoon (PMS)], neither holding
  MBr Fumigation.
- **`VEHICLE_CAPACITY_EXCEEDED`** — "Bolero Truck LM-3067 seats 2 and the
  crew is 3." Observed live trying to assign LM-3067 (seats 2) to Hill
  Country — Drying Floor (crew size 3). Capacity is checked per assigned
  vehicle against the full onsite crew count; adding a second, smaller
  vehicle to carry the overflow did **not** clear the error (tried: LM-3067
  + Motor Bike BFT 9134 together for a 3-person crew — BFT 9134 alone was
  then flagged "seats 1 and the crew is 3," i.e. each vehicle is validated
  against the whole crew, not a portion of it) — worth a manager-guide
  callout so managers don't assume they can split a crew across multiple
  vehicles.

Also worth noting for the guide: **"Save assignment" stays disabled until
"Reason for this change" is filled in**, even once the Validation panel says
"This crew is eligible to take the visit." Observed directly: with a fully
valid crew/vehicle/driver and an empty Reason field, Save's `disabled`
attribute remained true; filling Reason with no other change flipped it to
enabled. This isn't announced anywhere in the UI — a manager could stare at
a silently-disabled Save button with no visible error. Recommend the guide
calls this out explicitly as a recovery step (already added).

---

## Defects found

### 1. Re-opening an already-assigned visit shows false "double-booked" errors against itself

**Dataset:** The already-saved valid assignment from the vehicle-authorization
scenario above (Harbour View — Main Building, 2026-09-08, crew [Chaminda
Peiris, Kamala Wijesinghe], vehicle CAB-2288/Chaminda Peiris).

**Commands:**
```
goto /dispatch-board, date=2026-09-08 → click "Edit crew" (no edits made)
read Validation panel text immediately on open
```

**Expected result:** Re-opening a visit that was just saved with a fully
valid assignment should show it as still valid (or at minimum, no false
conflict against itself).

**Actual result:**

- `Employee overlap / EMPLOYEE_DOUBLE_BOOKED` for Chaminda Peiris: "already
  on another job from 08:00 to 12:00 on 2026-09-08" — the "other job" is
  this same visit's own just-saved assignment.
- `Employee overlap / EMPLOYEE_DOUBLE_BOOKED` for Kamala Wijesinghe, same
  cause.
- `Vehicle overlap / VEHICLE_DOUBLE_BOOKED` for CAB-2288, same cause.

`Save assignment` disabled throughout. Reproduced twice: once on a
completely untouched re-open (screenshot below), and again after adding one
more crew member on a separate attempt. **Does not match expected** — this
is a real defect.

**Impact:** a manager cannot currently make any further edit to an
already-assigned visit (swap a sick employee, change the vehicle, adjust
the time) — every re-open is blocked by the tool treating the visit's own
existing assignment as a conflict with itself. Underlying save itself is
correct (confirmed via a fresh page reload showing the right
supervisor/crew/vehicle with no error state) — this is specifically a
re-open/re-validate bug, not a data-corruption bug.

**Root cause (from reading, not modifying, the source):** the check call is
`POST /visits/{visitId}/assignment/check` — the visit ID is already in the
URL, so the fix (excluding the visit's own current assignment from its own
overlap check) belongs in the API's eligibility logic. **Flagged for the
API owner rather than fixed here** — backend files are out of scope for
this UAT pass.

**Suggested severity:** high — blocks a routine manager workflow, though
data itself is not corrupted and a workaround exists (Remove crew, then
rebuild from scratch instead of editing in place). Recommend the API owner
confirms severity/fix before pilot sign-off, per the O08 release gate
requiring zero unresolved critical/high defects.

Screenshot: `screenshots/permanent-station-validation-and-reopen-bug.png`
(shows the false overlap errors alongside the correct
`EMPLOYEE_PERMANENTLY_STATIONED` error in the same validation list, proving
the permanent-station check itself is unaffected — only the overlap check is
wrong).

---

## Known limitations of this UAT pass

1. **Not the real employee matrix or master schedule.** Per
   `data/README.md`, `technician-matrix.xlsx` and `master-schedule-2026.xlsx`
   are never committed (real personnel/customer data) and weren't available
   in this sandbox. This pass used `pnpm db:seed:demo`'s fabricated 14-person
   workforce and 3 fabricated customers. Every rule above is proven to work
   *mechanically*; O08 also requires the same walk-through against the real
   imported data on staging. **Per Whyshni's update:** C07 is reconciled,
   local typechecks/lint/unit tests/production builds are green, and the
   real workbook dry-runs pass (including DAC-2485 normalization and 30 red
   inactive records) — staging package/runbook is ready locally, pending a
   staging host and GitHub PR/CI. This document will be re-run against that
   data once the staging URL is available.
2. **Demo vehicles need a branch assigned by hand.** See Environment section
   above for the exact fix applied locally (not a code or migration change).
   Worth a demo-seed follow-up (owner: API) so a fresh demo environment can
   exercise vehicle assignment out of the box.
3. **No inactive customer/site existed in demo data**, so one site and one
   customer were deactivated directly in the local database (see
   Environment section) to exercise the O09 inactive-record scenarios.
   Also revealed: **manager-web has no deactivate/reactivate control in the
   UI itself** — `isActive` is read-only in this phase, set only by the
   master-schedule import. If a manager is expected to deactivate a
   customer/site themselves during the pilot (rather than it always coming
   from a re-import), that's a gap worth confirming with the Project Lead
   before sign-off.
4. **`DAC-2485` (the real vehicle named explicitly in O09) doesn't exist in
   demo data** — sub-scenario 1 used a demo vehicle with an equivalent
   shape (3 checked drivers) instead. Per Whyshni's update, the real
   workbook dry-run already covers DAC-2485 normalization on her side;
   this doc's own screenshot-based check against it is still pending the
   staging URL.
5. **Release gate "screenshots match the deployed staging interface"
   cannot be satisfied yet** — there is no staging deployment reachable
   from this UAT pass. All screenshots in this document are from local
   dev. Waiting on the staging URL per Whyshni's message.

---

## Still to do (blocked on staging)

- Re-run every scenario above against the real imported data once the
  staging URL is available, including the specific DAC-2485 check.
- Re-take every screenshot against the deployed staging interface (release
  gate requirement).
- Only then: mark ULK-O08 complete and request the final UAT gate sign-off.

**PR #36 (branding/redesign) stays separate and unmerged into the release
candidate per instruction — not part of this UAT scope.**

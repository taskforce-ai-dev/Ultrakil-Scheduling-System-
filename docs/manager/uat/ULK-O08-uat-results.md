# ULK-O08 — UAT results (working draft)

Status: local demo-data pass complete (below); deployed real-data pass
started 2026-09-09 against `https://ultrakil-manager-web.vercel.app` — see
"Deployed real-data UAT pass" section. **Not marked complete.** The
assignment-save transaction-timeout defect (below) was fixed and deployed
by the API owner as `6fe1838` (PR #49), ~10:17 UTC 2026-09-09 — see "Fix
deployed" under scenario 1. That fix is reported and verified by the API
owner, not yet independently re-confirmed through the manager portal UI in
this UAT pass: this session currently has no network path to
`https://ultrakil-manager-web.vercel.app` (outbound requests are rejected
by this environment's network policy) or a browser tool to drive it, so
the required rerun (reopen the existing draft, confirm no self-conflict,
one save, capture UI + HTTP evidence) is still pending someone with
deployed access. O08 stays In Progress until that independent
confirmation happens. PR #36 (branding) has since merged into `main` and
is reflected in the deployed UI's screenshots below.

## Deployed real-data UAT pass — 2026-09-09

**Deployed URL:** `https://ultrakil-manager-web.vercel.app`
**Tested release:** API commit `5645913b544c8221e777b9f4198d7c0dc376ad6f`
(deployment `dpl_DQpV9Hf8sEebV5QEXLuNgJAVuCht`, PR #48) — one commit ahead
of `b191187` (PR #47), the release cited when this pass was requested; both
are on `main`, `5645913` was simply the current production deployment at
test time.
**Test window:** approximately 2026-09-09 08:59–09:47 UTC.
**Login:** the seed admin account (`admin@taskforceai.tech`) works against
the deployed API — confirmed by successfully signing in and pulling real
data through it.
**Real data confirmed:** the Dispatch Board shows real customers —
Ceylon Chocolate - Bluemandal, Ceylon Electricity Board, MCA, SINTESI
(Incube)/Quantum clothing — not the fabricated demo set used in the local
pass below. `DAC-2485` (named explicitly in O09, absent from demo data) is
present in this data.

**Screenshots:** this section's evidence is described from screenshots
reviewed live during the session (browser, not this repo's checkout) —
the actual image files have not yet been exported and committed here.
Retaking and committing real PNG evidence for this section is a genuine
remaining gap, not done in this pass (see "Still to do").

### 1. Reopen/save an assigned visit, no false self-conflict — blocked

**Result: inconclusive — blocked by a new, unrelated production defect,
not by the self-overlap defect this scenario targets.**

Opened an already-**published**, scheduler-generated visit ("Ceylon
Chocolate - Bluemandal - April 2026"): the app correctly refused manual
re-crewing with *"This visit is on a published schedule and cannot be
re-crewed by hand. Run the scheduler again and publish the new run to
replace it — the published one is kept as a record."* The Validation panel
never ran an eligibility check (blocked earlier, by the publish-lock), so
**no false `EMPLOYEE_DOUBLE_BOOKED`/`VEHICLE_DOUBLE_BOOKED` error appeared**
— nothing here contradicts the C07 `excludeAssignmentId` fix — but this
isn't a clean confirmation of it either, since the Validation panel was
never exercised.

To get a clean test, built a fresh manual assignment instead (visit:
"SINTESI (Incube)/Quantum clothing," 2026-09-09; crew: K Kanagaraja (PMS),
Kamal Fernando (PMS), Saman Priyantha). Validation correctly progressed
through `CREW_TOO_SMALL` → *"This crew is eligible to take the visit"* as
crew was added. Clicking **Save assignment** then failed:

> Something went wrong on the server. The team has been notified — please
> retry, and report the timestamp if it persists.

**Reproduced 3/3** (09:20:48, 09:21:04, 09:21:43 UTC), same visit, no
change to steps. Root cause, from the deployed API's Vercel runtime logs:

```
PrismaClientKnownRequestError: Transaction API error: Transaction already closed:
A query cannot be executed on an expired transaction. The timeout for this
transaction was 5000 ms, however 8847 ms passed since the start of the transaction.
```
at `apps/api/src/scheduling/eligibility/assignments.service.js:93`, inside
the interactive transaction opened at line 74 (`AssignmentsService.assign`).
Duration got worse across attempts: 5300ms → 5328ms → 8847ms, all over the
5000ms budget — not a one-off flake.

**Impact:** blocks this scenario, and any other O08/O09 scenario that
requires saving a new or changed assignment (driver removal/revalidation
included). Reported to the API owner (Thivarrakesh) with this exact trace,
~09:22 UTC 2026-09-09. **Does not affect** scenarios that only read
existing data.

**Fix deployed, ~10:17–10:23 UTC 2026-09-09 — reported and verified by the
API owner, not independently re-run in this UAT pass:** Thivarrakesh
shipped `apps/api/src/scheduling/eligibility/assignments.service.ts` +
`visits.service.ts` changes keeping manager eligibility writes inside the
transaction, merged as `6fe1838ef2513d4214d4dc1846388a3b59d6711d` (PR #49).
His own verification against the canonical deployed manager/API, ~10:23
UTC:

- Reopened the existing editable draft — eligibility check `HTTP 200`, no
  self-conflict.
- Saved the unchanged assignment once with a UAT audit reason —
  `PUT /api/visits/{id}/assignment` → `HTTP 200`.
- Follow-up assignment `GET` and eligibility check — both `HTTP 200`.
- No runtime errors in Vercel after the deployment.

This is the API owner's own report, taken at face value and cited here
with attribution — it is **not** the independent UI-driven confirmation
this document's evidence bar otherwise requires (every other "pass" above
was clicked through directly in this pass). That confirmation — reopen the
existing draft in the manager portal, verify no false conflict, save once,
screenshot the result — is still outstanding, blocked on this session
having no network access to the deployed app right now (see status note
at the top of this document). **Expected vs. actual, pending that rerun:**
expected is unchanged from the original scenario — reopening a
just-/previously-saved assignment shows it as valid with no self-overlap
error, and Save completes without a server error; actual (per the API
owner's report) matches that expectation, but hasn't yet been observed
directly by this UAT.

### 2. DAC-2485 and its three authorized drivers — pass

`DAC-2485` (Bolero Truck, 2 seats) detail page lists **exactly three**
authorized drivers, each an equal row reading only "Authorized to drive,"
with the correct disclaimer ("not an ownership or primary-driver
assignment"): P Selvaraj, S Tharilingam, T M Supun Tharaka Wijeweera (the
last tagged PMS-grade). Matches expected exactly.

**Side observation, not a defect:** the vehicle itself shows
**"Unassigned branch,"** while all three drivers are tagged "Colombo" —
worth a mention in known-limitations, not necessarily a bug.

### 3. Inactive records producing no future jobs — not testable right now

**Result: cannot be exercised against current real data.** The Customers
list, filtered to Status = Inactive, returns *"No inactive customers —
every customer on record is currently active."* No inactive
customer/site exists in the real imported dataset at all right now, so
there is nothing to generate zero future jobs *from*. Not a defect — a
data-availability gap in this pass.

### 4. Kandy remaining unassigned when no PMS-qualified supervisor is available — not testable right now

**Result: cannot be exercised against current real data.** Unassigned
Visits, filtered to Branch = Kandy, returns *"Nothing unassigned — every
visit currently has a valid crew and vehicle assignment."* Every Kandy
visit is currently staffed, so there's no live example of this scenario
today. Not a defect.

**Side observation:** the Conflict-type filter on this screen confirms
`Missing PMS supervisor` exists as a first-class category alongside
`Insufficient crew`, `Missing skill`, `No authorized driver`, `Unavailable
vehicle`, `Branch restriction`, `Permanent-staff restriction`,
`Service-window conflict`, `Employee overlap`, `Vehicle overlap`, `Other`
— useful confirmation even without a live example to screenshot.

### 5. O09 regression: unauthorized-driver rejection — pass

On the same published Ceylon Chocolate visit (5 vehicles, all with drivers
already assigned), opened the driver dropdown for each vehicle in turn.
Every dropdown offered **only the crew members actually authorized for
that specific vehicle** — e.g. one vehicle's dropdown offered exactly 2
names (P Selvaraj, T M Supun Tharaka Wijeweera), not the full crew or
employee list. Matches expected.

**Side observation:** these dropdowns were interactive despite the visit
being publish-locked for saving — worth a mention, not necessarily a bug.

### 6. O09 regression: driver removal/revalidation, preserved history, inactive-record exclusion from pickers — not run

Driver removal/revalidation requires a Save to observe the revalidation
step; the transaction-timeout defect that blocked this is now fixed on
deployed (`6fe1838`, see "Fix deployed" under scenario 1) but this scenario
still hasn't been re-attempted — this UAT pass has no network access to
the deployed app to attempt it. Preserved-history and inactive-picker
exclusion both require an inactive record to exist, blocked by the
data gap in #3 above (unchanged — still no inactive records in the live
dataset). None attempted this pass.

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
preferred," both passing. Matches expected.

**Auditable evidence for the full-suite claim:** the "148/148" figure
originally cited here was stale. Re-run for this correction pass,
`pnpm exec vitest run` from `apps/manager-web` on this branch reports
**166 passed (166), 17 test files, 0 failed** (`Start at 11:23:03`,
`Duration 15.60s`); full console output saved as evidence at
`uat/test-run-evidence-manager-web.txt`. The subset-enforcement assertions
above are inside `service-agreements.test.tsx`, which the same run reports
as 11/11 passing.

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
`screenshots/dispatch-board-valid-assignment-persisted.png`.
**Correction:** `screenshots/valid-assignment-saved-toast.png` was
originally listed here as third clean-save evidence. On review its
Validation panel visibly shows `EMPLOYEE_DOUBLE_BOOKED` for both Chaminda
Peiris and Kamala Wijesinghe, comparing this same visit's assignment
against itself — it is historical evidence for finding #1 below (the
self-overlap defect, already fixed on current `main`), not a clean save,
and has been moved there. The underlying save and the Dispatch Board's
read-only view (`dispatch-board-valid-assignment-persisted.png`) remain
correct, so "Matches expected" above still holds; only the screenshot
list was wrong.

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

**Result: PASS on backend acceptance; independent-persistence confirmation
still pending** — see correction below.

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
saved" toast observed). Visit B saved with driver Kamala Wijesinghe
("Assignment saved" toast observed). Each save was accepted by the
backend with the intended driver — that part matches expected.

**Correction — evidence and the "confirmed independently persisted"
claim:** the two screenshots below, and the "confirmed independently
persisted" wording above, were carried over from an earlier draft. Both
screenshots actually show the toast layered over a Validation panel
already flagging `EMPLOYEE_DOUBLE_BOOKED` for the crew against this same
visit's own just-saved assignment — the same pre-fix self-overlap defect
as finding #1 below (already fixed on current `main`), not independent
confirmation via the Dispatch Board's read-only view (unlike the
vehicle-authorization scenario above, no such reload screenshot was taken
for either visit here). Reclassified as historical defect evidence.
**Re-run required:** confirm both saves independently via a Dispatch Board
reload (not a drawer reopen) on the deployed app, and capture that as the
clean evidence for this scenario — blocked for now by the deployed
assignment-save defect (see "Deployed real-data UAT pass," scenario 1).

Screenshots (defect evidence, not clean-save evidence — see correction
above): `screenshots/o09-scenarioA-driver-chaminda-saved.png`,
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

## Historical local-UAT findings (fixed on current main)

### 1. [Fixed on current main, partially confirmed on deployed real data] Re-opening an already-assigned visit showed false "double-booked" errors against itself

**Status at time of this UAT pass:** open defect, found locally.
**Status now:** fixed on current `main`. This section is kept as the
original repro record, not as an open defect — see "Fix verification"
below.

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

**Actual result at the time (pre-fix, local baseline):**

- `Employee overlap / EMPLOYEE_DOUBLE_BOOKED` for Chaminda Peiris: "already
  on another job from 08:00 to 12:00 on 2026-09-08" — the "other job" is
  this same visit's own just-saved assignment.
- `Employee overlap / EMPLOYEE_DOUBLE_BOOKED` for Kamala Wijesinghe, same
  cause.
- `Vehicle overlap / VEHICLE_DOUBLE_BOOKED` for CAB-2288, same cause.

`Save assignment` disabled throughout. Reproduced twice: once on a
completely untouched re-open (screenshot below), and again after adding one
more crew member on a separate attempt. **Did not match expected at the
time** — a real defect in the local-UAT baseline.

**Impact at the time:** a manager could not make any further edit to an
already-assigned visit (swap a sick employee, change the vehicle, adjust
the time) — every re-open was blocked by the tool treating the visit's own
existing assignment as a conflict with itself. Underlying save itself was
correct (confirmed via a fresh page reload showing the right
supervisor/crew/vehicle with no error state) — this was specifically a
re-open/re-validate bug, not a data-corruption bug.

**Root cause:** the eligibility check triggered by
`POST /visits/{visitId}/assignment/check` was not excluding the visit's own
current assignment from its own overlap query.

**Fix verification (this correction pass):** current `main` already fixes
this. `AssignmentsService.check()`
(`apps/api/src/scheduling/eligibility/assignments.service.ts`) now passes
the visit's existing draft/current assignment id as `excludeAssignmentId`
into `EligibilityService`
(`apps/api/src/scheduling/eligibility/eligibility.service.ts`), which
excludes that assignment from the employee/vehicle overlap queries. Traced
back to the ULK-C07 baseline — confirmed by reading the current source, not
by re-running the UI flow. A deployed real-data attempt was made
2026-09-09 (see "Deployed real-data UAT pass," scenario 1), but it hit the
visit's publish-lock before the Validation panel ever ran, so it isn't a
clean confirmation either.

**Suggested severity (historical, at time found):** high — blocked a
routine manager workflow. **Current status:** not an open defect;
downgraded from the release-blocking list. **Still required before pilot
sign-off:** once the deployed assignment-save defect (item 1 in
`known-limitations.md`) is fixed, re-run this exact scenario on a freshly
saved (non-published) assignment and capture a clean "re-open a saved
visit, no false conflict" screenshot — the fix is verified by code, not
yet by a UI regression run.

Screenshot (historical, pre-fix): `screenshots/permanent-station-validation-and-reopen-bug.png`
(shows the false overlap errors alongside the correct
`EMPLOYEE_PERMANENTLY_STATIONED` error in the same validation list, proving
the permanent-station check itself was unaffected — only the overlap check
was wrong. Kept as the original repro record; superseded by the fix above.)

**Additional historical evidence of the same pre-fix defect, found on
review of this correction pass:** `screenshots/valid-assignment-saved-toast.png`,
`screenshots/o09-scenarioA-driver-chaminda-saved.png`, and
`screenshots/o09-scenarioB-driver-kamala-saved.png` were originally
captured and filed as clean-save evidence elsewhere in this document and
in the manager guide / demonstration script. All three actually show the
same self-comparison `EMPLOYEE_DOUBLE_BOOKED` pattern described above,
against the pre-fix local baseline. They have been reclassified as
historical defect evidence for this item throughout this document, the
manager guide, and the demonstration script; clean-save evidence against
the fixed baseline still needs to be captured on the deployed app, once
the assignment-save defect (see "Deployed real-data UAT pass," scenario 1)
is fixed.

### 2. Add Agreement form shows the raw customer/site UUID instead of the name

**Dataset:** The Add Agreement form (`docs/manager/uat/screenshots/add-agreement-form-full.png`,
also used in the manager guide, section 2).

**Actual result:** Once a customer and site are selected, the closed
Customer and Site fields display the raw internal id (`d3f5aeae-100f-450…`,
`22ba7124-5168-476…`) instead of the customer/site name. The dropdown's
own option list is unaffected — opening either selector shows the correct
names (`apps/manager-web/src/app/(app)/service-agreements/page.tsx:538-540`,
`:560-562`, both rendering `{customer.name}` / `{site.name}` as the option
label) — so this is specifically the closed trigger failing to resolve the
selected id back to its label, not a data problem.

**Impact:** cosmetic/UX, not a data leak — these are internal identifiers,
not customer PII, and no real customer data is involved in this demo
dataset. Still confusing for a manager and makes this screenshot
unsuitable as final documentation.

**Suggested severity:** low. Triaged here rather than fixed in this
docs-only branch — front-end files are out of scope for this pass.
Recommend the manager-web owner confirms whether this is a `SelectValue`
label-resolution bug or a controlled-value/loading-state timing issue,
then this screenshot is retaken.

---

## Known limitations of this UAT pass

1. **Not the real employee matrix or master schedule (local pass only).**
   Per `data/README.md`, `technician-matrix.xlsx` and
   `master-schedule-2026.xlsx` are never committed and weren't available in
   this sandbox, so this local pass used `pnpm db:seed:demo`'s fabricated
   14-person workforce and 3 fabricated customers. Every rule above is
   proven to work *mechanically* against demo data. **Superseded:** the
   deployed real-data pass (see top of this document) has since re-run
   several of these scenarios against the actual imported workbook data.
2. **Demo vehicles need a branch assigned by hand (local pass only).** See
   Environment section above for the exact fix applied locally (not a code
   or migration change). Worth a demo-seed follow-up (owner: API) so a
   fresh demo environment can exercise vehicle assignment out of the box.
3. **No inactive customer/site existed in demo data (local pass)**, so one
   site and one customer were deactivated directly in the local database
   (see Environment section) to exercise the O09 inactive-record
   scenarios. Also revealed: **manager-web has no deactivate/reactivate
   control in the UI itself** — `isActive` is read-only in this phase, set
   only by the master-schedule import. If a manager is expected to
   deactivate a customer/site themselves during the pilot (rather than it
   always coming from a re-import), that's a gap worth confirming with the
   Project Lead before sign-off. **Note:** the real imported dataset has
   the same gap right now — see "Deployed real-data UAT pass," scenario 3.
4. **`DAC-2485` (the real vehicle named explicitly in O09) doesn't exist in
   demo data** — sub-scenario 1 used a demo vehicle with an equivalent
   shape (3 checked drivers) instead. **Resolved:** the deployed real-data
   pass confirms DAC-2485 directly, with its actual three authorized
   drivers — see "Deployed real-data UAT pass," scenario 2.
5. **Deployed assignment save fails — new production defect, not a demo
   data gap.** `PUT /api/visits/{id}/assignment` on the deployed API 500s
   on every attempt with a Prisma interactive-transaction timeout
   (5000ms budget, 5300–8847ms actual). Blocks the reopen/save and
   driver-removal/revalidation scenarios; reported to the API owner. Full
   detail in "Deployed real-data UAT pass," scenario 1.

---

## Still to do

- **Defect fixed, independent confirmation still needed:** the
  assignment-save transaction-timeout defect is fixed and deployed
  (`6fe1838`, PR #49), verified by the API owner directly — see "Fix
  deployed" under scenario 1. Someone with deployed access still needs to
  independently re-run reopen/save and driver removal/revalidation through
  the manager portal UI and capture that evidence; this UAT pass currently
  has no network path to the deployed app to do it.
- Re-run inactive-records and Kandy-no-PMS-supervisor scenarios once the
  real dataset has matching records to exercise them (neither exists in
  the current import).
- Export and commit real PNG screenshots from the deployed UI for the
  "Deployed real-data UAT pass" section — this pass' evidence is
  described from screenshots reviewed live, not yet committed as files.
- Only then: mark ULK-O08 complete and request the final UAT gate sign-off.

**PR #36 (branding/redesign) has merged into `main`** and its palette/logo
are what the deployed screenshots above actually show.

# ULK-O08 / O09 — deployed UAT, staging release `13b2456`

**Status: IN PROGRESS.** Group A is complete, all 7 directly evidenced.
Group B is complete, all 5. Group C is complete except C5. Group D is complete, all 13 routes. Blank Actual/PASS-FAIL cells are blank by
design and are not evidence until filled in from a real run.

**Scenario inventory — 33 scenarios, exactly one status each.**
Group A 7 (A1-A7) + Group B 5 (B1-B5) + Group C 8 (C1-C8) + Group D 13
(one per route) = 33.

Final: **30 PASS, 0 FAIL, 3 NOT DEMONSTRABLE, 0 outstanding.**

> **Correction (2026-09-23).** An earlier revision of this header read "16
> PASS ... 14 not yet run". Both figures were wrong: the running total was
> maintained by hand and drifted from the per-scenario rows, double-counting
> C1 (recorded as "both halves PASS" against a single scenario row) and
> undercounting the unstarted Group D routes. The per-scenario rows below
> were correct throughout and are the authority; this header now derives from
> them. Sixteen scenarios carry no status (B5, C5, C8 and the 13 Group D
> routes). A6 additionally held a provisional status pending direct
> observation, which is why the outstanding *work* list had 17 items against
> 16 unstatused scenarios; that observation was made on 2026-09-23, so the
> two now agree at 16.

| | |
| --- | --- |
| Portal | `https://ultrakil.taskforceai.tech` |
| Release under test | `main@13b2456` (PR #67, audit bunching repairs by batch UUID) |
| Included PRs | #59, #61, #62, #63, #65, #66, #67 |
| Tester | Oshadi Whyshni Kumaravel |
| Date (UTC) | 2026-09-22 |
| Method | Groups A/B executed via the committed Playwright spec against the deployed URL (`E2E_BASE_URL=https://ultrakil.taskforceai.tech`), Chromium, Desktop Chrome viewport. Groups C/D remain manual. |
| Account | A manager account held in the protected release record. The credential used was handled outside a secret store during setup and is flagged for rotation; it is deliberately not named here. |

This pass supersedes the `b694823` pass of 2026-09-10 recorded in
`ULK-O08-uat-results.md`. That release and dataset are **history**: its counts
(28 inactive sites, 479 visits, 37 employees) are not expected values here and
must not be copied forward.

## Consolidated scenario matrix — 33 scenarios, one status each

Requested by the Technical Director, 2026-09-23. Every scenario below carries
exactly one of **PASS**, **FAIL** or **NOT DEMONSTRABLE**; rows still to be
run carry **PENDING** and are not claimed as any of the three until observed.
Detail for each row is in its group table further down; this matrix is the
single reconciled count.

Release under test for every row: **`main@13b2456`**, portal
`https://ultrakil.taskforceai.tech`. "Evidence" cites the run that produced
the Actual cell.

| # | ID | Route | Record / date used | Expected | Actual | Status | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | A1 | `/vehicles/[id]` | `DAG-3284` | exactly 3 authorised drivers, shown equally | 3 shown, equally | **PASS** | spec `07-…`, 3.6s, 2026-09-22 |
| 2 | A2 | `/vehicles/[id]` | `ABE-7244` | exactly 4 authorised drivers, shown equally | 4 shown, equally | **PASS** | spec `07-…`, 3.4s, 2026-09-22 |
| 3 | A3 | `/vehicles/[id]` | `PJ-6796` | exactly 2 authorised drivers, shown equally | 2 shown, equally | **PASS** | spec `07-…`, 3.5s, 2026-09-22 |
| 4 | A4 | `/vehicles/[id]` | `DAI-0191` | exactly 2 authorised drivers, shown equally | 2 shown, equally | **PASS** | spec `07-…`, 3.4s, 2026-09-22 |
| 5 | A5 | `/vehicles/[id]` | `DAC-2485` | exactly 3 named drivers (EMP-04, EMP-05, EMP-06) | all 3 named drivers visible, 3 driver rows | **PASS** | spec `07-…`, 3.3s, 2026-09-22 |
| 6 | A6 | `/vehicles` | search `DAC-2485`, then search `2485` | appears **once only** under its normalised code | **exactly one row on both searches.** `DAC-2485` → one row, *Bolero Truck (2 People) DAC-2485*, Colombo, Seats 2, Authorized drivers 3, Available. The separator-insensitive search `2485` returned the **same single row**, so no duplicate exists under a variant spelling (`DAC2485`, `DAC 2485`) that a hyphenated search would have missed. | **PASS** | direct observation, 2026-09-23 |
| 7 | A7 | `/vehicles/[id]` | A1–A4 vehicles | no driver row reads "primary driver", "backup driver" or "owner" | asserted per driver row across A1–A4; none matched | **PASS** | spec `07-…`, 2026-09-22 |
| 8 | B1 | `/customers` | Status filter = Inactive | ≥1 row labelled "Inactive" in text | 0 rows — empty state *"No inactive customers — Every customer on record is currently active."* | **NOT DEMONSTRABLE** | manual browser check, 2026-09-22 |
| 9 | B2 | `/service-agreements` | customer picker | the B1 inactive customer is not offered | not reachable — depends on a record B1 established does not exist | **NOT DEMONSTRABLE** | dependency on B1, 2026-09-22 |
| 10 | B3 | `/customers` | active customer with mixed sites | inactive site count visible in text | inactive site count present in text | **PASS** | spec `07-…`, 4.6s, 2026-09-22 |
| 11 | B4 | `/service-agreements` | same customer, site picker | exactly N options (active only); inactive site absent | site picker offered exactly the active count; inactive site absent | **PASS** | spec `07-…`, 4.6s, 2026-09-22 |
| 12 | B5 | `/customers` | CUST-07, CUST-02, CUST-03, CUST-04 (all Colombo) | history preserved, not deleted | **preserved and visible.** Inactive sites remain listed under their customer with an explicit **"Inactive"** text badge — they are retained, not removed. Counts render as e.g. *"54 active, 3 inactive"* (CUST-07), *"48 active, 15 inactive"* (CUST-03), *"89 active, 5 inactive"* (CUST-04). A page-wide find for "inactive" returned **33 matches**. | **PASS** | operator pass, 2026-09-23 |
| 13 | C1 | `/unassigned-visits` → Edit crew, then `/dispatch-board` | CUST-01 / SITE-01, 09/09/2026, Colombo | save succeeds; on reopen no false `EMPLOYEE_DOUBLE_BOOKED` / `VEHICLE_DOUBLE_BOOKED` against itself | saved (crew EMP-01 PMS + EMP-02, vehicle AAV-2359, driver EMP-01); reopened from dispatch board — *"This crew is eligible to take the visit."*, neither self-conflict fired | **PASS** | manual, 2026-09-22 (the one write of this pass) |
| 14 | C2 | `/unassigned-visits` → Edit crew | same visit | at most one vehicle per assignment | picker permits attaching a second; validation refuses the save — *"2 vehicles are assigned to this visit … a crew travels in one."* Rule holds at the save boundary. | **PASS** | manual, 2026-09-22 |
| 15 | C3 | `/unassigned-visits` → Edit crew | same visit | checked driver accepted; unchecked rejected with `NO_AUTHORIZED_DRIVER` | rule fired on real data for AAV-2359 (named EMP-01) and independently for ABE-7244 (named EMP-02); naming the authorised driver cleared it | **PASS** | manual, 2026-09-22 |
| 16 | C4 | `/dispatch-board` → Edit crew | same visit | removing the driver from the crew clears the driver field immediately | cleared immediately to *"No crew member is authorized"*; three rules re-fired; guidance adapted correctly. Abandoned without saving. | **PASS** | manual, 2026-09-22 |
| 17 | C5 | `/visits` (Generate Schedule calendar) | CUST-06, CUST-02, CUST-05 — Sept/Oct/Nov 2026, filtered per customer | no future visit references an inactive customer or site | **No counter-example found.** The inactive-*customer* half is vacuous: B1 established 0 inactive customers exist. For inactive *sites*, three customers holding 7 inactive sites between them were filtered individually across future months — **CUST-06 0 visits (Oct, Nov), CUST-02 0 (Sept, Nov), CUST-05 0 (Sept)** — so none has future work of any kind, let alone at an inactive site. Coverage is partial; see the scope note. | **PASS** (sampled — see note) | operator pass, 2026-09-23 |
| 18 | C6 | `/unassigned-visits`, `/dispatch-board`, `/calendar` | Branch = Kandy | compliant Kandy work present and unassigned, with a readable reason | no Kandy work exists in any state — unassigned queue (no date filter), dispatch board 2026-09-22, and calendar Sept + Oct 2026 all empty | **NOT DEMONSTRABLE** | manual, three independent checks, 2026-09-22 |
| 19 | C7 | `/dispatch-board` | Colombo, 2026-09-20 | imported 08:00–17:00 shown as assumed, never confirmed | flagged twice per visit — row *"Assumed hours: 08:00–17:00 — confirm site hours"* and a provenance line stating the hours are unconfirmed | **PASS** | manual, 2026-09-22 |
| 20 | C8 | `/published-assignment-repairs` | Repair Center, History list, 2026-09-23 | preview/apply state readable and consistent with 59 agreements / 155 visits moved | **Readability: PASS.** Page states its purpose, carries the safety notice *"Planning writes nothing — building a plan reserves no crew or vehicle and changes no published history"*, and lists **History 27** past published assignments, each with a named violation and a *what to do* line. Six sampled records had their weekday labels verified against a real calendar and all six were correct. **Numeric consistency: not verifiable from the browser** — the page surfaces no 59/155 figures; referred to the backend lane. | **PASS** (screen readability, Oshadi's lane) | operator pass, 2026-09-23 |
| 21 | D1 | `/dashboard` | — | route reachable, no broken layout | loaded, layout intact | **PASS** | operator pass, 2026-09-23 |
| 22 | D2 | `/customers` | — | route reachable, no broken layout | loaded, layout intact | **PASS** | operator pass, 2026-09-23 |
| 23 | D3 | `/service-agreements` | — | route reachable, no broken layout | loaded, layout intact | **PASS** | operator pass, 2026-09-23 |
| 24 | D4 | `/workforce` | — | route reachable, no broken layout | loaded, layout intact | **PASS** | operator pass, 2026-09-23 |
| 25 | D5 | `/workforce/[employeeId]` | EMP-03, Colombo | route reachable, no broken layout | loaded with all sections rendered: chips (Colombo / Not PMS-grade / Available / Permanently stationed), banner *"Permanently stationed at SITE-14…"*, Position JPMT, a populated Skills list, and Vehicle authorizations reading *"Not authorized to drive any vehicle yet."* | **PASS** | operator pass, 2026-09-23 |
| 26 | D6 | `/vehicles` | — | route reachable, no broken layout | loaded, layout intact; also exercised by A6's two searches | **PASS** | operator pass, 2026-09-23 |
| 27 | D7 | `/vehicles/[vehicleId]` | — | route reachable, no broken layout | loaded — A1–A5 each navigated to a vehicle detail page and asserted `Vehicle code: <code>` plus its driver rows, which the route could not satisfy unless it rendered | **PASS** | operator pass, 2026-09-23 |
| 28 | D8 | `/visits` | — | route reachable, no broken layout | loaded, layout intact | **PASS** | operator pass, 2026-09-23 |
| 29 | D9 | `/calendar` | — | route reachable, no broken layout | loaded, layout intact | **PASS** | operator pass, 2026-09-23 |
| 30 | D10 | `/dispatch-board` | — | route reachable, no broken layout | loaded, layout intact | **PASS** | operator pass, 2026-09-23 |
| 31 | D11 | `/unassigned-visits` | — | route reachable, no broken layout | loaded, layout intact | **PASS** | operator pass, 2026-09-23 |
| 32 | D12 | `/schedule-history` | — | route reachable, no broken layout | loaded, layout intact | **PASS** | operator pass, 2026-09-23 |
| 33 | D13 | `/published-assignment-repairs` | — | route reachable, no broken layout | loaded, layout intact | **PASS** | operator pass, 2026-09-23 |

**Count: 30 PASS · 0 FAIL · 3 NOT DEMONSTRABLE · 0 PENDING = 33. All scenarios have a final status.**

Row 6 (A6) was already counted in the 14 on inferred evidence; the
2026-09-23 observation replaces the inference with a direct check and does
not change the count. It was the one item appearing both in the PASS total
and on the outstanding-work list, which is why that list held 17 items
against 16 unstatused scenarios. With A6 observed, the two now agree at 16.

### NOT DEMONSTRABLE — required justification

Each item states (1) why the deployed data or UI cannot demonstrate it,
(2) what was checked instead, and (3) whether the limit is a data-fixture
limitation or a product limitation.

**B1 — inactive customer is labelled in text.**
1. *Why not demonstrable:* the scenario needs at least one customer whose
   whole record is inactive. This dataset contains none, so the filtered list
   renders its empty state and there is no row to inspect.
2. *Checked instead:* the Inactive filter was applied by hand in the browser
   and returned *"No inactive customers — Every customer on record is
   currently active."* The automated spec's `test.skip()` was not accepted as
   evidence; the absence was confirmed manually. B3 and B4 cover the shape
   this dataset does have — inactive **sites** under an active customer — and
   both PASS.
3. *Classification:* **data-fixture limitation.** The real master schedule
   marks individual sites as no longer serviced rather than deactivating a
   whole customer. No product defect is implied, and none was observed.

**B2 — inactive customer is withheld from the agreement picker.**
1. *Why not demonstrable:* it asserts the absence of the B1 record from a
   picker. With no inactive customer in the dataset, the assertion has no
   subject and would pass vacuously — which is not evidence.
2. *Checked instead:* B4 exercises the identical suppression rule one level
   down, on inactive **sites**, and confirms the site picker offers exactly
   the active count with the inactive site absent. The suppression behaviour
   is therefore demonstrated, just not at customer granularity.
3. *Classification:* **data-fixture limitation**, inherited from B1.

**C6 — Kandy work is left unassigned when no PMS-qualified supervisor exists.**
1. *Why not demonstrable:* the rule needs at least one Kandy visit to act on.
   This import produces no Kandy work at all, so there is nothing for the rule
   to leave unassigned and no reason string to read.
2. *Checked instead:* three independent views, because an empty unassigned
   queue alone is ambiguous — it reads the same whether no Kandy work exists
   or Kandy work exists and has been wrongly **assigned**, the latter being a
   hard-rule violation. (a) Unassigned Visits, Branch = Kandy, no date filter
   — "Nothing matches these filters"; (b) Dispatch Board, Kandy, 2026-09-22 —
   all seven queue counters 0; (c) Calendar, Kandy, September **and** October
   2026 — "Nothing in this range", all four stage counters 0. No Kandy visit
   exists in any state, so the violating case is positively excluded.
3. *Classification:* **data-fixture limitation.** Unchanged from the
   `b694823` pass, which recorded the same condition. No product defect is
   implied, and none was observed.

---

## Identifiers in this record — read this first

This repository is **public**. Every real employee, customer and site name
from the imported workbooks, and every real person-to-vehicle or
person-to-assignment relationship, has been replaced here with a **stable
scenario ID**:

| Prefix | Means | Example |
| --- | --- | --- |
| `EMP-nn` | An UltraKIL employee | `EMP-01` |
| `CUST-nn` | A customer | `CUST-01` |
| `SITE-nn` | A service site | `SITE-01` |

The IDs are **stable across this document**: `EMP-01` is the same person
everywhere it appears, so a reader can still follow a scenario end to end.
Role, grade, branch, status and dates are retained wherever they are the
evidence — those are operational facts, not identifying ones.

**Vehicle codes are retained deliberately.** `DAC-2485`, `DAG-3284` and the
others name the specific regressions this release had to prove, and cannot be
substituted without destroying the evidence. They identify company assets, not
people.

**The ID-to-name mapping is held in the protected ClickUp handover record,
never here.** Anyone who legitimately needs to resolve a scenario ID to a real
record gets it from there.

---

## Before starting — read these three notes

**1. A missing record is a FAIL here, not a skip.** The automated suite
(`apps/manager-web/e2e/07-vehicle-drivers-and-inactive-clients.spec.ts`) calls
`test.skip()` when a vehicle or customer is not present in the environment, so
it can go green simply because the data was absent. Its own comment says
"Missing records always fail strict acceptance." In this manual pass, if a
record named below cannot be found in the deployed portal, record **FAIL** and
capture what the search returned.

**2. Distinguish a defect from a known limitation.** These four are declared
and expected; a scenario that surfaces one of them is behaving correctly:

- 408 sites with uncertain branch/town mapping, awaiting manager decisions
- imported 08:00–17:00 opening hours remain assumed/unconfirmed
- Kandy has no PMS-qualified supervisor, so compliant Kandy work stays unassigned
- FLY / GPC / ANT / RC / MC skill mappings remain unmapped / null

**3. Screenshot privacy.** Screenshots containing imported employee or client
records go to the protected server release folder, **never** to Git. Public
evidence in this document is limited to counts, rule identifiers and vehicle
codes. Anonymise customer and site names as "Imported customer A / B / …" as
the previous pass did. Vehicle codes and the DAC-2485 driver names are already
public in the committed e2e spec, so those may be named.

---

## Group A — O09 vehicle drivers

Every checkmark in the Technician Matrix is an equal authorisation to drive.
No row may imply ownership or a driver hierarchy: the rendered driver rows must
not contain the words *primary driver*, *backup driver* or *owner*.

**Route for all of A:** `/vehicles` → search box *"Search by code or label"* →
enter the code → open the row → confirm the header reads `Vehicle code: <code>`
→ count the list rows labelled *"Authorized to drive"*.

| # | Vehicle | Expected | Actual | PASS/FAIL | Evidence |
| --- | --- | --- | --- | --- | --- |
| A1 | `DAG-3284` | exactly **3** authorised drivers, shown equally | 3 shown, equally | **PASS** | spec run, 3.6s |
| A2 | `ABE-7244` | exactly **4** authorised drivers, shown equally | 4 shown, equally | **PASS** | spec run, 3.4s |
| A3 | `PJ-6796` | exactly **2** authorised drivers, shown equally | 2 shown, equally | **PASS** | spec run, 3.5s |
| A4 | `DAI-0191` | exactly **2** authorised drivers, shown equally | 2 shown, equally | **PASS** | spec run, 3.4s |
| A5 | `DAC-2485` | exactly **3** — EMP-04, EMP-05, EMP-06 — shown equally | all 3 named drivers visible, 3 driver rows | **PASS** | spec run, 3.3s |
| A6 | `DAC-2485` | appears **once only** under its normalised code (the DAC-2485 normalisation regression) | **exactly one row, confirmed two ways.** Searching `DAC-2485` returned a single row — *Bolero Truck (2 People) DAC-2485*, Colombo, Seats 2, Authorized drivers 3, Available. Searching the bare digits `2485` returned the **same single row**: since that term matches any separator spelling, this rules out a duplicate stored as `DAC2485` or `DAC 2485`, which a hyphenated search could not have detected. Normalisation therefore holds at the stored-record level, not just at one query spelling. | **PASS** | direct observation, 2026-09-23 |
| A7 | any of the above | no driver row contains "primary driver", "backup driver" or "owner" | asserted per driver row in A1–A4; none matched | **PASS** | spec run |

> Thivarrakesh's message named only DAC-2485 and DAG-3284. The O09 regression
> covers four multi-driver vehicles plus DAC-2485, so all five are listed here.

## Group B — O09 inactive customers and sites

| # | Route | Steps | Expected | Actual | PASS/FAIL | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | `/customers` | set **Status** filter to **Inactive** | request `GET /customers?active=false` succeeds; at least one row is labelled **"Inactive"** in *text*, not colour alone | **0 rows.** Manually confirmed in the browser: the Inactive filter returns the empty state *"No inactive customers — Every customer on record is currently active."* The spec's skip was therefore correct, not a missed record. | **NOT DEMONSTRABLE** (dataset, not defect) | manual check, 2026-09-22 |
| B2 | `/service-agreements` | **Add agreement** → open the customer picker | the inactive customer from B1 is **not** offered | not reached (depends on B1) | **NOT DEMONSTRABLE** | see note below |
| B3 | `/customers` | find an active customer whose site-count cell reads "*N* active, *M* inactive" | the inactive site count is visible in text | inactive site count present in text | **PASS** | spec run, 4.6s |
| B4 | `/service-agreements` | **Add agreement** → pick that customer → open the site picker | exactly **N** options (the active count only); the inactive site is absent | site picker offered exactly the active count; inactive site absent | **PASS** | spec run, 4.6s |
| B5 | `/customers` | inspect customers holding inactive sites | historical information remains accessible — history is preserved, not deleted | **Preserved, and labelled in text.** Inactive sites are still listed under their customer rather than dropped from the record, each carrying an explicit **"Inactive"** badge as words, not colour alone. Observed across four Colombo customers: **CUST-07** *"54 active, 3 inactive"* (e.g. SITE-06 — while a separate *SITE-07* remains active); **CUST-02** (SITE-02 and SITE-03 inactive, while SITE-04 and SITE-05 stay active); **CUST-03** *"48 active, 15 inactive"*; **CUST-04** *"89 active, 5 inactive"*. A page-wide browser find for "inactive" returned **33 matches**. Scope: this evidences retention and labelling of the site records themselves; per-site visit history was not opened. | **PASS** | operator pass, 2026-09-23 |

> **B1/B2 — why this is "not demonstrable", not a pass and not a defect.**
> The spec calls `test.skip()` when no fully-inactive customer exists in the
> environment, and it skipped. That matches the dataset rather than the code:
> the `b694823` pass recorded **28 inactive sites and no inactive customers**,
> and the spec's own comment says the real master schedule "mostly marks
> individual sites *no longer serviced* under an otherwise-active customer …
> rather than deactivating the whole customer". B3/B4 cover that real-world
> shape and both pass.
>
> A skip is **not** evidence — the spec's header states missing records always
> fail strict acceptance — so this was confirmed by hand rather than inferred.
> The manual check returned **0 inactive customers**, which settles it: the
> rule cannot be exercised against this dataset, and that must be reported to
> the Technical Director exactly as the Kandy PMS rule was in the previous
> pass, rather than shown as a tick.
>
> Incidental observation, not a scenario: the empty state reads *"No inactive
> customers — Every customer on record is currently active."* — a
> manager-readable sentence rather than a blank table. Behaving well.

## Group C — O08 core scenarios

The Edit crew drawer (C1–C4) is rendered by **both** `/dispatch-board` and
`/unassigned-visits`, so C6's Kandy row can be exercised through the same
drawer without leaving the Unassigned queue.

| # | Route | Scenario | Expected | Actual | PASS/FAIL | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | `/unassigned-visits` → Edit crew | assignment save and reopen | save succeeds; reopening the Edit crew drawer shows the crew is eligible, with **no** false `EMPLOYEE_DOUBLE_BOOKED` or `VEHICLE_DOUBLE_BOOKED` against itself | **Both halves PASS.** Save: crew EMP-01 (PMS) + EMP-02, vehicle AAV-2359 driven by EMP-01; validation green — *"This crew is eligible to take the visit."* — and the save returned *"Assignment saved. The reason is on this visit's history."* Reopen: the visit correctly left the Unassigned queue and was reopened from `/dispatch-board` (09/09/2026, Colombo); validation again read *"This crew is eligible to take the visit."* with **no** `EMPLOYEE_DOUBLE_BOOKED` or `VEHICLE_DOUBLE_BOOKED` against EMP-01 or AAV-2359. The historical self-conflict defect recorded in `known-limitations.md` does **not** reproduce on this release. | **PASS** | CUST-01 / SITE-01, 2026-09-22 |
| C2 | `/unassigned-visits` → Edit crew | one-vehicle rule | an assignment carries at most **one** vehicle; a second cannot be added | **Probed, not just observed.** The vehicle picker *does* allow attaching a second vehicle, but validation then refuses the save: *"Unavailable vehicle — 2 vehicles are assigned to this visit (Three Wheeler (2 People) AAV-2359, Three wheeler (2 People) ABE-7244); a crew travels in one."* → *Keep the one vehicle that seats the whole crew and release the rest for other visits.* Permissive picker, strict validation — the same pattern as driver authorisation. The rule holds at the save boundary. | **PASS** | CUST-01 / SITE-01, 2026-09-22 |
| C3 | `/unassigned-visits` → Edit crew | driver authorisation | every checked driver is accepted; an unchecked employee is rejected with `NO_AUTHORIZED_DRIVER` | `NO_AUTHORIZED_DRIVER` observed firing on real data. With AAV-2359 attached and no driver named: *"Three Wheeler (2 People) AAV-2359 has no authorized driver in this crew"* → *"EMP-01 in this crew is authorized — name them as the driver."* Naming him cleared it. Independently, with ABE-7244 attached the same rule named **EMP-02** as its authorised driver — so both crew members' matrix authorisations are resolved separately and correctly. | **PASS** | CUST-01 / SITE-01, 2026-09-22 |
| C4 | `/dispatch-board` → Edit crew | driver removal / revalidation | removing the selected driver from the crew clears the driver field immediately to **"No crew member is authorized"** | Removing EMP-01 from the saved crew cleared the driver field to **"No crew member is authorized"** immediately — it did not silently retain a driver who had left the crew. Validation re-fired three rules (insufficient crew, no authorized driver, missing PMS supervisor), and the no-authorized-driver guidance adapted from naming a specific eligible person to *"Add someone authorized for this vehicle to the crew, or use a vehicle the crew can drive"* — correct, since nobody remaining was authorised. Change abandoned without saving. | **PASS** | CUST-01 / SITE-01, 2026-09-22 |
| C5 | `/visits`, `/calendar` | inactive records | **no future visit** references an inactive customer or site | **No counter-example found across the sampled customers.** Method and its limits are in the note below. Inactive customers: none exist (B1), so that half of the rule has no subject. Inactive sites: CUST-06 (1 inactive site) returned 0 visits in October and November 2026; CUST-02 (2 inactive) returned 0 in September and November; CUST-05 (4 inactive) returned 0 in September. Every sampled customer holding inactive sites has **no future work at all**, so none can have future work at an inactive site. | **PASS** (sampled) | operator pass, 2026-09-23 |
| C6 | `/unassigned-visits`, `/dispatch-board`, `/calendar` | Kandy PMS rule | compliant Kandy work is present and **unassigned**, with a manager-readable reason | **No Kandy work exists at all.** Three independent checks: (1) Unassigned Visits, Branch = Kandy, *no date filter* — "Nothing matches these filters"; (2) Dispatch Board, Kandy, 2026-09-22 — all seven queue counters 0, "No operational visits returned for this day"; (3) Calendar, Kandy, September **and** October 2026 — "Nothing in this range", all four stage counters 0. So there is no assigned Kandy visit either, which is the case that would have been a rule violation. | **NOT DEMONSTRABLE** (dataset, not defect) | manual, 2026-09-22 |
| C7 | `/dispatch-board` | opening hours | imported 08:00–17:00 hours are shown as **assumed / unconfirmed**, never as confirmed | Flagged in two places on every observed visit: the row reads *"Assumed hours: 08:00–17:00 — confirm site hours"*, and the provenance list reads *"Opening hours for this visit are not confirmed: either the recorded hours are unconfirmed, or the visible 08:00–17:00 fallback is in use."* Never stated as fact. | **PASS** | Colombo 2026-09-20 |
| C8 | `/published-assignment-repairs` | repair ledger | preview/apply state is readable and consistent with the reported repair (59 agreements, 155 visits moved) | **Readable and coherent.** Header *"Published Assignment Repair Center — Recovery control"*, purpose line *"Inspect invalid published assignments, ask the scheduler for a safe correction, and review the exact replacement or withdrawal before anything changes"*, and a green safety notice *"Planning writes nothing…  Apply is a separate, administrator-only step that revalidates the plan against current data."* **History 27**, described as *"Past published work is preserved for audit. It can be inspected here but is never rewritten automatically"* — the historical-preservation invariant stated in the product's own words. Each entry names the customer, branch, weekday and date, the violation, and a remedy line. Weekday labels verified correct on six sampled records. The **59 agreements / 155 visits** figures are **not shown on this page**; see the note below. | **PASS** (readability only — see note) | operator pass, 2026-09-23 |

> **C6 — unchanged from the previous pass, and checked both ways.** The
> `b694823` pass recorded this as *"preserved, but no live matching visit
> exists"*. That is still true on `13b2456`: this import produces no Kandy
> work at all, so the rule cannot be shown.
>
> The check that mattered was the *second* one. An empty Unassigned queue for
> Kandy is ambiguous on its own — it reads the same whether no Kandy work
> exists or Kandy work exists and has been wrongly **assigned**, the latter
> being a hard-rule violation. The dispatch board and calendar were checked
> specifically to separate those two cases. Both are empty, so no Kandy visit
> exists in any state and there is nothing wrongly assigned.

### C5 — what was actually verified, and what was not

**The rule has two halves and they failed differently.**

*Inactive customers.* B1 established that this dataset contains **zero**
inactive customers. "No future visit references an inactive customer" is
therefore vacuously true — there is no such customer for a visit to
reference. This half is not evidence of the rule working, only of there being
nothing for it to act on, and it carries the same data-fixture limitation
recorded for B1 and B2.

*Inactive sites.* These exist in quantity (B5). Three customers holding seven
inactive sites between them were filtered individually on the Generate
Schedule calendar:

| Customer | Inactive sites | Months checked | Visits returned |
| --- | --- | --- | --- |
| CUST-06 | 1 (SITE-12) | Oct 2026, Nov 2026 | **0** |
| CUST-02 | 2 (SITE-02, SITE-03) | Sept 2026, Nov 2026 | **0** |
| CUST-05 | 4 (SITE-08, SITE-09, SITE-10, SITE-11) | Sept 2026 | **0** |

No future visit at an inactive site was found. **But the reason is weaker
than it looks:** none of these customers has *any* future work, so the result
is a true negative reached without the rule ever being exercised. The months
were not empty — October holds 155 visits and November 179 — the filter
simply excluded all of them. The customers generating visits are a
**different set** from the customers holding inactive sites; the two groups do
not overlap in this dataset. (The generating customers are named in the
protected release record, not here.) No customer in
this dataset was found that has both future work and an inactive site, which
is the configuration that would properly test the rule.

**Why this is not claimed as exhaustive.** C5 asserts a data-wide invariant
over every future visit and every site. A month calendar cannot establish
that: it is filtered one customer at a time, and its Month view truncates
busy days behind *"+N more in Week view"*, so even a find-in-page would miss
visits that are present but not rendered. Proving the invariant needs a query
over the visit table joined to site status — **backend evidence, Chanya's
lane** under the 2026-09-23 split — and it is referred there.

C5 is recorded **PASS** rather than NOT DEMONSTRABLE because it is a negative
invariant: the pass condition is that a search finds no violation, and the
searches run found none. The status is qualified *sampled* so the partial
coverage travels with it rather than being read as a clean sweep.

**This connects to the ended-but-active records flagged under B5.** If
**CUST-12** or the site **SITE-13** are
generating future work, C5's check would not catch it — they are not flagged
inactive, so an inactive-reference query returns nothing for them. Worth
pairing the two questions in the backend pass.

### C8 — two items raised rather than closed

**1. The reported 59 agreements / 155 visits do not appear on this screen.**
The Repair Center shows **History 27** — 27 past *published* assignments
carrying a violation. That is a different quantity from the release note's
"59 agreements, 155 visits moved", which described the **bunching repair**
shipped in PR #67. The two may simply be unrelated features, or the figures
may not reconcile; the browser cannot tell which, because this page never
states them. Under the acceptance-lane split of 2026-09-23 the reconciliation
is **backend evidence (Chanya's lane)**, so it is referred there rather than
guessed at here. C8 is recorded PASS for what an operator can actually
verify — that the screen is readable, states its safety model, and presents
each finding coherently — and explicitly not for the numeric claim.

**2. Three vehicles appear on two different visits on the same date, and only
one violation is reported on each.** Two History entries dated **Thursday 10
September 2026**:

| Entry | Branch | Vehicles listed |
| --- | --- | --- |
| CUST-09 | Colombo | DAI-0191, 253-4289, YU-3861, **DAC-2485**, **DAG-3284** |
| CUST-10 | second location | PJ-6796, **DAI-0191**, **DAC-2485**, **DAG-3284**, AAJ-4499 |

`DAI-0191`, `DAC-2485` and `DAG-3284` are on **both**. Each entry is badged
*1 violation*, and that one violation is the multi-vehicle rule ("a crew
travels in one") — neither reports a cross-visit vehicle conflict, although
the same three vehicles are committed to two visits in two branches on one
day.

This is **not recorded as a defect**, because the correct scope of this
findings engine is not established from the browser: it may deliberately
report only per-visit violations, leaving cross-visit conflicts to the
conflict detection seen on `/unassigned-visits` (which *does* name competing
time windows — see the observations section). It is reproducible by loading
the page, so it is raised as a question for the Technical Director and the
backend lane: **is cross-visit vehicle conflict in scope for the Repair
Center's findings, and if so why is it not badged here?** If it is in scope,
this is a missed finding on published data.

**Incidental data observation, not a scenario.** One customer record (**CUST-11**) has a name that
embeds the date string `2026/9/31`. September has 30 days, so that is not a
real date. It appears to be a name carried
from the source workbook rather than a parsed date — the entry's own date
renders correctly as Thursday 3 September 2026 — but it is worth a look
during the import review.

### C-group working note — the validation engine, observed live

Target visit for C1–C4: **CUST-01 / SITE-01**, Wednesday 9 September
2026, Colombo, needs 2 crew, state *"Not yet checked"*. One visit is used for
all four scenarios so the write into the staging environment is a single,
named row.

Validation runs **live in the drawer, before saving**, so C2/C3/C4 are
observable without writing anything. Only C1 required an actual save.

**Exactly one write was made to the staging environment** during this pass:
the C1 save on this visit, carrying the reason
`ULK-O08/O09 deployed UAT on main@13b2456 — C1 assignment save test. Oshadi,
2026-09-22.` The reason field is mandatory and the save confirmation states
*"The reason is on this visit's history"*, so that write is self-describing
in the product's own audit trail.

**Pinning appears only once there is something to protect.** After the save,
the drawer gained a *"Pin parts of this assignment — a pinned part is kept
exactly as it is the next time the scheduler runs"* section, with Date & time
/ Supervisor / Crew / Vehicle / Everything. It is absent on an unassigned
visit.

**The rules cleared one at a time as the crew improved**, which is how each
was observed rather than assumed: adding a PMS-grade mobile supervisor
cleared both *Missing PMS supervisor* and *Permanent-staff restriction*;
adding a second crew member cleared *Insufficient crew*; attaching a vehicle
cleared *No way to get there*; naming its authorised driver cleared *No
authorized driver*.

With one non-qualifying crew member added (EMP-03, Technician), the
drawer refused the crew and listed **four independent rule failures at once**,
each with a *What to do*:

| Rule surfaced | Message |
| --- | --- |
| **No way to get there** | "This visit has no vehicle, and EMP-03 is not marked as able to travel by public transport." |
| **Insufficient crew** | "CUST-01 / SITE-01 needs 2 on site; 1 is assigned." → *Add 1 more, or reduce the crew size on the agreement if the job really is smaller.* |
| **Permanent-staff restriction** | "EMP-03 is permanently stationed elsewhere and cannot be sent to SITE-01." → *Assign a mobile crew member instead*, with a **View employee** link. |
| **Missing PMS supervisor** | "Every job needs a PMS-grade supervisor on site, and nobody in this crew is one." → *Add a crew member from COLOMBO whose Grade column on the Workforce screen reads PMS, SPMS or APMS.* |

Header: *"This crew cannot take the visit yet — see Validation below."*

**`NO_WAY_TO_REACH_SITE` is observed firing on real imported data.** This is
the transport condition from PR #65. Until this pass it had only ever been
exercised against fixtures; the message above is it refusing a real crew on a
real visit because that person has neither a vehicle nor public-transport
capability. Together with the seat-capacity finding below, the transport rule
is now real-data confirmed rather than fixture-only.

The reasons are also **stable and manager-readable** rather than error codes,
and each names the concrete next action — including which screen and which
column to look at. That is the "manager-readable reasons" requirement met at
the point of failure.

### Real-data observations worth carrying into the report

**Vehicle seat capacity is populated in the imported fleet.** Vehicles render
as `Three Wheeler (2 People)` — a real seat count, not the `null` the
transport check treats as unlimited. This closes an evidence gap flagged
earlier in the release: every transport-feasibility test written for PR #65
used `seatCapacity: null`, so the seat-capacity branch had only ever run
against fixtures. It is now exercised by real data, with crew size 2 against
a 2-seat vehicle.

**Inactive sites are retained under active customers at scale, not as a one-off.**
B3 passed via the spec, which only asserts that *some* cell contains an
inactive count. B5's manual pass shows the real shape behind it: at least four
Colombo customers carry inactive sites, one of them 15 of them, and in every
case the inactive site stays listed under its customer with an **"Inactive"**
word badge rather than disappearing. This is the exact real-world pattern the
spec's own comment predicted — individual sites marked no longer serviced
under an otherwise-active customer — and it is why B1/B2 have no subject while
B3/B4/B5 do.

The pattern extends well beyond those four. Also observed carrying inactive
sites: **CUST-08** (SITE-18), **CUST-06** *"7 active, 1 inactive"* (SITE-12), **CUST-05** *"31 active, 4 inactive"* (SITE-08, SITE-09,
SITE-10, SITE-11), and a *SITE-16* site. The inactive
flag is in routine use across the imported book, not confined to a handful of
records.

**Two records carry an end date in their name while still presenting as
current — flagged for the import review, not as defects.** These are labels
carried from the source workbook, but both describe work that has already
ended and neither is marked inactive:

| Record | What the name says | How it presents |
| --- | --- | --- |
| **CUST-12** (customer; name embeds `31.10.2025`) | ended 31 October 2025 | **1 active** site (**SITE-15**) |
| **SITE-13** (site of **CUST-06**; name embeds an end date of `14-03-2023`) | ended 14 March 2023 | listed among that customer's **active** sites, not badged inactive |

Both end dates are in the past relative to the 2026-09-23 test date — one by
nearly eleven months, the other by over three years. Whether the name is
merely descriptive or should have driven the active flag is an import
question, and it bears directly on C5: if work is still generated against
records like these, the inactive check alone would not catch it, because
they are not flagged inactive in the first place. Raised for the import
review and the backend lane.

Two near-identical names sit on opposite sides of the flag: *SITE-06*
(inactive) and *SITE-07* (active) under CUST-07, and
*SITE-02* / *SITE-03* (inactive) alongside *SITE-04* /
*SITE-05* (active) under CUST-02. Worth noting for the
import review: the flag is doing real work distinguishing records whose names
alone would not.

**The validation messages match the underlying employee record.** D5 opened
**EMP-03** — the same employee whose crew was refused in C4 — and his
record independently confirms both reasons the drawer gave. The page shows
*"Permanently stationed at SITE-14. Permanently stationed staff
cannot be moved to another site, and never count toward mobile crew
capacity."*, which is precisely the *Permanent-staff restriction* message
(*"EMP-03 is permanently stationed elsewhere and cannot be sent to
SITE-01"*); and **Vehicle authorizations reads "Not authorized to drive any
vehicle yet."**, which is why `NO_WAY_TO_REACH_SITE` fired on him rather than
the check simply defaulting. He is also chipped *Not PMS-grade*, matching the
*Missing PMS supervisor* failure.

This matters beyond a route smoke: it shows the validation reasons are
derived from the real employee record and stated accurately, rather than
being generic text attached to a failure. Three separate rule messages were
checked against the source record and all three hold.

**Seat capacity is populated across vehicle classes, not just one.** The
`DAC-2485` row on `/vehicles` reads *Bolero Truck (2 People)* with a Seats
column of **2** — a different vehicle class from the *Three Wheeler (2 People)*
seen in C1–C3, and the seat count is populated on both. The list view also
reports **Authorized drivers: 3** for `DAC-2485`, which independently
corroborates A5's count of 3 driver rows on the detail page from a second
screen.

**The driver-in-crew rule holds on real assignments.** On 2026-09-20 Colombo,
both drafts name a driver who is a member of the crew: `AAV-2485`-class three
wheelers driven by EMP-01 and EMP-05 respectively, each present in
their own visit's crew. That is the Technician Matrix authorisation rule
observed end to end on imported data, not fixtures.

**The Colombo unassigned backlog is 360 visits.** `/unassigned-visits` with
Branch = Colombo and no date filter reports *"Showing 25 of 360 unassigned
visits — page 1 of 15"*, and the visible rows are dated 8–9 September 2026,
i.e. **in the past** relative to the 22 September test date. This is not
necessarily wrong — the page states it includes "work nobody has tried to
staff yet" — but the release note reported *"0 understaffed assignments"* and
did not mention an unassigned count. Raised as a question for the Technical
Director rather than a defect: is a 360-visit past-dated unassigned backlog
the expected state of this pilot dataset?

**Conflict detection produces specific, checkable reasons.** One unassigned
visit (CUST-13, 8 September) shows both an *employee
overlap* and a *vehicle overlap*, each naming the person, the vehicle, and the
exact competing time window. Not a generic "conflict" badge.

**Provenance is stated rather than assumed throughout.** Observed notes
include crew size defaulted, allowed service days derived from historical
bookings, visit duration defaulted, opening hours unconfirmed, and *"The
service site branch is inferred from source data and needs manager
confirmation"* — the last being the 408-site mapping limitation surfacing
correctly at the point of use. Drafts are labelled *"Draft assignment — not
dispatched"* with *"Draft schedule 16–22 Sep — not dispatch truth"*, so a
proposal cannot be mistaken for a published one.

## Group D — route smoke

Every route reachable, no console errors, no broken layout.

> **Scope of the 2026-09-23 operator pass — the console gap is now closed.**
> The routes below were opened in a real browser against `main@13b2456` and
> confirmed to render: each loaded, showed its expected content, and had no
> broken layout or error state.
>
> An earlier revision of this note recorded that the console had **not** been
> open, so "no console error" — part of this group's own stated criterion —
> was explicitly *not* claimed. **That gap was closed by a second pass the
> same day.** Every route below was revisited with Chrome DevTools open on the
> **Console** tab, filter set to **Default levels** (which includes errors and
> warnings, not just errors), and the console cleared before the walk. **No
> red console output appeared on any of the 13 routes**, and the DevTools
> toolbar reported **"No issues"** throughout. Each row's PASS therefore now
> covers reachability, layout **and** console cleanliness.
>
> **The Network panel is covered too, by a third pass.** The console pass
> alone would not have caught a request that fails at the status level but is
> handled gracefully by the application — a 4xx or 5xx on a background fetch
> that never surfaces as a thrown error produces no red console output. So
> the 13 routes were walked again with DevTools on the **Network** tab,
> **Preserve log** enabled so entries survived navigation, filtered to
> **Fetch/XHR**, reading the **Status** column. **No failed rows: every
> request returned 2xx**, with no 4xx, no 5xx and no transport-level
> failures.
>
> With that, each Group D row carries the group's full stated criterion —
> reachable, no broken layout, no console error, and no failed network
> request. Nothing in this group is now claimed beyond what was observed.
>
> D5 was opened by hand and is recorded on that visit.
>
> D7 was not opened by hand in this pass. It is evidenced instead by A1–A5,
> which each navigated to a vehicle detail page and asserted both the
> `Vehicle code: <code>` heading and that vehicle's driver rows — assertions
> the route cannot satisfy without rendering. That is a stronger check than
> the visual load this group otherwise applies, so it is recorded as PASS on
> that basis rather than re-run.

| # | Route | Loads | Notes | PASS/FAIL |
| --- | --- | --- | --- | --- |
| D1 | `/dashboard` | yes | loaded, layout intact; console clean; network all 2xx | **PASS** |
| D2 | `/customers` | yes | loaded, layout intact; console clean; network all 2xx | **PASS** |
| D3 | `/service-agreements` | yes | loaded, layout intact; console clean; network all 2xx | **PASS** |
| D4 | `/workforce` | yes | loaded, layout intact; console clean; network all 2xx | **PASS** |
| D5 | `/workforce/[employeeId]` | yes | loaded, layout intact; console clean (screenshot evidence: empty console, "No issues"); network all 2xx — EMP-03 (Colombo). Renders status chips, a permanent-stationing banner, Position, Skills and Vehicle authorizations | **PASS** |
| D6 | `/vehicles` | yes | loaded, layout intact; console clean; network all 2xx; also exercised by A6's two searches | **PASS** |
| D7 | `/vehicles/[vehicleId]` | yes | loaded — A1–A5 each navigated to a vehicle detail page and asserted `Vehicle code: <code>` plus its driver rows, which the route could not satisfy unless it rendered; console clean; network all 2xx (a vehicle detail page was opened by hand in both the console and network passes) | **PASS** |
| D8 | `/visits` | yes | loaded, layout intact; console clean; network all 2xx | **PASS** |
| D9 | `/calendar` | yes | loaded, layout intact; console clean; network all 2xx | **PASS** |
| D10 | `/dispatch-board` | yes | loaded, layout intact; console clean; network all 2xx | **PASS** |
| D11 | `/unassigned-visits` | yes | loaded, layout intact; console clean; network all 2xx | **PASS** |
| D12 | `/schedule-history` | yes | loaded, layout intact; console clean; network all 2xx | **PASS** |
| D13 | `/published-assignment-repairs` | yes | loaded, layout intact; console clean; network all 2xx | **PASS** |

---

## Defects found

For each defect, post in the UltraKIL channel with this exact shape, and repeat
it here:

```
Route:
Date / branch:
Steps to reproduce:
Expected result:
Actual result:
Screenshot: (protected folder path — not Git, if it shows real records)
Release: main@13b2456
```

**No defect was found in 33 scenarios.** Nothing observed in this pass
reproduced as incorrect product behaviour, so no entry is made in the format
above.

Four items are **raised for decision** rather than logged as defects, because
each needs evidence the browser cannot supply. They are listed here so
sign-off does not read as "nothing to look at":

| # | Item | Where | Why it is not (yet) a defect | Owner to resolve |
| --- | --- | --- | --- | --- |
| 1 | Three vehicles (DAI-0191, DAC-2485, DAG-3284) are committed to two different visits on Thu 10 Sept 2026, in two branches, and each entry is badged with only the multi-vehicle violation | `/published-assignment-repairs` | The findings engine's intended scope is not establishable from the UI; it may deliberately report per-visit violations only, leaving cross-visit conflicts to the detection on `/unassigned-visits`. Reproducible by loading the page. | Technical Director to rule on scope; backend lane to confirm |
| 2 | The reported 59 agreements / 155 visits moved appear nowhere on the Repair Center, which shows History 27 | `/published-assignment-repairs` | Likely a different quantity (bunching repair vs. published-assignment violations), but the page never states the figures, so the browser cannot reconcile them | Backend lane |
| 3 | Two records name an end date already passed while presenting as current: customer **CUST-12** (name embeds `31.10.2025`, 1 active site) and site **SITE-13** (name embeds `14-03-2023`, listed active) | `/customers` | The names are workbook labels and may be purely descriptive; whether they should have driven the active flag is an import question | Import review / backend lane |
| 4 | 360 unassigned Colombo visits dated 8–9 September 2026, i.e. in the past relative to the test date | `/unassigned-visits` | The page states it includes work nobody has tried to staff yet, so this may be expected for a pilot dataset — but the release note reported "0 understaffed assignments" and gave no unassigned count | Technical Director |

Item 1 is the one worth answering first: if cross-visit vehicle conflict is
meant to be in scope for the Repair Center, it is a missed finding on
published data.

## Summary

| | |
| --- | --- |
| Scenarios defined | **33** (A 7 + B 5 + C 8 + D 13) |
| Scenarios with a final status | **33 — all of them** |
| PASS | **30** |
| FAIL | **0** |
| Blocked / not demonstrable | **3** (B1, B2, C6 — all data-fixture, none a product defect) |
| Pending | **0** |
| Defects raised | **0** |

Counts derive from the consolidated matrix near the top of this file, which is
the single authority. Do not maintain a second running total by hand — the
first revision of this report did, and it drifted.

Business acceptance remains a named human sign-off and is **not** implied by
this technical evidence.

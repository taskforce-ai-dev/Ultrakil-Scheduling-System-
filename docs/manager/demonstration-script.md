# ULK-O08 — Demonstration script

A short, self-contained walkthrough a manager can run without a developer
present: one visit scheduled cleanly, and one that the system correctly
refuses to schedule and explains why. Total time: under 5 minutes.

The steps below are a representative local example — the same flow and
screens, run against fabricated demo data on a local stack. A deployed
pass against the pilot's real data has since started at
`https://ultrakil-manager-web.vercel.app` (see `known-limitations.md` and
`uat/ULK-O08-uat-results.md`); Part 1's actual "Save" step is currently
blocked there by a live defect (assignment save transaction timeout, see
below) rather than untested — real, passing evidence for this exact flow
is still pending that fix.

---

## Part 1 — A valid schedule

**Goal:** assign a full, rule-compliant crew and vehicle to a visit, and
see it save.

1. Open **Dispatch Board**, pick a date with a scheduled visit, and click
   **Edit crew** on any visit still showing "No PMS supervisor."
2. Click **Add crew member** and add one PMS-grade employee (the picker
   marks them, e.g. "Kamala Wijesinghe (PMS)") — this satisfies the
   PMS-supervisor rule.
3. Add a second crew member to meet the agreement's required crew size —
   the Validation panel tells you the exact number needed if you're short.
4. Click **Add vehicle**, choose one from the list (only vehicles for this
   visit's branch are offered), then set **Driver** — only crew members who
   are individually checked to drive that vehicle appear here.
5. Type a short **Reason for this change** (e.g. "Initial crew
   assignment").
6. Confirm the Validation panel now reads *"This crew is eligible to take
   the visit"* and click **Save assignment**.

**Expected result:** a "Assignment saved" confirmation, and the Dispatch
Board row now shows the supervisor, full crew, and vehicle instead of the
red "No PMS supervisor" warning.

*(Evidence from this exact flow, run during the local UAT pass:
`uat/screenshots/vehicle-authorized-driver-picker.png`,
`uat/screenshots/dispatch-board-valid-assignment-persisted.png`.
**Correction:** an earlier version of this list also cited
`valid-assignment-saved-toast.png` as clean-save evidence. That screenshot
was actually captured against a self-overlap defect present in the local
UAT baseline at the time — `EMPLOYEE_DOUBLE_BOOKED` errors comparing the
assignment against itself — which is already fixed on current `main` (see
"Known limitations" for the fix). It has been removed from this list as
historical, pre-fix evidence rather than clean-save evidence.
**Deployed-pass update, 2026-09-09:** attempted this exact flow against
real data at `https://ultrakil-manager-web.vercel.app` — Validation
correctly reached "This crew is eligible to take the visit," but clicking
**Save assignment** failed with a server error, reproduced 3/3 (Prisma
transaction timeout, see `known-limitations.md` item 1). A clean
"Assignment saved" screenshot against the deployed app is blocked on that
fix, not merely un-attempted.)*

---

## Part 2 — An unresolved conflict

**Goal:** show a visit the system correctly refuses to schedule, with a
plain-language explanation instead of a silent failure or a wrong guess.

1. Open **Dispatch Board**, find a visit for a fumigation job (job type
   "Fumigation"), and click **Edit crew**.
2. Add two crew members — enough to look plausible, but short of what the
   job actually needs, and without the specific skill the job requires
   (e.g. neither holds "MBr Fumigation").
3. Look at the **Validation** panel without changing anything else.

**Expected result:** at least two blocking errors, each with a stable code
and a concrete fix:

> **Insufficient crew** `CREW_TOO_SMALL` — *Greenfield Brewery — Greenfield
> Brewery — Plant needs 3 on site; 2 are assigned.* **What to do:** Add 1
> more, or reduce the crew size on the agreement if the job really is
> smaller.
>
> **Missing skill** `SKILL_NOT_HELD` — *This job needs MBR_FUMIGATION and
> nobody in the crew holds it.* **What to do:** Add someone qualified, or
> correct the required skills on the agreement.

**Save assignment stays disabled** — the system will not let this go out
half-staffed or under-qualified, and it will not silently drop the
requirement to make the screen look clean.

4. Close the drawer without saving. Go to **Unassigned Visits** and point
   out that this same visit is listed there — this is the queue of
   everything still needing attention, so nothing falls through the
   cracks; it's a checklist, not a place where broken work hides.

*(Evidence: `uat/screenshots/crew-size-and-missing-skill-validation.png`,
`uat/screenshots/unassigned-visits-queue.png`.)*

---

## Part 3 — A vehicle with more than one authorized driver

**Goal:** show that a company vehicle can be shared by more than one
checked driver, with no "ownership" concept, and that only checked
drivers ever appear as options.

1. Open **Vehicles**, click a vehicle with more than one authorized driver
   (e.g. the Bolero Truck).
2. Point out its driver list: every authorized driver is shown as an equal
   row reading only "Authorized to drive" — no "primary" or "owner."
3. Go to **Dispatch Board**, open **Edit crew** on a visit, add that
   vehicle, and open the **Driver** dropdown.

**Expected result:** only crew members who are both on this crew *and*
individually checked for that vehicle appear — nobody else, no matter who
else is on the crew.

4. Remove the currently-selected driver from the crew (not the vehicle)
   using **Remove crew member**.

**Expected result:** the vehicle's Driver field clears back to the
placeholder, and the Validation panel immediately shows
`NO_AUTHORIZED_DRIVER`, naming any other crew member who is still checked
for that vehicle.

*(Evidence: `uat/screenshots/o09-all-checked-drivers-lm3067.png`,
`uat/screenshots/o09-unauthorized-driver-excluded.png`,
`uat/screenshots/before-driver-removed-from-crew.png`,
`uat/screenshots/after-driver-removed-revalidated.png`.)*

---

## Part 4 — An inactive customer/site, and preserved history

**Goal:** show that deactivating a customer or site stops new scheduling
without erasing what already happened.

1. Open **Customers**, filter Status to **Inactive**, and open an inactive
   customer.
2. Point out the **text label** (not colour alone) — e.g. an "Inactive"
   badge, or "1 active, 1 inactive" on a customer whose other site is
   still active.
3. Go to **Service Agreements → Add agreement** and open the customer
   dropdown, then the site dropdown.

**Expected result:** the inactive customer doesn't appear at all; for a
still-active customer with one inactive site, that customer's site
dropdown offers only the active site.

4. Go to **Dispatch Board** and find a visit that was generated for that
   customer/site *before* it went inactive.

**Expected result:** the visit is still listed, and **Edit crew** is
still available on it — deactivation only stops future scheduling, it
does not hide history.

*(Evidence: `uat/screenshots/o09-active-customer-with-inactive-site-label.png`,
`uat/screenshots/o09-inactive-customer-labeled.png`,
`uat/screenshots/o09-inactive-site-excluded-from-picker.png`,
`uat/screenshots/o09-historical-info-still-accessible.png`.)*

---

## What this demonstrates

- The system enforces every hard rule (crew size, PMS supervisor,
  branch/permanent-station isolation, required skills, vehicle
  authorization) the same way: block Save, explain why, say what to do.
- A conflict is never hidden or auto-resolved by quietly weakening a rule —
  it goes to the Unassigned queue with its reasons intact.
- A manager can complete the entire successful path — and correctly
  identify and stop at a genuine conflict — using only what's on screen,
  with no developer involved.
- Vehicles are shared resources with multiple checked drivers, not
  single-owner assets, and the picker only ever offers someone who is
  actually authorized.
- Deactivating a customer or site stops future scheduling immediately
  without erasing anything that already happened.

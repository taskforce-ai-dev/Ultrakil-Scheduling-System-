# ULK-O08 — Demonstration script

A short, self-contained walkthrough a manager can run without a developer
present: one visit scheduled cleanly, and one that the system correctly
refuses to schedule and explains why. Total time: under 5 minutes.

Run this against the pilot's real data once staging is available; the
steps and screens are identical to what's shown here against local test
data.

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

*(Evidence from this exact flow, run during UAT:
`uat/screenshots/vehicle-authorized-driver-picker.png`,
`uat/screenshots/valid-assignment-saved-toast.png`,
`uat/screenshots/dispatch-board-valid-assignment-persisted.png`.)*

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

## What this demonstrates

- The system enforces every hard rule (crew size, PMS supervisor,
  branch/permanent-station isolation, required skills, vehicle
  authorization) the same way: block Save, explain why, say what to do.
- A conflict is never hidden or auto-resolved by quietly weakening a rule —
  it goes to the Unassigned queue with its reasons intact.
- A manager can complete the entire successful path — and correctly
  identify and stop at a genuine conflict — using only what's on screen,
  with no developer involved.

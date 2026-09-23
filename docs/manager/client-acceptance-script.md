# UltraKIL — Client acceptance script

**Release under acceptance:** `main@13b2456`
**Portal:** `https://ultrakil.taskforceai.tech`
**Expected duration:** 25–35 minutes

This is the script a named person from the client runs, in the portal, to
decide whether Phase 1 is accepted. It is deliberately **not** the
demonstration script: a demo shows the system working, whereas acceptance
asks the client to try it themselves and judge whether it does the job.

**What the technical testing does and does not say.** A 33-scenario pass was
run against this exact release and is recorded in
`uat/ULK-O08-O09-deployed-uat-13b2456.md`. Its result was **30 PASS, 0 FAIL,
and 3 NOT DEMONSTRABLE**. The distinction matters and is not a formality:

- **30 scenarios were exercised and behaved correctly.**
- **0 scenarios failed.**
- **3 scenarios could not be exercised at all**, because this dataset does not
  contain the records they need — the Kandy no-PMS-supervisor rule (no Kandy
  work exists), and two behaviours that require a wholly inactive customer
  (every customer on record is currently active). Those three are implemented
  and covered by automated tests, but **nobody has watched them act on this
  data**, and this script cannot show them to you either.

**Zero failures is not the same as complete verification.** It means nothing
broke in what could be tested. Three rules remain untested against real
records, and one further check — that no future visit is scheduled at a site
you have stopped servicing — was **sampled rather than proven**, for the
reason given under "What this release does not do".

**And none of it is acceptance.** Acceptance is this document, signed.
Technical evidence says the software behaved as specified; it does not say
the business agrees the system is fit for their work. Nobody on the delivery
side can sign that on the client's behalf.

Read **"What this release does not do"** near the end *before* signing. It is
placed there deliberately, not buried: a signature given without it is not an
informed one.

---

## Before you start

| | |
| --- | --- |
| Who signs | A named person from the client with authority to accept Phase 1 |
| Who assists | Oshadi Whyshni Kumaravel (manager portal) |
| What you need | A manager account, a desktop or laptop browser |
| What you do **not** need | Any technical knowledge, any setup, any installation |

Two things to know before the first click:

- **Nothing you do here can break live work.** Only Section 5 saves anything,
  and it is on a visit chosen for that purpose. Every other section is
  look-only, and you can close any panel without saving.
- **If something does not match what is written here, that is a finding, not
  your mistake.** Say so and it gets recorded. A section that does not behave
  as described should be marked FAIL, not explained away.

---

## Section 1 — Can I see the work?

**The business question:** is the schedule visible, in one place, without
asking anyone?

1. Sign in. You land on **Dashboard**.
2. Open **Calendar**. Move between months with the arrows.
3. Open **Dispatch Board** and pick a date with work on it.
4. Open **Unassigned Visits**.

**What you should be able to say:** I can see what is scheduled, for which
customer and site, on which date, and I can see what still has nobody
assigned to it.

**The point of Unassigned Visits** is that work needing attention is
collected in one queue rather than hidden. It is a to-do list, not a place
where problems disappear.

| Accepted? | ☐ PASS ☐ FAIL | Initials: ______ |
| --- | --- | --- |

---

## Section 2 — Does it know my customers and sites?

**The business question:** is our own book of work in here correctly?

1. Open **Customers**. Find a customer you know well.
2. Look at its site list. Sites no longer serviced are still listed, marked
   **Inactive** in words.
3. Open **Service Agreements** and look at an agreement for that customer.

**What you should be able to say:** these are our customers and our sites,
and a site we have stopped servicing is still on the record rather than
deleted.

**Why inactive sites are kept:** history is preserved. If you stop servicing
a site, its past work remains visible for audit; it simply stops being
offered for new work.

| Accepted? | ☐ PASS ☐ FAIL | Initials: ______ |
| --- | --- | --- |

---

## Section 3 — Does it know who can do the work?

**The business question:** does it respect who is qualified, and who may
drive what?

1. Open **Workforce** and click any employee. Note their grade, their
   skills, and their **Vehicle authorizations**.
2. Open **Vehicles** and click a vehicle with more than one authorized
   driver.
3. Look at the driver list.

**What you should be able to say:** every authorized driver is listed as an
**equal** — no "primary driver", no "backup", no "owner".

**This is deliberate and worth confirming out loud, because it is a rule the
system was specifically built to follow:** a tick in the Technician Matrix
means that person may drive that vehicle, full stop. The same rule applies to
personal, company-owned and company-rented vehicles alike. If your operation
does *not* work that way, say so now — it is a requirement question, not a
bug.

| Accepted? | ☐ PASS ☐ FAIL | Initials: ______ |
| --- | --- | --- |

---

## Section 4 — Does it stop me making a mistake?

**The business question:** when I try to schedule something that will not
work, does it tell me plainly, or does it let it through?

**This is the most important section. Take your time on it.**

1. Open **Dispatch Board** or **Unassigned Visits** and click **Edit crew**
   on a visit that has nobody assigned.
2. Add **one** crew member. Look at the **Validation** panel. Do not save.
3. Now, deliberately, try to build a crew that should not be allowed. Add
   someone who is not qualified, or leave the crew short.

**What you should see:** every reason the crew cannot go, listed at once, in
plain English, each with a **What to do** line telling you the fix — and for
some, a link straight to the screen where you would fix it.

Real examples from this release:

> **Insufficient crew** — *needs 2 on site; 1 is assigned.*
> → Add 1 more, or reduce the crew size on the agreement if the job really
> is smaller.

> **Missing PMS supervisor** — *Every job needs a PMS-grade supervisor on
> site, and nobody in this crew is one.*
> → Add a crew member from COLOMBO whose Grade column reads PMS, SPMS or
> APMS.

> **No way to get there** — *This visit has no vehicle, and [name] is not
> marked as able to travel by public transport.*

> **No authorized driver** — *[Vehicle] has no authorized driver in this
> crew.* → *[Name] in this crew is authorized — name them as the driver.*

4. Now fix the crew one problem at a time. Watch each reason disappear as
   you solve it.

**What you should be able to say:** it does not let bad work through, it
tells me exactly why in language I understand, and it tells me what to do
about it.

**One behaviour to expect, which is not a fault:** the vehicle and crew
pickers will let you *select* something invalid — for example a second
vehicle. The refusal comes when you try to **save**. The rule holds; it is
enforced at the point of saving rather than by hiding options.

5. Close the drawer **without saving**.

| Accepted? | ☐ PASS ☐ FAIL | Initials: ______ |
| --- | --- | --- |

---

## Section 5 — Can I take control when I need to?

**The business question:** when I know better than the system, can I
override it — and is there a record?

**This is the only section that saves anything.** Use the visit your
assistant has identified for this purpose.

1. On that visit, click **Edit crew**.
2. Build a valid crew: a PMS-grade supervisor, enough people, one vehicle,
   and name a driver who is authorized for that vehicle.
3. Confirm the Validation panel reads *"This crew is eligible to take the
   visit."*
4. Type a **Reason for this change**. This is mandatory — Save stays
   disabled until it is filled in. That is intentional: every manual change
   carries a reason.
5. Click **Save assignment**.
6. Reopen the same visit.

**What you should be able to say:** I can assign work by hand, the system
records why I did it, and reopening it shows it is still valid rather than
inventing a conflict with itself.

**After saving**, note the **Pin** section that has appeared — *"a pinned
part is kept exactly as it is the next time the scheduler runs"*. This is how
you protect a decision you have made from being changed by automatic
scheduling.

| Accepted? | ☐ PASS ☐ FAIL | Initials: ______ |
| --- | --- | --- |

---

## Section 6 — Does it tell me what it is unsure about?

**The business question:** does it distinguish what it knows from what it
has assumed?

1. On the Dispatch Board, look at a visit's detail.
2. Find the provenance notes.

**What you should see** — statements like these, which are the system saying
plainly where a value came from:

> *Assumed hours: 08:00–17:00 — confirm site hours*

> *The service site branch is inferred from source data and needs manager
> confirmation*

> *Draft assignment — not dispatched*

**What you should be able to say:** it does not present a guess as a fact.
Where it has filled a gap from the imported workbook, it says so and asks for
confirmation.

**This matters for the pilot.** Opening hours imported as 08:00–17:00 are a
**fallback**, not confirmed reality. Part of pilot work is confirming real
hours for the sites that matter.

| Accepted? | ☐ PASS ☐ FAIL | Initials: ______ |
| --- | --- | --- |

---

## What this release does not do

**Read this before signing.** These are not faults; they are the agreed
boundary of Phase 1, plus honest limits of what has been shown. Accepting
Phase 1 means accepting it *with* these.

**Not built, by design (Phase 2):**

- No phone or tablet app. Technicians and PMS supervisors have no mobile
  view. The portal is desktop/laptop only.
- No push notifications.
- One vehicle per visit. A crew cannot be split across two vehicles; you keep
  one that seats everyone.

**Limits of what has been demonstrated on this release — stated so the
signature is informed:**

- **Kandy.** The rule that Kandy work stays unassigned when no PMS-qualified
  supervisor is available **could not be shown**, because this import
  contains no Kandy work at all. Checked three ways to be sure nothing is
  being wrongly assigned there. The rule is implemented and the workforce
  audit confirms zero PMS-qualified Kandy supervisors, but you have not seen
  it act on a live row.
- **Inactive customers.** Every customer on record is currently active, so
  the behaviour for a *wholly* inactive customer could not be demonstrated.
  Inactive **sites** were demonstrated and work correctly.
- **Future work against closed sites.** The check that no future visit is
  scheduled at a site you have stopped servicing was **sampled, not proven**
  across the whole dataset. Confirming it fully requires a database check,
  which is being done separately.
- **Data still being confirmed.** Some site-to-branch mappings are inferred
  and flagged for manager confirmation; some opening hours are the assumed
  08:00–17:00 fallback. These surface in the product where they apply.

**Open questions raised during technical testing, not yet resolved:**

1. Whether the Repair Center should flag the same vehicle being committed to
   two different visits on the same day. It currently reports each visit's
   own violation only.
2. Whether a backlog of past-dated unassigned visits is the expected state of
   the pilot dataset.
3. Two records name an end date that has already passed while still
   presenting as current — an import question.

**These three are open, and their effect on day-to-day use has not been
established.** All are with the Technical Director and the backend review; none
has been dispositioned yet. Question 1 in particular could matter operationally
— if cross-visit vehicle conflict is meant to be in scope for that screen and
is not being reported, the same vehicle could be committed to two visits on one
day without the screen saying so. Whether that is the case is exactly what is
being determined.

They are listed here so the decision to accept, or to accept with conditions,
is made with them in view rather than after the fact. **Judging whether they
are tolerable is the client's call, not the delivery team's**, and this
document deliberately does not make it for you.

---

## Acceptance

I have run the sections above against `main@13b2456` myself, and I have read
**"What this release does not do"**.

| | |
| --- | --- |
| Sections passed | ______ of 6 |
| Sections failed | ______ |
| Findings raised (attach or list) | |

**Decision** — tick one:

- ☐ **Accepted.** Phase 1 is fit for pilot use as it stands.
- ☐ **Accepted with conditions.** Fit for pilot use once the conditions
  listed below are met.
- ☐ **Not accepted.** Reasons listed below.

Conditions or reasons:

```


```

| | |
| --- | --- |
| Name (printed) | |
| Role | |
| Organisation | |
| Signature | |
| Date | |

| | |
| --- | --- |
| Witnessed by (delivery side) | |
| Role | |
| Date | |

---

*A signature on this page is the business acceptance of Phase 1. It is not
implied by, and cannot be substituted with, passing tests, green CI or the
UAT evidence file — those record that the software behaves as specified, not
that it does the job the client needs.*

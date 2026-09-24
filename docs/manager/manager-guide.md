# UltraKIL Manager Portal — Manager Guide

This guide covers the day-to-day tasks a manager needs for the Phase 1
pilot: setting up customers, agreements and visits, understanding the
conflicts the system flags, overriding them by hand when needed, and
publishing a schedule. It assumes you can already sign in — if not, ask
your administrator for an account.

The screenshots in this public guide use fabricated rehearsal data. The
current staging portal is `https://ultrakil.taskforceai.tech`; its deployed
release and real-data rules were verified separately, with privacy-sensitive
evidence retained only in the protected VPS release folder. Small visual
details can differ from these examples, but the workflows and labels match the
current release.

**Current staging baseline (24 September 2026):** application release
`500daf80a85aea18ca5e5d74d2552739b7e3fb57` (PR #75) plus ingress update
`a8174accb7d99248ba415fe78bb227c49aac23e9` (PR #76). All 11 manager routes
passed the authenticated deployed smoke with zero console, page or API HTTP
errors. The approved repair replaced 11 future published assignments and the
post-repair audit found zero employee or vehicle overlaps, zero short crews,
zero missing PMS supervisors and at most one vehicle per assignment. Before a
production handover, management still needs to confirm uncertain site branches
and real opening hours described in [Known limitations](known-limitations.md).

**What this covers today:** the manager portal (this web app), used from a
desktop or laptop browser. There is no phone app yet — technicians and PMS
supervisors don't have a mobile view. That's planned for Phase 2, described
at the end of this guide under "What's coming later."

---

## 1. Adding a customer and their sites

Go to **Customers → Add customer**. A customer needs at least one site
before you can create a service agreement for it.

![Add customer form](uat/screenshots/add-customer-site-form.png)

For each site you can set:

- **Address / city** (optional, for reference)
- **Opening hours per weekday** — each day is independent. Leave a day with
  no time window and it's treated as closed. You can add more than one
  window on the same day (for example, a lunch closure) using the **+**
  button next to that day.

A customer and its sites belong to one branch (Colombo or Kandy) — this
determines which employees and vehicles can ever be assigned to work
there, so double-check it before saving.

---

## 2. Creating a service agreement

Go to **Service Agreements → Add agreement**. This is where you say what
recurring work a site needs.

The Customer and Site selectors show names after selection; internal record
IDs are not shown to managers.

Key fields:

- **Visits / Per** — how often the work repeats (e.g. "2 / WEEK" or
  "1 / MONTH"). Frequency is flexible per agreement; there's no fixed
  company-wide schedule.
- **Crew size** — how many people must be on site. This varies by
  agreement — a small routine visit might need 2, a larger job 3 or more.
- **Allowed days** — a **hard constraint**. A visit can never be scheduled
  outside these weekdays, no matter what.
- **Preferred days** — a **soft preference**, used only to rank options
  within the allowed days. It can never widen the allowed set, and the form
  won't let you mark a day preferred until it's already allowed.
- **Required skills** — anything extra the job needs beyond what the job
  type itself already implies (e.g. a fumigation job might specifically
  need MBr Fumigation).

Once saved, an agreement can be **paused** from the Service Agreements list
without deleting it — useful if a customer temporarily suspends service.

---

## 3. Generating visits

Service agreements describe recurring *demand*; they don't create anything
on the calendar by themselves. Go to **Visit Calendar → Generate visits**.

![Generate visits preview](uat/screenshots/generate-visits-preview.png)

This is always a **preview first** — nothing is written until you click
**Generate** in the panel. It shows exactly what will be created, what's
a safe change to an existing visit, what's no longer required (because an
agreement changed or was paused), and what's protected and won't be
touched (see "Locks," section 6).

**Generation shows up in Schedule History.** Confirming a run writes a record
there, badged **Visit generation** and counted as *"105 visits generated."* It
is not a schedule: generation creates the visits, and staffs nobody. There is
nothing to publish on it, and no Publish button on it. To staff those visits,
solve the range from the Schedule History page as usual.

**What range gets generated, and what each view can plan.** A run plans only
the periods it can see **whole**, and a period is a whole week (Monday to
Sunday) or a whole calendar month, counted from the agreement's own start date
— never from the range you happen to be generating.

- **Week view** generates the seven days on screen. That is one whole week, so
  it plans every weekly agreement in range and nothing longer: a fortnightly,
  monthly or quarterly agreement has no whole cycle inside a single week.
- **Month view** generates the whole grid you are looking at — including the
  last days of the previous month and the first of the next, because the grid
  begins on a Monday and ends on a Sunday. That gives it whole weeks *and* the
  whole calendar month, so it plans weekly and monthly agreements alike, and
  fortnightly ones in almost every month. Quarterly ones need a longer range.

  *Almost* every month, because a fortnight is counted from each agreement's
  own start date and can straddle the join between two months. Where one
  month's grid ends the day before the next begins — May 2026 ends on Sunday
  31 May and June begins on Monday 1 June — the run reaches a week further so
  that the fortnight across the join belongs to somebody. You will see visits
  created in that extra week; they are the ones no other run would plan.

  With that week of overlap in place, **a fortnight is always covered by one
  month or the next**, so you will not see a warning about one. Cycles of
  three weeks or longer are the ones that can still fall between two months,
  and those are what the warning below is for.

Because the two views measure periods the same way, they agree. Generate a week
from the week view and then the month it sits in, or the other way round, and
the second run has nothing to add and nothing to remove. Neither view ever
proposes deleting work the other created: a visit in a period this range holds
only part of is left to the run that can see that period whole.

**When a range cannot plan an agreement at all**, the panel says so under **Not
planned by this range** — *"Quarterly agreements need a range covering a whole
quarter; 3 skipped."* Nothing is wrong with those agreements. Move to the month
view, or ask for a longer range, and the run that covers a whole cycle will
plan them. A silent zero would read exactly like a calendar already in order,
which is why it is never left silent.

The same panel has a second, sharper line: *"Every three weeks agreements: 1
three weeks runs past an edge of this range with no visit in it, and no
neighbouring month's grid holds it whole either."* That one is not a hand-off.
Neither the month before nor the month after reaches the whole cycle, and
nothing is standing in it — so switching views will not help. **Generate from
the month the cycle starts in**, or ask for a wider range, or it stays
unplanned.

Two things about when you see it. A cycle cut at the *start* of a range is
normally the previous month's, and is not mentioned — unless nothing is in it,
which is what happens when an agreement is created after that month was
already generated. Its first cycle belongs to a run that has been and gone, so
the panel names it and you can plan it from the month it starts in. And a
fortnight is never named here at all: the week of overlap above covers every
one of them.

### Why a visit is on the date it is

Open a visit and the detail panel gives a one-line answer under **Why this
date**:

- **Booked with the customer** — this date came from the master schedule
  workbook, where UltraKIL had already agreed it. It is a commitment. The
  system never moves it, however busy the day gets.
- **Near this site's usual day** — nothing was booked for that month, so the
  visit was placed close to the days this site is normally served on, worked
  out from the dates the workbook did book.
- **Moved off a day that was full** — the visit could have sat on a busier
  day, but that day had already reached the branch's daily limit, so it moved
  to the quietest other day its agreement allows in the same week or month.
- **First allowed day of the period** — nothing is booked for this agreement
  and nothing is on record about its usual days, so it takes the first
  allowed day. Adding the real dates to the workbook and re-importing is what
  turns this into one of the answers above.

The same panel's **History** block names the run that created the visit by the
weeks it covered — *"Schedule run 15-21 Sep"* — not by an id. If nothing
generated the visit it says *"Not recorded"*. On the operations board, the line
naming a visit's published schedule links straight to that run in Schedule
History, where it is marked and scrolled to for you.

A visit you have locked, edited by hand, or already staffed keeps its date
even when the agreement would now put that period's visit somewhere else. It
is not moved, and no second visit is created alongside it — your date *is*
that week's or month's visit. The panel lists it under "Protected," and tells
you where the agreement now points: *"generation would have moved it to
2026-09-18."* Nothing is done about it — the visit is yours — but if the
agreement's allowed days have changed under it, that line is how you find out.
Move it yourself if you want the new day.

A **cancelled** visit is protected too: it is never deleted. But it does not
count as that week's or month's visit, because the work did not happen — the
period still asks for a visit, and the day it sits on is treated as free when
the branch's daily limit is worked out, both in the generation panel and on the
calendar's own **Over the branch's daily limit** badge.

Its *slot* is spent, though. A visit is identified by its agreement, its date
and its start time, so the cancelled row keeps that day and time for ever and
nothing new can be put on it. Generation therefore plans that period onto
another day the agreement allows. Where the period has no other day — a weekly
agreement allowed only Mondays, say — it reports a shortfall saying the only
visit is cancelled. Reinstate it, or allow another weekday. If the period was
short of days *anyway* — the site shut on the other allowed day, or open for
less time than the visit needs — the shortfall names that instead, because
reinstating the cancelled visit would still leave the week short.

A **booked** date whose visit is cancelled is the one case a booking cannot
answer for itself. The date is a commitment and is never moved, but the
cancelled row holds that day for ever, so nothing can be planned on it again
and the calendar would otherwise read as already correct while the customer
has no visit. The panel names the date under the booking warnings — *"the
visit on that booked date is cancelled"*. Reinstate that visit, or agree
another date with the customer.

The "generation would have moved it to…" line is shown only when the day your
visit sits on is one the agreement **no longer allows**. Moving a visit from one
allowed day to another is a choice the agreement is content with, and you are
not told about it again on every run.

If a single day still carries more work than the branch plans for, the
generation panel says so by date, count and limit, under **Days over the
branch's limit**. That happens when the work on that day is already booked
with customers, is already in the calendar and not this run's to move, or —
most often — belongs to weekly agreements allowed only one weekday, which have
nowhere inside their week to move to. The system reports it rather than
quietly moving a date somebody promised.

That panel closes, and the day goes on carrying the work. So the calendar
marks it too: a day over its branch's limit is badged **Over the branch's
daily limit** in the visit calendar. The count is per branch — two Colombo and
one Kandy visit on the same day is not three against one limit. (If the range
holds more visits than the calendar has loaded, the banner above the grid says
so, and the badge can only speak for what is loaded.)

### Two more things the generation panel tells you

**Booked on a day the site's hours do not allow.** A booked date is honoured
whatever the opening hours say — it is a commitment. But if the site has no
hours recorded for that weekday, if the hours it does have are shorter than
the visit needs, or if the agreement's own service window and the site's hours
do not overlap at all, the panel names the date and says which of them it is
(a fourth, a booked date whose visit is cancelled, is described above). The visit is planned either way, on the site's recorded window; this is
your warning that the crew may find a locked door, or an hour where they
expected a day. Recording the site's real hours clears the first two. The
third is fixed on the agreement, by widening its service window — the hours
were never the problem.

The warning is on the panel, and the panel closes. So the visit itself carries
it too: open a visit whose window is shorter than the work takes and it is
badged **Window shorter than the visit**. You can still edit that visit —
change its crew, move its date — without being made to fix the window first.
Only an edit that actually touches the window or the duration has to leave the
visit fitting inside it.

**Booked fewer times than the frequency promises.** An agreement written as
twice a week, with only one date booked in a week, appears under Conflicts.
The booked dates are used exactly as the workbook wrote them and no extra
visit is invented — add the missing date to the workbook, or correct the
frequency.

---

## 4. Reading the Dispatch Board and assigning a crew

**Dispatch Board** shows, for a given date and branch, every visit and who
(if anyone) is on it. A visit with no crew shows a plain-language reason
why, e.g. "No PMS supervisor." Click **Edit crew** to open the assignment
editor. Visits still waiting for a crew are queued on their own page,
**Unassigned Visits**; the board itself is where the crew on a visit is read
and changed.

Under each visit the board names the schedule run its assignment came from by
the weeks that run covered and when it was published — *"Published schedule
15–21 Sep, published 15 Sep 20:05"* — and links to Schedule History for the
rest of that run's story.

In the editor:

- **Add crew member** — the employee list only shows people who are
  actually eligible for this site's branch. An employee permanently
  stationed at a different site can still be selected here, but adding
  them produces a validation error explaining why (see section 5).
- **Add vehicle** — vehicles that can serve the visit's branch are offered:
  those recorded in that branch, plus a manually created legacy vehicle with
  no recorded branch. The Technician Matrix never states a vehicle's branch,
  so the importer applies the approved Colombo default on both create and
  update. A vehicle recorded in a *different* branch is never offered. If no
  active vehicle can serve the branch, the drawer says so instead of offering
  an empty list. Once a vehicle is chosen, the **Driver** dropdown next to it
  only offers people who are *both* already on this crew *and* individually
  checked as authorized to drive that specific vehicle — never anyone else,
  even if they're authorized for a different vehicle.
- **Reason for this change** — fill this in before saving a manual edit. Until
  then, the Save control says that it is waiting for a reason; selecting it
  focuses this required box. Other blockers are described beside the same
  control instead of leaving it silently unavailable.

Once every check passes, the panel says *"This crew is eligible to take
the visit"* and Save becomes available.

---

## 5. Vehicles with more than one driver

A company vehicle is not owned by one person. Open **Vehicles** and click
any vehicle to see its full list of authorized drivers — every one is
shown as an equal row reading only "Authorized to drive," with no
"primary driver" or ownership concept anywhere on the page.

![Authorized drivers for one vehicle](uat/screenshots/o09-all-checked-drivers-lm3067.png)

This carries through to assignment:

- In the **Edit crew** drawer, the **Driver** dropdown for a vehicle only
  offers people who are *both* on that visit's crew *and* individually
  checked as authorized for that specific vehicle. Someone not checked for
  it never appears in the list at all — there's nothing to reject after
  the fact, because the list is filtered before you open it.

  ![Unauthorized driver excluded from the dropdown](uat/screenshots/o09-unauthorized-driver-excluded.png)

- The same vehicle can be assigned to two different visits at
  **non-overlapping times**, with a different authorized driver for each
  visit. Overlapping use is blocked as `VEHICLE_DOUBLE_BOOKED`.
- If you remove the assigned driver from the crew (not the vehicle), the
  vehicle's **Driver** field clears back to its placeholder and the
  Validation panel immediately re-checks, naming any other crew member who
  is still authorized for that vehicle:

  ![Driver selected before crew removal; the demo visit has separate crew-size and skill conflicts](uat/screenshots/before-driver-removed-from-crew.png)
  ![Re-validated after the driver is removed from the crew](uat/screenshots/after-driver-removed-revalidated.png)

---

## 6. Understanding validation errors

Every rule the system enforces shows up the same way: a labelled card, a
stable error code (useful if you ever need to report an issue), a
plain-English explanation, and a **What to do** line telling you the fix.
You never have to guess.

| What you'll see | What it means | What to do |
| --- | --- | --- |
| **Insufficient crew** `CREW_TOO_SMALL` | Fewer people assigned than the agreement requires. | Add more crew, or fix the crew size on the agreement if it's genuinely wrong. |
| **Missing PMS supervisor** `NO_PMS_SUPERVISOR_AVAILABLE` | Nobody in the crew holds a PMS grade (Senior PMS, PMS, Assistant PMS, SPMS or APMS). | Add a PMS-grade employee from the same branch. |
| **Permanent-staff restriction** `EMPLOYEE_PERMANENTLY_STATIONED` | You've added someone who is permanently stationed at a different site. | Assign a mobile crew member instead. |
| **Missing skill** `SKILL_NOT_HELD` | The job needs a specific skill nobody in the crew holds. | Add someone qualified, or fix the required skills on the agreement. |
| **No authorized driver** `NO_AUTHORIZED_DRIVER` | A vehicle is assigned but nobody in the crew is checked to drive it. | Name one of the checked drivers already in the crew, or add one who is checked. |
| **Unavailable vehicle** `VEHICLE_CAPACITY_EXCEEDED` | The vehicle's seat count is smaller than the whole on-site crew. | Replace it with one vehicle large enough for the full crew. |
| **Unavailable vehicle** `TOO_MANY_VEHICLES` | More than one vehicle is assigned to the visit. | Keep exactly one suitable vehicle and release the others. The current release does not split a crew across multiple vehicles. |
| **Employee / Vehicle overlap** `EMPLOYEE_DOUBLE_BOOKED` / `VEHICLE_DOUBLE_BOOKED` | This person or vehicle is already committed elsewhere at an overlapping time. | Assign someone/something else, or move one of the two visits. |
| **Employee / Vehicle travel gap** `EMPLOYEE_TRAVEL_GAP_TOO_SHORT` / `VEHICLE_TRAVEL_GAP_TOO_SHORT` | This person or vehicle has less than 60 minutes to move between different service sites. Same-site jobs may follow immediately. | Move one visit by enough time, or choose a different available person or vehicle. |

None of these are colour-only — every one carries text, so they read
correctly even in black-and-white or for a colour-blind reader.

---

## 7. Overrides and locks

Any manual edit through **Edit crew** is an override — it's how you swap
a sick technician, change a vehicle, or fix a visit the scheduler couldn't
resolve on its own. Every override requires a **Reason**, which is kept in
the visit's history.

If you don't want your manual override undone the next time the scheduler
runs, use **Pin parts of this assignment** at the bottom of the editor:

![Pin controls](uat/screenshots/pin-lock-controls.png)

You can pin just the date & time, just the supervisor, just the crew, just
the vehicle, or everything about the assignment. A pinned part is kept
exactly as-is on the next run — the scheduler works around it instead of
overwriting it.

---

## 8. Publishing a schedule

Go to **Schedule History**. This is where the automated optimizer runs —
give it a date range and a branch, click **Start run**, and it proposes a
schedule.

![Schedule History](uat/screenshots/schedule-history-publish.png)

A run stays a **draft** until you review it and click **Publish**.
Publishing is one-way: a published run is never edited in place — running
again and publishing a new one supersedes it, and both stay on the record
for history. This is also where you'd generate a schedule covering a
period, rather than assigning visit-by-visit from the Dispatch Board.

---

## 9. Customers and sites that are no longer active

An inactive customer or site is labelled in **text** (not colour alone) —
e.g. "1 active, 1 inactive" on the Customers list, or an "Inactive" badge
when filtering to inactive customers.

![An active customer with one inactive site, labelled in text](uat/screenshots/o09-active-customer-with-inactive-site-label.png)
![A fully inactive customer, labelled with a badge](uat/screenshots/o09-inactive-customer-labeled.png)

Deactivating a customer or site:

- Removes it from every picker used to create new work — the "Add
  agreement" customer/site dropdowns, for example — so nobody can
  accidentally schedule new work there. A still-active customer with one
  inactive site keeps offering its other active sites; only the inactive
  one drops out of the site picker.

  ![The inactive site no longer offered on Add agreement](uat/screenshots/o09-inactive-site-excluded-from-picker.png)

- Stops it from generating any new visits.
- **Does not** hide anything that already happened — a visit that was
  generated before the site went inactive stays visible and editable on the
  Dispatch Board and in history. Going inactive only affects future
  scheduling.

  ![A visit generated before deactivation, still visible and editable](uat/screenshots/o09-historical-info-still-accessible.png)

**Note:** in this phase, deactivating a customer/site is not something you
do from this portal directly — it's set by the underlying data import. If
you need one deactivated, contact the person who manages the data import.

---

## 10. Common problems and how to recover

**"I can't find an employee/vehicle in the picker."**
Check the branch on the visit and on the employee/vehicle — the portal only
offers matches within the same branch; this filtering is not lifted for
anyone. Permanently stationed staff are a narrower exception *within* that
same-branch rule: they still only appear on visits for their own branch,
but within that branch they're selectable for any of that branch's sites,
not filtered down to their permanent one first — and get rejected by
validation if you pick a site other than the one they're stationed at.

**"Save stays greyed out and I don't see an error."**
Check the **Reason for this change** field — it's required, and an empty
one silently disables Save with no separate warning.

**"The site I need isn't in the picker at all."**
It's most likely inactive. Check the Customers list with the Status filter
set to "Inactive."

---

## What's coming later (Phase 2)

The following are **out of scope for this Phase 1 pilot** and are not in
this portal:

- A tablet view for PMS supervisors in the field.
- A mobile app for technicians/workers.
- Push notifications.

The underlying data model already keeps these compatible for later, but
there is nothing to click on for them today — if a screen doesn't exist for
one of these, that's expected, not a bug.

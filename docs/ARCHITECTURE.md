# Architecture

## Three services, one job

```
┌──────────────────────┐        ┌──────────────────────┐
│  apps/manager-web    │  HTTP  │      apps/api        │
│  Next.js             │───────▶│      NestJS          │
│  The manager's screen│        │  System of record    │
│  [Oshadi]            │◀───────│  [Chanya]            │
└──────────────────────┘  JSON  └───────┬──────┬───────┘
           ▲                            │      │
           │ imports types              │      │ enqueue
           │                            ▼      ▼
┌──────────┴───────────┐        ┌──────────┐ ┌──────────┐
│ packages/api-contracts│       │PostgreSQL│ │  Redis   │
│ OpenAPI + TS client   │       │  Prisma  │ │ BullMQ   │
│ [Chanya]              │       └──────────┘ └────┬─────┘
└───────────────────────┘                         │
                                                  ▼
                                     ┌────────────────────────┐
                                     │  services/scheduler    │
                                     │  Python / FastAPI      │
                                     │  Constraint solving    │
                                     │  [Chanya]              │
                                     └────────────────────────┘
```

### `apps/api` — NestJS

The system of record and the only writer to the database. Owns every business
rule. Nothing else talks to PostgreSQL.

Why NestJS: opinionated module structure, first-class OpenAPI generation from
decorators, and dependency injection that makes the rule engine straightforward
to unit-test.

### `services/scheduler` — Python / FastAPI

Given a set of visits and the eligible resources, works out an assignment that
satisfies every hard rule and ranks well against the soft preferences. Stateless
— the API sends it a problem and stores the answer.

Why a separate Python service: constraint solving is Python's strongest
ecosystem (OR-Tools), and keeping it out of the API means a slow solve never
blocks a manager clicking around the dispatch board.

### `apps/manager-web` — Next.js

Everything the manager sees. Holds no business rules of its own: it renders what
the API returns and shows the reasons the API gives for a conflict. A rule
duplicated in the frontend is a rule that will eventually disagree with the backend.

### `packages/api-contracts`

The OpenAPI document generated from the API's decorators, plus the TypeScript
types generated from it. This is the seam between the two developers.

---

## Why a queue

Generating three months of recurring visits, or re-optimising a week's schedule,
takes seconds to minutes. Doing that inside an HTTP request would time out and
leave the manager staring at a spinner.

Instead the API creates a `ScheduleRun` row, enqueues a BullMQ job and returns
immediately. The manager portal polls the run's status. Every run is a durable
database row, so the operations history shows exactly what was generated, when,
by whom, and what it produced.

Phase 1 registers two queues:

| Queue              | Purpose                                                               |
| ------------------ | --------------------------------------------------------------------- |
| `visit-generation` | Turn service agreement frequency rules into concrete visits (ULK-C04) |
| `schedule-run`     | Run the optimizer over generated visits (ULK-C06)                     |

---

## Where the rules live

Every hard rule is enforced in `apps/api`, in one place, with tests.

| Rule                        | Enforced by                                                                      |
| --------------------------- | -------------------------------------------------------------------------------- |
| Branch separation           | `branchCode` carried on employee, site, agreement, visit and assignment          |
| Permanently stationed staff | `PermanentAssignment` excludes an employee from mobile crew selection            |
| At least one PMS supervisor | `isPmsGrade` on Employee, denormalised to `AssignmentCrewMember.isPmsSupervisor` |
| Authorized driver only      | `VehicleAuthorization` must exist for `AssignmentVehicle.driverEmployeeId`       |
| Allowed vs preferred days   | `ServiceAgreementDayRule.kind` — `ALLOWED` filters, `PREFERRED` only ranks       |
| Booked dates are facts      | `ServiceAgreementBooking` — a booked period's visits are exactly those dates     |
| One day, one day's work     | `VISIT_GENERATION_DAILY_CAP` — the cross-agreement load guard in generation     |
| Service hours               | `SiteOperatingHours` per weekday, plus the agreement's optional window           |
| No double booking           | Overlap check across `Assignment.plannedStart`/`plannedEnd`                      |

When a rule cannot be satisfied, the visit stays `UNASSIGNED` and a
`VisitUnassignedReason` row records a stable code and a manager-readable
explanation. **A rule is never relaxed to make the board look full.**

---

## Where a visit lands

Frequency says how many visits a period needs. It never said which days, and
taking the earliest allowed day of every period put forty-seven monthly
agreements in the first week of the month — 192 visits in week one against 48,
60, 74 and 25 in the weeks after, with single days carrying 28. The workbook's
own plan for the same book of work is 159 visits over 28 days, never more than
twelve on one of them.

Placement is decided in three steps, and which one applied is recorded on the
visit so a manager can see it.

1. **Bookings win** (`BOOKED`). The master schedule's month columns hold the
   days already agreed with each customer. A period holding one or more of
   them requires exactly those dates — no re-planning — and a booked weekday
   outranks the allowed-days rule, because that rule is usually inferred from
   these very dates. A booked date the site has no usable window on still
   becomes a visit, but not by inventing a day: hours recorded for that
   weekday are used as they stand, however short, and keep their own
   provenance; only a weekday with *no* hours on record falls back to the
   disclosed 08:00-17:00 assumption, flagged `DEFAULTED`. Either way the
   contradiction comes back as a booking warning naming the date and the
   agreement — never the customer, because a warning outlives the screen it
   was raised on. And a period booked fewer times than the frequency promises
   is reported as a `BOOKED_BELOW_FREQUENCY` shortfall: the bookings still
   stand exactly as written, and nothing extra is planned, but the gap is not
   left for someone to notice a quarter later.
2. **Anchors place the rest** (`ANCHORED`). For a month nothing is booked in,
   `computeSchedulePreview` ranks candidates by preferred weekday, then by how
   far the candidate's day of month sits from the agreement's anchor, then
   earliest. Anchors come from the bookings: each month's booked days are
   ranked within that month and the medians taken, so "the 5th and the 20th"
   stays two anchors rather than collapsing into one day mid-month. An
   agreement with no bookings keeps the old earliest-first behaviour
   (`EARLIEST`). The label is per visit, not per period: an agreement served
   four times a month with one known anchor gets one `ANCHORED` visit and
   three `EARLIEST` ones, because the anchor had no part in choosing the other
   three. The preview stays pure — anchors are an input to it.
3. **The load guard spreads what is left** (`SPREAD`). Each agreement is
   planned alone, so nothing in step 2 can see that forty of them chose the
   same Monday. `VisitGenerationService` runs one cross-agreement pass over
   every planned visit: for a (branch, date) above `VISIT_GENERATION_DAILY_CAP`
   — default 12, the workbook's own busiest day — it moves unbooked visits to
   the emptiest other day inside their own period, lowest load then earliest,
   taking agreements in id order so a second run makes the same moves. Booked
   visits count towards the load and are never moved. A day left over the cap
   comes back as a warning naming the date and the count, never a customer.

   The guard's picture of a day is not limited to the run's own list. Every
   visit already standing in the horizon that the run will not be replacing is
   counted towards its day and barred as a destination for the agreement that
   already holds it. Three kinds qualify, and the set is deliberately the
   complement of "this run's to judge" rather than of "protected":

   - protected work, which stays whatever the run decides;
   - every agreement outside a scoped run. Without this a run scoped to one
     agreement read every day as empty, anchored onto a Monday already
     carrying twelve, and the next full run moved it straight off again;
   - and **a visit whose period this run did not plan** — a monthly visit met
     from a week view, skipped because the week holds no whole month. It is
     rightly outside `existing`, since the run must never propose removing it,
     and it used to be outside `standing` too, so it counted nowhere. A week
     run read the Monday as emptier than it is and placed weekly work onto it;
     the month run, whose fuller picture was right, moved that work straight
     off again. Measured on a fresh database: an ISO week, then its month
     grid, then the same ISO week again offered two additions and two removals
     for work nobody had touched.

   Standing is read over the run's own range only — the whole range and
   nothing wider. Those are the days the guard may place anything on, and a
   day the run was never asked about is not its to warn about. The read used
   to widen to the enclosing calendar months for protected and out-of-scope
   work, which bought the guard nothing it could act on and cost a manager
   real confusion: previewing 28 September to 1 November on the walkthrough
   database returned four over-cap warnings, all of them for September days
   that view cannot touch. The warnings are filtered to the range as well,
   because pinning a requirement onto a protected visit outside it can put one
   there by another road.

### What a period is

A period is a **whole ISO week (Monday to Sunday) or a whole calendar month**,
and an interval above one groups them from the agreement's **own start date**: a
fortnightly agreement's fortnights are the two ISO weeks counted from the week
it began in, and a quarterly agreement's quarters are the three-month blocks
counted from the month it began in. `periodIndexOf` is the single definition,
and the bookings, the anchors, the pinning, `honourProtectedDates` and the load
guard all key by `(agreement, periodIndex)`, so they cannot disagree.

Because the phase belongs to the agreement, **editing an agreement's start date
or its frequency interval re-phases every future period of it**: a fortnight
counted from the 5th is not the fortnight counted from the 12th, and a visit
already generated under the old phasing sits in a period the next run no longer
plans. That is correct — the agreement really did change — but it is not
something to discover from a calendar that has quietly moved, so the agreement
form says it beside the start date.

Periods used to be phased from the run's own `from`, and that made the answer
depend on who pressed the button. The portal's week view sent its Monday-to-
Sunday week; the month view sent the calendar month; September began on a
Tuesday, so the month view's buckets ran Tuesday to Monday. A weekly Mon–Fri
agreement got Monday the 14th from one view and Tuesday the 15th from the
other — a duplicate where the Monday was protected, and churn where it was not.
Fortnightly and quarterly agreements, which the importer produces, generated
nothing at all from any view: no portal range held one of their periods whole,
and a clipped period is skipped. Anchoring periods to the agreement fixes all
of it at once, because a fortnight then belongs to the agreement that sells it.

### What a range may plan

A run plans only the periods its range holds **whole**. The calendar grid
September is drawn on begins on 31 August and ends on 4 October; asked to
generate that, the run used to plan the one-day stub of August as though it
were the month, and the August visit already published on the 17th lay outside
the range where neither the pinning nor the load guard could see it — two
August visits, every press of the button. So: a period clipped by the horizon
is left to the run that can see it whole, and a period clipped by the
agreement's own first or last day is planned, because the agreement really does
begin or end there. A booking inside such a stub still stands: a booked date is
a commitment to a day, not a plan the run made.

With periods calendar-aligned, "whole" is a property of the range and the
cadence alone, so the portal can choose ranges the two views agree about. **Both
views send whole ISO weeks**: the week view sends its own seven days, and the
month view sends the grid it already draws, which begins on a Monday, ends on a
Sunday, and contains the whole calendar month. That range therefore holds a
whole week for every weekly agreement and a whole month for every monthly one —
and a week generated from the week view and then from the month view is planned
identically. The calendar month on its own would hold the month but neither
end's week, which is exactly what made the two views disagree.

A **fortnight is not guaranteed** by that alone, and saying it was hid a real
loss. A fortnight is phased from the agreement's own start, so it can straddle
the join between two month grids. Normally that is harmless: one month's grid
reaches into the next — March's runs to 3 May, September's to 4 October — so
consecutive runs overlap and one of them holds the straddling fortnight whole.
The exception is a month that **begins on a Monday**. May 2026's grid ends on
Sunday 31 May and June's begins on Monday 1 June, with not one day in common;
the fortnight from 25 May to 7 June is clipped by the horizon in both, so
neither run plans it, neither is "the run that can see it whole", and the
customer loses a visit with nothing said. Two things close it:

- where a month grid ends the day before a month begins, `rangeForGeneration`
  reaches **one whole ISO week further**, so consecutive month ranges always
  overlap by a week. That week is a whole ISO week, so a weekly agreement
  plans it exactly as the week view would, and a monthly one still skips it as
  the stub it is. The week view is untouched: it asks about its own seven days
  and no more, because a manager who generates a week must not find visits in
  the next one.
- a range that leaves a period of a **multi-week cadence** unfinished says so
  even when it planned that agreement's other periods, as
  `RANGE_CLIPS_A_PERIOD` — but only when the period is genuinely at risk, on
  two counts.

  The first is arithmetic. Because the grids overlap by exactly one ISO week,
  the next grid always begins on the **Monday of this range's final week**. A
  period cut by this range's *end* is therefore picked up by the next grid
  whenever it began on or after that Monday. A fortnight is fourteen days and
  the overlap is seven, so an end-clipped fortnight **always** begins inside
  the overlap: **with one week of overlap, fortnights are always covered**,
  and this warning exists for cadences of **three weeks or more**, whose
  periods are long enough to begin before the next grid does. Reporting every
  end-clipped fortnight was not an occasional false alarm but a total one —
  the October grid on the walkthrough database named eleven, and November's
  grid planned a visit in all eleven.

  The second is evidence. A period cut by this range's *start* ordinarily
  belongs to the run before this one, whose range reaches at least this one's
  first day — but that run may never have happened. An agreement created on 28
  May starting the 27th has a first fortnight of 25 May to 7 June; May was
  generated on the 1st, before the agreement existed, and June's run met that
  period clipped at the start and skipped it in silence. So rather than reason
  about which runs someone has pressed, the rule asks the calendar: a clipped
  period **a visit of that agreement already stands in** was handed over as
  designed and is not reported, and an empty one is. That test applies at both
  edges and assumes nothing. (`around`, the existing visits over the enclosing
  months, is already loaded; `periodIndexOf` places each of them.)

  A clipped *month* is never reported at all — the next grid holds the
  calendar month whole by construction. The impact drawer gives the clipped
  case its own advice, because the line for `RANGE_HOLDS_NO_WHOLE_PERIOD`
  ("switch to the month view") is wrong here: nothing beginning later picks
  the period up, and nothing stands in it. Nor can the advice be "generate
  over a range that reaches its last day" — in the month view a manager picks
  a month, not a range — so it names the month to generate from instead.

Generation still reads the existing and standing visits over the whole
calendar months the range touches; what it may *change* is still exactly the
range it was given, and now so is what it may warn about.

Neither view holds a whole quarter. An agreement whose cadence the range cannot
hold is not planned and is named in `skippedPeriods` — agreement, unit,
interval, count — which the impact drawer renders by cadence as "Quarterly
agreements need a range covering a whole quarter; 3 skipped". A bare zero there
is indistinguishable from a calendar already in order, and that is how
fortnightly and quarterly work went missing without a word.

And the comparison against what already exists is limited, per agreement, to
the periods that agreement actually planned. Without that, a month view offered
to delete the week a week view had just created. The one exception is not a
period at all: a visit outside the agreement's **own** start or end date is not
waiting for a better run — no period will ever ask for it again — so it stays
this run's to propose for removal.

Confirming a generation run writes a `ScheduleRun` to account for what it did,
which put it in Schedule History beside the solver's runs — where its
`visitsScheduled` of 0 was read by the solver's own yardstick and badged "Draft
— no dispatchable assignments", directly above a real run. A manager reads that
as a schedule that failed. `trigger` does not tell the two apart (it defaults
to MANUAL and neither writer sets anything else), so the read side derives the
run's `kind` from the one relation that does: every optimiser run is created
with a dispatch outbox row in the same transaction, and generation creates
none. Deriving it rather than adding a column also settles the rows already in
the database — with one gap. The outbox arrived with migration
`20260908093000`, and every solve run before it has no row, which read those
runs as generation. Two marks only a solve ever carries stand in: a queue
delivery id (`jobId`), which generation never sets, and `visitsScheduled` above
zero, which generation always leaves at zero. **A `kind` column written by both
writers is the long-term answer**; this derivation is what can be had without a
backfill, and it should be replaced the next time the schema moves. A `VISIT_GENERATION` run carries a null `publishReadiness` —
there is no publication for it to be ready for — and the portal names it, counts
the visits it generated, and offers no Publish.

A run is **named on screen by the weeks it covered and the moment it was
published**, never by its id. The operational visits list printed "Published
schedule version 6a1d0f2e-9c4b-…" nineteen times down a single day: a uuid
tells a manager nothing they can act on, and makes every row look different
from every other. The operations day read model therefore carries the run's own
`rangeStart`/`rangeEnd` — one batched lookup per day, not one per visit — and
the line reads "Published schedule 15-21 Sep, published 15 Sep 20:05", linking
to Schedule History where the rest of the run's story is. The id stays in the
payload for that link and is never rendered — and the link **carries** it, as
`?run=<id>`, so Schedule History marks that run and scrolls to it rather than
leaving a manager to find a date range by eye down fifty rows.

The same rule reaches the two other places a raw id was printed. The visit
detail drawer's "Schedule run" row showed `generatedByRunId` as a uuid; the
visit origin now carries the generating run's own `rangeStart`/`rangeEnd`
(looked up per visit, not joined into the list query) and the row reads "15-21
Sep". And the per-visit published-assignment lineage printed eight-character id
prefixes for each version, its repair and what it superseded — three hashes on
one line, none of them searchable. It reads by **ordinal and by what produced
it** instead: "Version 12 of 13 · superseded · from the audited repair of 10
Sep · replaces version 11", numbered from the whole chain so truncation cannot
make it lie, and "replaces an earlier version" when the predecessor is not in
the window shown.

A cancelled visit's shortfall names the cancellation only when the period had
days enough without it. Blaming it whenever *any* of the period's days was
blocked sent a manager to reinstate a visit that would still have left the week
short — the remaining cause being a window an hour under the visit, or a day
the site is shut. And a **booked** date whose visit is cancelled is the one
case a booking cannot answer for itself: bookings deliberately bypass the
blocked slots, because a booking cannot be moved, but the cancelled row holds
that `(agreement, date, start time)` for ever, so the day the customer agreed
can never be served again and the plan read it as already correct, run after
run. It now comes back as a `BOOKED_DATE_CANCELLED` booking warning naming the
date.

A cancelled visit is protected and never removed, and it satisfies no period —
the work did not happen. Its **slot** is spent, though: a visit is identified by
agreement, date and start time, so the cancelled row holds that identity for
ever and the unique index forbids anything new on it. Generation used to match
the period's requirement to the cancelled row, report it unchanged, and leave
the week with no live visit at all, every run agreeing there was nothing to do.
The cancelled slots are now passed into the preview as blocked, so the period
takes another allowed day (and that day is never offered to the load guard
either); where it has no other day, it is a shortfall saying the only visit is
cancelled. A booked date is exempt, because a booking cannot be moved.

A visit can breach the window/duration invariant without anyone having erred:
a booked date on hours the site records as an hour is planned on those hours
deliberately. So a hand edit enforces the invariant only when the edit touches
`windowStartMinute`, `windowEndMinute` or `durationMinutes` — validating it on
every edit made such a visit uneditable, refusing a crew-size change for a
window the manager had not touched. The breach is shown instead, as a badge on
the visit itself, because the generation warning that raised it is gone the
moment the panel closes.

Regeneration's existing protections are untouched by all of this: a published,
locked, hand-edited or already-staffed visit is reported and left exactly as it
is, and a placement that would change shows up in the preview like any other
difference.

One thing those protections needed in addition, once dates started moving. A
visit is identified by agreement, date and start time, so a period re-planned
onto another day is one addition and one removal — right for a visit the
generator owns, wrong for one a manager owns, where the removal is refused and
the addition goes ahead anyway and the customer ends up with two visits in one
period. So **a protected visit satisfies its period**: the requirement for that
(agreement, period) is pinned to the protected visit's date and start time
rather than planned onto another day, it keeps the placement already on record
(the manager chose the day, not the generator), and it is never offered to the
load guard. The requirement takes that visit's whole window, both ends of it:
the window belongs to the day, and a day the site shuts at noon does not get
the closing time of the day the generator had in mind. What the agreement
still owns — how long the visit is, how many people it needs — comes from the
agreement, so a genuine change is still reported as one and still not applied.
A period holding more protected visits than the agreement now asks for keeps
the surplus and reports it, exactly as before: nothing here removes work. And
a date is not a slot: a site served morning and afternoon on the same Monday
holds two protected visits that day, and each satisfies one requirement.

A cancelled visit is the exception that proves the rule. It is protected, so
it is never removed — but it stands for work that did not happen, so it
satisfies no period and reserves no room: the period still asks for its visit,
and the day it sits on is counted as empty by the load guard, exactly as the
optimizer counts it when it staffs the day.

Pinning stops a duplicate; it must not also hide a difference. The pinned
requirement remembers the day generation had chosen, and the plan reports it as
a protected `visitDate` change — "generation would have moved it to the 18th".
Without that, a visit a manager holds on a weekday the agreement no longer
allows reads as unchanged on every run, and nothing ever prompts anyone to move
it. Nothing is applied: a protected visit is still never written.

It is reported **only when the keeper's weekday is not one the agreement still
allows**. Remembering it whenever the two days merely differed told a manager
who had moved a Monday visit to Wednesday, both allowed, that generation would
have moved it back — on every run, for ever. A report that never goes away is
one nobody reads, and it buried the case the report exists for: the visit
stranded on a Saturday the agreement has since dropped.

---

## Phase 2 compatibility

Phase 2 adds PMS tablet views, a worker mobile app and push notifications. Those
are not built now, but Phase 1 does not paint them into a corner:

- `Assignment` already carries `publishedAt`, `acknowledgedAt`, `startedAt` and
  `completedAt`, so the worker app has somewhere to write.
- `AssignmentStatus` already includes `ACKNOWLEDGED` and `IN_PROGRESS`.
- `AuditEvent` is generic (`entityType`, `entityId`, `action`, `before`, `after`),
  so new event types need no migration.
- Publishing a schedule writes an `AssignmentNotificationOutbox` row per crew
  member (ULK-C07). Nothing reads these rows in Phase 1 — no push
  notification is sent — but a future consumer can send them and mark
  `processedAt` without any change to how they are written.
- `GET /api/schedule/calendar` and `GET /api/employees/{id}/assignments`
  (ULK-C07) already return the crew roster, supervisor, instructions,
  assignment status and published-schedule identity a PMS tablet or worker
  app would need — see [`docs/API_INTEGRATION.md`](API_INTEGRATION.md).
  The employee endpoint is currently restricted to managers/admins. Worker
  access requires a User-to-Employee identity link and self-scope authorization
  in Phase 2; the read model alone does not provide worker authentication.
- Every entity uses a stable UUID, so a mobile client can hold a reference across
  sessions.

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
   visit already standing in the horizon that the run will not be replacing —
   protected work, and every agreement outside a scoped run — is counted
   towards its day and barred as a destination for the agreement that already
   holds it. Without that a run scoped to one agreement read every day as
   empty, anchored onto a Monday already carrying twelve, and the next full
   run moved it straight off again; placement flapped with whatever scope
   somebody happened to generate under.

One more thing decides where a visit lands, and it is the range itself. A run
plans only the periods its range holds **whole**. The calendar grid September
is drawn on begins on 31 August and ends on 4 October; asked to generate that,
the run used to plan the one-day stub of August as though it were the month,
and the August visit already published on the 17th lay outside the range where
neither the pinning nor the load guard could see it — two August visits, every
press of the button. So: a period clipped by the horizon is left to the run
that can see it whole, and a period clipped by the agreement's own first or
last day is planned, because the agreement really does begin or end there. A
booking inside such a stub still stands: a booked date is a commitment to a
day, not a plan the run made. The portal sends the calendar month for a month
view and its own seven days for a week view, and generation reads the existing
and standing visits over the whole calendar months the range touches — what it
may *change* is still exactly the range it was given.

Confirming a generation run writes a `ScheduleRun` to account for what it did,
which put it in Schedule History beside the solver's runs — where its
`visitsScheduled` of 0 was read by the solver's own yardstick and badged "Draft
— no dispatchable assignments", directly above a real run. A manager reads that
as a schedule that failed. `trigger` does not tell the two apart (it defaults
to MANUAL and neither writer sets anything else), so the read side derives the
run's `kind` from the one relation that does: every optimiser run is created
with a dispatch outbox row in the same transaction, and generation creates
none. Deriving it rather than adding a column also settles the rows already in
the database. A `VISIT_GENERATION` run carries a null `publishReadiness` —
there is no publication for it to be ready for — and the portal names it, counts
the visits it generated, and offers no Publish.

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

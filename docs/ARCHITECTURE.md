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

| Queue | Purpose |
| --- | --- |
| `visit-generation` | Turn service agreement frequency rules into concrete visits (ULK-C04) |
| `schedule-run` | Run the optimizer over generated visits (ULK-C06) |

---

## Where the rules live

Every hard rule is enforced in `apps/api`, in one place, with tests.

| Rule | Enforced by |
| --- | --- |
| Branch separation | `branchCode` carried on employee, site, agreement, visit and assignment |
| Permanently stationed staff | `PermanentAssignment` excludes an employee from mobile crew selection |
| At least one PMS supervisor | `isPmsGrade` on Employee, denormalised to `AssignmentCrewMember.isPmsSupervisor` |
| Authorized driver only | `VehicleAuthorization` must exist for `AssignmentVehicle.driverEmployeeId` |
| Allowed vs preferred days | `ServiceAgreementDayRule.kind` — `ALLOWED` filters, `PREFERRED` only ranks |
| Service hours | `SiteOperatingHours` per weekday, plus the agreement's optional window |
| No double booking | Overlap check across `Assignment.plannedStart`/`plannedEnd` |

When a rule cannot be satisfied, the visit stays `UNASSIGNED` and a
`VisitUnassignedReason` row records a stable code and a manager-readable
explanation. **A rule is never relaxed to make the board look full.**

---

## Phase 2 compatibility

Phase 2 adds PMS tablet views, a worker mobile app and push notifications. Those
are not built now, but Phase 1 does not paint them into a corner:

- `Assignment` already carries `publishedAt`, `acknowledgedAt`, `startedAt` and
  `completedAt`, so the worker app has somewhere to write.
- `AssignmentStatus` already includes `ACKNOWLEDGED` and `IN_PROGRESS`.
- `AuditEvent` is generic (`entityType`, `entityId`, `action`, `before`, `after`),
  so new event types need no migration.
- Every entity uses a stable UUID, so a mobile client can hold a reference across
  sessions.

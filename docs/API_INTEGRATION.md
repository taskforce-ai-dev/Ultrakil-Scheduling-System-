# API integration — what the manager portal consumes

Written for ULK-C07. The full contract is generated from the API's own
decorators — `packages/api-contracts/openapi/openapi.json`, browsable live at
`/api/docs` — so this is not a second copy of it. It answers the question the
generated document does not: **which of these endpoints does
`apps/manager-web` actually call, and why**. Regenerate the contract after any
endpoint change:

```bash
pnpm contracts:generate
```

CI fails a pull request whose committed contract does not match the code.

---

## Authentication

| Endpoint | Portal usage |
| --- | --- |
| `POST /api/auth/login` | Manager/admin sign-in. Returns a bearer token. |
| `GET /api/auth/me` | Confirms the stored token is still valid on app load. |

Every other endpoint below requires `Authorization: Bearer <token>`.

## Reference data

| Endpoint | Portal usage |
| --- | --- |
| `GET /api/branches` | Colombo/Kandy branch picker. |
| `GET /api/skills` | Skill picker on employee and agreement forms. |
| `GET /api/meta` | Build/version info shown in the footer. |

## Workforce (`apps/api/src/workforce`)

| Endpoint | Portal usage |
| --- | --- |
| `GET/POST /api/employees`, `GET/PATCH /api/employees/{id}` | Employee directory and edit form. |
| `POST/DELETE /api/employees/{id}/vehicle-authorizations/{vehicleId}` | Driver authorization toggle on an employee's page. |
| `PUT /api/employees/{id}/permanent-assignment` | Stationing an employee at a permanent site. |
| `PUT /api/employees/{id}/skills` | Replacing an employee's skill set. |
| `POST /api/employees/{id}/availability`, `DELETE .../availability/{id}` | Recording and removing absences. |
| `POST /api/employees/{id}/(de)activate` | Deactivate/reactivate an employee. |
| `GET/POST /api/vehicles`, `GET/PATCH /api/vehicles/{id}` | Vehicle directory and edit form. |
| `GET /api/vehicles/{id}/authorized-drivers` | Driver picker when assigning a vehicle. |
| `POST /api/vehicles/{id}/(de)activate` | Deactivate/reactivate a vehicle. |
| `GET /api/employees/{employeeId}/assignments` **(new, ULK-C07)** | Phase 2-compatible read model — an employee's published daily assignments. Not called by any Phase 1 screen; exists so a PMS tablet or worker app can be added later without a new endpoint shape. |

## Customers, sites and agreements (`apps/api/src/catalog`)

| Endpoint | Portal usage |
| --- | --- |
| `GET/POST /api/customers`, `GET/PATCH /api/customers/{id}` | Customer directory and edit form. |
| `POST /api/customers/{id}/(de)activate` | Deactivate/reactivate a customer. |
| `GET/POST /api/customers/{id}/sites` | Sites list and creation under a customer. |
| `GET/PATCH /api/service-sites/{id}`, `POST .../(de)activate` | Site edit form. |
| `GET/POST /api/service-agreements`, `GET/PATCH /api/service-agreements/{id}` | Agreement creation and edit form — frequency, allowed/preferred days, crew size, window. |
| `GET /api/service-agreements/{id}/schedule-preview` | "What would this generate?" preview before saving. |
| `GET /api/service-agreements/{id}/versions` | Version history shown on the agreement page. |
| `POST /api/service-agreements/{id}/status` | Pause/resume/archive an agreement. |
| `GET/POST /api/job-types`, `GET/PATCH /api/job-types/{id}`, `POST .../(de)activate` | Job type admin screen. |

## Scheduling (`apps/api/src/scheduling`)

| Endpoint | Portal usage |
| --- | --- |
| `POST /api/visit-generation/preview`, `POST /api/visit-generation/confirm` | "Generate visits" flow on an agreement. |
| `GET /api/visits`, `GET/PATCH /api/visits/{id}` | Visit list and hand-edit dialog. |
| `POST /api/visits/{id}/lock`, `POST /api/visits/{id}/unlock` | Pinning a visit so regeneration leaves it alone. |
| `GET/PUT/DELETE /api/visits/{id}/assignment`, `POST /api/visits/{id}/assignment/check` | Dispatch board: check eligibility, assign, unassign. |
| `GET /api/unassigned-visits` | The Unassigned queue. |
| `POST/GET /api/schedule-runs`, `GET /api/schedule-runs/{id}` | Starting the optimizer and polling a run. |
| `POST /api/schedule-runs/{id}/cancel` | Cancelling a queued/running solve. |
| `POST /api/schedule-runs/{id}/publish` | Publishing a schedule. |
| `POST /api/assignments/{id}/lock`, `POST /api/assignments/{id}/unlock` | Manager pins on the dispatch board. |
| `GET /api/schedule/calendar` **(new, ULK-C07)** | The unified calendar — see below. |

## The unified calendar

`GET /api/schedule/calendar?from=<date>&to=<date>&branchCode=<COLOMBO\|KANDY>`

One row per visit in the range (max 120 days), joining what used to take
several screens to piece together: date, time window, customer, site, job
type, the agreement's notes as manager-facing instructions, and — when a crew
is on it — the crew roster with the PMS-grade supervisor called out
(`supervisorEmployeeId`/`supervisorName`), the vehicle and driver, the
assignment's status, and its published-schedule identity
(`scheduleRunId` + `publishedAt` — there is no separate version number; a
schedule run's id and publish timestamp together *are* its version). This is
the read model behind the manager portal's unified calendar page
(`apps/manager-web/src/app/(app)/calendar`) and doubles as the Phase
2-compatible crew-roster/instructions/status read model ULK-C07 asks for —
the same row a PMS tablet could read later needs no reshaping.

`acknowledgedAt`/`startedAt`/`completedAt` on each assignment are the Phase 2
worker-app hooks already carried on `Assignment` (see
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md#phase-2-compatibility)) — always
`null` in Phase 1, because nothing writes them yet.

## The assignment notification outbox

Publishing a schedule (`POST /api/schedule-runs/{id}/publish`) now also
writes one `AssignmentNotificationOutbox` row per crew member per published
assignment (`assignment.published`, with a payload snapshot of the visit,
customer, site, and the crew member's role). Nothing reads these rows yet —
this is the write half of the outbox pattern; Phase 2 adds a consumer that
sends the notification and sets `processedAt`, without touching how
publishing writes them. No push notification is sent in Phase 1.

## Still on mocks

`apps/manager-web/src/lib/mock-data` still backs two screens directly rather
than calling the real API:

- `workforce-badges.tsx` (`mockVehicles`, `mockEmployees`)
- `vehicles/[vehicleId]/page.tsx` (`mockVehicles`)

Both are wired to `GET /api/vehicles` and `GET /api/employees` as part of this
task. Everything else the manager portal reads is already live.

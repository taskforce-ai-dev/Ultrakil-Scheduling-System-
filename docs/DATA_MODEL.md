# Data model

Defined in [`apps/api/prisma/schema.prisma`](../apps/api/prisma/schema.prisma).
Every table uses a UUID primary key and `createdAt` / `updatedAt` timestamps.

## Conventions

- **Branch is carried everywhere.** `branchCode` is denormalised onto employees,
  customers, sites, agreements, visits and assignments. Branch separation is the
  most frequently checked rule, and this keeps the check to a single column
  comparison rather than a multi-table join.
- **Source values are preserved.** Anything imported from the workforce matrix
  keeps the workbook's own spelling in `gradeLabel`, `skillLabel` and `sourceRow`.
  Normalised forms sit *alongside* the original, never replacing it.
- **Times are minutes from midnight.** Operating hours and service windows are
  stored as integers, so comparisons carry no timezone ambiguity. Dates are
  `@db.Date` in Asia/Colombo terms.

---

## Tables

### Organisation

| Table | Purpose |
| --- | --- |
| `branches` | Colombo and Kandy. |

### Workforce

| Table | Purpose |
| --- | --- |
| `employees` | One row per person in the technician matrix. `sourceKey` is the idempotency key for re-import. `isPmsGrade` marks a supervisor. `deploymentType` marks whether the person is mobile or permanently stationed. |
| `employee_skills` | Normalised `skillCode` for matching, `skillLabel` for display. |
| `permanent_assignments` | Employee ↔ site, with effective dates. A person with an active row here is never dispatched elsewhere. |
| `vehicles` | One row per vehicle column in the matrix. |
| `vehicle_authorizations` | A checkmark: this employee may drive this vehicle. Authorization only — no ownership, no primary driver. |

### Customers

| Table | Purpose |
| --- | --- |
| `customers` | Customer with its branch. |
| `service_sites` | A physical location belonging to a customer. |
| `site_operating_hours` | Opening hours per weekday. A weekday with no row is closed. |

### Services

| Table | Purpose |
| --- | --- |
| `job_types` | Type of work, with default duration, default crew size and whether a PMS supervisor is required. |
| `service_agreements` | The contract: frequency (N per week/month), crew size, duration, optional service window, date range. |
| `service_agreement_day_rules` | `ALLOWED` rows are hard constraints; `PREFERRED` rows only affect ranking. Kept as rows rather than a bitmask so the reason for a rejected day is explainable. |

### Scheduling

| Table | Purpose |
| --- | --- |
| `generated_visits` | One concrete visit produced from an agreement. Exists whether or not it can be staffed. |
| `visit_unassigned_reasons` | Why a visit could not be staffed: a stable `code` plus a manager-readable `message`. This is what the Unassigned queue displays. |
| `assignments` | A crew and vehicle proposal for one visit, with its lifecycle timestamps. |
| `assignment_crew_members` | Who is on the crew, their role, and whether they are the PMS supervisor. |
| `assignment_vehicles` | Which vehicle, and which crew member drives it. |
| `assignment_locks` | A manager pin. Re-running the scheduler preserves locked decisions. A lock can never make an invalid assignment valid. |
| `schedule_runs` | One invocation of generation or optimisation, with counters and status. |
| `audit_events` | Append-only operations history: who changed what, when, before and after. |

---

## Design decisions worth knowing

**`Employee.sourceKey`** — the workforce matrix has no reliable employee number,
so the importer derives a stable key from the normalised name plus branch and
upserts on it. That is what makes re-importing the workbook safe: it updates
people rather than duplicating them.

**`AssignmentCrewMember.isPmsSupervisor` is denormalised** from
`Employee.isPmsGrade` at assignment time. Two reasons: the "at least one PMS
supervisor" check needs no join, and if someone's grade changes next year, last
month's completed assignments still record who actually supervised them.

**`visit_unassigned_reasons` is a table, not a JSON column.** The dispatch board
filters and counts by reason code, and the codes need to be queryable.

**`VehicleAuthorization` has no `isPrimary` flag** — deliberately. The matrix
checkmark means "authorized to drive", nothing more. Adding a primary-driver
concept would invent a rule the client never stated.

**`assignment_locks` is scoped** (`FULL`, `CREW`, `VEHICLE`, `TIME`) so a manager
can pin the crew while still letting the optimizer move the time.

---

## Supporting tables

The ULK-C01 task names sixteen models. Four more exist because the named ones
require them:

| Table | Why |
| --- | --- |
| `vehicles` | `VehicleAuthorization` and `AssignmentVehicle` both need something to point at. |
| `site_operating_hours` | The rule "opening hours vary by customer and weekday" has nowhere else to live. |
| `service_agreement_day_rules` | Allowed and preferred weekdays, as queryable rows. |
| `visit_unassigned_reasons` | The Unassigned queue must show a clear reason. Defined now so the queue's shape is stable from day one; populated by ULK-C05. |

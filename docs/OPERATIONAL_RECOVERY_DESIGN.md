# UltraKIL operational recovery design

Status: approved recovery direction for implementation on `origin/main`.

## Problem statement

Managers currently cannot distinguish vehicle authorisation, draft proposals,
and the published plan that is safe to dispatch. Historical assignments created
before the one-vehicle and public-transport guards remain current even though
they violate those guards. Ordinary schedule runs intentionally exclude
published work, so they cannot repair it.

The imported workbooks also omit operational facts. Missing opening hours,
uncertain site branches, defaulted crew sizes, and unknown vehicle branches must
remain visible as unconfirmed data, never be presented as confirmed facts.

## Invariants

1. A dispatchable assignment is published and passes every current hard rule.
2. A visit uses at most one vehicle. Its driver is an authorised crew member.
3. With no vehicle, every crew member must be able to use public transport.
4. Published history is immutable. Corrections supersede it with explicit
   assignment-level lineage or withdraw the visit to the unassigned queue.
5. Draft/proposed work never substitutes for published dispatch truth.
6. Missing source data remains visibly unconfirmed and keeps its provenance.
7. Repair preview writes nothing; apply is transactional and idempotent.

## Recovery domain

Add a published-assignment validator and repair workflow. A repair targets only
current `PUBLISHED` work. `ACKNOWLEDGED`, `IN_PROGRESS`, or completed work needs
an explicit operational disposition and is never automatically rewritten.

Preview accepts exact source assignments and replacement or withdrawal
proposals, validates the complete post-repair batch, and returns a canonical
plan hash. Apply requires an administrator, reason, confirmation, idempotency
key, matching plan hash, and unchanged source fingerprints. It locks affected
visits deterministically and performs the entire repair in one transaction.

Replacement keeps the predecessor intact, creates a valid published successor,
marks only that predecessor `SUPERSEDED`, records immutable before/after
snapshots, and creates correction/publication notification intents. Withdrawal
supersedes the invalid predecessor, sets the visit `UNASSIGNED`, and records
structured reasons. Ordinary assignment writers remain unable to mutate
published history.

## Scheduler and persistence

Non-target published work is passed to the solver as fixed employee and vehicle
reservations. A repair target excludes only its own predecessor reservation.
Agreement/date candidate generation considers every sibling generated visit,
including omitted or unstaffed rows, so persistence cannot move a visit onto an
occupied unique key. Persistence locks affected agreements in sorted order and
maps a final database uniqueness race to a safe `RESOURCE_CONFLICT` response.

## Operational read model

`GET /operations/day` is the authoritative manager view. Each visit has a
server-calculated state (`READY`, `PROPOSED`, `UNASSIGNED`, `EXCEPTION`,
`COMPLETED`, or `CANCELLED`), distinct published and proposed snapshots, stable
violation codes, source-data warnings, schedule lineage, and a concrete next
action. The API, not individual pages, owns these meanings.

The dashboard and Dispatch Board consume this read model. Schedule History
shows per-visit published lineage and mixed published versions truthfully.
Unassigned Visits uses server-side date/status/conflict filters and pagination.
Zero-result runs are blocked from publication, partial runs require an explicit
acknowledgement, and manager-facing errors never expose internal URLs, Prisma
details, or raw scheduler responses.

## Source-data provenance

The Technician Matrix is authoritative for vehicle codes, capacity, ownership
group, and many-to-many driver authorisations. It does not state vehicle branch,
so branch remains unconfirmed until a manager supplies it.

The Master Schedule is authoritative only for values it actually contains.
Imported missing hours continue to use the visible assumption 08:00-17:00.
Fallback site branch, defaulted crew size/duration, and derived service days are
stored with provenance and shown as warnings. Publishing affected work requires
an explicit acknowledgement and reason; it never silently converts assumptions
into facts.

## Delivery and verification

Implementation is test-first on an isolated feature branch. Required evidence
includes solver/unit/integration/browser tests, clean database migration and
rollback compatibility, workbook dry-runs with aggregate-only output, a restored
database repair rehearsal, idempotency/concurrency/failure-injection tests,
contract regeneration, full CI, independent review, and staging verification.

Existing staging data is not mutated during code development. Before repair,
take and restore-verify a fresh backup, close write ingress, drain scheduling
work, run a write-free preview, and retain private pre/post evidence. A successful
but incorrect repair is corrected forward; history is never deleted.

# Task 4 report — deterministic staging/test synthetic capacity

## Delivered

- Added a fail-closed `db:synthetic-capacity` CLI with dry-run, explicit apply,
  and explicit branch-scoped deactivation modes.
- Database safety parses the complete URL before Prisma construction, accepts
  only PostgreSQL database names ending `_staging` or `_test`, rejects encoded
  path separators, withholds the supplied URL, and verifies
  `current_database()` after connection.
- Synthetic teams are deterministic and visibly labelled. Team size is the
  maximum effective active agreement crew size for the branch (minimum two),
  with one PMS supervisor, all active required skills, one sufficient branch
  vehicle, and two authorized team-member drivers.
- Apply/reactivation/shrink/deactivation takes employee locks before vehicle
  locks, refuses non-exact reserved identities, preserves history and
  relations, and keeps a whole surplus team active when one of its resources
  has a current/future live assignment.
- The Technician Matrix importer refuses reserved synthetic vehicle identities
  before opening its write transaction.
- Added local and Compose operator documentation. Output is count-only and the
  docs explicitly prohibit treating synthetic capacity as real-workforce or
  production-readiness evidence.

## TDD and verification evidence

- RED: the focused unit suite initially failed because
  `prisma/synthetic-capacity.ts` did not exist.
- RED: the matrix importer test initially proved a reserved synthetic vehicle
  was accepted and the transaction opened.
- GREEN unit: 2 suites, 23 tests passed.
- GREEN PostgreSQL integration: 1 suite, 6 tests passed against a freshly
  initialized, migrated, disposable `ultrakil_synthetic_test` database.
  Coverage includes write-free dry-run, injected rollback, effective active
  agreement filtering, idempotent skill/authorization relations, exact
  reactivation, team-count and member-count shrink, identity collision
  rollback, live-reference refusal, and assignment-writer/deactivation
  serialization.
- API typecheck passed.
- API lint passed with zero warnings.
- API production build passed.
- `git diff --check` passed.

No staging or production database was read or written.

## Operator note

The dry-run result reports planned resource counts. Apply/deactivate results
report actual created, reactivated, unchanged, blocked-live, and deactivated
resource counts. An operator must still run the documented read-only shortage
measurement and approve the minimum team count before any staging apply.

## Independent-review follow-up

Actual-source review found that an apply with smaller current agreement
requirements could remove an old skill or reduce vehicle seats before surplus
deactivation noticed that the team still had a future live assignment. A new
PostgreSQL regression reproduced that failure first: a four-person team with
two skills and four seats was narrowed to two people, one skill, and two seats
while its published future assignment remained live.

The apply transaction now snapshots live references only after taking the
shared employee-then-vehicle locks. It retains existing skills for referenced
employees and never reduces a referenced vehicle's existing seat capacity.
Surplus team members remain active through the existing whole-team protection.
Once the assignment becomes historical, a subsequent deterministic apply
removes the obsolete skill from retained members, deactivates surplus members,
and reduces the vehicle to the current required capacity.

Follow-up evidence: the regression failed before the fix (`GPC` remained on
only 2 of 4 live crew members), then passed after it. The full focused
PostgreSQL suite passes 7/7; focused unit tests pass 23/23; API typecheck and
lint pass; `git diff --check` passes.

### Inclusive agreement end-date follow-up

Agreement `startDate` and `endDate` are inclusive PostgreSQL `date` columns.
The source now explicitly normalizes only their comparison instant to the UTC
date boundary before querying effective agreements. The original precise
wall-clock `asOf` remains unchanged for current/future assignment
`plannedEnd` checks.

A PostgreSQL regression uses a midday instant on an agreement's final
effective date and proves its six-person crew and final-day skill still
contribute to the synthetic plan. A focused unit test also pins the UTC
normalization. Updated evidence: PostgreSQL 8/8 and unit 24/24 pass, along with
API typecheck, lint, and `git diff --check`.

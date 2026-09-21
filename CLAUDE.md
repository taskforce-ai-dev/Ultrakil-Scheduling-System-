# UltraKIL Repository Instructions

## Purpose and context

Use this file for durable project rules. Use the repository documentation for
architecture and workflows, and verify live task, pull-request, CI, deployment,
and deadline state in ClickUp and GitHub before acting. Treat historical
handoffs and memory as orientation until current sources confirm them.

Keep `AGENTS.md` and `CLAUDE.md` synchronized whenever applicable project
guidance changes.

## Authority and ownership

- Thivarrakesh Parthipan is the Technical Director and final authority for
  requirements, task ownership, release acceptance, merges, deployments,
  infrastructure, and credentials.
- Chanya Shehani is the Project Lead and default owner of `apps/api/`,
  `services/scheduler/`, `packages/api-contracts/`, database migrations,
  imports, backend scheduling rules, and backend integration evidence.
- Oshadi Whyshni Kumaravel is the default owner of `apps/manager-web/`,
  `docs/manager/`, manager UAT, screenshots, the manager guide, and the demo
  script.
- Complete work under the current human assignment. Report blockers with the
  exact evidence, attempts, and required decision or access. Apply a new owner
  only after Thivarrakesh records the ownership change.
- Record Thivarrakesh's approval before editing another owner's paths, and
  reference that approval in the pull request.
- For UltraKIL, use GPT-model subagents only when Thivarrakesh explicitly asks
  for delegation or parallel agents. Sol remains the orchestrator and final
  reviewer. Continue locally when delegation has not been requested.

## Starting and resuming work

1. Inspect `git status`, the current branch, worktrees, and existing changes.
   Preserve user and team work.
2. Fetch the relevant remote refs and compare work with the current
   `origin/main`.
3. Read the applicable README, architecture, data-model, integration,
   branching, ownership, setup, and nested instruction files.
4. Read the live ClickUp task, recent UltraKIL channel messages, the complete
   pull-request conversation, exact head SHA, reviews, checks, and attachments.
5. Resolve conflicts between live Technical Director instructions and
   repository documentation by surfacing the conflict and correcting the stale
   documentation.
6. Use an isolated branch or worktree for focused changes and keep unrelated
   work outside the diff.

## Architecture and contract boundaries

- Keep the NestJS API and PostgreSQL database as the system of record.
- Keep optimization logic in the Python scheduler and validate every proposed
  assignment again in the API before persistence or publication.
- Publish backend interface changes through OpenAPI and regenerate
  `packages/api-contracts/`. Consume generated types in the manager portal.
- Keep imports idempotent, auditable, and transactional, with source provenance
  retained.
- Preserve the documented database lock order and add forced PostgreSQL
  concurrency tests for multi-writer changes.
- Represent work that cannot satisfy a hard rule as unplanned or unassigned
  with stable, manager-readable reasons.

## Scheduling and operational invariants

- Preserve the master workbook's booked dates as the baseline. Project each
  agreement's observed cadence and anchors into later periods without globally
  reshuffling existing work.
- Create an initial rolling 12-month plan for an open-ended agreement and extend
  the horizon deterministically. Stop a fixed-term agreement at its end date.
- Scope automatic planning for a new agreement to that agreement while treating
  existing booked, published, locked, historical, and manually adjusted work as
  protected.
- Calculate feasibility from duration, crew demand, service windows, employee
  availability, branch, skills, PMS coverage, vehicles, and authorized drivers.
  Leave work explicitly unplanned when no compliant date exists.
- Support audited manual date, crew, employee, and vehicle overrides while
  continuing to enforce branch, qualification, authorization, overlap,
  publication, and lock protections.
- Apply repair through preview, reviewed moves, a plan hash, an idempotency key,
  and a durable result ledger. Preserve protected and historical records.
- Treat every Technician Matrix checkmark as authorization for that employee to
  drive that vehicle. Require at least one checked driver in the assigned crew.
  Apply the same rule to personal, company-owned, and company-rented vehicles,
  with no primary-driver or owner priority.
- Keep the `DAC-2485` normalization regression and the `DAG-3284`
  multi-driver real-data scenario in release evidence.
- Keep Kandy work unassigned whenever no PMS-qualified supervisor is available.
- Preserve inactive client and site history. Exclude confirmed inactive records
  from future generation, and distinguish inactive identity rows from unrelated
  red workbook formatting.
- Label imported 08:00–17:00 opening hours as assumed and unconfirmed until an
  authoritative source confirms real hours.
- Report uncertain town or branch mappings as unresolved until closure evidence
  is recorded.
- Use clearly labelled `SYNTHETIC/TEST` employees, skills, PMS qualifications,
  vehicles, and driver links only in an isolated test or staging dataset.
  Provide deterministic seed and cleanup paths and use real constraints for
  real-data conclusions.

## Data and credential handling

- Keep real workbooks, database dumps, exports, credentials, private keys, and
  personal data outside Git history.
- Retrieve sensitive inputs from an authorized ClickUp attachment, protected
  incoming directory, approved secret store, or location supplied by
  Thivarrakesh.
- Mount source workbooks read-only for import and dry-run workflows.
- Use dedicated development, test, rehearsal, staging, and production
  databases. Point destructive tests and cleanup scripts only at disposable
  databases whose names and connection targets have been verified.
- Present count-only or anonymized real-data evidence in public pull requests
  and logs.
- Store runtime credentials in the deployment platform or protected environment
  files with the narrowest practical access.

## Implementation and verification

- Build changes incrementally with focused tests that reproduce the defect or
  acceptance rule before the implementation change.
- Run the smallest relevant test first, then the complete affected package
  suite and the required repository checks.
- Use real PostgreSQL for migrations, locking, concurrency, idempotency, and
  persistence behavior.
- Verify migrations on a clean database and rehearse forward migration,
  backup/restore, and rollback on an isolated clone before a release.
- Run both workbook imports in dry-run mode and complete the authorized
  real-data regression pass before release acceptance.
- Exercise manager workflows in a real browser against the exact deployed
  build, including success, conflict, unassigned, stale-response, override,
  repair, and recovery paths.
- Treat green CI as evidence for the exact SHA rather than proof that all
  business semantics are correct. Complete an independent source and behavior
  review before acceptance.
- Record exact commands, results, SHAs, CI runs, migration state, import
  summaries, backup/restore evidence, rollback evidence, URLs, and UAT results.

## Pull requests, merges, and deployments

- Keep one understandable task or tightly coupled release unit per branch and
  pull request, with focused commits and a complete handover.
- Merge the exact reviewed head after required CI finishes successfully, review
  conversations are resolved, ownership approvals are recorded, contracts are
  current, and Thivarrakesh has authorized the merge.
- Push through feature branches and pull requests, keeping `main` protected
  from direct or forced updates.
- Deploy only to infrastructure authorized for UltraKIL and only after
  Thivarrakesh authorizes that environment and release.
- Verify health, migrations, image or commit identity, scheduler execution,
  runtime logs, and rollback readiness after deployment.
- Mark a task complete only when its Definition of Done and required evidence
  are actually satisfied. Report partial completion and blockers precisely.

## ClickUp and team communication

- Use ClickUp as the live coordination record and GitHub as the code-review and
  exact-head evidence record.
- Read channel messages and task comments efficiently: request only the recent
  page needed, follow threads with replies, and reuse fetched state during the
  same review to preserve quota.
- Treat a current explicit instruction from Thivarrakesh as the required
  authorization for each outbound team message.
- Post decisions in the main UltraKIL channel when the whole team needs the
  context, quote the update being answered, tag the responsible owner, and link
  the exact GitHub review.
- Give each owner concrete next actions, acceptance evidence, and blocker
  reporting requirements while preserving their assigned scope.
- Keep credentials in approved protected channels or secret stores rather than
  public GitHub or public ClickUp messages.

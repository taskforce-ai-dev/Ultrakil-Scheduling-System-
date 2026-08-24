# Contributing to UltraKIL

## Ownership

- **Chanya** owns `apps/api`, `services/scheduler`, database migrations and
  `packages/api-contracts` — backend rules, scheduling, audit history, deployment and
  Phase 2-compatible APIs.
- **Oshadi** owns `apps/manager-web` — the manager portal, customer/service agreement
  workflow, calendar, dispatch board, overrides and manager documentation. `apps/manager-web`
  must consume the generated API client from `packages/api-contracts` rather than manually
  duplicating backend types.

Do not modify another developer's owned folders without the Project Lead recording the reason
and approving the change.

## Review and merge

- Chanya reviews and merges Oshadi's PRs.
- Chanya's own PRs require Thivarrakesh's (Project Supervisor) approval before she merges
  them — implementation work is never self-approved.
- No PR is merged with failing checks, unresolved review comments, or undocumented
  schema/API changes.
- Direct pushes and force pushes to `main` are not permitted; all changes land via reviewed
  pull requests.

## Daily working process

1. Read the complete ClickUp task before starting.
2. Use a dedicated branch and pull request for each task.
3. Record assumptions and decisions in the task instead of silently changing requirements.
4. Keep the OpenAPI contract (`packages/api-contracts`) updated before frontend integration.
5. Add tests with the implementation.
6. Post the required completion comment on the PR: screenshots/examples, test results,
   API/database changes, limitations and deployment impact.
7. Raise blockers in the relevant task immediately — do not wait until the due date.
8. Do not add out-of-scope features during this sprint.

## Secrets

Never commit secrets, credentials, or `.env` files. Use `.env.example` to document required
variables with placeholder values only.

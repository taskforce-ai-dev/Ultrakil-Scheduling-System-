# UltraKIL Scheduling & Dispatching System

UltraKIL is a scheduling and dispatching pilot for field crews (Colombo and Kandy). Phase 1
delivers a complete, testable manager workflow: customer/service agreements, calendar and
dispatch board, rule-based scheduling, overrides, and audit history — built on a backend that
stays compatible with Phase 2 additions (equipment tracking, PMS tablets, worker app, push
notifications).

Pilot window: **Monday 24 August 2026 – Friday 4 September 2026** (no work on the Sri Lankan
holidays 26–27 August).

## Project structure

This is a monorepo. Each top-level app/service has a single owning developer — see
[CODEOWNERS](.github/CODEOWNERS) and [CONTRIBUTING.md](CONTRIBUTING.md) for the ownership and
review rules.

```
apps/
  api/              Backend API (owned by Chanya)
  manager-web/      Manager portal frontend (owned by Oshadi)
services/
  scheduler/        Scheduling engine / rules service (owned by Chanya)
packages/
  api-contracts/    Shared OpenAPI contract + generated API client (owned by Chanya)
```

- `apps/manager-web` must consume the generated client from `packages/api-contracts` rather
  than duplicating backend types by hand.
- The OpenAPI contract in `packages/api-contracts` is kept up to date **before** frontend
  integration work starts on a given endpoint.

## Core product rules (Phase 1)

- Colombo staff only serve Colombo; Kandy staff only serve Kandy.
- Permanently stationed staff cannot be moved.
- Every job requires at least one PMS-grade supervisor.
- Crew size is variable.
- A vehicle checkmark means the employee is authorized to drive it — there is no
  vehicle-ownership rule.
- Frequency is visits per week or month.
- Allowed service days are hard constraints; preferred days are scheduling preferences.
- Opening/service hours vary by customer and weekday.
- Invalid work must remain in the Unassigned queue with a clear reason.
- Manager overrides and locks are supported, but hard rules cannot be bypassed.
- Equipment tracking, PMS tablets, worker apps and push notifications are **out of scope** for
  Phase 1. The backend must remain compatible with those Phase 2 additions.

## Getting started

Copy `.env.example` to `.env` and fill in local values. Never commit `.env` or any other file
containing real secrets.

```
cp .env.example .env
```

Per-app setup instructions live in each app/service's own README as they are built out.

## Project roles

| Role | Person |
| --- | --- |
| Project Lead / repo owner & maintainer / PR reviewer & merger | Chanya |
| Backend, scheduler, migrations, API contracts | Chanya |
| Manager portal (`apps/manager-web`) | Oshadi |
| Project Supervisor | Thivarrakesh |

Chanya reviews and merges Oshadi's PRs. Chanya's own PRs require Thivarrakesh's approval before
she merges them — implementation work is never self-approved.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full daily working process and branch/PR rules.

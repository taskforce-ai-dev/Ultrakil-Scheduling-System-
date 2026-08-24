# UltraKIL Scheduling & Dispatching System — Phase 1

Scheduling and dispatch pilot for UltraKIL's Colombo and Kandy pest-management
operations. The Phase 1 goal is a **complete, testable manager workflow**: set up
a customer and service agreement, generate recurring visits, build a valid
schedule that never breaks a hard rule, let the manager adjust and publish it,
and record what the field team did.

> Phase 1 is a pilot, not a production-hardened platform. Equipment tracking,
> PMS tablet views, the worker mobile app and push notifications are **Phase 2** —
> not built now, but the API and data model stay compatible with them.

---

## Repository layout

```
ultrakil-scheduling-system/
├── apps/
│   ├── api/                  NestJS API — the system of record          [Chanya]
│   └── manager-web/          Next.js manager portal                     [Oshadi]
├── services/
│   └── scheduler/            Python scheduling service                  [Chanya]
├── packages/
│   └── api-contracts/        OpenAPI document + generated TS client     [Chanya]
├── data/                     Local input workbooks (never committed)
├── docs/                     Setup, architecture and process docs
├── docker-compose.yml        PostgreSQL, Redis and the scheduler service
└── .github/                  CI, CODEOWNERS, PR template
```

### Who owns what

| Path | Owner | Scope |
| --- | --- | --- |
| `apps/api`, `services/scheduler`, `packages/api-contracts`, migrations | **Chanya** (@cha-she) | Backend rules, scheduling, audit history, deployment, Phase 2-compatible APIs |
| `apps/manager-web`, `docs/manager` | **Oshadi** (@Oshadi2005) | Manager portal, customer/service agreement workflow, calendar, dispatch board, overrides |

Do not modify another developer's owned paths without the Project Lead recording
the reason in the ClickUp task and approving the change. See
[`.github/CODEOWNERS`](.github/CODEOWNERS) and [`docs/OWNERSHIP.md`](docs/OWNERSHIP.md).

---

## Quick start

Requires **Node 22**, **pnpm 10**, **Python 3.11** and **Docker Desktop**.

```bash
git clone https://github.com/taskforce-ai-dev/Ultrakil-Scheduling-System-.git
cd Ultrakil-Scheduling-System-

cp .env.example .env          # then edit if you need non-default ports
pnpm install

pnpm dev:infra                # PostgreSQL + Redis in Docker
pnpm db:migrate               # create the schema
pnpm db:seed                  # reference data + technician matrix (see data/README.md)

pnpm dev:api                  # http://localhost:3001/api
pnpm dev:scheduler            # http://localhost:8000
```

| What | Where |
| --- | --- |
| API base URL | http://localhost:3001/api |
| Interactive API docs | http://localhost:3001/api/docs |
| API readiness check | http://localhost:3001/api/health/ready |
| Scheduling service | http://localhost:8000/docs |
| Manager portal | http://localhost:3000 *(from ULK-O01)* |

Full walkthrough, including Windows notes and common errors:
**[`docs/LOCAL_SETUP.md`](docs/LOCAL_SETUP.md)**.

---

## The shared contract

The manager portal never hand-writes backend types. The backend publishes an
OpenAPI document and a generated TypeScript client; the portal imports it.

```bash
pnpm contracts:generate       # regenerate after any endpoint change
```

CI fails a pull request whose committed contract is out of date, so the two
sides cannot drift.

---

## Hard rules the system must never break

These are enforced in code and covered by tests. A schedule is never made to
*look* complete by relaxing one of them — work that cannot satisfy them all goes
to the **Unassigned queue with a clear reason**.

1. Colombo staff serve Colombo work only; Kandy staff serve Kandy work only.
2. Permanently stationed staff are never moved away from their site.
3. Every job carries at least one **PMS-grade supervisor** — Senior PMS, PMS,
   Assistant PMS, SPMS or APMS.
4. A vehicle may only be driven by an employee **authorized** for it. A checkmark
   in the matrix means authorization — there is no ownership or primary-driver rule.
5. **Allowed** service days are hard constraints; **preferred** days are only
   preferences used for ranking.
6. Visits must fall inside the customer's opening hours for that weekday.
7. No employee and no vehicle is double-booked.
8. Crew size is variable per service agreement.
9. A manager override or lock can change *who* and *when* — it can never bypass
   rules 1–7.

---

## Daily working process

1. Read the whole ClickUp task before starting.
2. Branch per task: `feat/ULK-C01-backend-foundation`. See [`docs/BRANCHING.md`](docs/BRANCHING.md).
3. Record assumptions and decisions in the ClickUp task — never silently change a requirement.
4. Update the OpenAPI contract **before** frontend integration.
5. Add tests with the implementation.
6. Open a PR using the template, then post the completion comment on the task.
7. Raise blockers in the task immediately — not on the due date.
8. No out-of-scope features during this sprint.

---

## Documentation

| Doc | What it covers |
| --- | --- |
| [`docs/LOCAL_SETUP.md`](docs/LOCAL_SETUP.md) | Getting the whole stack running on your machine |
| [`docs/BRANCHING.md`](docs/BRANCHING.md) | Branch naming, PR flow, review and merge rules |
| [`docs/OWNERSHIP.md`](docs/OWNERSHIP.md) | Who owns which folders, and how to request a change |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How the three services fit together |
| [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) | Every table and why it exists |
| [`data/README.md`](data/README.md) | The technician matrix and how it is imported |

---

## Team

| Person | Role |
| --- | --- |
| **Chanya Shehani** (@cha-she) | Project Lead — repository owner, reviewer and merger |
| **Oshadi Kumaravel** (@Oshadi2005) | Manager portal developer |
| **Thivarrakesh Parthipan** (@thiva2k) | Project Supervisor |

Chanya reviews and merges Oshadi's pull requests. As Project Lead and
repository owner, Chanya merges her own pull requests without a second
approval — but they still go through a pull request and still need green CI.
Nobody pushes to `main` directly.

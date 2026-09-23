# UltraKIL Operational Cleanliness Design

**Approved by:** Thivarrakesh Parthipan, Technical Director, in the active Codex thread on 23 September 2026.

## Outcome

The manager portal must open onto a calm, truthful operational picture. Long-range generated demand must not look like a present-day staffing failure, normal assignment work must not invite a manager to choose resources already booked for the selected time, and historical repair lineage must not look like current dispatch conflict.

When the authorized staging dataset lacks enough real capacity to demonstrate a complete workflow, the system may add visibly labelled synthetic employees and vehicles. Those resources remain staging/test-only, follow the real scheduling rules, and have a deterministic deactivation path. They never alter the source workbooks and are not production workforce evidence.

## Verified current state

- `origin/main` is `13b2456c0027f6a0a302e8eb6d9a623351d8d845`.
- The saved live assignment set has zero employee-overlap pairs and zero vehicle-overlap pairs.
- Current/future published assignments have at most one vehicle, no understaffed crew, and a named authorized driver for every vehicle.
- The staging database has 1,582 current/future visits: 66 staffed, 1,512 `PENDING`, and four `UNASSIGNED` with `NO_FEASIBLE_CREW`.
- `PENDING` currently renders as `Awaiting staffing`; `UNASSIGNED` renders as `Staffing failed`; several calendar and dispatch surfaces repeat `No crew` wording.
- The assignment drawer fetches all active branch employees and serving vehicles before it knows whether they are busy in the selected time window. The later eligibility check correctly rejects overlaps.
- `SUPERSEDED` and `CANCELLED` assignments are already excluded from live eligibility and operational dispatch truth.
- The dashboard currently suppresses an operations-fetch error, which can make unavailable data appear clean.

## Product model

### Planning is not failure

The persistent API statuses remain unchanged for compatibility:

- `PENDING` means generated work whose staffing has not been attempted.
- `UNASSIGNED` means staffing was attempted and the proposed work failed one or more hard rules.
- `SCHEDULED` means an assignment record exists; dispatch readiness still comes from the published operational read model.

Manager-facing vocabulary changes without rewriting stored history:

| Stored fact | Manager wording | Meaning |
| --- | --- | --- |
| `PENDING` | Planned | The visit exists; staffing is not yet committed. |
| `UNASSIGNED` | Action required | A staffing attempt failed and needs intervention. |
| No assignment on a planned visit | Planning stage | No false suggestion that a dispatch is ready. |
| Resource already used in the selected window | Booked `<time>` | Availability fact shown before selection; the UI avoids the word “overlap.” |
| Superseded/cancelled assignment | Historical version | Audit lineage, never current dispatch truth. |

The landing dashboard continues to show today rather than silently hiding visits. It emphasizes published dispatch and action-required work. Planned visits are presented neutrally. If operations cannot be loaded, the dashboard renders an explicit unavailable state and retry action.

### Availability-aware assignment candidates

Add an additive endpoint:

`POST /api/visits/{visitId}/assignment/candidates`

Request:

```json
{
  "plannedStartMinute": 540,
  "plannedEndMinute": 660
}
```

Response:

```json
{
  "employees": [
    {
      "id": "uuid",
      "displayName": "Employee name",
      "isPmsGrade": true,
      "isAvailable": false,
      "unavailableReason": {
        "code": "EMPLOYEE_DOUBLE_BOOKED",
        "message": "Booked 09:00–11:00"
      }
    }
  ],
  "vehicles": [
    {
      "id": "uuid",
      "displayName": "Vehicle label",
      "seatCapacity": 4,
      "isAvailable": true,
      "unavailableReason": null
    }
  ]
}
```

The API owns every availability decision. It returns active employees from the visit branch and active vehicles allowed to serve the visit branch. It accounts for date absence, permanent stationing, and live time-window reservations. When editing a draft/proposed assignment, it excludes that assignment from its own reservations. `SUPERSEDED` and `CANCELLED` remain historical and never reserve a candidate.

This response is advisory UX, not authorization. The existing full-proposal eligibility check and locked transactional save remain authoritative, so two managers cannot commit the same resource after both saw it available.

The portal requests candidates whenever the visit or proposed time changes. Available resources appear first. Unavailable resources are placed in an expandable, disabled section with a concise reason such as `Booked 09:00–11:00`. Request-generation fencing prevents an older response from repopulating a newer visit/time.

### Staging-only synthetic capacity

Add a dedicated command rather than using the existing broad demo seed:

```bash
pnpm --filter @ultrakil/api db:synthetic-capacity -- --branch COLOMBO --teams 2
pnpm --filter @ultrakil/api db:synthetic-capacity -- --branch COLOMBO --teams 2 --apply --confirm-staging-synthetic-capacity
pnpm --filter @ultrakil/api db:synthetic-capacity -- --deactivate --confirm-staging-synthetic-capacity
```

Safety and behavior:

- The command accepts only databases whose name ends in `_staging` or `_test`.
- Dry-run is the default and reports only counts.
- Apply requires the explicit confirmation flag.
- Employees use deterministic `sourceKey` and `employeeCode` prefixes and a JSON marker.
- Names and vehicle labels begin with `SYNTHETIC/TEST` so nobody can mistake them for real workforce.
- Each team has one PMS-grade supervisor, mobile technicians, a correctly sized vehicle, and at least two authorized drivers who are members of that team.
- Synthetic employees receive the union of skill codes currently required by active job types/agreements in their branch.
- Re-running upserts the same resources and reactivates them; it never duplicates them.
- Cleanup deactivates the marked employees and vehicles rather than deleting rows referenced by audit or assignment history.
- The source workbooks and imported real rows are never changed.

After deployment, staging capacity is added only when a read-only shortage report proves it is needed. The optimizer is rerun for the agreed operational horizon, the result is reviewed and published, and all business invariants are rechecked. Synthetic capacity is explicitly excluded from real-workforce readiness claims.

## Error and history presentation

- Dashboard operations failures render `Operational status unavailable` with retry.
- Repair Center and published lineage retain the full audit story but use `Historical version` and `Replaced` wording.
- Current operational counts never include superseded/cancelled reservations.
- Conflict-group filters may keep stable machine codes, while their visible labels become `Employee booking conflict` and `Vehicle booking conflict`.
- Genuine action-required work remains accessible and countable; it is not deleted, silently filtered, or marked ready.

## Verification gates

1. Focused UI tests prove the prohibited phrases do not appear in normal dashboard, calendar, visit-detail, dispatch, and assignment-editor states.
2. API unit and PostgreSQL integration tests prove busy candidates, back-to-back windows, different dates, self-exclusion, historical exclusion, and concurrent save revalidation.
3. UI race tests prove a stale candidate response cannot overwrite a newer visit/time.
4. Contract generation is clean and the manager client consumes generated types.
5. Synthetic capacity tests prove database-name refusal, dry-run default, explicit apply confirmation, deterministic idempotency, valid PMS/skills/vehicle/driver links, and reversible deactivation.
6. Full API, manager-web, scheduler, lint, typecheck, build, contract, secret-scan, and strict browser checks pass on the exact PR head.
7. Staging verification proves zero live overlap, at most one vehicle per assignment, required crew size, PMS/skills, authorized driver in crew, public-transport validity, historical preservation, and visibly labelled synthetic resources.
8. Browser acceptance uses the exact deployed SHA and checks dashboard, calendar, dispatch board, Edit crew, Repair Center, and recovery/error states.


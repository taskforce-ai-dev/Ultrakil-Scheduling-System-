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

The API owns every availability decision. It returns active employees from the visit branch and active vehicles allowed to serve the visit branch. A serving vehicle is active and either belongs to the visit branch or has no recorded branch. It accounts for date absence, permanent stationing, and live time-window reservations. Assignment windows remain within the visit day (`0…1440` minutes), with `1440` denoting the following midnight; back-to-back windows at that boundary are adjacent rather than overlapping. When editing, the endpoint uses the same unpublished-visit gate as check/save and excludes exactly the sole editable draft/proposal returned by that gate. Published or otherwise historical lineage is never excluded merely to make a candidate appear free. `SUPERSEDED` and `CANCELLED` remain historical and never reserve a candidate.

`isAvailable` means that the individual resource is selectable for the requested visit and time. It does not claim that a proposed crew is collectively feasible. PMS coverage, combined skills, driver-in-crew authorization, seat capacity, public-transport eligibility, and every other proposal-level rule remain in the authoritative check/save path. Unavailable reasons use a stable enum and deterministic precedence: absence, permanent stationing, then the earliest overlapping live booking.

This response is advisory UX, not authorization. The existing full-proposal eligibility check and locked transactional save remain authoritative, so two managers cannot commit the same resource after both saw it available.

The portal requests candidates whenever the visit or proposed time changes. Available resources appear first. Unavailable resources are placed in an accessible expandable, disabled section with a count and a concise reason such as `Booked 09:00–11:00`. Candidate state clears while the current request is pending. Request-generation fencing covers success, failure, and completion so an older request cannot replace or reset a newer visit/time. A previously selected resource that has become unavailable remains visibly selected for explanation; the full eligibility check blocks save instead of silently dropping the choice.

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
- Each team size is `max(2, the largest crewSize on an active effective agreement in the branch)`, including one PMS-grade supervisor. Its vehicle has at least that seat capacity, and at least two members of the generated team are authorized to drive it.
- Synthetic employees receive the union of skill codes required by active branch agreements only. Inactive customers, sites, and agreements do not contribute requirements.
- Re-running upserts the same resources and reactivates them; it never duplicates them.
- Synthetic vehicles use an exact reserved identity tuple in addition to the `SYN-TEST-` prefix. The command refuses an identity collision unless the complete stored marker matches, and workbook import refuses reserved synthetic identities.
- Re-running with a smaller `--teams` value reconciles to the requested cardinality. It deactivates only unused surplus teams; it refuses and reports any surplus resource referenced by a current/future live assignment.
- Cleanup locks employees and vehicles in the same order as assignment writers, then refuses to deactivate any resource referenced by a current/future live assignment. It preserves completed, superseded, and cancelled history and retains skill/authorization links.
- The database guard parses the complete `DATABASE_URL`, rejects malformed or encoded unsafe paths without printing credentials, and verifies `current_database()` after connecting.
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
2. API unit and PostgreSQL integration tests prove busy candidates, back-to-back windows including the midnight boundary, different dates, self-exclusion, historical exclusion, and concurrent save revalidation.
3. UI race tests prove stale success, failure, or completion cannot overwrite or reset a newer visit/time.
4. Contract generation is clean and the manager client consumes generated types.
5. Synthetic capacity unit and PostgreSQL tests prove full database-URL refusal, dry-run default, explicit apply confirmation, deterministic idempotency, exact identity collision refusal, correct maximum crew capacity, valid PMS/skills/vehicle/driver links, rollback, safe cardinality reduction, live-reference deactivation refusal, and assignment-writer serialization.
6. Full API, manager-web, scheduler, lint, typecheck, build, contract, secret-scan, and strict browser checks pass on the exact PR head.
7. Staging verification proves zero live overlap, at most one vehicle per assignment, required crew size, PMS/skills, authorized driver in crew, public-transport validity, historical preservation, and visibly labelled synthetic resources.
8. Browser acceptance uses the exact deployed SHA and checks dashboard, calendar, dispatch board, Edit crew, Repair Center, and recovery/error states.

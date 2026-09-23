# UltraKIL Operational Cleanliness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make UltraKIL’s normal management workflow calm and truthful by separating planned work from actionable staffing failures, preventing busy-resource selection, and providing deterministic staging-only synthetic capacity.

**Architecture:** Keep PostgreSQL/NestJS as the authority. Add an availability-candidate read model that reuses live-assignment semantics but remains advisory; retain the existing locked full-proposal validation on save. Change only manager-facing vocabulary, and add a guarded Prisma CLI that upserts or deactivates visibly synthetic staging resources without changing source workbooks.

**Tech Stack:** NestJS 11, Prisma 6/PostgreSQL 16, generated OpenAPI contracts, Next.js 16/React 19, Vitest/Testing Library, Jest, Playwright, Python scheduler tests.

## Global Constraints

- Preserve every hard branch, qualification, PMS, skill, vehicle-driver, seat, public-transport, overlap, lock, and publication rule.
- Use `SYNTHETIC/TEST` resources only in `_staging` or `_test` databases; dry-run by default and provide reversible deactivation.
- Preserve `SUPERSEDED` and `CANCELLED` history while excluding it from live availability.
- Keep API contract changes additive and regenerate `packages/api-contracts/`.
- Use test-first red/green cycles and focused commits.
- Reference Thivarrakesh’s 23 September 2026 ownership override in the pull request.

---

### Task 1: Calm, truthful manager vocabulary and dashboard failure state

**Files:**
- Modify: `apps/manager-web/src/components/shared/visit-badges.tsx`
- Modify: `apps/manager-web/src/components/shared/operations.tsx`
- Modify: `apps/manager-web/src/app/(app)/dashboard/page.tsx`
- Modify: `apps/manager-web/src/app/(app)/dispatch-board/page.tsx`
- Modify: `apps/manager-web/src/app/(app)/visits/page.tsx`
- Modify: `apps/manager-web/src/app/(app)/calendar/calendar-board.tsx`
- Modify: `apps/manager-web/src/app/(app)/schedule-history/page.tsx`
- Modify: `apps/manager-web/src/lib/visit-tile.ts`
- Modify: `apps/manager-web/src/lib/conflict-groups.ts`
- Test: existing colocated tests for each component/page

**Interfaces:**
- Produces: `VISIT_STATUS_LABEL.PENDING === "Planned"` and `VISIT_STATUS_LABEL.UNASSIGNED === "Action required"`.
- Produces: an explicit dashboard operations error/retry state independent of metadata loading.
- Preserves: stable API status and conflict codes.

- [ ] **Step 1: Write failing vocabulary and dashboard tests**

```tsx
expect(screen.getByText("Planned")).toBeInTheDocument();
expect(screen.getByText("Action required")).toBeInTheDocument();
expect(screen.queryByText(/awaiting staffing|staffing failed|no crew yet/i)).not.toBeInTheDocument();

operationsDeferred.reject(new ApiError({ code: "SERVICE_UNAVAILABLE", message: "offline" }));
expect(await screen.findByText("Operational status unavailable")).toBeInTheDocument();
expect(screen.getByRole("button", { name: /retry operational status/i })).toBeEnabled();
```

- [ ] **Step 2: Run focused tests and confirm the old vocabulary/error behavior fails**

Run:

```bash
pnpm --filter @ultrakil/manager-web test -- src/components/shared/__tests__/visit-badges.test.tsx src/components/shared/__tests__/operations.test.tsx src/app/\(app\)/dispatch-board/__tests__/dispatch-board.test.tsx src/app/\(app\)/__tests__/routes.smoke.test.tsx
```

Expected: assertions fail on old labels and the missing operations error state.

- [ ] **Step 3: Implement the minimal wording and error-state changes**

```ts
export const VISIT_STATUS_LABEL: Record<VisitStatus, string> = {
  PENDING: "Planned",
  UNASSIGNED: "Action required",
  SCHEDULED: "Crew assigned",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};
```

Use status-aware presentation: planned work reads `Planning stage`; failed work reads `Assignment required`; conflict groups read `Employee booking conflict` and `Vehicle booking conflict`. Keep machine codes unchanged. Track `operationsError` separately and render `ErrorState` with an operations-only retry.

- [ ] **Step 4: Run the focused manager tests**

Expected: focused files pass with no prohibited phrase in their normal states.

- [ ] **Step 5: Commit the slice**

```bash
git add apps/manager-web/src
git commit -m "fix(manager): distinguish planned work from staffing exceptions"
```

---

### Task 2: Add the assignment-candidate API contract and read model

**Files:**
- Modify: `apps/api/src/scheduling/eligibility/dto.ts`
- Modify: `apps/api/src/scheduling/eligibility/assignments.controller.ts`
- Modify: `apps/api/src/scheduling/eligibility/assignments.service.ts`
- Modify: `apps/api/src/scheduling/eligibility/eligibility.service.ts`
- Test: `apps/api/src/scheduling/eligibility/assignments.controller.spec.ts`
- Test: `apps/api/src/scheduling/eligibility/assignments.service.spec.ts`
- Test: `apps/api/src/scheduling/eligibility/eligibility.service.spec.ts`

**Interfaces:**
- Consumes: visit ID and `{ plannedStartMinute, plannedEndMinute }`.
- Produces: `POST /visits/:id/assignment/candidates` returning typed employee and vehicle candidates with availability and one manager-readable reason.
- Preserves: `AssignmentsService.check` and transactional `assign` as authoritative validation.

- [ ] **Step 1: Add failing DTO/controller tests**

```ts
expect(controller.candidates(VISIT_ID, { plannedStartMinute: 540, plannedEndMinute: 660 }))
  .resolves.toEqual(candidateResponse);
expect(assignments.candidates).toHaveBeenCalledWith(VISIT_ID, {
  plannedStartMinute: 540,
  plannedEndMinute: 660,
});
```

- [ ] **Step 2: Add failing service tests for live, historical, and self reservations**

```ts
expect(byEmployeeId.get(BUSY_EMPLOYEE_ID)).toMatchObject({
  isAvailable: false,
  unavailableReason: { code: "EMPLOYEE_DOUBLE_BOOKED", message: "Booked 09:00–11:00" },
});
expect(byEmployeeId.get(SELF_EMPLOYEE_ID)?.isAvailable).toBe(true);
expect(byEmployeeId.get(HISTORICAL_EMPLOYEE_ID)?.isAvailable).toBe(true);
expect(byVehicleId.get(BUSY_VEHICLE_ID)?.isAvailable).toBe(false);
```

- [ ] **Step 3: Run focused API tests and confirm the endpoint is absent**

```bash
pnpm --filter @ultrakil/api exec jest --config jest.config.js --selectProjects unit --runInBand src/scheduling/eligibility/assignments.controller.spec.ts src/scheduling/eligibility/assignments.service.spec.ts src/scheduling/eligibility/eligibility.service.spec.ts
```

Expected: tests fail because `candidates` and response DTOs do not exist.

- [ ] **Step 4: Implement additive DTOs and endpoint**

```ts
export class AssignmentCandidateWindowDto {
  @IsInt() @Min(0) @Max(1440) plannedStartMinute!: number;
  @IsInt() @Min(0) @Max(1440) plannedEndMinute!: number;
}

export class AssignmentCandidateReasonDto {
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
}
```

Add employee/vehicle candidate DTOs and `AssignmentCandidatesDto`. The service loads the visit, resolves the one editable draft/proposal for self-exclusion, and delegates to one batched eligibility query. Validate `end > start` at the service boundary using the existing error shape.

- [ ] **Step 5: Implement batched candidate availability**

Query active branch employees and serving vehicles once. Include date absences, permanent assignments, and live-status reservations; exclude the editable current assignment. Convert busy windows to `Booked HH:MM–HH:MM`. Sort available candidates first and then by display name/id. Never derive collective crew skills or PMS coverage in the frontend.

- [ ] **Step 6: Run focused tests and API typecheck**

```bash
pnpm --filter @ultrakil/api exec jest --config jest.config.js --selectProjects unit --runInBand src/scheduling/eligibility/assignments.controller.spec.ts src/scheduling/eligibility/assignments.service.spec.ts src/scheduling/eligibility/eligibility.service.spec.ts
pnpm --filter @ultrakil/api typecheck
```

Expected: focused tests and typecheck pass.

- [ ] **Step 7: Commit the slice**

```bash
git add apps/api/src/scheduling/eligibility
git commit -m "feat(api): expose time-aware assignment candidates"
```

---

### Task 3: Consume availability-aware candidates in Edit crew

**Files:**
- Modify: `apps/manager-web/src/lib/api-client.ts`
- Modify: `apps/manager-web/src/app/(app)/visits/assignment-editor-drawer.tsx`
- Test: `apps/manager-web/src/lib/__tests__/api-client.test.ts`
- Test: `apps/manager-web/src/app/(app)/visits/__tests__/assignment-editor-drawer.test.tsx`

**Interfaces:**
- Consumes: generated `AssignmentCandidatesDto` and the new endpoint.
- Produces: available options first; disabled booked options with time reason; stale-response fencing on visit/time changes.

- [ ] **Step 1: Write failing client and drawer tests**

```tsx
expect(fetchAssignmentCandidates).toHaveBeenCalledWith(VISIT_ID, {
  plannedStartMinute: 540,
  plannedEndMinute: 660,
});
expect(screen.getByRole("option", { name: /Booked 09:00–11:00/ })).toHaveAttribute("aria-disabled", "true");
expect(screen.queryByText(/overlap/i)).not.toBeInTheDocument();
```

Add a deferred-response test: change time, resolve the newer request first, then the older request; assert the older candidates never replace the current list.

- [ ] **Step 2: Run the focused tests and confirm failure**

```bash
pnpm --filter @ultrakil/manager-web test -- src/lib/__tests__/api-client.test.ts src/app/\(app\)/visits/__tests__/assignment-editor-drawer.test.tsx
```

- [ ] **Step 3: Implement contract parsing and drawer integration**

Use generated component types. Add a candidate-request generation ref separate from proposal eligibility. Reload candidates on visit/start/end. Keep selected historical names visible but nonselectable. Render an `Available` group and a collapsed `Unavailable for this time` group.

- [ ] **Step 4: Run focused tests, typecheck, and accessibility assertions**

Expected: unavailable items are keyboard-readable, cannot be selected, and the newest response wins.

- [ ] **Step 5: Commit the slice**

```bash
git add apps/manager-web/src
git commit -m "feat(manager): prevent selection of booked resources"
```

---

### Task 4: Add deterministic staging-only synthetic capacity

**Files:**
- Create: `apps/api/prisma/synthetic-capacity.ts`
- Create: `apps/api/prisma/seed-synthetic-capacity.ts`
- Create: `apps/api/prisma/synthetic-capacity.spec.ts`
- Modify: `apps/api/package.json`
- Modify: `package.json`
- Modify: `data/README.md`
- Modify: `docs/STAGING_RUNBOOK.md`

**Interfaces:**
- Produces: `db:synthetic-capacity` dry-run/apply/deactivate CLI.
- Uses deterministic prefixes `synthetic-capacity:` / `SYN-TEST-` and source marker `__syntheticCapacity__`.
- Rejects any database name not ending `_staging` or `_test`.

- [ ] **Step 1: Write failing pure-generator and guard tests**

```ts
expect(assertSyntheticDatabase("ultrakil")).toThrow("SYNTHETIC_DATABASE_REFUSED");
expect(assertSyntheticDatabase("ultrakil_staging")).toBeUndefined();
expect(buildSyntheticTeams({ branchCode: BranchCode.KANDY, teams: 2, skillCodes: ["GPC"] }))
  .toHaveLength(2);
expect(new Set(secondRun.map((row) => row.sourceKey))).toEqual(
  new Set(firstRun.map((row) => row.sourceKey)),
);
```

Verify every generated team has a PMS supervisor, enough mobile crew, one branch vehicle, and two team-member driver authorizations.

- [ ] **Step 2: Run the focused test and confirm the implementation is absent**

```bash
pnpm --filter @ultrakil/api exec jest --config jest.config.js --selectProjects unit --runInBand prisma/synthetic-capacity.spec.ts
```

- [ ] **Step 3: Implement the pure generator and guarded CLI**

```ts
export const SYNTHETIC_CAPACITY_MARKER = "__syntheticCapacity__";
export const SYNTHETIC_SOURCE_PREFIX = "synthetic-capacity:";
export const SYNTHETIC_VEHICLE_PREFIX = "SYN-TEST-";
```

Parse `--branch`, `--teams`, `--apply`, `--deactivate`, and `--confirm-staging-synthetic-capacity`. Dry-run prints counts only. Apply runs one transaction, upserts labelled employees, skills, vehicles, and driver links, and reactivates matching rows. Deactivate sets marked resources inactive and leaves assignments/history intact.

- [ ] **Step 4: Add scripts and operator documentation**

```json
{
  "db:synthetic-capacity": "node scripts/with-env.mjs tsx prisma/seed-synthetic-capacity.ts"
}
```

Document dry-run, explicit apply, deactivation, identity markers, count-only evidence, optimizer rerun, and the prohibition on using synthetic results as real-workforce proof.

- [ ] **Step 5: Run focused tests and typecheck**

Expected: guard, idempotency, relationship, and deactivation tests pass.

- [ ] **Step 6: Commit the slice**

```bash
git add apps/api/prisma apps/api/package.json package.json data/README.md docs/STAGING_RUNBOOK.md
git commit -m "feat(staging): add reversible synthetic capacity seed"
```

---

### Task 5: Regenerate and verify the cross-workspace contract

**Files:**
- Modify: `packages/api-contracts/openapi/openapi.json`
- Modify: generated client files under `packages/api-contracts/src/`
- Modify: `docs/API_INTEGRATION.md`

**Interfaces:**
- Produces: generated candidate endpoint types consumed by manager-web.

- [ ] **Step 1: Generate the contract**

```bash
pnpm contracts:generate
```

- [ ] **Step 2: Regenerate again and require no diff**

```bash
pnpm contracts:generate
git diff --exit-code -- packages/api-contracts
```

- [ ] **Step 3: Run contract builds and checks**

```bash
pnpm --filter @ultrakil/api-contracts typecheck
pnpm --filter @ultrakil/api-contracts build
pnpm --filter @ultrakil/manager-web typecheck
```

- [ ] **Step 4: Commit the generated contract and integration note**

```bash
git add packages/api-contracts docs/API_INTEGRATION.md
git commit -m "docs(contract): publish assignment candidate availability"
```

---

### Task 6: Full verification, independent review, staging application, and UAT

**Files:**
- Modify only defects found by verification/review.
- Record count-only private runtime evidence outside Git.

**Interfaces:**
- Consumes: complete feature branch and authorized staging environment.
- Produces: reviewed PR, exact-head CI, deployed SHA, synthetic-capacity ledger, optimizer/publication result, and browser UAT evidence.

- [ ] **Step 1: Run package verification**

```bash
pnpm --filter @ultrakil/api test
pnpm --filter @ultrakil/api typecheck
pnpm --filter @ultrakil/api lint
pnpm --filter @ultrakil/api build
pnpm --filter @ultrakil/manager-web test
pnpm --filter @ultrakil/manager-web typecheck
pnpm --filter @ultrakil/manager-web lint
pnpm --filter @ultrakil/manager-web build
python3 -m pytest services/scheduler/tests
```

- [ ] **Step 2: Run PostgreSQL integration and concurrency tests**

Use a verified disposable database ending `_test`; run the complete API integration project and retain aggregate results.

- [ ] **Step 3: Run static hygiene and privacy checks**

```bash
git diff --check
git status --short
git grep -n -i -E "awaiting staffing|staffing failed|no crew yet|employee overlap|vehicle overlap" HEAD -- apps/manager-web/src
```

The grep must find no user-facing normal-state copy; comments/tests may retain quoted regression vocabulary only when explicitly asserting absence.

- [ ] **Step 4: Push, open the PR, and obtain independent exact-head review**

The PR records the Technical Director ownership override, exact commands/results, contract regeneration, baseline Node 24 staging-import test limitation if still present, and no personal data.

- [ ] **Step 5: Merge only after exact-head CI/review approval, then deploy staging**

Verify deployment SHA, migrations, health, logs, backup/restore readiness, and rollback artifact identity.

- [ ] **Step 6: Measure shortages before adding synthetic resources**

Run a read-only count report for the agreed operational horizon. If compliant real capacity is insufficient, dry-run the synthetic command, review counts, then apply only the minimum labelled teams required.

- [ ] **Step 7: Rerun optimizer, review, and publish**

Do not weaken hard rules. Verify current/future live overlap count zero, max one vehicle, crew size, PMS, skills, driver-in-crew authorization, and public transport.

- [ ] **Step 8: Complete browser acceptance on the exact deployed SHA**

Cover dashboard success/error, calendar, dispatch, Edit crew candidate availability and races, action-required work, historical repair lineage, and synthetic labels. Post the final ClickUp handover and remaining limitations.


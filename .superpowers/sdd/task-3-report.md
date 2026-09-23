# Task 3 report — manager assignment candidates

## Outcome

- Added a typed manager client for `POST /visits/:visitId/assignment/candidates` using the generated `AssignmentCandidateWindowDto` and `AssignmentCandidatesDto` contracts.
- Replaced broad employee/vehicle picker reads with the time-aware candidate response for the active visit window.
- Added an independent candidate-request generation fence. A visit/time change clears candidate data while the newest request is pending, and stale success, rejection, and `finally` paths cannot overwrite or unlock newer state.
- Lists available resources first. Unavailable resources remain collapsed behind an accessible `Unavailable for this time (N)` disclosure; their disabled options include the server reason in the accessible name.
- A selected resource that becomes unavailable (or no longer appears in candidates) remains in the proposal and stays visible by name as a read-only current value. The replacement picker never silently clears it and only commits an available replacement chosen by the manager.
- Kept the existing authorized-driver intersection and the server-side eligibility check/save flow unchanged. Collective PMS, skills, seats, crew, and driver rules remain authoritative on the API.

## TDD evidence

Red tests were added first for the client request, time-aware loading, collapsed unavailable reasons, retained unavailable selections, and stale request fencing. Before implementation they failed because the client export and candidate picker behavior did not exist.

Green verification:

- `pnpm --filter @ultrakil/manager-web exec vitest run 'src/lib/__tests__/api-client.test.ts' --pool=forks --maxWorkers=1 --minWorkers=1` — 12/12 passed.
- `pnpm --filter @ultrakil/manager-web exec vitest run 'src/app/(app)/visits/__tests__/assignment-editor-drawer.test.tsx' --pool=forks --maxWorkers=1 --minWorkers=1` — 40/40 passed.
- `pnpm --filter @ultrakil/manager-web typecheck` — passed.
- `pnpm --filter @ultrakil/manager-web lint` — passed.
- `git diff --check` — passed.

## Review notes

- Candidate availability is advisory. The existing assignment check and save endpoints still make the final decision.
- Current unavailable resources are shown separately from the replacement select because Base UI treats a disabled selected option as a non-openable picker. This also makes the distinction between retained current value and selectable replacement explicit.
- No shared Select primitive or authorized-driver logic was changed.

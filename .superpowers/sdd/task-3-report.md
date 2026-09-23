# Task 3 report — manager assignment candidates

## Outcome

- Added a typed manager client for `POST /visits/:visitId/assignment/candidates` using the generated `AssignmentCandidateWindowDto` and `AssignmentCandidatesDto` contracts.
- Replaced broad employee/vehicle picker reads with the time-aware candidate response for the active visit window.
- Added an independent candidate-request generation fence. A visit/time change clears candidate data while the newest request is pending, and stale success, rejection, and `finally` paths cannot overwrite or unlock newer state.
- Lists available resources in the select. Unavailable resources remain collapsed behind an adjacent, keyboard-accessible `Unavailable for this time (N)` disclosure whose semantic static list names each resource and the server reason; they are never select options.
- A selected resource that becomes unavailable (or no longer appears in candidates) remains in the proposal and stays visible by name as a read-only current value. The replacement picker never silently clears it and only commits an available replacement chosen by the manager.
- Kept the existing authorized-driver intersection and the server-side eligibility check/save flow unchanged. Collective PMS, skills, seats, crew, and driver rules remain authoritative on the API.

## TDD evidence

Red tests were added first for the client request, time-aware loading, collapsed unavailable reasons, retained unavailable selections, and stale request fencing. Before implementation they failed because the client export and candidate picker behavior did not exist. Review follow-up tests then failed against the invalid `listbox > group > button` structure and proved the corrected disclosure is outside the listbox, reachable and operable by keyboard, and renders unavailable resources as static text. A direct fetch-failure-and-retry regression was also added.

Green verification:

- `pnpm --filter @ultrakil/manager-web exec vitest run 'src/lib/__tests__/api-client.test.ts' --pool=forks --maxWorkers=1 --minWorkers=1` — 12/12 passed.
- `pnpm --filter @ultrakil/manager-web exec vitest run 'src/app/(app)/visits/__tests__/assignment-editor-drawer.test.tsx' --pool=forks --maxWorkers=1 --minWorkers=1` — 41/41 passed.
- `pnpm --filter @ultrakil/manager-web typecheck` — passed.
- `pnpm --filter @ultrakil/manager-web lint` — passed.
- `git diff --check` — passed.

## Review notes

- Candidate availability is advisory. The existing assignment check and save endpoints still make the final decision.
- Current unavailable resources are shown separately from the replacement select because Base UI treats a disabled selected option as a non-openable picker. This also makes the distinction between retained current value and selectable replacement explicit.
- The unavailable disclosure is a native button outside `SelectContent`, with stable `aria-expanded` and `aria-controls`; the controlled content is a noninteractive `<ul>` rather than disabled options inside a listbox.
- No shared Select primitive or authorized-driver logic was changed.

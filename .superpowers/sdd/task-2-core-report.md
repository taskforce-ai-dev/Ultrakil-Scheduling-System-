# Task 2 core API report

## Red

The first endpoint test was added before implementation and run with:

`pnpm --filter @ultrakil/api exec jest --config jest.config.js --selectProjects unit --runInBand src/scheduling/eligibility/assignments.controller.spec.ts`

It failed because `AssignmentCandidatesDto`, `AssignmentCandidateWindowDto`, and `AssignmentsController.candidates` did not exist.

## Green

Focused unit verification passed:

`pnpm --filter @ultrakil/api exec jest --config jest.config.js --selectProjects unit --runInBand src/scheduling/eligibility/assignments.controller.spec.ts src/scheduling/eligibility/assignments.service.spec.ts src/scheduling/eligibility/eligibility.service.spec.ts`

Result: 3 suites passed, 43 tests passed.

`pnpm --filter @ultrakil/api typecheck` passed.

`pnpm --filter @ultrakil/api lint` exited successfully.

This core slice deliberately does not generate OpenAPI/client contracts and does not modify manager, data, or documentation paths.

## Midnight-boundary correction

Added a red regression test for a live 22:00–24:00 reservation. Before the fix,
the authoritative employee and vehicle loaders mapped its end to minute `0`.
They now calculate both endpoints relative to the visit date, preserving `1440`.
The focused eligibility, rules, controller, and assignment run passed 4 suites / 97 tests,
followed by API typecheck and lint.

## Test colocation

Moved the full candidate eligibility behavior suite to `eligibility.service.spec.ts`.
The affected eligibility and assignments suites passed (16 tests), followed by API typecheck and lint.

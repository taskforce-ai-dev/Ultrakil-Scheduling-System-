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

## PostgreSQL integration and generated contract

Added `test/integration/assignment-candidates-api.spec.ts`, a focused real-HTTP/real-Prisma
suite covering:

- live employee and vehicle reservations are unavailable;
- completed history and the target visit's sole editable draft do not block;
- same-branch and branchless vehicles are returned while another branch's vehicle is excluded;
- a persisted 22:00–24:00 reservation blocks 23:00–24:00 for both employee and vehicle,
  while 20:00–22:00 remains adjacent and assignable; and
- a resource committed after the advisory candidate read is rejected by the authoritative
  assignment mutation.

The focused integration command was attempted against the configured disposable database:

`node /home/dev/worktrees/ultrakil-perfect/apps/api/scripts/with-env.mjs corepack pnpm --filter @ultrakil/api exec jest --config jest.config.js --selectProjects integration --runInBand test/integration/assignment-candidates-api.spec.ts`

The first attempt passed the `_test` safety guard (`ultrakil_ops_code_test`) but could not connect
because the local PostgreSQL process was not running at its configured Unix socket. After starting
the existing isolated test instance, the same focused command was rerun with socket access outside
the restricted sandbox. Result: 1 suite passed, 3 tests passed. The tests exercised the Nest HTTP
boundary and persisted PostgreSQL fixtures; cleanup completed successfully.

Contract generation initially failed on missing explicit Swagger runtime types in the new
candidate DTOs. After adding those types and explicit candidate endpoint path/body metadata,
the generated client contains a UUID `id` path parameter, required
`AssignmentCandidateWindowDto` request body, and typed `AssignmentCandidatesDto` response.

`pnpm contracts:generate` completed twice. The first and second final passes produced identical
hashes:

- OpenAPI: `c215e00b2c0e456c288cb734d886beda986a202f9bf3e3d705d139215e47de74`
- generated TypeScript: `18968b43ba50380dcd53d9f2552c3233cbfe2bfea8afdc2997b763324f0eb1e9`

Additional verification:

- focused candidate unit suites: 3 suites / 45 tests passed;
- API typecheck passed;
- API-contracts typecheck and build passed;
- focused API ESLint passed with zero warnings; and
- `git diff --check` passed.

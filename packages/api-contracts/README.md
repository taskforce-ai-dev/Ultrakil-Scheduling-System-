# `packages/api-contracts` — the shared contract

**Owner: Chanya (@cha-she). Consumed by: `apps/manager-web`.**

This package is the seam between the backend and the manager portal. The backend
publishes it; the portal imports it. Neither side hand-writes the other's types.

| File | Generated from | Committed? |
| --- | --- | --- |
| `openapi/openapi.json` | The NestJS decorators in `apps/api` | Yes |
| `src/generated/api.ts` | `openapi/openapi.json` | Yes |
| `src/index.ts` | Written by hand — re-exports only | Yes |

Both generated files are committed so that a fresh clone can typecheck the portal
without first running the backend.

## Regenerating

From the repository root, after changing any endpoint or DTO:

```bash
pnpm contracts:generate
```

That runs two steps:

1. `apps/api` writes `openapi/openapi.json` from its decorators.
2. This package writes `src/generated/api.ts` from that document.

Commit both. **CI fails a pull request whose committed contract does not match
the code**, so the contract and the API cannot drift apart.

## Using it

```ts
import type { components, paths } from '@ultrakil/api-contracts';

type HealthResponse = components['schemas']['HealthResponseDto'];

type MetaResponse =
  paths['/api/meta']['get']['responses']['200']['content']['application/json'];
```

## Error handling

Every error response carries a stable `code`. Branch on `code`, never on
`message` — messages are written for managers and will be reworded.

```ts
if (error.code === 'NO_PMS_SUPERVISOR_AVAILABLE') {
  // show the "no supervisor available" state
}
```

`GET /api/meta` returns the full list of error codes the API can produce.

# `apps/manager-web` — UltraKIL manager portal

**Owner: Oshadi (@Oshadi2005) — ULK-O01 onwards.**

This directory is intentionally empty apart from this file. The Next.js
application is scaffolded as part of **ULK-O01 — Manager portal foundation**, so
that Oshadi owns its structure and dependency choices from the first commit.

## What the backend already gives you

You do not need to wait for endpoints to start. The shared contract lives in
`packages/api-contracts`:

- `packages/api-contracts/openapi/openapi.json` — the OpenAPI document.
- `packages/api-contracts/src/generated/` — the generated TypeScript types.

Import the generated client. **Do not hand-write request or response types** —
duplicated types drift from the backend and cause integration bugs that only
appear at runtime.

```ts
import type { paths } from '@ultrakil/api-contracts';
```

Regenerate after the backend changes an endpoint:

```bash
pnpm contracts:generate
```

## Running against a local backend

```bash
pnpm dev:infra      # PostgreSQL + Redis in Docker
pnpm dev:api        # NestJS API on http://localhost:3001
```

Point the portal at it with `NEXT_PUBLIC_API_BASE_URL=http://localhost:3001/api`.
Browse the live API documentation at http://localhost:3001/api/docs.

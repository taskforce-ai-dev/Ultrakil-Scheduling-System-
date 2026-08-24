# Code ownership

## Owners

| Path | Owner | What lives there |
| --- | --- | --- |
| `apps/api/` | **Chanya** (@cha-she) | NestJS API, Prisma schema, migrations, seed and matrix importer |
| `services/scheduler/` | **Chanya** | Python scheduling service |
| `packages/api-contracts/` | **Chanya** | OpenAPI document and the generated TypeScript client |
| `docker-compose.yml`, `.github/` | **Chanya** | Local infrastructure, CI, repository policy |
| `apps/manager-web/` | **Oshadi** (@Oshadi2005) | Manager portal: customer and service agreement workflow, calendar, dispatch board, overrides |
| `docs/manager/` | **Oshadi** | Manager-facing documentation |
| Everything else | **Chanya** (Project Lead) | Root configuration and shared docs |

`.github/CODEOWNERS` encodes this, so GitHub requests the right reviewer
automatically.

---

## The rule

> Do not modify another developer's owned folders without the Project Lead
> recording the reason and approving the change.

This is not bureaucracy — it stops two people rewriting the same file on the same
afternoon and losing a day to conflicts.

### If you need a change in someone else's folder

1. Comment on the ClickUp task, naming the file and what you need.
2. The owner makes the change in their own pull request, **or** the Project Lead
   records approval on the task for you to make it.
3. Reference that approval in your pull request description.

---

## The contract boundary

This is where the two sides meet, and the one rule that matters most:

**Chanya publishes the contract. Oshadi consumes it.**

```ts
// apps/manager-web — correct
import type { paths, components } from '@ultrakil/api-contracts';

type Employee = components['schemas']['EmployeeDto'];
```

```ts
// apps/manager-web — wrong
interface Employee {      // hand-written duplicate of a backend type
  id: string;
  fullName: string;
}
```

A hand-written copy compiles happily and then breaks in production the day the
backend adds a required field. The generated client breaks at build time
instead, which is when you want to find out.

After any endpoint change:

```bash
pnpm contracts:generate
git add packages/api-contracts
```

CI fails the pull request if the committed contract does not match the code, so
this cannot be forgotten.

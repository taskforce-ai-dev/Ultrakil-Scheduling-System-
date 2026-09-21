# Branching, review and merge rules

## The short version

- Route every change to `main` through a pull request.
- Use one ClickUp task or tightly coupled release unit per branch and pull request.
- Keep commits focused and preserve an understandable handover.
- Require independent review of the exact head, successful required checks, and
  resolved review conversations.
- Merge after Thivarrakesh authorizes the release or explicitly delegates that
  merge to a release agent.

## Branch naming

```
<type>/<task-id>-<short-description>
```

| Type    | Use for                                            |
| ------- | -------------------------------------------------- |
| `feat`  | New functionality                                  |
| `fix`   | Bug fix                                            |
| `chore` | Tooling, CI, dependencies, repository housekeeping |
| `docs`  | Documentation only                                 |

Examples:

```
feat/ULK-C01-backend-foundation
feat/ULK-O01-manager-portal-foundation
fix/ULK-C05-pms-supervisor-check
```

Personal branches are scratch space. Put task work on a task branch so reviewers
can assess one coherent change and its evidence.

## The flow for one task

```bash
# 1. Start from the current remote baseline
git fetch origin
git switch main
git pull --ff-only origin main

# 2. Create the task branch
git switch -c feat/ULK-C01-backend-foundation

# 3. Commit meaningful increments
git add apps/api/src/health
git commit -m "feat(api): add dependency health checks"

# 4. Publish the feature branch
git push -u origin feat/ULK-C01-backend-foundation
```

Open a pull request with the repository template and complete every applicable
section. Before requesting review, run the checks relevant to the changed paths,
including contract generation for API changes.

## Commit messages

Use this form:

```
<type>(<scope>): <what changed>
```

Examples:

```
feat(api): add service agreement day rules
fix(scheduler): keep stationed staff out of mobile crews
chore(ci): run integration tests against PostgreSQL
docs(readme): document hard scheduling rules
```

Describe the change and its intent. Keep credentials, customer identities,
staff identities, and other sensitive data in approved protected systems.

## Review and acceptance

The pull-request author supplies a complete handover. The independent reviewer
checks the exact current head rather than relying on an earlier review or a green
badge alone.

A pull request becomes mergeable when all applicable conditions hold:

- [ ] Every required CI and deployment-preview check succeeds on the exact head.
- [ ] Every review conversation is resolved with a fixing commit or an accepted
      technical explanation.
- [ ] Schema, migration, scheduling, and API changes are documented.
- [ ] OpenAPI and the generated client match the backend.
- [ ] Cross-owner edits reference Thivarrakesh's recorded approval.
- [ ] The diff contains no secrets, environment files, real workbooks, dumps, or
      personal-data exports.
- [ ] Hard scheduling and vehicle-driver rules remain enforced.
- [ ] PostgreSQL migrations and concurrency behavior have appropriate evidence.
- [ ] Real-data and browser evidence required by the task has been completed.
- [ ] Thivarrakesh has authorized the merge or named the release agent who may
      perform it.

Use squash merge when one pull request represents one task. Preserve multiple
commits when their separation is required for an understandable audited release.
Delete merged feature branches after any required release or rollback references
have been recorded.

## Branch protection outcome

Configure protection for `main` so the repository enforces these outcomes:

- updates arrive through pull requests;
- force pushes and branch deletion are blocked;
- required checks pass before merge;
- review conversations are resolved;
- stale approvals are dismissed after reviewable changes;
- the most recent reviewable push receives independent review;
- administrative access follows the same pull-request path.

Verify the effective rules with a harmless throwaway pull request and the GitHub
ruleset view. Record changes to repository protection in ClickUp and obtain
Thivarrakesh's approval before applying them.

## Release handover

After merge, record the merge commit, source PR, CI runs, migrations, deployment
identity, health checks, UAT, backup/restore evidence, rollback state, and any
remaining limitations. Mark the task complete when its Definition of Done and
evidence are satisfied.

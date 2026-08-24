# Branching, review and merge rules

## The short version

- `main` is protected. Nobody pushes to it directly, ever.
- One ClickUp task = one branch = one pull request.
- Chanya reviews and merges Oshadi's pull requests.
- Chanya's own pull requests need **Thivarrakesh's** approval before merge.
- No merge with failing checks, unresolved review comments, or undocumented
  schema/API changes.

---

## Branch naming

```
<type>/<task-id>-<short-description>
```

| Type | Use for |
| --- | --- |
| `feat` | New functionality |
| `fix` | Bug fix |
| `chore` | Tooling, CI, dependencies, repo housekeeping |
| `docs` | Documentation only |

Examples:

```
feat/ULK-C01-backend-foundation
feat/ULK-O01-manager-portal-foundation
fix/ULK-C05-pms-supervisor-check
```

The repository also has personal branches (`Chanya`, `Oshadi`, `Rakesh`). Those
are scratch space only. **Task work goes on a task branch**, because a reviewer
needs to see one task's change in one pull request.

---

## The flow for one task

```bash
# 1. Always start from the latest main
git checkout main
git pull origin main

# 2. Create the task branch
git checkout -b feat/ULK-C01-backend-foundation

# 3. Work, committing in meaningful steps
git add .
git commit -m "feat(api): add health checks for database, queue and scheduler"

# 4. Push
git push -u origin feat/ULK-C01-backend-foundation
```

Then open a pull request on GitHub. The template loads automatically — fill in
every section.

Before you ask for review, run what CI runs:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm contracts:generate
```

A pull request that fails CI costs the reviewer a round trip. Catch it locally.

---

## Commit messages

```
<type>(<scope>): <what changed>
```

```
feat(api): add ServiceAgreement day rules
fix(scheduler): keep permanently stationed staff out of mobile crews
chore(ci): run integration tests against a real PostgreSQL service
docs(readme): document the hard scheduling rules
```

Write what changed, not what you did. Never put credentials, customer names or
staff names in a commit message.

---

## Review rules

| Author | Reviewer | Merged by |
| --- | --- | --- |
| Oshadi | Chanya | Chanya |
| Chanya | Thivarrakesh | Chanya, after approval |

A pull request may only be merged when **all** of these hold:

- [ ] Every CI check is green
- [ ] Every review comment is resolved
- [ ] Any schema, migration or API change is documented in the pull request
- [ ] The OpenAPI contract was regenerated if endpoints changed
- [ ] Only the author's owned paths are modified, or the Project Lead recorded
      an approved reason for touching another owner's path
- [ ] No secrets, `.env` file or real workforce data is included
- [ ] No hard scheduling rule was weakened to make something pass

Merge with **Squash and merge**, so `main` keeps one clean commit per task.
Delete the branch afterwards.

---

## Branch protection settings for `main`

The Project Lead configures these once, under
**Settings → Branches → Add branch ruleset** (or *Add classic branch protection rule*)
for `main`:

| Setting | Value |
| --- | --- |
| Require a pull request before merging | ✅ |
| Required approvals | **1** |
| Dismiss stale approvals when new commits are pushed | ✅ |
| Require review from Code Owners | ✅ |
| Require status checks to pass before merging | ✅ |
| Required checks | `API (build, test, contract)`, `Scheduler service (Python)`, `Secret scan` |
| Require branches to be up to date before merging | ✅ |
| Require conversation resolution before merging | ✅ |
| Block force pushes | ✅ |
| Restrict deletions | ✅ |
| Do not allow bypassing the above settings | ✅ |

> **Important:** every collaborator on this repository currently has *admin*
> permission. Without **"Do not allow bypassing the above settings"** ticked,
> admins can push straight to `main` and the protection is decorative. Tick it.

The required status check names only appear in the dropdown after CI has run at
least once, so configure protection right after the first pull request opens.

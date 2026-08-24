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

The Project Lead configures this once, under
**Settings → Rules → Rulesets → New branch ruleset**.

| Field | Value |
| --- | --- |
| Ruleset Name | `main-protection` |
| Enforcement status | **Active** |
| Bypass list | **leave empty** |
| Target branches | Add target → **Include default branch** |

> **The bypass list is the setting that matters most.** Every collaborator on
> this repository has *admin* permission. An empty bypass list is the only thing
> that makes these rules apply to admins as well — add anyone to it and they can
> push straight to `main`, which makes the whole ruleset decorative.
>
> **Enforcement status is the one people forget.** A ruleset left *Disabled*
> looks fully configured and enforces nothing.

### Branch rules to enable

| Rule | Setting |
| --- | --- |
| Restrict deletions | ✅ *(on by default)* |
| Block force pushes | ✅ *(on by default)* |
| Require a pull request before merging | ✅ |
| — Required approvals | **1** |
| — Dismiss stale pull request approvals when new commits are pushed | ✅ |
| — Require approval of the most recent reviewable push | ✅ |
| — Require conversation resolution before merging | ✅ |
| — Require review from Code Owners | ❌ **leave off** — see below |
| Require status checks to pass | ✅ |
| — Required checks | `API (build, test, contract)`, `Scheduler service (Python)`, `Secret scan` |
| — Require branches to be up to date before merging | ✅ |

The required status check names only appear in the picker after CI has run at
least once, so create the ruleset once the first pull request has run its checks.

### Why "Require review from Code Owners" stays off

It sounds like exactly what we want, and it would deadlock the Project Lead's
own pull requests.

`CODEOWNERS` makes `@cha-she` the owner of `apps/api`, `services/scheduler`,
`packages/api-contracts` and the repository root. GitHub does not accept a pull
request's author as a valid code-owner reviewer. So on any pull request Chanya
authors touching her own folders — which is most of them — the requirement can
never be satisfied and the merge button stays disabled permanently.

Nothing is lost by leaving it off. `CODEOWNERS` still requests the right
reviewer automatically, and **Required approvals: 1** combined with **Require
approval of the most recent reviewable push** already guarantees that somebody
other than the author approved the work.

Revisit this if a second owner is ever added to the backend paths.

### Rules to leave off, and why

| Rule | Reason |
| --- | --- |
| Restrict creations | Would block creating new branches |
| **Restrict updates** | Does not mean what it sounds like — it would block merging pull requests too |
| Require linear history | Unnecessary friction; squash-merge already keeps `main` clean |
| Require signed commits | Needs GPG keys configured for everyone first |
| Require merge queue / Require deployments to succeed | Overkill for a two-developer team |
| Code scanning / code quality / code coverage / Copilot review | Not configured on this repository |

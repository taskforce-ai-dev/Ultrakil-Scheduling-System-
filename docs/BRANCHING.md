# Branching, review and merge rules

## The short version

- `main` is protected. Nobody pushes to it directly, ever.
- One ClickUp task = one branch = one pull request.
- Chanya reviews and merges Oshadi's pull requests.
- Chanya merges her own pull requests herself — no second approval needed.
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
| Oshadi | **Chanya** — approval required before merge | Chanya |
| Chanya | None required | Chanya |

Chanya still opens a pull request for her own work and still waits for green
CI. What she skips is the second pair of eyes, not the process.

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

Configured under **Settings → Rules → Rulesets → New branch ruleset**.

We use **two rulesets**, not one. GitHub applies "Required approvals" to a
*branch*, not to a particular author, so a single ruleset cannot say "one
approval for Oshadi's pull requests, none for Chanya's". But a bypass list is
evaluated **per ruleset**, and where several rulesets target the same branch
GitHub applies the strictest combination of what is left. Splitting the rules
across two rulesets is what lets Chanya skip the review requirement while
staying bound by everything else.

| | `main-baseline` | `main-review` |
| --- | --- | --- |
| Applies to | **everyone** | Oshadi (and anyone not bypassed) |
| Bypass list | **empty** | `cha-she` |
| Effect | Pull request required, CI must pass, no direct or force pushes | One approving review required |

The result:

| | Direct push to `main` | Green CI | Approval needed | Can merge own work |
| --- | --- | --- | --- | --- |
| Oshadi | blocked | required | **1 — from Chanya** | no |
| Chanya | blocked | required | none | yes |

### Ruleset 1 — `main-baseline`

| Field | Value |
| --- | --- |
| Ruleset Name | `main-baseline` |
| Enforcement status | **Active** |
| Bypass list | **leave empty** |
| Target branches | Add target → **Include default branch** |

Branch rules:

| Rule | Setting |
| --- | --- |
| Restrict deletions | ✅ *(on by default)* |
| Block force pushes | ✅ *(on by default)* |
| Require a pull request before merging | ✅ |
| — Required approvals | **0** |
| — Require conversation resolution before merging | ✅ |
| — Require review from Code Owners | ❌ **leave off** — see below |
| Require status checks to pass | ✅ |
| — Required checks | `API (build, test, contract)`, `Scheduler service (Python)`, `Secret scan` |
| — Require branches to be up to date before merging | ✅ |

Required approvals is **0** here on purpose. This ruleset's job is "a pull
request, with green checks, and no direct pushes" — the part that binds
everybody including the Project Lead. Review is ruleset 2's job.

> **The empty bypass list is the point.** Every collaborator on this repository
> has *admin* permission. An empty bypass list is the only thing that makes
> these rules apply to admins as well — put anyone in it and they can push
> straight to `main`, which makes the whole ruleset decorative.
>
> **Enforcement status is the one people forget.** A ruleset left *Disabled*
> looks fully configured and enforces nothing.

### Ruleset 2 — `main-review`

| Field | Value |
| --- | --- |
| Ruleset Name | `main-review` |
| Enforcement status | **Active** |
| Bypass list | **add `cha-she`** (Role/User → Chanya) |
| Target branches | Add target → **Include default branch** |

Branch rules — tick **only** this one:

| Rule | Setting |
| --- | --- |
| Require a pull request before merging | ✅ |
| — Required approvals | **1** |
| — Dismiss stale pull request approvals when new commits are pushed | ✅ |
| — Require approval of the most recent reviewable push | ✅ |

Leave every other rule in this ruleset unticked. Anything ticked here is
something Chanya would bypass, and the only thing she should bypass is the
review requirement.

### Why "Require review from Code Owners" stays off

It sounds like exactly what we want, and it would deadlock Chanya's own pull
requests.

`CODEOWNERS` makes `@cha-she` the owner of `apps/api`, `services/scheduler`,
`packages/api-contracts` and the repository root. GitHub does not accept a pull
request's author as a valid code-owner reviewer. So on any pull request Chanya
authors touching her own folders — which is most of them — the requirement
could never be satisfied.

Nothing is lost by leaving it off. `CODEOWNERS` still requests the right
reviewer automatically, and on Oshadi's pull requests **Required approvals: 1**
combined with **Require approval of the most recent reviewable push** already
guarantees somebody other than the author approved the work.

### Rules to leave off, and why

| Rule | Reason |
| --- | --- |
| Restrict creations | Would block creating new branches |
| **Restrict updates** | Does not mean what it sounds like — it would block merging pull requests too |
| Require linear history | Unnecessary friction; squash-merge already keeps `main` clean |
| Require signed commits | Needs GPG keys configured for everyone first |
| Require merge queue / Require deployments to succeed | Overkill for a two-developer team |
| Code scanning / code quality / code coverage / Copilot review | Not configured on this repository |

### Checking it actually works

After creating both rulesets, confirm the arrangement rather than assuming it:

1. Open a throwaway pull request into `main` from any branch. It should show
   **"Review required"** and a blocked merge button.
2. On one of Chanya's own pull requests, the merge button should be enabled once
   CI is green, with no reviewer needed.
3. `git push origin main` from any account should be **rejected**. If it
   succeeds, the bypass list on `main-baseline` is not empty, or a ruleset is
   still *Disabled*.

Step 3 is the one worth actually running. It is the difference between
protection that works and protection that only looks configured.

### If the review rule stops being followed

The single-approval requirement on Oshadi's pull requests is enforced by
GitHub. Chanya's self-merge is enforced by nothing but judgement — there is no
second reviewer to catch a mistake in backend or scheduling code. If a change
is large, touches a hard scheduling rule, or changes the database schema, ask
Thivarrakesh for a review anyway. The ruleset permits self-merge; it does not
require it.

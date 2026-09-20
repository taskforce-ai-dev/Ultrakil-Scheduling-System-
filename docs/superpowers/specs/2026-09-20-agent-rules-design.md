# UltraKIL Agent Rules Design

## Goal

Give Codex, Claude Code, and future contributors one durable, repository-local
source of operating rules without embedding volatile release state that will
become misleading.

## Context hierarchy

The repository will use three layers of context:

1. `AGENTS.md` and `CLAUDE.md` contain stable authority, ownership, safety,
   business-rule, verification, communication, merge, and deployment rules.
2. Existing architecture, data-model, setup, branching, ownership, and manager
   documentation explain implementation details and workflows.
3. ClickUp and GitHub contain volatile state such as deadlines, active task
   ownership, PR heads, CI runs, review findings, and deployment status.

An agent must verify layer 3 live before acting. Historical memory and old
handoffs may orient an investigation, but they are never proof of current
state.

## Files and responsibilities

- `AGENTS.md`: authoritative project instructions for Codex and compatible
  agents.
- `CLAUDE.md`: a synchronized copy of the applicable project guidance for
  Claude Code.
- `README.md`: correct team roles and remove the obsolete self-merge policy.
- `docs/OWNERSHIP.md`: retain path ownership while making Thivarrakesh the only
  authority who may approve ownership changes.
- `docs/BRANCHING.md`: replace obsolete self-approval and two-ruleset guidance
  with the current independent-review and explicit-authorization policy.
- `.github/CODEOWNERS`: retain functional code-owner routing while correcting
  role and approval comments.

## Stable rules included

The agent rules will cover:

- Thivarrakesh as Technical Director and final authority for ownership,
  requirements, merges, deployments, infrastructure, and credentials;
- Chanya's default ownership of API, database, scheduler, migrations, and
  generated API contracts;
- Oshadi's default ownership of manager-web, manager documentation, UAT,
  screenshots, and demo preparation;
- no human-task delegation or reassignment without Thivarrakesh's approval;
- the UltraKIL-specific GPT-subagent exception and Sol's final-review role;
- mandatory repository, ClickUp, GitHub, and dirty-worktree checks before work;
- architecture and generated-contract boundaries;
- scheduling, vehicle authorization, inactive-client, Kandy PMS, opening-hour,
  uncertain-mapping, manual-override, repair, and synthetic-data rules;
- workbook, dump, credential, and test-database safety;
- exact-head review, PostgreSQL integration, migration, import, browser,
  backup/restore, rollback, and deployment evidence;
- ClickUp quota discipline and the requirement for explicit authorization
  before sending team messages;
- truthful completion reporting.

## Explicitly excluded

The rules files will not contain:

- current PR numbers or head SHAs;
- temporary blockers or CI run links;
- deadlines or due dates;
- current staging/production health;
- credentials, host addresses, workbook contents, or personal data.

Those facts belong in ClickUp, GitHub, protected deployment records, or an
explicit release handoff.

## Conflict handling

The current direct instruction from Thivarrakesh overrides stale project
documentation. Agents must surface conflicts rather than silently choosing an
interpretation. Repository documentation must then be corrected so future
sessions do not repeatedly encounter the same conflict.

## Verification

This documentation-only change is accepted when:

- `AGENTS.md` and `CLAUDE.md` contain the same applicable guidance;
- README, ownership, branching, and CODEOWNERS comments agree on roles and
  approval authority;
- no current PR state, deadlines, credentials, or personal data appear in the
  new rules;
- Markdown formatting passes the repository formatter;
- `git diff --check` is clean;
- the final diff contains documentation and policy files only.

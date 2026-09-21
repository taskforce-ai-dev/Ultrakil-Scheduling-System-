# UltraKIL Agent Rules Implementation Plan

> **For contributors:** Apply each task in order and verify the exact diff before publishing it.

**Goal:** Add synchronized, durable operating guidance for Codex and Claude Code, and align the repository's role and review documentation with the Technical Director's current authority.

**Scope:** Documentation and repository policy files only. Live PR heads, deadlines, credentials, host details, and personal data remain in GitHub, ClickUp, or protected release records.

## Task 1: Add synchronized agent guidance

**Files:** `AGENTS.md`, `CLAUDE.md`

1. Define the authority and ownership model.
2. Record the project-specific GPT-subagent rule and Sol review responsibility.
3. Record required live-state checks, scheduling invariants, data safety, verification, release, and ClickUp practices.
4. Phrase instructions as the action an agent should take.
5. Keep both files byte-for-byte synchronized.

## Task 2: Align roles and ownership

**Files:** `README.md`, `docs/OWNERSHIP.md`, `.github/CODEOWNERS`

1. Identify Thivarrakesh as Technical Director and final authority.
2. Retain Chanya's backend ownership and Oshadi's manager-portal ownership.
3. Route cross-owner work and ownership changes through recorded Technical Director approval.
4. Preserve the existing CODEOWNERS path assignments.

## Task 3: Replace the obsolete merge policy

**File:** `docs/BRANCHING.md`

1. Keep task-branch and commit conventions.
2. Require independent exact-head review, resolved conversations, green required checks, and explicit merge authorization.
3. Remove self-approval and author-specific ruleset instructions that conflict with current authority.
4. Describe branch protection by the outcome it must enforce.

## Task 4: Verify the documentation change

1. Run `cmp -s AGENTS.md CLAUDE.md`.
2. Run the repository Markdown formatter check on every changed Markdown file.
3. Run `git diff --check`.
4. Inspect the complete diff for volatile release facts, credentials, personal data, and unintended source changes.
5. Commit only the intended documentation and policy files.

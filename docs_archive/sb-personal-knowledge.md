# Organization Knowledge Base

Shared facts, context, and institutional knowledge for all agents in this org. Read on every session start. Update when you learn something that all agents should know.

<!--
  This file is the org's shared brain. It should contain:
  - Business facts that don't change often (what the company does, key products, team)
  - Technical context (repos, infrastructure, deployment targets)
  - Key people and their roles
  - Important links and resources
  - Decisions that were made and why

  It should NOT contain:
  - Ephemeral task details (use tasks for that)
  - Agent-specific knowledge (use agent MEMORY.md)
  - Secrets or credentials (use .env files)
-->

## Business

<!-- What does this org do? Key products/services, business model, stage -->

## Team

<!-- Key people, their roles, how to reach them -->

## Technical

<!-- Repos, infrastructure, deployment targets, key services -->

## Key Links

<!-- Dashboards, docs, tools, reference material -->

## Standard Coding Practice (fleet-wide, ratified by Saurav 2026-05-08)

Binding contract for every code-producing agent (engineer + any future build agents). Applies to **all** code work — jarvis retrofit, cortexOS features, new repos, etc. Stop conditions in BUILD_PROMPT.md still apply.

**Source-of-truth for code-quality rules:** `/Volumes/MacStorage/UserData/0devprojects/sb-cortextos-fork/.claude/rules/code-quality.md`. Universal P9-eng standards (file size, function size, single responsibility, edge cases, etc.) plus cortextOS-specific micro-retros (each rule is the *class of trap*, not a per-symptom fix). Read on session start (already in engineer + boss CLAUDE.md bootstrap step 3). Re-read when starting a non-trivial coding task. Append new micro-retros in date order when new class-of-trap incidents surface — see "How these rules update" footer in the file.

**Per phase:**
1. Implement (primitive **and its callers** in the same commit — never "phase 1 = primitive only")
2. Spawn `code-evaluator` subagent (brief: spec path, phase number, commit SHA, summary of what changed)
3. If CHANGES REQUIRED → fix in a **separate commit** (never `--amend` pushed commits)
4. Re-spawn evaluator if changes were non-trivial
5. **Do not proceed past LGTM** (or only NIT-level remarks)

**Per feature:**
6. All phases LGTM → push branch
7. Open PR (title: `<type>(<scope>): <one-line>`; body: phase-by-phase notes + spec link)
8. Spawn `pr-deep-evaluator` subagent (brief: PR URL, spec path, expected acceptance criteria)
9. Address CHANGES REQUIRED items; re-eval if non-trivial
10. `gh pr merge <num> --merge --delete-branch` (**`--merge`, never `--squash`** — per-phase commits stay visible in main history)

**Hard rules (non-negotiable):**
- No `--no-verify`, no `--no-gpg-sign`
- No `--amend` on pushed commits
- Tests must drive the artifact a downstream consumer reads (not just side-channel state)
- Verify subagent work via `git status` / `git log` / actual file reads before trusting summaries
- One feature per branch, one feature per PR
- One logical change per commit

Source: jarvis BUILD_PROMPT.md (`docs/roadmap/v0.3-multi-agent-fleet/BUILD_PROMPT.md`) generalized to all repos.

## Decisions Log

<!-- Important decisions and their rationale. Format: YYYY-MM-DD: decision - why -->
- **2026-05-08:** Build/evaluate/fix/PR loop ratified as fleet-wide standard coding practice (per Saurav). Codified above. Reason: ensures quality discipline across all code-producing agents and future repos, not just jarvis retrofit.

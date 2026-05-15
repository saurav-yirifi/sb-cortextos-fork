# 08 — Boss bootstrap consumes ~67k tokens before useful work

**Severity:** P2 (recurring cost on every boot; multiplied by ~5 hard-restarts/day)
**Status:** In progress — Item 1 done fleet-wide; statusline calibrated for 1M-Opus; engineer threshold tightened. Tracking against `/Users/sauravb/.claude/plans/think-through-all-these-cuddly-wigderson.md`.
**Source:** Manual audit during operator-as-boss session, 2026-05-16. File sizes via `wc -c`; bus-command outputs measured live.

## Symptom

Operator observed that boss sessions reach ~67k tokens used *before* the first real instruction is processed. That budget is recovered on every restart (session-refresh cron at 6h cadence + yellow/red `/compact` hard-restarts → ~5 boots/day in practice), so the per-day cost of bootstrap bloat is non-trivial and compounds with the issues already filed under `01-context-discipline-not-self-applied.md` and `06-compact-boundaries-systematically-missed.md`.

## Evidence — where the 67k goes

| Bucket | Bytes | ≈Tokens | Notes |
|---|---:|---:|---|
| **Harness base** (Claude Code system prompt + tool schemas + deferred-tool list + skills/agent blocks + computer-use MCP block) | — | ~17,000 | Mostly out of our control |
| **Ambient files** — user `~/.claude/CLAUDE.md` (3,418) + user auto-MEMORY (6,123) + project `CLAUDE.md` (2,256) + auto-attached `.claude/rules/comms-discipline.md` (6,835) | 18,632 | ~4,600 | |
| **Boss agent files** — IDENTITY/SOUL/GOALS/GUARDRAILS/HEARTBEAT/MEMORY/USER/SYSTEM/CLAUDE/value-spec.md + goals.json | 39,778 | ~9,960 | `MEMORY.md` (13,173) and `CLAUDE.md` (9,115) dominate |
| **Bootstrap step 2-4 reads** — `.claude/docs/code-quality.md` (16,465) + `orgs/sb-personal/knowledge.md` (3,549) + today's daily memo (10,707) | 30,721 | ~7,670 | `code-quality.md` alone is 4.1k tokens |
| **Bus boot commands** — `list-skills` (13,635) + `list-agents` (3,042) + `list-crons` (1,272) | 17,949 | ~4,480 | `list-skills` alone is 3.4k tokens |
| **Subtotal cortextOS-controlled** | **107,080** | **~26,710** | |
| **Total (harness + cortextOS)** | | **~43,700** | Gap to observed 67k → daily-memo overspill, multi-day handoff reads on post-restart, first-heartbeat extras |

## Root cause

Boss's `CLAUDE.md` "Session Start" checklist treats every referenced file as eager-load on every boot. That made sense when the agent files were small. They're not anymore — MEMORY.md and code-quality.md have grown without anyone re-asking "does this need to be in the cold-boot context, or can it be lazy?"

Two specific design errors:

1. **`code-quality.md` is eager-loaded for boss** (`orgs/sb-personal/agents/boss/CLAUDE.md:44`), yet boss's role explicitly forbids specialist code work. The file is listed for "decomposition + delegation patterns" awareness — a vague justification that would be true of literally any document. Net effect: 4.1k tokens per boot for awareness boss never references.
2. **Bootstrap path is stale.** Same line references `.claude/rules/code-quality.md`, but the file moved to `.claude/docs/code-quality.md` in PR #25 (2026-05-13). Today's daily memo (`memory/2026-05-15.md:56`) already flagged this. Step 2 is silently failing — which means boss has been booting *without* the file it claims to need, and nothing has broken. Strong evidence the eager-load was never load-bearing.

## Action items

Ranked by leverage. All targets are per-boot savings; multiply by ~5 boots/day for daily impact.

### Cheap wins (do first)

1. **Drop `code-quality.md` from boss bootstrap entirely.** Lazy-load it only when boss is about to dispatch code work to engineer/fullstack. Single edit to `orgs/sb-personal/agents/boss/CLAUDE.md` step 2. **Savings: ~4,100 tokens/boot.** ⭐ biggest single win.
2. **Switch `bus list-skills --format text` to `--format names` at boot** (or drop entirely; fetch lazily when boss needs to choose a skill). Names-only lists ~30 skills × 25 chars ≈ 750 bytes instead of 13.6k. **Savings: ~2,500 tokens/cycle** (this fires every heartbeat, not just boot — bigger lifetime impact).
3. **Prune boss `MEMORY.md`.** Stale entries: "Operational lessons (2026-05-08 burst session)" (rolled into permanent practice), "Reverse-retrofit candidates" (past bake date 2026-05-26), "BL-2026-05-10-007 closed (2026-05-13)" (closed), "Analyst cron changes (revert when HALT lifts)" (revert if HALT lifted), "devops-c A/B trial" (decision due 2026-05-18 — already past or near). Target: 13k → ~6k. **Savings: ~1,700 tokens/boot.**

### Architectural fix (do this week)

4. **Two-tier bootstrap.** Minimal cold-boot set (IDENTITY + GOALS + GUARDRAILS + a 1-page operating-norms summary) on every restart — ~3k tokens. Everything else (HEARTBEAT.md, full MEMORY.md, knowledge.md, code-quality.md) becomes lazy-loaded on the cron prompt that needs it. Heartbeat cron reads HEARTBEAT.md; dispatch-code work reads code-quality.md; org questions read knowledge.md. **Savings: ~6–8k tokens/boot** in addition to items 1-3.

### Secondary cleanups

5. **Slim boss `CLAUDE.md` (9.1k).** Bus CLI reference table duplicates `docs_sb/guides/bus-cli-reference.md`; skills index duplicates `list-skills`; Protocol D2 inline-bash should move to `scripts/relay-fleet-context.sh`. Target ~5k. **Savings: ~1,000 tokens/boot.**
6. **Codify daily-memo read rule.** Today only; if today is short, fall back to `memory/handoffs/latest.md` (structured, small) rather than reading yesterday's full memo. **Savings: ~1,500–2,000 tokens/post-restart.**
7. **Collapse duplicated comms-discipline copies.** `.claude/rules/comms-discipline.md` (6.8k, auto-attached) and `community/skills/comms-discipline/RULE.md` (canonical, referenced from boss CLAUDE.md) say nearly the same thing. Slim the project rule to a 1-line pointer to the canonical. **Savings: ~1,500 tokens/boot fleet-wide.**
8. **Move `HEARTBEAT.md` inline bash to scripts.** Step 3a (quarterly disk check) and Step 3c (rare-trigger context-relay sweep) run no-op 99% of cycles. Refactor to `scripts/heartbeat-*.sh` invoked from a short HEARTBEAT.md. **Savings: ~500 tokens, plus less visual noise per cycle.**
9. **Prune user auto-MEMORY (`~/.claude/projects/.../memory/MEMORY.md`).** ~30% is project-state (closed BLs, completed initiatives) that decays fast. **Savings: ~1,000 tokens/boot.**

## Projected end state

If items 1–3 land: ~67k → ~58k per boot (~13% reduction, no architectural change).
If items 1–9 all land: ~67k → ~48k (~28% reduction, headroom for `/compact` cadence to actually work on Saurav-engaged sessions).

## Verification

Re-measure after each item lands. Track via `scripts/session-analysis/analyze.py session <id>` on the first heartbeat cycle of a fresh boss restart — the `cache_read` baseline of an early-turn Bash call is a reliable proxy for "what we loaded at boot."

## Class of trap

**Eager-load creep.** A file added to a bootstrap checklist with reasonable justification (e.g. "code-quality awareness for delegation") never gets re-evaluated when its size grows or when its actual use frequency stays at zero. The checklist needs a periodic "is this still earning its tokens?" pass — same shape as `01-context-discipline-not-self-applied.md` (the rules existed but weren't applied to their author's session). Add a quarterly bootstrap audit to the weekly-review skill.

Related signal: the stale path bug (step 2 references a file that's been at a different location for 3 days) silently producing zero observable failure is itself proof the file wasn't load-bearing. Anywhere a bootstrap step can be silently broken without anyone noticing, it's a lazy-load candidate.

---

## Implementation status (2026-05-16)

After the initial filing, the operator asked for a first-principles re-think; the resequenced plan lives at `/Users/sauravb/.claude/plans/think-through-all-these-cuddly-wigderson.md`. The 9 action items above were reorganized against three Anthropic-canonical levers (small/stable cache prefix · compaction-first signal · just-in-time loading) and merged with action items from issues 01, 02, 03, 04, 05, 06.

### Action-item status

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Drop `code-quality.md` from boss bootstrap | **Done — extended fleet-wide** | All 6 agents had stale `.claude/rules/code-quality.md` reference (file moved to `.claude/docs/` in PR #25). Both `code-quality.md` + subfile tree + `orgs/sb-personal/knowledge.md` archived to `docs_archive/`. Refs stripped from all 6 agents' CLAUDE.md + 5 agents' HEARTBEAT.md. Lazy-load pointer added to engineer/fullstack/devops CLAUDE.md `## Code quality reference` section so the rules remain discoverable on code-task start. ~58k tokens/day fleet-wide saved (eager-load × ~12 boots/day). |
| 2 | Strip `bus list-skills` from boot block | **Done — fleet-wide** | Removed from `## Session Start` bash block in all 6 agents (boss, analyst, engineer, fullstack, devops, token-auditor). Descriptive references in the skills-index body kept (they're docs, not eager-load). ~30-40k tokens/day saved. |
| 3 | Prune boss `MEMORY.md` stale entries | **Done (conservative)** | 13,173 → 9,018 bytes (~31% reduction, ~1,040 tokens/boot × ~5 boots/day = ~5,200 tokens/day). Dropped: Operational lessons 2026-05-08 (14 lines, rolled into permanent practice), BL-2026-05-10-007 closed (6 lines, content lives in `docs_sb/usage_tracking/PLAN.md`), Reverse-retrofit candidates (collapsed 8 lines → 2-line pointer), Idle-timeout crash prevention (collapsed 7 → 2 lines). Fleet cost model section refreshed to current state (boss=opus etc, engineer 1M with handoff 50). Kept: Analyst cron changes (HALT state contingent), devops-c A/B trial (decision imminent 2026-05-18), Repo baseline (still a useful reference). |
| 4 | Two-tier bootstrap | Pending (Tier 5) | Reframed from "optimization" to canonical Anthropic CLAUDE.md pattern (progressive-disclosure pointers + `@path/to/file.md`). |
| 5 | Slim boss `CLAUDE.md` | Subsumed by Tier 5 (two-tier) | |
| 6 | Daily-memo discipline | Subsumed by Tier 5 | |
| 7 | Collapse comms-discipline duplication | Subsumed by Tier 5 | |
| 8 | HEARTBEAT.md inline bash → scripts | Subsumed by Tier 5 | |
| 9 | Prune user auto-MEMORY | Operator-side; deferred | |

### Additional fixes landed this session (not in original 9)

- **Engineer `ctx_handoff_threshold` 80 → 50** (`orgs/sb-personal/agents/engineer/config.json:38`). Engineer is the only Opus + 1M-context agent; Claude Code auto-compacts ~42-45% on 1M, so 80 was decorative. Now matches the red-boundary per `docs_archive/code-quality/compact-instructions.md`. Pilot 48h; raise to 55-60 if mid-work handoffs trip.
- **Operator statusline tuned for 1M-context** (`~/.claude/statusline.sh`). Existing statusline already showed model · ctx-bar · cost · lines · duration · branch (Lever B per-turn signal already in place). Gap was that thresholds were 200K-tuned. Added model-aware threshold block: if `model.display_name` contains "1M"/"1m" → yellow ≥30%, orange ≥35%, red bar ≥42%, RED label ≥50%, CRITICAL BG_RED ≥60%. Otherwise unchanged. Smoke-tested with three scenarios.
- **Boss CLAUDE.md + HEARTBEAT.md / 5 other agents** had `/compact` cadence line pointing at moved `compact-instructions.md` path. Path reference removed (operational guidance kept). The relocated file is now reachable via the new lazy-load pointer in engineer/fullstack/devops `## Code quality reference` section.

### What this issue did NOT cover (added by first-principles plan)

The Anthropic prompt-caching docs surfaced a structural concern that no Issue 01-08 file caught:

- **Cache-stability audit (plan Tier 2). DONE.** Read-only audit completed 2026-05-16. Findings:
  - All 7 agents' cron prompts are **static text** — no timestamps, rotating IDs, or dynamic content in the cacheable region. ✅
  - **Zero MCP servers** registered across the fleet. No mid-session tool-list mutation risk. ✅
  - Per-agent settings.json have identical shape (`hooks`, `permissions`, `statusLine`) and hooks fire on lifecycle events (SessionStart/End, PreCompact, PermissionRequest, PreToolUse, Stop) — not per-turn modifications. Cache-prefix safe. ✅
  - **Conclusion:** the fleet already has clean cache-stability hygiene. Remaining cost is structural (4h heartbeat > 5min cache TTL, every heartbeat is a cache miss by design). Two-tier bootstrap (Tier 5) is the right architectural fix for *small cold-start prefix*, not for *cache-hit preservation* — those are lost anyway at 4h cadence.
- **Heartbeat-cadence vs cache-TTL mismatch.** Default cache TTL is 5 min; 1h is paid. cortextOS heartbeats fire every 4h — so every heartbeat is a structural cache miss regardless of TTL choice. Implication: don't try to win on cache hits at 4h cadence; win on small prefix. Tier 5 should optimize for that.

### Verification status

Pre-change baseline captured implicitly in this file (the ~67k figure). Post-Tier-1 measurement will use:
```bash
python3 scripts/session-analysis/analyze.py session <id>
# cache_read of first heartbeat post-restart = proxy for boot payload
```

Cross-agent verification (e.g. "did fleet-wide spend drop?") requires `analyze.py feature <branch>` from Issue 03 item 1 — plan Tier 3, engineer dispatch pending.

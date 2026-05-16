# Context-optimization sweep — full record

**Date:** 2026-05-17
**PR:** [#79](https://github.com/saurav-yirifi/sb-cortextos-fork/pull/79) — merged 2026-05-16T23:15:52Z as commit `92fc3cd`
**Branch (deleted post-merge):** `chore/context-optimization-sweep`
**Trigger:** First-principles audit of cortextOS against two Claude Code context-optimization guides authored in sibling Jarvis repo (`claude-code-optimization-playbook.md`, `claude-code-context-strategy.md`).

## TL;DR

Eight specific gaps surfaced between cortextOS's running config and the published optimization guides. Seven were fixed in this PR; one was skipped after re-measurement showed the plan's savings estimate was 12× over-stated. The headline finding: **boss + analyst had been running on 200k context for weeks despite explicit `.env` comments claiming 1M was enabled** — the active `CLAUDE_CODE_DISABLE_1M_CONTEXT=true` flag silently contradicted the operator's stated intent. Verified live on the fleet post-merge: boss + analyst now report `context_limit: 1000000`.

A second structural finding: the project's `.gitignore` rule `.claude/` (bare directory) made all the `!.claude/*/` re-include negations silently dead — `.claude/rules/comms-discipline.md` had been loaded by Claude Code on disk for months but was never in version control. Fixed by switching to `.claude/**`. Upstream `grandamenium/cortextos` still has the same bug.

## What was wrong

Verified by direct inspection (`bash scripts/audit-fleet-config.sh` + per-file checks):

| Compliance area | Pre-sweep state | Why it mattered |
|---|---|---|
| 1M context on boss + analyst | `CLAUDE_CODE_DISABLE_1M_CONTEXT=true` despite "1M enabled" comments | Orchestrator + analyst are the cascade-critical roles; running on 200k forced lossy compaction far too often |
| 1M context on engineer | Flag commented out (= 1M ON) — actually correct | The only opus agent that *was* right |
| 1M context on fullstack | Flag set, comment said "Removed 2026-05-08" — flag was re-set later by accident | Specialist doing deep coding work; lossy compaction drops file refs + tool outputs mid-task |
| boss `ctx_handoff_threshold=80` | Same as specialists — too loose for cascade-critical role | Boss's context loss propagates to all downstream specialists |
| engineer `ctx_handoff=50` | Tighter than spec | Forced premature handoffs |
| `max_session_seconds=28800` on all 6 agents | All rotate at the same 8h wall-clock tick | Simultaneous PTY teardowns + spawns + "back online" Telegram bursts on the same bot tokens |
| `enableAllProjectMcpServers: true` on 5/7 agents | claude-code issue [#11370](https://github.com/anthropics/claude-code/issues/11370) anti-pattern | Loads every MCP server's tool defs (~400-650 tok each) into the prefix even when the agent uses only some |
| `orgs/` fully gitignored | Config drift invisible — agent CLAUDE.md / config.json / .mcp.json changes left no audit trail | Six-month gap where the 1M tier inversion went undetected |
| `comms-discipline.md` always-loaded | 160 lines (8.4k bytes ≈ 2.1k tok) on every turn for every agent | Rules 5-8 were operational guardrails (only matter at send-time), not every-turn correctness gates |

## What was changed (commits in order)

| # | Commit | Phase | Change |
|---|---|---|---|
| 1 | `7307c51` | 0 | Selectively un-ignore non-secret agent files: `config.json`, `CLAUDE.md`, `IDENTITY.md`, `SOUL.md`, `GOALS.md`, `GUARDRAILS.md`, `HEARTBEAT.md`, `.mcp.json`, `.claude/settings.json`. 59 files added. `.env` and `memory/` stay ignored. |
| 2 | `07e4662` | 1.1 + 1.2 | `.env` edits (gitignored, documented in commit body): removed `CLAUDE_CODE_DISABLE_1M_CONTEXT=true` from boss/analyst/fullstack. `config.json` edits (tracked): boss/analyst `warn=40, handoff=50`; engineer/fullstack `warn=50, handoff=60`; devops-c `null→70/80` (doc-only — `??` defaults already supplied 70/80 at `fast-checker.ts:1023`). |
| 3 | `6ebd534` | 1.3 | Staggered `max_session_seconds` by 30-min offsets: boss 26100 / analyst 27000 / engineer 27900 / fullstack 28800 / devops 29700 / token-auditor 30600. devops-c stays at 255600 (separate runtime). |
| 4 | `e88efbd` | 1.4 | Replaced `enableAllProjectMcpServers: true` on 5 agents with explicit `enabledMcpjsonServers` allowlist auto-derived from each agent's `.mcp.json` keys via jq one-liner (so they can't drift). |
| 5 | `6a3da9b` | 2.1 | Moved `comms-discipline.md` Rules 5-8 (online-ready cold-boot gate, 30-min Telegram dedup, event-action glossary, single-quote shell bodies) to new on-demand skill `.claude/skills/comms-send-discipline/SKILL.md`. Also fixed the gitignore: `.claude/` → `.claude/**` so all the existing `!.claude/*` negations finally work. |
| 6 | `5e10647` | 3 | `scripts/audit-fleet-config.sh` (drift reporter) + `scripts/audit-prefix-size.sh` (per-agent always-loaded token estimator). |
| 7 | `409d57c` | 3 fixup | Per `code-evaluator`: removed dead `mcp_file` variable; added bidirectional 1M flag check (`sonnet + 1M-not-disabled` flags as `1M-ON`); inlined the 5 canonical cycle-name list in Rule 1 so common cases don't round-trip into the skill. |
| 8 | `8523d5b` | 3 fixup | Per `pr-deep-evaluator`: added `MCP-DRIFT` detection — cross-checks `enabledMcpjsonServers` allowlist against `.mcp.json` keys; flags drift if someone adds a server to `.mcp.json` without updating the allowlist. |

**Skipped (with reasoning):** Phase 2.2 — orchestrator template inline bus CLI table was estimated at 1.5-2k tokens in the plan but actually measured at ~133 tokens (12× over-stated). Cross-template consistency cost would have required touching 5+ template files for marginal per-session savings. Deferred.

## Why this went undetected

Three independent mechanisms colluded:

1. **`orgs/` gitignored entirely.** Agent config drift was invisible to git. Operators couldn't `git log -- orgs/sb-personal/agents/boss/config.json` to see when the 1M flag flipped or who set it. The audit script that would have caught the inversion (`scripts/audit-fleet-config.sh`) didn't exist.

2. **Misleading inline comments.** Each `.env` file had a comment claiming the file was in the post-fix state ("1M context enabled 2026-05-05", "Removed 2026-05-08"). The active flag below contradicted the comment, but no automated check verified flag-vs-comment consistency. The validator agent's spot-check of one file would have surfaced this; nobody ran one.

3. **Dead gitignore negations.** `.gitignore` line 2 had `.claude/` (bare directory) which prevented git from descending. The subsequent `!.claude/rules/`, `!.claude/commands/`, `!.claude/skills/` negations all looked correct but were silently inert per git docs: "It is not possible to re-include a file if a parent directory of that file is excluded — Git doesn't list excluded directories for performance reasons." The only file under `.claude/` that was tracked (`commands/onboarding.md`) was grandfathered in from a pre-gitignore commit. Any new rule/skill/command would silently fail to commit; `git status` would show clean.

## Verification (post-merge, post-restart)

Verified at 2026-05-16T23:18:01Z, ~3 minutes after restart:

```
agent            limit       next_threshold  pct  sev      severity table
boss             1000000     25              7    green    THRESHOLDS_1M (was 200000 pre-PR)
analyst          1000000     25              5    green    THRESHOLDS_1M (was 200000 pre-PR)
engineer         1000000     25              9    green    THRESHOLDS_1M (already 1M)
fullstack        200000      50              49   green    STALE — standby agent, will refresh on dispatch
devops           200000      50              46   green    sonnet, unchanged
token-auditor    200000      50              36   green    sonnet, restarted
```

Read from `~/.cortextos/default/state/<agent>/context-pct.json`. The `next_threshold` is set from `THRESHOLDS_1M.soft=25` or `THRESHOLDS_200K.soft=50` per `src/monitor/context-usage.ts:35-36`.

**Same prefix load (~71k loaded tokens) costs boss 7% headroom on 1M vs 36% on 200k** — that's the structural win this PR captures. Lossy compaction events drop from "every few hours" to "rarely needed" for the cascade-critical roles.

`bash scripts/audit-fleet-config.sh` → 7/7 clean, exit 0.

## What I did (operational sequence)

1. Read the two Claude Code optimization guides from sibling Jarvis repo.
2. Spawned 3 parallel `Explore` agents to audit fleet configs, settings, prefix sizes — surfaced 8 specific gaps.
3. Verified the most-surprising findings directly (the 1M tier inversion) before trusting the audit summaries.
4. Wrote a plan file with corrected per-agent tables.
5. Spawned an independent code-grounded `general-purpose` validator on the plan — it caught 4 real bugs (stale MCP server lists that would have broken boss's github-gw + analyst's grafana access, a 10× over-stated token-savings figure, wrong stagger rationale, null-vs-undefined conflation).
6. Corrected the plan against validator findings; got user approval via `ExitPlanMode`.
7. Implemented in 4 phases, one logical change per commit. Per-phase `code-evaluator` after each batch.
8. Opened PR #79; ran `pr-deep-evaluator` — APPROVE with should-fixes; addressed the highest-value one (`MCP-DRIFT` detection in audit script).
9. User merged via gh after authorizing.
10. Restarted 4 live agents to apply new config.
11. Verified live state matches intent.
12. Updated `MEMORY.md` index with two durable lessons: the `.claude/**` gitignore trap (existing memory amended); fleet audit tooling reference (new).

## Critical files

**Tracked in this PR:**
- `.gitignore` — selective negations for `orgs/**` and the `.claude/**` fix
- `.claude/rules/comms-discipline.md` — now Rules 1-4 only + pointer to skill
- `.claude/skills/comms-send-discipline/SKILL.md` — Rules 5-8 on-demand
- `.claude/skills/act-as/SKILL.md` — pre-existing skill, now correctly tracked (had been untracked due to dead gitignore)
- `orgs/sb-personal/agents/*/config.json` — ctx thresholds + max_session_seconds
- `orgs/sb-personal/agents/*/.claude/settings.json` — `enabledMcpjsonServers` allowlists
- `orgs/sb-personal/agents/{boss,analyst,devops,devops-c,engineer,fullstack,token-auditor}/{CLAUDE.md,IDENTITY.md,SOUL.md,GOALS.md,GUARDRAILS.md,HEARTBEAT.md,.mcp.json}` — first-time tracking, ~3.5k LOC of agent identity prose
- `scripts/audit-fleet-config.sh`, `scripts/audit-prefix-size.sh` — new audit tooling

**Out-of-band edits (gitignored, documented in commit bodies):**
- `orgs/sb-personal/agents/{boss,analyst,fullstack}/.env` — removed `CLAUDE_CODE_DISABLE_1M_CONTEXT=true` lines

**Existing primitives this PR relies on:**
- `src/monitor/context-usage.ts:125-131` — `resolveContextLimit()` reads `CLAUDE_CODE_DISABLE_1M_CONTEXT`
- `src/daemon/fast-checker.ts:957-1099` — `checkContextStatus()` consumes `ctx_handoff_threshold`
- `src/daemon/agent-process.ts:786,800` — per-agent `max_session_seconds` override
- `src/pty/agent-pty.ts:100-113` — `.env` plumbing into PTY child env
- `scripts/comms/send-telegram-guarded.sh` — wrapper that enforces Rule 5+6 even if the skill isn't invoked

## Audit baseline (recorded for future drift detection)

`bash scripts/audit-prefix-size.sh` at 2026-05-17 (post-merge):

```
Repo-level always-loaded (shared across all agents):
  CLAUDE.md                                    ~564 tok
  .claude/rules/comms-discipline.md           ~1138 tok  (was ~2091 tok pre-trim)
  TOTAL (repo)                                ~1702 tok

Per-agent prefix (repo + agent files):
  analyst       ~10013 tok
  engineer      ~9853 tok
  boss          ~9276 tok
  devops        ~7263 tok
  fullstack     ~6401 tok
  devops-c      ~4729 tok
  token-auditor ~4699 tok
```

`bash scripts/audit-fleet-config.sh` → 7/7 agents clean, drift=0, exit 0.

## Outstanding

- **Fullstack** is in standby — context-pct.json still shows the stale 200k from its last run. Next time the boss dispatches it from standby, the `.env` edit will take effect and it'll come up on 1M.
- **Upstream PR** to `grandamenium/cortextos` for the `.gitignore` `.claude/` → `.claude/**` fix. The fork is fixed; upstream still has the dead-negations bug.
- **Stagger verification** — wait one full ~8h rotation cycle (next ~24h) and observe that "back online" Telegram pings spread across a 2h window instead of clustering on a single wall-clock second.
- **Phase 2.2 deferred** — orchestrator template inline bus CLI table trim. Only ~133 tok per orchestrator session; revisit only if a future audit finds bigger wins in templates that justify touching 5+ files.

## Lessons (now in MEMORY.md)

1. **`.claude/` bare-dir gitignore trap** — `[[project_slash_picker_dedup_gitignore]]` updated. Upstream still vulnerable. Same root cause as the `orgs/` ignore that hid the 1M inversion.
2. **Fleet audit tooling reference** — `[[reference_fleet_audit_tooling]]` new. Run `audit-fleet-config.sh` before assuming the fleet matches its plan.

## Process notes (worked well)

- **Plan-validation subagent before code changes.** The independent validator caught 4 bugs (including the 2 MCP-allowlist correctness errors that would have broken boss's github access). Cost: one subagent call. Saved: an embarrassing rollback.
- **Per-phase `code-evaluator` + final `pr-deep-evaluator`.** Caught the dead `mcp_file` variable, the asymmetric 1M check, and the missing MCP-DRIFT detection — all real should-fixes, all addressed pre-merge.
- **One logical change per commit.** Eight commits cleanly bisect-able. The MCP allowlist change is one commit (1.4); the comms-discipline split is its own (2.1); the audit scripts come last (3 + 2 fixups).
- **Auto-derive config from source of truth.** The MCP allowlist used `jq '.mcpServers | keys'` to populate `enabledMcpjsonServers` — closes the loop where a future operator could update one without the other. Audit script enforces this invariant on every run.

## What would have caught this earlier

A weekly cron running `bash scripts/audit-fleet-config.sh` and posting non-zero exits to the activity-channel. Pre-PR there was no such drift detector; this PR ships one. The follow-up is wiring it as a cron — left out of this PR scope to keep the change set bounded (the script alone is the deliverable; wiring as cron is a separate, smaller change).
